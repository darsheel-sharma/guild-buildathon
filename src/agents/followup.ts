/**
 * Follow-up agent.
 *
 * Decides when to try again and — more importantly — when to stop. Knowing
 * when to give up is the part of an SDR sequence that automation usually gets
 * wrong, so "stop" is a normal outcome here rather than an error path.
 */
import { z } from "zod";
import type { Campaign, Channel, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";

const schema = z.object({
  action: z.enum(["follow_up", "wait", "stop", "escalate"]),
  wait_days: z.number().min(0).max(45),
  reasoning: z.string().max(300),
  channel: z.enum(["email", "linkedin", "sms", "voice"]).optional(),
  angle: z.string().optional(),
  stop_reason: z
    .enum(["SEQUENCE_COMPLETE", "NO_ENGAGEMENT", "UNDELIVERABLE", "SUPPRESSED", "NO_NEW_SIGNAL", "WRONG_AGENT", "ROLE_CHANGE"])
    .optional(),
  engagement_score: z.enum(["high", "medium", "zero"]).optional(),
  human_review: z.boolean().optional(),
  sequence_position: z.number().optional(),
});

export interface FollowupDecision {
  action: "follow_up" | "wait" | "stop" | "escalate";
  wait_days: number;
  reasoning: string;
  channel?: Channel;
  angle?: string;
  stop_reason?: string;
  engagement_score?: "high" | "medium" | "zero";
  human_review?: boolean;
  sequence_position?: number;
}

const VALID_ACTIONS = new Set(["FOLLOW_UP", "WAIT", "STOP", "REVIVE", "ESCALATE"]);
const VALID_CHANNELS = new Set(["email", "linkedin", "sms", "voice"]);

/**
 * Builds the {{variable.follow_up_cadence}} text from the campaign's actual
 * config, rather than a hardcoded default — this one we have real data for,
 * unlike escalation_policy/stop_policy on the Conversation Agent.
 */
function cadenceText(campaign: Campaign): string {
  const channels = campaign.channels.length ? campaign.channels.join(" → ") : "email";
  return (
    `Channel order: ${channels}. At least ${campaign.min_days_between_touches} days between touches. ` +
    `Sequence maximum: ${campaign.max_touches} touches. Widen, never narrow, the interval as the sequence progresses.`
  );
}

const DEFAULT_STOP_RULES =
  "Stop early if there has been zero recorded engagement (no opens, clicks, or replies) across at least " +
  "3 touches. Stop immediately on any suppression, unsubscribe, or two confirmed hard bounces.";

const DEFAULT_REVIVAL_POLICY =
  "Revive a paused prospect only if the dossier contains a signal that was not present when the sequence " +
  "was paused (a new funding round, a leadership change, a new hiring signal, or similar). Otherwise stop " +
  "with NO_NEW_SIGNAL.";

/**
 * The Follow-up Agent built on DronaHQ answers with a richer decision
 * (action FOLLOW_UP/WAIT/STOP/REVIVE/ESCALATE, a channel, an ISO send_at, an
 * angle, a machine-readable stop_reason, engagement_score, human_review) than
 * this codebase's FollowupDecision. The three base fields (action/wait_days/
 * reasoning) are always derived so nothing existing has to change; the richer
 * fields ride along on the optional properties added above. REVIVE is folded
 * into "follow_up" since engine.ts already treats "not stop/wait/escalate" as
 * "plan and send the next touch" — a revival is just that, after a longer gap.
 */
function normalizeFollowupDecision(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let obj = raw as Record<string, unknown>;

  // Already our shape (simulate()/direct-model paths) — pass through untouched.
  if (
    typeof obj.action === "string" &&
    ["follow_up", "wait", "stop", "escalate"].includes(obj.action) &&
    typeof obj.wait_days === "number" &&
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
      throw new Error(`DronaHQ Follow-up Agent returned unparseable text: ${text.slice(0, 200)}`);
    }
  }

  const actionRaw = String(obj.action ?? "").toUpperCase();
  if (!VALID_ACTIONS.has(actionRaw)) {
    throw new Error(
      `DronaHQ Follow-up Agent did not return a decision (got: ${JSON.stringify(obj).slice(0, 200)})`,
    );
  }

  const action: FollowupDecision["action"] =
    actionRaw === "STOP" ? "stop" : actionRaw === "WAIT" ? "wait" : actionRaw === "ESCALATE" ? "escalate" : "follow_up"; // FOLLOW_UP or REVIVE

  let waitDays = 0;
  if (action === "wait" || (action === "follow_up" && typeof obj.send_at === "string")) {
    if (typeof obj.send_at === "string") {
      const target = Date.parse(obj.send_at);
      if (Number.isFinite(target)) {
        waitDays = Math.max(0, Math.min(45, (target - Date.now()) / 86_400_000));
      }
    } else if (action === "wait") {
      waitDays = 1; // send_at missing on a WAIT verdict — fall back to a short, safe re-check rather than 0.
    }
  }

  const channelRaw = typeof obj.channel === "string" ? obj.channel.toLowerCase() : null;
  const channel = channelRaw && VALID_CHANNELS.has(channelRaw) ? (channelRaw as Channel) : undefined;

  const engagementRaw = typeof obj.engagement_score === "string" ? obj.engagement_score.toLowerCase() : null;
  const engagement_score =
    engagementRaw === "high" || engagementRaw === "medium" || engagementRaw === "zero" ? engagementRaw : undefined;

  return {
    action,
    wait_days: Number(waitDays.toFixed(1)),
    reasoning: (typeof obj.reasoning === "string" && obj.reasoning ? obj.reasoning : `${actionRaw} decision from DronaHQ`).slice(0, 300),
    channel,
    angle: typeof obj.angle === "string" && obj.angle ? obj.angle : undefined,
    stop_reason: typeof obj.stop_reason === "string" && obj.stop_reason ? obj.stop_reason : undefined,
    engagement_score,
    human_review: typeof obj.human_review === "boolean" ? obj.human_review : undefined,
    sequence_position: typeof obj.sequence_position === "number" ? obj.sequence_position : undefined,
  };
}

