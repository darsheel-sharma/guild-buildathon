/**
 * Everything the dashboards read.
 *
 * All figures are derived from the execution tables — there are no counter
 * columns to drift out of sync. Cost per qualified lead and cost per meeting
 * come from the same `agent_runs` rows the audit trail uses, so the economics
 * shown are the economics that happened.
 */
import { getDb } from "@/core/db/client";
import { AGENT_KEYS, CHANNELS, STAGES, type AgentKey, type Channel, type Stage } from "@/core/types";

export interface Funnel {
  discovered: number;
  researched: number;
  qualified: number;
  contacted: number;
  engaged: number;
  meeting: number;
  opportunity: number;
  rejected: number;
  stopped: number;
}

export interface ChannelActivity {
  channel: Channel;
  outbound: number;
  inbound: number;
}

export interface AgentActivity {
  agent: AgentKey;
  completed: number;
  degraded: number;
  skipped: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface CampaignMetrics {
  funnel: Funnel;
  /** Cumulative funnel: how many prospects reached each stage or beyond. */
  funnelReached: Record<Stage, number>;
  channels: ChannelActivity[];
  agents: AgentActivity[];
  totals: {
    prospects: number;
    outreach: number;
    replies: number;
    positiveReplies: number;
    meetings: number;
    opportunities: number;
    pendingApprovals: number;
    conflicts: number;
    costUsd: number;
    liveRuns: number;
    simulatedRuns: number;
  };
  rates: {
    replyRate: number;
    positiveRate: number;
    meetingRate: number;
    qualificationRate: number;
    costPerQualified: number;
    costPerMeeting: number;
  };
}

/** Stage order index, used to compute "reached this stage or beyond". */
const ORDER: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s, i]));

