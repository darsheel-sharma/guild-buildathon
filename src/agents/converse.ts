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
import { runAgent, type AgentOutcome } from "./runtime";

const schema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  intent: z.enum(["meeting", "info", "objection", "referral", "not_interested", "unsubscribe"]),
  next_action: z.enum([
    "book_meeting",
    "send_info",
    "handle_objection",
    "follow_up",
    "stop",
    "escalate",
  ]),
  reasoning: z.string().max(400),
  objection: z.string().max(300).optional(),
});

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
  },
): Promise<AgentOutcome<ReplyReading>> {
  return runAgent<ReplyReading>({
    campaignId: campaign.id,
    campaignProspectId: input.campaignProspectId,
    agent: "converse",
    tier: "strong",
    retrievalQuery: `objection handling response guidance ${input.replyBody.slice(0, 200)}`,
    retrievalKinds: ["objection", "playbook"],
    schema,
    seed: `${campaign.id}:${prospect.id}:${input.replyBody.length}`,
    input: { channel: input.channel, reply: input.replyBody.slice(0, 500) },
    buildPrompt: ({ knowledge }) => `Read this reply and decide the next action.

Campaign: ${campaign.name}
Channel:  ${input.channel}
Prospect: ${prospect.full_name}, ${prospect.title} at ${prospect.company}

Thread so far:
${input.threadSummary}

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