export async function decideFollowup(
  campaign: Campaign,
  prospect: Prospect,
  input: {
    campaignProspectId: string;
    touches: number;
    daysSinceLastTouch: number;
    everReplied: boolean;
    /** Full outbound+inbound history for this prospect. See engine.ts phaseOutreach. */
    touchHistory: string;
    emailInvalid: boolean;
    /** blocked_reason from campaign_prospects, if this cycle follows a converse.ts pause. */
    pausedReason: string | null;
    research: ResearchOutput | null;
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
    // Named fields for the DronaHQ agent's {{variable.*}} bindings.
    variables: (ctx: AgentContext) => ({
      campaign_name: campaign.icp_name,
      prompt_version: ctx.harness.prompt_version_id,
      follow_up_cadence: cadenceText(campaign),
      stop_rules: DEFAULT_STOP_RULES,
      revival_policy: DEFAULT_REVIVAL_POLICY,
    }),
    normalize: normalizeFollowupDecision,
    buildPrompt: ({ knowledge }) => `Decide whether to follow up with this prospect.

Campaign policy: max ${campaign.max_touches} touches, at least ${campaign.min_days_between_touches} days apart
Touches so far:  ${input.touches}
Days since last: ${input.daysSinceLastTouch.toFixed(1)}
Ever replied:    ${input.everReplied ? "yes" : "no"}
Email flagged invalid (prior bounce): ${input.emailInvalid ? "yes" : "no"}
Paused/blocked reason from last cycle, if any: ${input.pausedReason ?? "(none)"}

Engagement data (opens, clicks, profile views): not tracked by this system.
Treat engagement_score as unavailable — null, not zero — and flag human_review
per your own rule; never estimate it from silence.

Touch history, oldest first (channel and content, so you can tell whether an
angle has already been used):
${input.touchHistory}

Dossier signals available for a new angle or a revival check:
${input.research ? JSON.stringify({ signals: input.research.signals, pain_hypotheses: input.research.pain_hypotheses, personalisation_hooks: input.research.personalisation_hooks, role_summary: input.research.role_summary }) : "(no research on file)"}

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
