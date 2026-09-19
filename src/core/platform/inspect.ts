/**
 * Read models for the campaign dashboard.
 *
 * Separate from metrics.ts on purpose: metrics answers "how is this campaign
 * performing", this answers "what exactly did the agents do, to whom, and
 * under which configuration". The second question is the one a manager asks
 * when something looks wrong.
 */
import { getDb } from "@/core/db/client";

export interface RunRow {
  id: string;
  agent_key: string;
  status: string;
  summary: string;
  mode: string;
  model: string;
  cost_usd: string | number;
  latency_ms: number;
  harness_hash: string;
  created_at: string;
  prospect_name: string | null;
  prompt_scope: string | null;
  prompt_version: number | null;
  retrieved: { title: string; kind: string; similarity: number }[] | string;
  error: string | null;
}

/** Newest agent runs, each joined to the prompt version that produced it. */
export async function recentRuns(campaignId: string, limit = 25): Promise<RunRow[]> {
  const db = await getDb();
  const { rows } = await db.query<RunRow>(
    `SELECT r.id, r.agent_key, r.status, r.summary, r.mode, r.model, r.cost_usd,
            r.latency_ms, r.harness_hash, r.created_at, r.retrieved, r.error,
            p.full_name AS prospect_name,
            v.scope AS prompt_scope, v.version AS prompt_version
       FROM agent_runs r
       LEFT JOIN campaign_prospects cp ON cp.id = r.campaign_prospect_id
       LEFT JOIN prospects p ON p.id = cp.prospect_id
       LEFT JOIN prompt_versions v ON v.id = r.prompt_version_id
      WHERE r.campaign_id = $1
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2`,
    [campaignId, limit],
  );
  return rows;
}

export interface ThreadMessage {
  id: string;
  direction: string;
  channel: string;
  subject: string;
  body: string;
  sentiment: string | null;
  intent: string | null;
  provider: string;
  created_at: string;
}

export interface Thread {
  cpId: string;
  prospect: string;
  title: string;
  company: string;
  stage: string;
  messages: ThreadMessage[];
}

/**
 * Conversations, newest activity first. One thread per prospect across every
 * channel — a LinkedIn message and a phone call sit in the same thread, which
 * is what makes it read as one SDR rather than four tools.
 */
export async function threads(campaignId: string, limit = 6): Promise<Thread[]> {
  const db = await getDb();
  const { rows } = await db.query<{
    cp_id: string;
    full_name: string;
    title: string;
    company: string;
    stage: string;
  }>(
    `SELECT cp.id AS cp_id, p.full_name, p.title, p.company, cp.stage
       FROM campaign_prospects cp
       JOIN prospects p ON p.id = cp.prospect_id
      WHERE cp.campaign_id = $1
        AND EXISTS (SELECT 1 FROM messages m WHERE m.campaign_prospect_id = cp.id)
      ORDER BY (SELECT MAX(m.created_at) FROM messages m WHERE m.campaign_prospect_id = cp.id) DESC
      LIMIT $2`,
    [campaignId, limit],
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.cp_id);
  const { rows: messages } = await db.query<ThreadMessage & { campaign_prospect_id: string }>(
    `SELECT id, campaign_prospect_id, direction, channel, subject, body, sentiment,
            intent, provider, created_at
       FROM messages
      WHERE campaign_prospect_id = ANY($1)
      ORDER BY created_at ASC`,
    [ids],
  );

  return rows.map((r) => ({
    cpId: r.cp_id,
    prospect: r.full_name,
    title: r.title,
    company: r.company,
    stage: r.stage,
    messages: messages.filter((m) => m.campaign_prospect_id === r.cp_id),
  }));
}

export interface ApprovalRow {
  id: string;
  kind: string;
  reason: string;
  payload: Record<string, unknown> | string;
  created_at: string;
  prospect_name: string | null;
}

export async function pendingApprovals(campaignId: string): Promise<ApprovalRow[]> {
  const db = await getDb();
  const { rows } = await db.query<ApprovalRow>(
    `SELECT a.id, a.kind, a.reason, a.payload, a.created_at, p.full_name AS prospect_name
       FROM approvals a
       LEFT JOIN campaign_prospects cp ON cp.id = a.campaign_prospect_id
       LEFT JOIN prospects p ON p.id = cp.prospect_id
      WHERE a.campaign_id = $1 AND a.status = 'pending'
      ORDER BY a.created_at ASC`,
    [campaignId],
  );
  return rows;
}

export interface ProspectRow {
  cp_id: string;
  full_name: string;
  title: string;
  company: string;
  geography: string;
  employee_count: number;
  stage: string;
  icp_score: string | number | null;
  icp_verdict: string | null;
  icp_reasons: string[] | string;
  touches: number;
  last_channel: string | null;
  blocked_reason: string | null;
  updated_at: string;
}

export async function prospectRows(campaignId: string, limit = 40): Promise<ProspectRow[]> {
  const db = await getDb();
  const { rows } = await db.query<ProspectRow>(
    `SELECT cp.id AS cp_id, p.full_name, p.title, p.company, p.geography, p.employee_count,
            cp.stage, cp.icp_score, cp.icp_verdict, cp.icp_reasons, cp.touches,
            cp.last_channel, cp.blocked_reason, cp.updated_at
       FROM campaign_prospects cp
       JOIN prospects p ON p.id = cp.prospect_id
      WHERE cp.campaign_id = $1
      ORDER BY
        CASE cp.stage
          WHEN 'opportunity' THEN 0 WHEN 'meeting' THEN 1 WHEN 'engaged' THEN 2
          WHEN 'contacted' THEN 3 WHEN 'qualified' THEN 4 WHEN 'researched' THEN 5
          WHEN 'discovered' THEN 6 ELSE 7 END,
        cp.icp_score DESC NULLS LAST
      LIMIT $2`,
    [campaignId, limit],
  );
  return rows;
}

export interface RepRow {
  id: string;
  name: string;
  email: string;
  title: string;
  timezone: string;
  daily_limit: number;
  working_hours: string;
  active: boolean;
  is_sending_identity: boolean;
  other_campaigns: number;
}

export async function campaignReps(campaignId: string): Promise<RepRow[]> {
  const db = await getDb();
  const { rows } = await db.query<RepRow>(
    `SELECT r.id, r.name, r.email, r.title, r.timezone, r.daily_limit, r.working_hours,
            r.active, cr.is_sending_identity,
            (SELECT COUNT(*)::int - 1 FROM campaign_reps x WHERE x.rep_id = r.id) AS other_campaigns
       FROM campaign_reps cr JOIN reps r ON r.id = cr.rep_id
      WHERE cr.campaign_id = $1
      ORDER BY cr.is_sending_identity DESC, r.name`,
    [campaignId],
  );
  return rows;
}
