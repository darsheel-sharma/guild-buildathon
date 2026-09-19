/**
 * Conversation agent.
 *
 * Reads an inbound reply on any channel and decides the next action. It does
 * not send anything itself — it classifies and routes, and the orchestrator
 * acts on the routing. Unsubscribe and escalation decisions are deliberately
 * handled here rather than inside the message writer, so a "stop" is a
 * first-class outcome instead of an unwritten email.
 */
import { z } from "zod";
import type { Campaign, Channel, Prospect, ReplyReading } from "@/core/types";
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";

const schema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  intent: z.enum([
    "meeting",
    "info",
    "objection",
    "referral",
    "not_interested",
    "unsubscribe",
    "deferred",
    "complaint",
    "auto_reply",
    "bounce",
    "unclear",
  ]),
  next_action: z.enum([
    "book_meeting",
    "send_info",
    "handle_objection",
    "follow_up",
    "stop",
    "escalate",
    "pause",
  ]),
  reasoning: z.string().max(400),
  objection: z.string().max(300).optional(),
  trigger_phrase: z.string().optional(),
  response_brief: z.string().optional(),
  resume_after_days: z.number().optional(),
  extracted: z.array(z.string()).max(10).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  human_review: z.boolean().optional(),
  flags: z.array(z.string()).max(10).optional(),
});

const VALID_ACTIONS = new Set(["RESPOND", "BOOK", "ESCALATE", "PAUSE", "SUPPRESS", "RESCHEDULE"]);

function toStringArray(value: unknown, max = 10): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, max);
}

/**
 * The Conversation Agent built on DronaHQ answers with a "conversation_verdict":
 * a machine action (RESPOND/BOOK/ESCALATE/PAUSE/SUPPRESS/RESCHEDULE), a richer
 * intent vocabulary, a quoted trigger_phrase, and conditional fields
 * (response_brief, escalation_reason, resume_after_days) that are only
 * meaningful for some actions — DronaHQ's schema builder can't express "null
 * unless X" so all are marked Required and may come back empty. This
 * reconciles that into ReplyReading: the base fields (sentiment/intent/
 * next_action/reasoning/objection) are always derived so nothing downstream
 * has to change; the richer fields ride along as optional properties.
 */
