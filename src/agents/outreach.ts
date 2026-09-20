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
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";

const schema = z.object({
  channel: z.enum(["email", "linkedin", "sms", "voice"]),
  should_contact: z.boolean(),
  rationale: z.string().max(400),
  wait_days: z.number().min(0).max(30),
  sequence_step: z.number().min(1).max(10),
  action: z.enum(["contact", "wait", "skip", "escalate"]).optional(),
  reason: z.string().optional(),
  human_approval_required: z.boolean().optional(),
  angle: z.string().optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  flags: z.array(z.string()).optional(),
  planned_sequence: z.array(z.string()).optional(),
});

const VALID_CHANNELS = new Set(["email", "linkedin", "sms", "voice"]);

/**
 * The Outreach Strategy Agent built on DronaHQ answers with a richer decision
 * (action CONTACT/WAIT/SKIP/ESCALATE, an ISO send_at, a planned_sequence, a
 * machine-readable reason constant, human_approval_required) than this
 * codebase's OutreachPlan. The base five fields (channel/should_contact/
 * rationale/wait_days/sequence_step) are always derived so nothing existing
 * has to change; the richer fields ride along on the optional properties
 * added to OutreachPlan.
 *
 * Needs the enabled channels and last-used channel to pick a sensible
 * `channel` value for WAIT/SKIP/ESCALATE (DronaHQ's channel is null there),
 * so this is a factory rather than a standalone function.
 */
function makeOutreachNormalizer(opts: { enabled: Channel[]; lastChannel: Channel | null; step: number }) {
  const fallbackChannel: Channel =
    (opts.lastChannel && opts.enabled.length > 1
      ? opts.enabled.find((c) => c !== opts.lastChannel)
      : opts.enabled[0]) ?? opts.enabled[0] ?? "email";

  return function normalizeOutreachPlan(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    let obj = raw as Record<string, unknown>;

    // Already our shape — pass through untouched.
    if (
      typeof obj.channel === "string" &&
      VALID_CHANNELS.has(obj.channel) &&
      typeof obj.should_contact === "boolean" &&
      typeof obj.rationale === "string" &&
      typeof obj.wait_days === "number" &&
      typeof obj.sequence_step === "number"
    ) {
      return obj;
    }

    let freeText: string | null = null;
    if (typeof obj.response === "string") {
      const text = obj.response.trim();
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
        else throw new Error("not an object");
      } catch {
        freeText = text;
      }
    }

    if (freeText !== null) {
      const actionMatch = freeText.match(/\b(CONTACT|WAIT|SKIP|ESCALATE)\b/i);
      if (!actionMatch) {
        throw new Error(`DronaHQ Outreach Strategy Agent returned unparseable text: ${freeText.slice(0, 200)}`);
      }
      const action = actionMatch[1].toUpperCase();
      const channelMatch = freeText.match(/\b(email|linkedin|sms|voice)\b/i);
      const channel: Channel =
        channelMatch && VALID_CHANNELS.has(channelMatch[1].toLowerCase())
          ? (channelMatch[1].toLowerCase() as Channel)
          : fallbackChannel;
      return {
        channel,
        should_contact: action === "CONTACT",
        rationale: freeText.slice(0, 400),
        wait_days: action === "CONTACT" ? 0 : action === "WAIT" ? 1 : 30,
        sequence_step: opts.step,
        action: action.toLowerCase(),
        human_approval_required: action === "ESCALATE",
      };
    }

    const hasAnyPlanField =
      "action" in obj || "channel" in obj || "send_at" in obj || "planned_sequence" in obj || "reason" in obj;
    if (!hasAnyPlanField) {
      throw new Error(
        `DronaHQ Outreach Strategy Agent did not return a plan (got: ${JSON.stringify(obj).slice(0, 200)})`,
      );
    }

    // An unrecognised action used to fall through to WAIT, which looks
    // identical to a deliberate hold: the prospect stalls and nothing is
    // recorded as degraded. Fail instead, so a misconfigured agent is
    // visible rather than quietly patient.
    const actionRaw = String(obj.action ?? "").toUpperCase();
    if (!["CONTACT", "WAIT", "SKIP", "ESCALATE"].includes(actionRaw)) {
      throw new Error(
        `DronaHQ Outreach Strategy Agent returned an unrecognised action "${actionRaw}" ` +
          `(expected CONTACT, WAIT, SKIP or ESCALATE)`,
      );
    }
    const action = actionRaw;

    const channelRaw = typeof obj.channel === "string" ? obj.channel.toLowerCase() : null;
    const channel: Channel = channelRaw && VALID_CHANNELS.has(channelRaw) ? (channelRaw as Channel) : fallbackChannel;

    let waitDays = 1;
    if (action === "CONTACT") {
      waitDays = 0;
    } else if (action === "WAIT" && typeof obj.send_at === "string") {
      const target = Date.parse(obj.send_at);
      if (Number.isFinite(target)) {
        waitDays = Math.max(0, Math.min(30, Math.ceil((target - Date.now()) / 86_400_000)));
      }
    } else if (action === "SKIP" || action === "ESCALATE") {
      waitDays = 30;
    }

    const rationale = [
      typeof obj.reasoning === "string" ? obj.reasoning : null,
      typeof obj.reason === "string" ? `reason: ${obj.reason}` : null,
    ]
      .filter((v): v is string => Boolean(v))
      .join(" ");

    return {
      channel,
      should_contact: action === "CONTACT",
      rationale: (rationale || `${action} decision from DronaHQ`).slice(0, 400),
      wait_days: waitDays,
      sequence_step: opts.step,
      action: action.toLowerCase(),
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
      human_approval_required:
        typeof obj.human_approval_required === "boolean" ? obj.human_approval_required : action === "ESCALATE",
      angle: typeof obj.angle === "string" ? obj.angle : undefined,
      priority:
        typeof obj.priority === "string" && ["high", "medium", "low"].includes(obj.priority.toLowerCase())
          ? (obj.priority.toLowerCase() as "high" | "medium" | "low")
          : undefined,
      flags: Array.isArray(obj.flags) ? obj.flags.filter((f): f is string => typeof f === "string") : undefined,
      planned_sequence: Array.isArray(obj.planned_sequence)
        ? obj.planned_sequence.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        : undefined,
    };
  };
}

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
    // Named fields for the DronaHQ agent's {{variable.*}} bindings.
    variables: (ctx: AgentContext) => ({
      campaign_name: campaign.icp_name,
      prompt_version: ctx.harness.prompt_version_id,
      channel_config: {
        email: enabled.includes("email"),
        linkedin: enabled.includes("linkedin"),
        sms: enabled.includes("sms"),
        voice: enabled.includes("voice"),
      },
      outreach_policy: {
        min_days_between_touches: campaign.min_days_between_touches,
        max_touches: campaign.max_touches,
        conflict_policy: campaign.conflict_policy,
        daily_send_limit: campaign.daily_send_limit,
      },
      rep_context: campaign.owner,
    }),
    normalize: makeOutreachNormalizer({ enabled, lastChannel: input.lastChannel, step }),
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