export async function campaignMetrics(campaignId: string): Promise<CampaignMetrics> {
  const db = await getDb();

  const [stageRows, channelRows, agentRows, replyRows, extras] = await Promise.all([
    db.query<{ stage: string; n: number }>(
      `SELECT stage, COUNT(*)::int AS n FROM campaign_prospects
        WHERE campaign_id = $1 GROUP BY stage`,
      [campaignId],
    ),
    db.query<{ channel: string; direction: string; n: number }>(
      `SELECT channel, direction, COUNT(*)::int AS n FROM messages
        WHERE campaign_id = $1 GROUP BY channel, direction`,
      [campaignId],
    ),
    db.query<{
      agent_key: string;
      status: string;
      n: number;
      cost: string | number;
      latency: string | number;
      mode: string;
    }>(
      `SELECT agent_key, status, mode, COUNT(*)::int AS n,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(AVG(latency_ms), 0) AS latency
         FROM agent_runs WHERE campaign_id = $1
        GROUP BY agent_key, status, mode`,
      [campaignId],
    ),
    db.query<{ sentiment: string | null; n: number }>(
      `SELECT sentiment, COUNT(*)::int AS n FROM messages
        WHERE campaign_id = $1 AND direction = 'inbound' GROUP BY sentiment`,
      [campaignId],
    ),
    db.query<{ approvals: number; conflicts: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM approvals
           WHERE campaign_id = $1 AND status = 'pending') AS approvals,
         (SELECT COUNT(*)::int FROM conflicts WHERE campaign_id = $1) AS conflicts`,
      [campaignId],
    ),
  ]);

  const stageCounts = new Map(stageRows.rows.map((r) => [r.stage, Number(r.n)]));
  const at = (stage: string) => stageCounts.get(stage) ?? 0;

  const funnel: Funnel = {
    discovered: at("discovered"),
    researched: at("researched"),
    qualified: at("qualified"),
    contacted: at("contacted"),
    engaged: at("engaged"),
    meeting: at("meeting"),
    opportunity: at("opportunity"),
    rejected: at("rejected"),
    stopped: at("stopped"),
  };

  // A prospect sitting at 'engaged' has also been discovered, researched,
  // qualified and contacted — the funnel chart needs the cumulative view.
  // `rejected` and `stopped` still count toward the stages they passed, which
  // is why they are tracked separately rather than folded into the ladder.
  const funnelReached = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const [stage, count] of stageCounts) {
    const idx = ORDER[stage];
    if (idx === undefined) {
      // Terminal stage: it reached at least 'researched' (rejected) or
      // 'contacted' (stopped) before exiting.
      const floor = stage === "rejected" ? ORDER.researched : ORDER.contacted;
      for (let i = 0; i <= floor; i++) funnelReached[STAGES[i]] += count;
      continue;
    }
    for (let i = 0; i <= idx; i++) funnelReached[STAGES[i]] += count;
  }

  const channels: ChannelActivity[] = CHANNELS.map((channel) => ({
    channel,
    outbound: Number(
      channelRows.rows.find((r) => r.channel === channel && r.direction === "outbound")?.n ?? 0,
    ),
    inbound: Number(
      channelRows.rows.find((r) => r.channel === channel && r.direction === "inbound")?.n ?? 0,
    ),
  }));

  const agents: AgentActivity[] = AGENT_KEYS.map((agent) => {
    const mine = agentRows.rows.filter((r) => r.agent_key === agent);
    const sum = (status: string) =>
      mine.filter((r) => r.status === status).reduce((acc, r) => acc + Number(r.n), 0);
    const cost = mine.reduce((acc, r) => acc + Number(r.cost), 0);
    const runs = mine.reduce((acc, r) => acc + Number(r.n), 0);
    const latency = runs
      ? mine.reduce((acc, r) => acc + Number(r.latency) * Number(r.n), 0) / runs
      : 0;
    return {
      agent,
      completed: sum("completed"),
      degraded: sum("degraded"),
      skipped: sum("skipped"),
      costUsd: cost,
      avgLatencyMs: Math.round(latency),
    };
  });

  const outreach = channels.reduce((acc, c) => acc + c.outbound, 0);
  const replies = channels.reduce((acc, c) => acc + c.inbound, 0);
  const positiveReplies = Number(replyRows.rows.find((r) => r.sentiment === "positive")?.n ?? 0);
  const costUsd = agents.reduce((acc, a) => acc + a.costUsd, 0);
  const prospects = [...stageCounts.values()].reduce((a, b) => a + b, 0);
  const qualifiedEver = funnelReached.qualified;
  const meetings = funnel.meeting + funnel.opportunity;

  const liveRuns = agentRows.rows
    .filter((r) => r.mode === "live")
    .reduce((acc, r) => acc + Number(r.n), 0);
  const simulatedRuns = agentRows.rows
    .filter((r) => r.mode === "simulated")
    .reduce((acc, r) => acc + Number(r.n), 0);

  const ratio = (num: number, den: number) => (den > 0 ? num / den : 0);

  return {
    funnel,
    funnelReached,
    channels,
    agents,
    totals: {
      prospects,
      outreach,
      replies,
      positiveReplies,
      meetings,
      opportunities: funnel.opportunity,
      pendingApprovals: Number(extras.rows[0]?.approvals ?? 0),
      conflicts: Number(extras.rows[0]?.conflicts ?? 0),
      costUsd,
      liveRuns,
      simulatedRuns,
    },
    rates: {
      replyRate: ratio(replies, outreach),
      positiveRate: ratio(positiveReplies, replies),
      meetingRate: ratio(meetings, outreach),
      qualificationRate: ratio(qualifiedEver, prospects),
      costPerQualified: ratio(costUsd, qualifiedEver),
      costPerMeeting: ratio(costUsd, meetings),
    },
  };
}

export interface OverviewRow {
  id: string;
  name: string;
  icp_name: string;
  status: string;
  owner: string;
  channels: string[];
  autonomy: string;
  variant_of: string | null;
  prospects: number;
  outreach: number;
  replies: number;
  meetings: number;
  qualified: number;
  costUsd: number;
  pendingApprovals: number;
  lastActivity: string | null;
}

/** One row per campaign for the all-campaigns view. */
export async function overview(): Promise<OverviewRow[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT c.id, c.name, c.icp_name, c.status, c.owner, c.channels, c.autonomy, c.variant_of,
            (SELECT COUNT(*)::int FROM campaign_prospects cp WHERE cp.campaign_id = c.id) AS prospects,
            (SELECT COUNT(*)::int FROM campaign_prospects cp
              WHERE cp.campaign_id = c.id
                AND cp.stage IN ('qualified','contacted','engaged','meeting','opportunity')) AS qualified,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.campaign_id = c.id AND m.direction = 'outbound') AS outreach,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.campaign_id = c.id AND m.direction = 'inbound') AS replies,
            (SELECT COUNT(*)::int FROM campaign_prospects cp
              WHERE cp.campaign_id = c.id AND cp.stage IN ('meeting','opportunity')) AS meetings,
            (SELECT COALESCE(SUM(r.cost_usd), 0) FROM agent_runs r WHERE r.campaign_id = c.id) AS cost,
            (SELECT COUNT(*)::int FROM approvals a
              WHERE a.campaign_id = c.id AND a.status = 'pending') AS approvals,
            (SELECT MAX(r.created_at) FROM agent_runs r WHERE r.campaign_id = c.id) AS last_activity
       FROM campaigns c
      WHERE c.status <> 'archived'
      ORDER BY CASE c.status
                 WHEN 'live' THEN 0 WHEN 'paused' THEN 1
                 WHEN 'draft' THEN 2 ELSE 3 END, c.created_at`,
  );

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    icp_name: String(r.icp_name),
    status: String(r.status),
    owner: String(r.owner),
    channels: Array.isArray(r.channels)
      ? (r.channels as string[])
      : JSON.parse(String(r.channels ?? "[]")),
    autonomy: String(r.autonomy),
    variant_of: (r.variant_of as string | null) ?? null,
    prospects: Number(r.prospects),
    outreach: Number(r.outreach),
    replies: Number(r.replies),
    meetings: Number(r.meetings),
    qualified: Number(r.qualified),
    costUsd: Number(r.cost),
    pendingApprovals: Number(r.approvals),
    lastActivity: r.last_activity ? String(r.last_activity) : null,
  }));
}
