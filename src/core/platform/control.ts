/**
 * The four levels of operational control, in one gate.
 *
 *   1. global kill switch  — stops every autonomous external action
 *   2. campaign status     — only `live` campaigns execute
 *   3. agent pause         — stops one agent, the rest of the campaign runs on
 *   4. channel pause       — stops one channel, other channels keep going
 *
 * The orchestrator calls `gate()` before each pipeline step and `canSend()`
 * again immediately before an external send. Checking twice is deliberate: a
 * manager who hits pause while a tick is mid-flight must not get one more
 * message out of the door.
 */
import { getDb } from "@/core/db/client";
import type { AgentKey, Channel } from "@/core/types";
import { logEvent } from "./events";

export interface GateDecision {
  allowed: boolean;
  /** Machine-readable reason, surfaced in the UI when a step is skipped. */
  reason?: "kill_switch" | "campaign_not_live" | "agent_paused" | "channel_paused";
  detail?: string;
}

const ALLOWED = { allowed: true } as const;

export async function isKillSwitchOn(): Promise<{ on: boolean; reason: string | null }> {
  const db = await getDb();
  const { rows } = await db.query<{ kill_switch: boolean; kill_reason: string | null }>(
    `SELECT kill_switch, kill_reason FROM platform_control WHERE id = 1`,
  );
  return { on: rows[0]?.kill_switch ?? false, reason: rows[0]?.kill_reason ?? null };
}

export async function setKillSwitch(on: boolean, reason: string, actor: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE platform_control
        SET kill_switch = $1, kill_reason = $2, updated_by = $3, updated_at = now()
      WHERE id = 1`,
    [on, on ? reason : null, actor],
  );
  await logEvent({
    level: on ? "error" : "action",
    type: on ? "kill_switch.engaged" : "kill_switch.released",
    message: on
      ? `Global kill switch engaged by ${actor}: ${reason}`
      : `Global kill switch released by ${actor}`,
    data: { actor, reason },
  });
}

export async function gate(opts: {
  campaignId: string;
  agent?: AgentKey;
  channel?: Channel;
}): Promise<GateDecision> {
  const db = await getDb();

  const kill = await isKillSwitchOn();
  if (kill.on) {
    return { allowed: false, reason: "kill_switch", detail: kill.reason ?? "platform halted" };
  }

  const { rows: campaign } = await db.query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id = $1`,
    [opts.campaignId],
  );
  const status = campaign[0]?.status;
  if (status !== "live") {
    return {
      allowed: false,
      reason: "campaign_not_live",
      detail: status ? `campaign is ${status}` : "campaign not found",
    };
  }

  if (opts.agent) {
    const { rows } = await db.query<{ paused: boolean }>(
      `SELECT paused FROM campaign_agent_state WHERE campaign_id = $1 AND agent_key = $2`,
      [opts.campaignId, opts.agent],
    );
    if (rows[0]?.paused) {
      return { allowed: false, reason: "agent_paused", detail: `${opts.agent} agent is paused` };
    }
  }

  if (opts.channel) {
    const { rows } = await db.query<{ paused: boolean }>(
      `SELECT paused FROM campaign_channel_state WHERE campaign_id = $1 AND channel = $2`,
      [opts.campaignId, opts.channel],
    );
    if (rows[0]?.paused) {
      return { allowed: false, reason: "channel_paused", detail: `${opts.channel} is paused` };
    }
  }

  return ALLOWED;
}

/** Re-checked immediately before any outbound message leaves the platform. */
export async function canSend(campaignId: string, channel: Channel): Promise<GateDecision> {
  return gate({ campaignId, channel });
}

export async function setAgentPaused(
  campaignId: string,
  agent: AgentKey,
  paused: boolean,
  actor: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO campaign_agent_state (campaign_id, agent_key, paused)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, agent_key) DO UPDATE SET paused = EXCLUDED.paused`,
    [campaignId, agent, paused],
  );
  await logEvent({
    campaignId,
    level: "action",
    type: paused ? "agent.paused" : "agent.resumed",
    message: `${agent} agent ${paused ? "paused" : "resumed"} by ${actor}`,
    data: { agent, actor },
  });
}

export async function setChannelPaused(
  campaignId: string,
  channel: Channel,
  paused: boolean,
  actor: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO campaign_channel_state (campaign_id, channel, paused)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, channel) DO UPDATE SET paused = EXCLUDED.paused`,
    [campaignId, channel, paused],
  );
  await logEvent({
    campaignId,
    level: "action",
    type: paused ? "channel.paused" : "channel.resumed",
    message: `${channel} ${paused ? "paused" : "resumed"} by ${actor}`,
    data: { channel, actor },
  });
}

export async function getPauseState(campaignId: string): Promise<{
  agents: Record<string, boolean>;
  channels: Record<string, boolean>;
}> {
  const db = await getDb();
  const [agents, channels] = await Promise.all([
    db.query<{ agent_key: string; paused: boolean }>(
      `SELECT agent_key, paused FROM campaign_agent_state WHERE campaign_id = $1`,
      [campaignId],
    ),
    db.query<{ channel: string; paused: boolean }>(
      `SELECT channel, paused FROM campaign_channel_state WHERE campaign_id = $1`,
      [campaignId],
    ),
  ]);
  return {
    agents: Object.fromEntries(agents.rows.map((r) => [r.agent_key, r.paused])),
    channels: Object.fromEntries(channels.rows.map((r) => [r.channel, r.paused])),
  };
}