export function normalizeConversationVerdict(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let obj = raw as Record<string, unknown>;

  // Already our shape (simulate()/direct-model paths) — pass through untouched.
  if (
    typeof obj.sentiment === "string" &&
    typeof obj.intent === "string" &&
    typeof obj.next_action === "string" &&
    typeof obj.reasoning === "string"
  ) {
    return obj;
  }

  if (typeof obj.response === "string") {
    const text = obj.response.trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
      else throw new Error("not an object");
    } catch {
      throw new Error(`DronaHQ Conversation Agent returned unparseable text: ${text.slice(0, 200)}`);
    }
  }

  const actionRaw = String(obj.action ?? "").toUpperCase();
  if (!VALID_ACTIONS.has(actionRaw)) {
    throw new Error(
      `DronaHQ Conversation Agent did not return a verdict (got: ${JSON.stringify(obj).slice(0, 200)})`,
    );
  }

  const intentRaw = String(obj.intent ?? "").toUpperCase();
  const intent: ReplyReading["intent"] =
    {
      POSITIVE: "meeting",
      DEFER: "deferred",
      OPT_OUT: "unsubscribe",
      OBJECTION: "objection",
      QUESTION: "info",
      REFERRAL: "referral",
      COMPLAINT: "complaint",
      AUTO_REPLY: "auto_reply",
      BOUNCE: "bounce",
      UNCLEAR: "unclear",
    }[intentRaw] ?? "unclear";

  // PAUSE and RESCHEDULE both mean "don't reply now, try later" — the
  // orchestrator (engine.ts phaseReplies) schedules a retry via
  // next_action_at rather than drafting anything immediately.
  let next_action: ReplyReading["next_action"];
  if (actionRaw === "RESPOND") next_action = intent === "objection" ? "handle_objection" : "send_info";
  else if (actionRaw === "BOOK") next_action = "book_meeting";
  else if (actionRaw === "ESCALATE") next_action = "escalate";
  else if (actionRaw === "SUPPRESS") next_action = "stop";
  else next_action = "pause"; // PAUSE or RESCHEDULE

  const confidenceRaw = String(obj.confidence ?? "").toLowerCase();
  const confidence: ReplyReading["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low" ? confidenceRaw : undefined;

  const reasoning = [
    typeof obj.escalation_reason === "string" && obj.escalation_reason ? obj.escalation_reason : null,
    typeof obj.response_brief === "string" && obj.response_brief ? obj.response_brief : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join(" ");

  return {
    sentiment: ["positive", "neutral", "negative"].includes(String(obj.sentiment).toLowerCase())
      ? String(obj.sentiment).toLowerCase()
      : "neutral",
    intent,
    next_action,
    reasoning: (reasoning || `${actionRaw} decision from DronaHQ`).slice(0, 400),
    objection: intent === "objection" && typeof obj.trigger_phrase === "string" ? obj.trigger_phrase : undefined,
    trigger_phrase: typeof obj.trigger_phrase === "string" ? obj.trigger_phrase : undefined,
    response_brief:
      typeof obj.response_brief === "string" && obj.response_brief ? obj.response_brief : undefined,
    resume_after_days:
      typeof obj.resume_after_days === "number" && obj.resume_after_days > 0 ? obj.resume_after_days : undefined,
    extracted: toStringArray(obj.extracted, 10),
    confidence: confidence ?? (typeof confidenceRaw === "string" && confidenceRaw !== "high" ? "medium" : undefined),
    human_review:
      typeof obj.human_review === "boolean"
        ? obj.human_review
        : ["ESCALATE", "SUPPRESS"].includes(actionRaw) || confidence !== "high",
    flags: toStringArray(obj.flags, 10),
  };
}

/**
 * Escalation and stop policy text sent to the DronaHQ Conversation Agent as
 * named variables ({{variable.escalation_policy}} / {{variable.stop_policy}}
 * per its instructions). Campaign has no such field yet, so these are fixed
 * defaults for now, kept in sync with the objection-handling knowledge base's
 * "Escalate to a human when" list and the hard-stop phrases already used by
 * readOffline() below. Promote to a per-campaign column if these ever need
 * to vary by campaign.
 */
const DEFAULT_ESCALATION_POLICY =
  "Escalate when: the reply asks about pricing specifics, contract terms, or security review; " +
  "names a competitor and asks for a comparison; asks a technical question about their own " +
  "architecture; is hostile or a complaint; is a referral or handoff to a different person; " +
  "sounds like legal, procurement, or compliance; or is ambiguous enough that guessing wrong " +
  "would be costly.";

const DEFAULT_STOP_POLICY =
  "Hard stop when the reply contains: unsubscribe, remove me, do not contact, stop contacting, " +
  "take me off, or opt out.";

/** Keyword reading used offline. Intentionally conservative: anything that
 *  looks like a legal or opt-out signal routes to stop, never to a follow-up. */
function readOffline(body: string): ReplyReading {
  const text = body.toLowerCase();

  if (/unsubscribe|remove me|do not contact|stop contacting|take me off/.test(text)) {
    return {
      sentiment: "negative",
      intent: "unsubscribe",
      next_action: "stop",
      reasoning: "Explicit opt-out language: suppress immediately and stop all outreach.",
    };
  }
  if (/not a priority|no thanks|not interested|no budget/.test(text)) {
    return {
      sentiment: "negative",
      intent: "not_interested",
      next_action: "stop",
      reasoning: "Clear decline without an objection to work; closing the sequence.",
    };
  }
  if (/not my area|copied|now owns|talk to them|forwarded/.test(text)) {
    return {
      sentiment: "neutral",
      intent: "referral",
      next_action: "escalate",
      reasoning: "Handed off to a different owner; a human should reroute to the named contact.",
    };
  }
  if (/already|in-house|in house|too expensive|stalled|residency|compliance|hard to justify/.test(text)) {
    const sentence =
      body
        .split(/(?<=[.!?])\s+/)
        .find((s) => /already|in-house|in house|expensive|stalled|residency|justify/i.test(s))
        ?.trim() ?? body.slice(0, 200);
    return {
      sentiment: "neutral",
      intent: "objection",
      next_action: "handle_objection",
      reasoning: "Substantive objection raised; answer it with retrieved objection handling.",
      objection: sentence,
    };
  }
  if (/works|send an invite|tuesday|thursday|happy to talk|book|calendar|call/.test(text)) {
    return {
      sentiment: "positive",
      intent: "meeting",
      next_action: "book_meeting",
      reasoning: "Prospect proposed or accepted a time; move to booking and escalate to the rep.",
    };
  }
  if (/can you send|how does|what does|rollout|pricing|more info|details/.test(text)) {
    return {
      sentiment: "positive",
      intent: "info",
      next_action: "send_info",
      reasoning: "Asked a specific question; answer it with grounded material.",
    };
  }
  return {
    sentiment: "neutral",
    intent: "info",
    next_action: "follow_up",
    reasoning: "No clear signal; keep the thread alive with a short follow-up.",
  };
}

export async function readReply(
  campaign: Campaign,
  prospect: Prospect,
  input: {
    campaignProspectId: string;
    channel: Channel;
    replyBody: string;
    threadSummary: string;
    /** Full prior thread, both directions, oldest first. See engine.ts phaseReplies. */
    threadTranscript: string;
  },
): Promise<AgentOutcome<ReplyReading>> {
  return runAgent<ReplyReading>({
    campaignId: campaign.id,
    campaignProspectId: input.campaignProspectId,
    agent: "converse",
    tier: "strong",
    retrievalQuery: `objection handling response guidance ${input.replyBody.slice(0, 200)}`,
    // The agent's own instructions name these two as its secondary
    // knowledge sources: objection handling for documented responses, the
    // product one-pager for factual questions.
    retrievalKinds: ["objection", "product"],
    schema,
    seed: `${campaign.id}:${prospect.id}:${input.replyBody.length}`,
    input: { channel: input.channel, reply: input.replyBody.slice(0, 500) },
    // Named fields for the DronaHQ agent's {{variable.*}} bindings.
    variables: (ctx: AgentContext) => ({
      campaign_name: campaign.icp_name,
      prompt_version: ctx.harness.prompt_version_id,
      escalation_policy: DEFAULT_ESCALATION_POLICY,
      stop_policy: DEFAULT_STOP_POLICY,
    }),
    normalize: normalizeConversationVerdict,
    buildPrompt: ({ knowledge }) => `Read this reply and decide the next action.

Campaign: ${campaign.name}
Channel:  ${input.channel}
Prospect: ${prospect.full_name}, ${prospect.title} at ${prospect.company}

Thread so far (oldest first; ignore quoted text and signatures within any message):
${input.threadTranscript}

Their reply:
"""
${input.replyBody}
"""

Objection handling guidance (retrieved):
${knowledge}

Classify sentiment and intent, then pick one next action. Rules that override
everything else: any opt-out request is intent unsubscribe and action stop; a
handoff to another person is action escalate, never an automated reply to the
new contact. When an objection is present, quote it in the objection field.`,
    simulate: () => readOffline(input.replyBody),
    summarise: (out) => `${out.intent} / ${out.sentiment} → ${out.next_action}`,
  });
}
