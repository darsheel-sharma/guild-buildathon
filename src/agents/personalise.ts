/**
 * Personalisation agent.
 *
 * The only agent that writes text a prospect will read, so it runs on the
 * strong model tier and is hard-wired to retrieval: the example-message and
 * case-study chunks it retrieves are passed in as the only permitted source of
 * specifics, and the titles it used are recorded on the run.
 *
 * Channel shapes the output — an SMS is not a shortened email.
 */
import { z } from "zod";
import type { Campaign, Channel, DraftedMessage, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";

const schema = z.object({
  subject: z.string().max(140),
  body: z.string().min(1).max(2000),
  knowledge_used: z.array(z.string()).max(6),
  personalisation_basis: z.string().max(400).optional(),
  word_count: z.number().optional(),
  requires_review: z.boolean().optional(),
  unverified_claims: z.array(z.string()).max(10).optional(),
  flags: z.array(z.string()).max(10).optional(),
});

function toStringArray(value: unknown, max = 10): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, max);
}

/**
 * The Personalisation / Email Agent built on DronaHQ answers with a richer,
 * audited shape (personalisation_basis, knowledge_sources, word_count,
 * requires_review, unverified_claims, flags) than this codebase's
 * DraftedMessage. The base three fields (subject/body/knowledge_used) are
 * always derived so nothing existing has to change; the richer fields ride
 * along on optional properties added to DraftedMessage.
 *
 * Edge case per the agent's instructions: a disabled channel returns an
 * `error` field and no body. That is treated as a decline (thrown) rather
 * than sent as an empty message, so the run degrades visibly to the next
 * backend instead of silently posing as a successful draft.
 */
export function normalizeDraftedMessage(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let obj = raw as Record<string, unknown>;

  // Already our shape (simulate()/direct-model paths) — pass through untouched.
  if (typeof obj.subject === "string" && typeof obj.body === "string" && Array.isArray(obj.knowledge_used)) {
    return obj;
  }

  // The trigger's envelope wraps the agent's answer in `response`, which may
  // be the message JSON serialised as a string, or free text if Structured
  // Output isn't enforcing the schema yet.
  if (typeof obj.response === "string") {
    const text = obj.response.trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
      else throw new Error("not an object");
    } catch {
      // Free text with no reliable subject/body split. Keep it as the body
      // rather than guessing at structure, and flag it for review.
      if (!text) throw new Error("DronaHQ Personalisation Agent returned an empty response");
      return {
        subject: "",
        body: text.slice(0, 2000),
        knowledge_used: [],
        requires_review: true,
        flags: ["unstructured_response"],
      };
    }
  }

  const hasAnyMessageField =
    "body" in obj ||
    "subject" in obj ||
    "error" in obj ||
    "personalisation_basis" in obj ||
    "unverified_claims" in obj;
  if (!hasAnyMessageField) {
    throw new Error(
      `DronaHQ Personalisation Agent did not return a message (got: ${JSON.stringify(obj).slice(0, 200)})`,
    );
  }

  if (typeof obj.error === "string" && obj.error.length > 0 && typeof obj.body !== "string") {
    throw new Error(`DronaHQ Personalisation Agent declined: ${obj.error.slice(0, 200)}`);
  }

  const knowledgeSources = toStringArray(obj.knowledge_sources ?? obj.knowledge_used, 6);
  const body = typeof obj.body === "string" ? obj.body : "";
  const wordCount =
    typeof obj.word_count === "number" ? obj.word_count : body.split(/\s+/).filter(Boolean).length;

  return {
    subject: typeof obj.subject === "string" ? obj.subject : "",
    body,
    knowledge_used: knowledgeSources,
    personalisation_basis: typeof obj.personalisation_basis === "string" ? obj.personalisation_basis : undefined,
    word_count: wordCount,
    requires_review: typeof obj.requires_review === "boolean" ? obj.requires_review : undefined,
    unverified_claims: toStringArray(obj.unverified_claims, 10),
    flags: toStringArray(obj.flags, 10),
  };
}

/**
 * Reads the tone the campaign prompt asks for. Crude keyword matching rather
 * than anything clever — the point is that the offline writer is driven by the
 * prompt rather than ignoring it, so prompt versioning is not cosmetic when no
 * model key is configured.
 */
type Register = "formal" | "informal" | "warm" | "direct";

function registerOf(system: string): Register {
  const text = system.toLowerCase();
  // "informal" is checked first and every pattern is word-bounded, because
  // /formal/ happily matches inside "informal" and silently turns the founder
  // campaign's copy into a bank letter.
  if (/\binformal\b|\blowercase\b|founder-to-founder|match their energy/.test(text)) {
    return "informal";
  }
  if (/\bformal\b|compliance-first|use full titles|no contractions/.test(text)) return "formal";
  if (/\bwarm\b|relationship already exists|low-pressure/.test(text)) return "warm";
  return "direct";
}

