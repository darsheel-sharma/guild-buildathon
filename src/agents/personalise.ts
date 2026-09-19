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
import { runAgent, type AgentOutcome } from "./runtime";

const schema = z.object({
  subject: z.string().max(140),
  body: z.string().min(1).max(2000),
  knowledge_used: z.array(z.string()).max(6),
});

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

const LIMITS: Record<Channel, string> = {
  email: "90 to 130 words, a subject line under 60 characters, one specific ask",
  linkedin: "under 60 words, no subject, conversational, no links",
  sms: "under 160 characters total, no links, sign off with the sender first name",
  voice: "a 30-second spoken opening: one sentence of context, one question",
};

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
    retrievalKinds: input.objection
      ? ["objection", "case_study"]
      : ["example_message", "case_study", "product"],
    retrievalLimit: 4,
    schema,
    seed: `${campaign.id}:${prospect.id}:${input.channel}:${input.sequenceStep}`,
    input: {
      channel: input.channel,
      step: input.sequenceStep,
      objection: input.objection ?? null,
    },
    buildPrompt: ({ knowledge }) => `Write outreach step ${input.sequenceStep} for this prospect.

Channel: ${input.channel} — ${LIMITS[input.channel]}
Campaign objective: ${campaign.objective}
From: ${input.senderName}, ${input.senderTitle}

Prospect
  ${prospect.full_name} — ${prospect.title} at ${prospect.company}
  ${prospect.industry}, ${prospect.geography}

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
