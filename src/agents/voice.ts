/**
 * Voice SDR agent.
 *
 * Plans a call rather than writing a message: an opening, the questions that
 * qualify the prospect, the objections likely on this ICP, and an explicit
 * escalation trigger. The plan's opening is what the telephony adapter speaks;
 * the questions and escalation rule are what keep the call from wandering.
 */
import { z } from "zod";
import type { Campaign, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentOutcome } from "./runtime";

const schema = z.object({
  opening: z.string().max(600),
  objective: z.string().max(200),
  qualification_questions: z.array(z.string()).min(1).max(4),
  likely_objections: z.array(z.string()).max(3),
  escalate_if: z.string().max(200),
});

export interface CallPlan {
  opening: string;
  objective: string;
  qualification_questions: string[];
  likely_objections: string[];
  escalate_if: string;
}

export async function planCall(
  campaign: Campaign,
  prospect: Prospect,
  input: {
    campaignProspectId: string;
    research: ResearchOutput | null;
    senderName: string;
  },
): Promise<AgentOutcome<CallPlan>> {
  const first = prospect.full_name.split(" ")[0];
  const pain = input.research?.pain_hypotheses?.[0] ?? "internal tooling has outgrown its owners";

  return runAgent<CallPlan>({
    campaignId: campaign.id,
    campaignProspectId: input.campaignProspectId,
    agent: "voice",
    tier: "strong",
    retrievalQuery: `voice call script qualification questions objection handling ${campaign.icp_name}`,
    retrievalKinds: ["voice_script", "objection", "playbook"],
    schema,
    seed: `${campaign.id}:${prospect.id}:call`,
    input: { prospect: prospect.email },
    buildPrompt: ({ knowledge }) => `Plan a cold qualification call.

Campaign objective: ${campaign.objective}
Prospect: ${prospect.full_name}, ${prospect.title} at ${prospect.company} (${prospect.geography})
Research: ${input.research ? input.research.pain_hypotheses.join("; ") : "none"}
Caller: ${input.senderName}

Scripts and objection handling (retrieved):
${knowledge}

Produce a 30-second opening that names the caller and the reason for the call,
two to four questions that would actually qualify or disqualify this prospect,
the objections most likely on this ICP, and one explicit condition under which
the agent must hand the call to a human instead of continuing.`,
    simulate: () => ({
      opening: `Hi ${first}, this is ${input.senderName} — I will keep this to thirty seconds. We work with ${prospect.industry} teams where ${pain}. Is that on your plate this quarter?`,
      objective: `Qualify fit against ${campaign.icp_name} and book a 20-minute technical call.`,
      qualification_questions: [
        "Who owns internal tooling and operational apps today?",
        "How much engineering time goes into admin panels and internal dashboards each month?",
        "Is there a budget line for this, or would it come out of the platform budget?",
      ],
      likely_objections: [
        "We already build this in-house",
        "Data residency and compliance review would take too long",
      ],
      escalate_if:
        "The prospect asks for pricing commitments, raises a legal or security review, or asks to speak to a human.",
    }),
    summarise: (out) => `call plan with ${out.qualification_questions.length} qualifying questions`,
  });
}