/**
 * Length limits by channel *and* sequence position, matching the campaign's
 * voice-and-rules knowledge document. A flat per-channel limit contradicted
 * that document at later touches — the agent was told 90-130 words while the
 * retrieved rules said under 40 — so the two are reconciled here, with the
 * knowledge base as the source of truth.
 */
function limitFor(channel: Channel, step: number): string {
  switch (channel) {
    case "email":
      if (step <= 1) return "60 to 110 words, a lowercase subject line under 8 words, one specific ask";
      if (step <= 3) return "40 to 70 words, a lowercase subject line under 8 words, one specific ask";
      return "under 40 words, a lowercase subject line under 8 words, one specific ask";
    case "linkedin":
      return "under 90 words, no subject, conversational, no links";
    case "sms":
      return "under 160 characters total, no links, sign off with the sender first name";
    case "voice":
      return "a 30-second spoken opening: one sentence of context, one question";
  }
}

export async function draftMessage(
  campaign: Campaign,
  prospect: Prospect,
  input: {
    campaignProspectId: string;
    channel: Channel;
    sequenceStep: number;
    research: ResearchOutput | null;
    senderName: string;
    senderTitle: string;
    /** Set when this message answers an objection raised in a reply. */
    objection?: string;
    /**
     * The hook the outreach agent picked for this step, chosen to differ from
     * every angle already used in the sequence. Without it the writer re-picks
     * a hook on its own and the no-repeat guarantee is lost.
     */
    angle?: string;
  },
): Promise<AgentOutcome<DraftedMessage>> {
  const hook = input.research?.personalisation_hooks?.[0] ?? "";
  const pain = input.research?.pain_hypotheses?.[0] ?? "";

  return runAgent<DraftedMessage>({
    campaignId: campaign.id,
    campaignProspectId: input.campaignProspectId,
    agent: "personalise",
    tier: "strong",
    retrievalQuery: input.objection
      ? `objection handling ${input.objection} ${campaign.icp_name}`
      : `example ${input.channel} message ${campaign.icp_name} ${prospect.industry} ${pain}`,
    // "voice" carries the hard tone rules (banned phrases, length table). It
    // was missing here, so the voice guide never reached the writer even
    // though its own front matter marks it always_retrieve.
    retrievalKinds: input.objection
      ? ["objection", "case_study", "voice"]
      : ["example_message", "case_study", "product", "voice"],
    retrievalLimit: 4,
    schema,
    seed: `${campaign.id}:${prospect.id}:${input.channel}:${input.sequenceStep}`,
    input: {
      channel: input.channel,
      step: input.sequenceStep,
      objection: input.objection ?? null,
    },
    // Named fields for the DronaHQ agent's {{variable.*}} bindings. This
    // agent's Variables panel declares only these five — prospect/research
    // specifics reach it through the prompt text (buildPrompt below) plus
    // retrieval, not through named variables.
    variables: (ctx: AgentContext) => ({
      campaign_name: campaign.icp_name,
      prompt_version: ctx.harness.prompt_version_id,
      sender_identity: { name: input.senderName, title: input.senderTitle },
      channel_rules: {
        channel: input.channel,
        enabled: campaign.channels.includes(input.channel),
        enabled_channels: campaign.channels,
        limit: limitFor(input.channel, input.sequenceStep),
        sequence_step: input.sequenceStep,
      },
      product_positioning: campaign.objective,
      angle: input.angle ?? null,
    }),
    normalize: normalizeDraftedMessage,
    buildPrompt: ({ knowledge }) => `Write outreach step ${input.sequenceStep} for this prospect.

Channel: ${input.channel} — ${limitFor(input.channel, input.sequenceStep)}
Campaign objective: ${campaign.objective}
From: ${input.senderName}, ${input.senderTitle}

Prospect
  ${prospect.full_name} — ${prospect.title} at ${prospect.company}
  ${prospect.industry}, ${prospect.geography}

Angle chosen by the outreach agent for this step — lead on this:
  ${input.angle || "(none supplied, pick the strongest unused dossier signal)"}

Research
  hook:    ${hook || "(none)"}
  pain:    ${pain || "(none)"}
  signals: ${input.research?.signals.join("; ") ?? "none"}
${input.objection ? `\nThey raised this objection, address it directly and without defensiveness:\n  "${input.objection}"\n` : ""}
Approved knowledge — the ONLY source you may draw specifics from:
${knowledge}

Rules
  - Every concrete claim (customer name, metric, capability) must appear in the
    knowledge above. If it is not there, write the message without it.
  - No invented mutual connections, no fake urgency, no "I noticed you" openers
    that are not backed by a research signal.
  - One ask, easy to say yes to.
  - List the knowledge titles you actually used in knowledge_used.`,
    simulate: (rng, { chunks, harness }) => {
      const first = prospect.full_name.split(" ")[0];
      const proof = chunks.find((c) => c.kind === "case_study");
      const used = chunks.slice(0, 2).map((c) => c.title);
      const register = registerOf(harness.system);
      const evidence = proof ? ` ${proof.content.split(".")[0]}.` : "";

      if (input.objection) {
        const body = `${first}, that is fair — most teams we work with had something in-house first.\n\nThe difference is usually maintenance load rather than capability: ${pain || "the internal version keeps needing engineering time"}. ${proof ? proof.content.split(".")[0] + "." : ""}\n\nWorth 20 minutes to compare notes, or should I close the loop here?\n\n${input.senderName}`;
        return {
          subject: `Re: your point on running this in-house`,
          body,
          knowledge_used: used,
        };
      }

      if (input.channel === "sms") {
        return {
          subject: "",
          body: `${first}, ${input.senderName} here re: ${prospect.company}'s internal tooling. Worth a 15-min call this week? Reply STOP to opt out.`,
          knowledge_used: used,
        };
      }

      if (input.channel === "linkedin") {
        return {
          subject: "",
          body: `${first} — ${hook || `saw ${prospect.company} is scaling its platform work`}. We help ${prospect.industry} teams ship internal tools without burning engineering cycles. Open to a short call?`,
          knowledge_used: used,
        };
      }

      if (input.channel === "voice") {
        return {
          subject: "",
          body: `Hi ${first}, this is ${input.senderName} from the platform team — I will keep this to thirty seconds. We work with ${prospect.industry} teams where ${pain || "internal tooling has outgrown its owners"}. Is that something your team is dealing with this quarter?`,
          knowledge_used: used,
        };
      }

      // The offline writer takes its register from the resolved harness, the
      // way a model would: a campaign prompt asking for formal, compliance-first
      // language produces visibly different copy from one asking for
      // founder-to-founder shorthand. Editing the prompt changes this output.
      if (register === "formal") {
        return {
          subject: `Introduction: internal application delivery at ${prospect.company}`,
          body: `Dear ${prospect.full_name},\n\nI am writing regarding internal application delivery at ${prospect.company}.${pain ? ` In institutions of comparable scale, ${pain}.` : ""}\n\nThe platform can be deployed inside your own infrastructure where that is required, with role-based access control and full audit logging of every agent action.${evidence}\n\nIf it would be useful, I would welcome an introductory conversation at your convenience, and I am happy to share the deployment documentation in advance.\n\nWith regards,\n${input.senderName}\n${input.senderTitle}`,
          knowledge_used: used,
        };
      }

      if (register === "informal") {
        return {
          subject: "the boring part of agents",
          body: `hey ${first},\n\n${hook || `saw what ${prospect.company} is building`}. you have the model layer sorted — the part that usually hurts is everything around it: durable state, tool calls that fail cleanly, human handoff, knowing whether a prompt change actually helped.\n\nthat is the bit we do.${evidence}\n\nworth a quick call this week?\n\n${input.senderName}`,
          knowledge_used: used,
        };
      }

      if (register === "warm") {
        return {
          subject: `${prospect.company}: the workflow after the first one`,
          body: `Hi ${first},\n\nOne team at ${prospect.company} is already building on the platform, and the pattern we usually see next is the adjacent operational workflow going the same way.${evidence}\n\nRather than a meeting with you, could you point me to whoever owns that area? Happy to take it from there.\n\n${input.senderName}\n${input.senderTitle}`,
          knowledge_used: used,
        };
      }

      const openers = [
        `${hook || `${prospect.company} looks like it is scaling faster than its internal tooling`}.`,
        // Phrased to avoid pluralising the title — "Director of Engineerings"
        // is the kind of tell that makes generated copy obviously generated.
        `Every ${prospect.title} I speak with in ${prospect.industry} says the same thing: ${pain || "internal tools get built and then nobody owns them"}.`,
      ];
      return {
        subject: `${prospect.company} — internal tooling without the engineering tax`,
        body: `Hi ${first},\n\n${rng.pick(openers)}\n\nWe give teams a way to ship operational tools and agents on top of the systems they already run, so the work stops queueing behind product.${proof ? ` ${proof.content.split(".")[0]}.` : ""}\n\nWould a 20-minute walkthrough next week be useful? Happy to send a short recording instead if that is easier.\n\n${input.senderName}\n${input.senderTitle}`,
        knowledge_used: used,
      };
    },
    summarise: (out) =>
      `${input.channel} draft, ${out.body.split(/\s+/).length} words, grounded in ${out.knowledge_used.length} sources`,
  });
}
