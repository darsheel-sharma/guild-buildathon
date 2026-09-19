/**
 * Follow-up agent.
 *
 * Decides when to try again and — more importantly — when to stop. Knowing
 * when to give up is the part of an SDR sequence that automation usually gets
 * wrong, so "stop" is a normal outcome here rather than an error path.
 */
import { z } from "zod";
import type { Campaign, Prospect } from "@/core/types";
import { runAgent, type AgentOutcome } from "./runtime";

const schema = z.object({
  action: z.enum(["follow_up", "wait", "stop"]),
  wait_days: z.number().min(0).max(45),
  reasoning: z.string().max(300),
});

export interface FollowupDecision {
  action: "follow_up" | "wait" | "stop";
  wait_days: number;
  reasoning: string;
}

export async function decideFollowup(
  campaign: Campaign,
  prospect: Prospect,
  input: {
    campaignProspectId: string;
    touches: number;
    daysSinceLastTouch: number;
    everReplied: boolean;
  },
): Promise<AgentOutcome<FollowupDecision>> {
  return runAgent<FollowupDecision>({
    campaignId: campaign.id,
    campaignProspectId: input.campaignProspectId,
    agent: "followup",
    tier: "fast",
    retrievalQuery: `follow up cadence when to stop sequence ${campaign.icp_name}`,
    retrievalKinds: ["playbook"],
    schema,
    seed: `${campaign.id}:${prospect.id}:fu:${input.touches}`,
    input: { touches: input.touches, days: input.daysSinceLastTouch },
    buildPrompt: ({ knowledge }) => `Decide whether to follow up with this prospect.

Campaign policy: max ${campaign.max_touches} touches, at least ${campaign.min_days_between_touches} days apart
Touches so far:  ${input.touches}
Days since last: ${input.daysSinceLastTouch.toFixed(1)}
Ever replied:    ${input.everReplied ? "yes" : "no"}

Cadence playbook (retrieved):
${knowledge}

Prospect: ${prospect.full_name}, ${prospect.title} at ${prospect.company}

Return follow_up to send the next touch now, wait with a day count if it is too
soon, or stop if the sequence is spent. A prospect who has never replied after
the full touch budget should be stopped, not cycled.`,
    simulate: () => {
      if (input.touches >= campaign.max_touches && !input.everReplied) {
        return {
          action: "stop" as const,
          wait_days: 0,
          reasoning: `${input.touches} touches with no reply; sequence budget spent.`,
        };
      }
      if (input.daysSinceLastTouch < campaign.min_days_between_touches) {
        return {
          action: "wait" as const,
          wait_days: Number(
            (campaign.min_days_between_touches - input.daysSinceLastTouch).toFixed(1),
          ),
          reasoning: `Cadence policy requires ${campaign.min_days_between_touches} days between touches.`,
        };
      }
      return {
        action: "follow_up" as const,
        wait_days: 0,
        reasoning: `Touch ${input.touches + 1} is due and within the ${campaign.max_touches}-touch budget.`,
      };
    },
    summarise: (out) =>
      out.action === "follow_up" ? "follow up now" : `${out.action} (${out.wait_days}d)`,
  });
}
