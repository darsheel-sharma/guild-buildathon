/**
 * Outreach strategy agent.
 *
 * Decides whether, when and on which channel a prospect should be contacted —
 * separate from the agent that writes the message. Keeping the two apart is
 * what makes the system read as one SDR rather than four channel bots: the
 * channel choice accounts for what has already been tried on every other
 * channel, and the copy is written afterwards knowing which step it is.
 */
import { z } from "zod";
import type { Campaign, Channel, OutreachPlan, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentOutcome } from "./runtime";

const schema = z.object({
  channel: z.enum(["email", "linkedin", "sms", "voice"]),
  should_contact: z.boolean(),
  rationale: z.string().max(400),
  wait_days: z.number().min(0).max(30),
  sequence_step: z.number().min(1).max(10),
});

/**
 * Channel ladder. Early steps stay low-friction; phone and voice are only
 * earned by a high fit score, because a cold call on a weak match is how a
 * brand gets burned.
 */
function chooseChannel(
  enabled: Channel[],
  step: number,
  score: number,
  lastChannel: Channel | null,
): Channel {
  const ladder: Channel[] = ["email", "linkedin", "email", "voice", "sms"];
  const preferred = ladder.slice(step - 1).concat(ladder);
  for (const channel of preferred) {
    if (!enabled.includes(channel)) continue;
    if (channel === lastChannel && enabled.length > 1) continue;
    if ((channel === "voice" || channel === "sms") && score < 0.75) continue;
    return channel;
  }
  return enabled[0] ?? "email";
}

export async function planOutreach(
  campaign: Campaign,
  prospect: Prospect,
  input: {
    campaignProspectId: string;
    touches: number;
    lastChannel: Channel | null;
    lastTouchAt: string | null;
    icpScore: number;
    research: ResearchOutput | null;
  },
): Promise<AgentOutcome<OutreachPlan>> {
  const step = input.touches + 1;
  const enabled = campaign.channels ?? ["email"];

  return runAgent<OutreachPlan>({
    campaignId: campaign.id,
    campaignProspectId: input.campaignProspectId,
    agent: "outreach",
    tier: "fast",
    retrievalQuery: `outreach sequence strategy channel cadence ${campaign.icp_name}`,
    retrievalKinds: ["playbook"],
    schema,
    seed: `${campaign.id}:${prospect.id}:${step}`,
    input: { step, enabled, score: input.icpScore },
    buildPrompt: ({ knowledge }) => `Decide the next outreach action for this prospect.

Campaign:         ${campaign.name}
Enabled channels: ${enabled.join(", ")}
Cadence policy:   at least ${campaign.min_days_between_touches} days between touches, at most ${campaign.max_touches} touches
Sequence step:    ${step}
ICP fit score:    ${input.icpScore}
Last channel:     ${input.lastChannel ?? "none yet"}
Last touch:       ${input.lastTouchAt ?? "never"}

Playbook (retrieved):
${knowledge}

Prospect: ${prospect.full_name}, ${prospect.title} at ${prospect.company} (${prospect.geography})
Research signals: ${input.research?.signals.join("; ") ?? "none"}

Pick exactly one enabled channel. Do not repeat the channel used for the last
touch unless it is the only one enabled. Reserve voice and SMS for fit scores
above 0.75. If contacting now would be wrong, set should_contact false and say
how many days to wait.`,
    simulate: (rng) => {
      const channel = chooseChannel(enabled, step, input.icpScore, input.lastChannel);
      const shouldContact = step <= campaign.max_touches;
      return {
        channel,
        should_contact: shouldContact,
        rationale: shouldContact
          ? `Step ${step} of the sequence on ${channel}; fit score ${input.icpScore} and last touch was ${input.lastChannel ?? "none"}.`
          : `Sequence budget of ${campaign.max_touches} touches is spent with no reply; stopping.`,
        wait_days: shouldContact ? 0 : campaign.min_days_between_touches + rng.int(0, 2),
        sequence_step: step,
      };
    },
    summarise: (out) =>
      out.should_contact
        ? `contact on ${out.channel} at step ${out.sequence_step}`
        : `hold for ${out.wait_days}d`,
  });
}
