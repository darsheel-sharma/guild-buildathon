/**
 * Campaign read/write for the control plane.
 *
 * All numeric coercion lives here: `pg` returns `numeric` columns as strings
 * while PGlite returns numbers, so every consumer above this layer would
 * otherwise have to guess. Campaign objects leave this module fully typed.
 */
import { getDb } from "@/core/db/client";
import { AGENT_KEYS, CHANNELS, type Campaign, type CampaignStatus, type Channel } from "@/core/types";
import { logEvent } from "./events";

type Raw = Record<string, unknown>;

function normalise(row: Raw): Campaign {
  const asArray = (v: unknown): string[] =>
    Array.isArray(v) ? (v as string[]) : typeof v === "string" ? (JSON.parse(v) as string[]) : [];
  const asObject = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : typeof v === "string" ? JSON.parse(v) : {};

  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    owner: String(row.owner),
    status: row.status as CampaignStatus,
    icp_name: String(row.icp_name ?? ""),
    geography: String(row.geography ?? ""),
    objective: String(row.objective ?? ""),
    target_roles: asArray(row.target_roles),
    company_criteria: asObject(row.company_criteria),
    exclusion_criteria: asArray(row.exclusion_criteria),
    channels: asArray(row.channels) as Channel[],
    daily_send_limit: Number(row.daily_send_limit),
    min_days_between_touches: Number(row.min_days_between_touches),
    max_touches: Number(row.max_touches),
    qualification_threshold: Number(row.qualification_threshold),
    autonomy: row.autonomy as Campaign["autonomy"],
    conflict_policy: row.conflict_policy as Campaign["conflict_policy"],
    variant_of: (row.variant_of as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const db = await getDb();
  const { rows } = await db.query<Raw>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  return rows[0] ? normalise(rows[0]) : null;
}

export async function listCampaigns(includeArchived = false): Promise<Campaign[]> {
  const db = await getDb();
  const { rows } = await db.query<Raw>(
    `SELECT * FROM campaigns
      ${includeArchived ? "" : "WHERE status <> 'archived'"}
      ORDER BY CASE status
                 WHEN 'live' THEN 0 WHEN 'paused' THEN 1
                 WHEN 'draft' THEN 2 ELSE 3 END,
               created_at`,
  );
  return rows.map(normalise);
}

export async function listLiveCampaignIds(): Promise<string[]> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM campaigns WHERE status = 'live' ORDER BY created_at`,
  );
  return rows.map((r) => r.id);
}

export interface CampaignInput {
  name: string;
  description?: string;
  owner: string;
  icp_name: string;
  geography: string;
  objective: string;
  target_roles: string[];
  company_criteria: Record<string, unknown>;
  exclusion_criteria: string[];
  channels: Channel[];
  daily_send_limit?: number;
  min_days_between_touches?: number;
  max_touches?: number;
  qualification_threshold?: number;
  autonomy?: Campaign["autonomy"];
  conflict_policy?: Campaign["conflict_policy"];
  variant_of?: string | null;
}

export async function createCampaign(input: CampaignInput, id?: string): Promise<Campaign> {
  const db = await getDb();
  const campaignId = id ?? crypto.randomUUID();
  await db.query(
    `INSERT INTO campaigns
       (id, name, description, owner, status, icp_name, geography, objective,
        target_roles, company_criteria, exclusion_criteria, channels,
        daily_send_limit, min_days_between_touches, max_touches,
        qualification_threshold, autonomy, conflict_policy, variant_of)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      campaignId,
      input.name,
      input.description ?? "",
      input.owner,
      input.icp_name,
      input.geography,
      input.objective,
      JSON.stringify(input.target_roles),
      JSON.stringify(input.company_criteria),
      JSON.stringify(input.exclusion_criteria),
      JSON.stringify(input.channels),
      input.daily_send_limit ?? 40,
      input.min_days_between_touches ?? 3,
      input.max_touches ?? 4,
      input.qualification_threshold ?? 0.6,
      input.autonomy ?? "auto",
      input.conflict_policy ?? "first_touch_wins",
      input.variant_of ?? null,
    ],
  );

  // Pause rows exist for every agent and channel from the start, so the UI has
  // something concrete to toggle and the gate has a row to read.
  for (const agent of AGENT_KEYS) {
    await db.query(
      `INSERT INTO campaign_agent_state (campaign_id, agent_key, paused)
       VALUES ($1, $2, false) ON CONFLICT DO NOTHING`,
      [campaignId, agent],
    );
  }
  for (const channel of CHANNELS) {
    await db.query(
      `INSERT INTO campaign_channel_state (campaign_id, channel, paused)
       VALUES ($1, $2, false) ON CONFLICT DO NOTHING`,
      [campaignId, channel],
    );
  }

  await logEvent({
    campaignId,
    level: "action",
    type: "campaign.created",
    message: `Campaign "${input.name}" created as draft by ${input.owner}`,
    data: { icp: input.icp_name },
  });

  const created = await getCampaign(campaignId);
  if (!created) throw new Error("campaign insert did not round-trip");
  return created;
}

const EDITABLE = new Set([
  "name",
  "description",
  "icp_name",
  "geography",
  "objective",
  "daily_send_limit",
  "min_days_between_touches",
  "max_touches",
  "qualification_threshold",
  "autonomy",
  "conflict_policy",
]);
const EDITABLE_JSON = new Set([
  "target_roles",
  "company_criteria",
  "exclusion_criteria",
  "channels",
]);

export async function updateCampaign(
  id: string,
  patch: Record<string, unknown>,
  actor: string,
): Promise<Campaign | null> {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (EDITABLE.has(key)) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    } else if (EDITABLE_JSON.has(key)) {
      params.push(JSON.stringify(value));
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (!sets.length) return getCampaign(id);

  params.push(id);
  await db.query(
    `UPDATE campaigns SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );
  await logEvent({
    campaignId: id,
    level: "action",
    type: "campaign.updated",
    message: `${actor} updated ${Object.keys(patch).filter((k) => EDITABLE.has(k) || EDITABLE_JSON.has(k)).join(", ")}`,
    data: { patch },
  });
  return getCampaign(id);
}

/** Lifecycle transitions the control plane permits. */
const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["live", "archived"],
  live: ["paused", "completed", "archived"],
  paused: ["live", "completed", "archived"],
  completed: ["archived", "live"],
  archived: [],
};

export async function setStatus(
  id: string,
  next: CampaignStatus,
  actor: string,
): Promise<{ ok: boolean; error?: string; campaign?: Campaign }> {
  const campaign = await getCampaign(id);
  if (!campaign) return { ok: false, error: "campaign not found" };
  if (campaign.status === next) return { ok: true, campaign };

  if (!TRANSITIONS[campaign.status].includes(next)) {
    return { ok: false, error: `cannot go from ${campaign.status} to ${next}` };
  }
  // A draft has never been reviewed; refusing to activate an unconfigured one
  // is cheaper than recalling the outreach it would send.
  if (next === "live") {
    const problems = await activationBlockers(campaign);
    if (problems.length) return { ok: false, error: problems.join("; ") };
  }

  const db = await getDb();
  await db.query(`UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2`, [next, id]);
  await logEvent({
    campaignId: id,
    level: next === "paused" ? "warn" : "action",
    type: `campaign.${next}`,
    message: `${actor} moved "${campaign.name}" from ${campaign.status} to ${next}`,
    data: { from: campaign.status, to: next },
  });
  return { ok: true, campaign: (await getCampaign(id)) ?? undefined };
}

/** Pre-flight checks shown on the dashboard before a campaign can go live. */
export async function activationBlockers(campaign: Campaign): Promise<string[]> {
  const db = await getDb();
  const problems: string[] = [];

  if (!campaign.channels.length) problems.push("no channels enabled");
  if (!campaign.target_roles.length) problems.push("no target roles set");

  const { rows: prompts } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM prompt_versions
      WHERE campaign_id = $1 AND scope = 'campaign' AND active`,
    [campaign.id],
  );
  if (!prompts[0]?.n) problems.push("no active campaign system prompt");

  const { rows: knowledge } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM knowledge_chunks
      WHERE campaign_id = $1 OR campaign_id IS NULL`,
    [campaign.id],
  );
  if (!knowledge[0]?.n) problems.push("knowledge base is empty");

  const { rows: reps } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM campaign_reps cr
       JOIN reps r ON r.id = cr.rep_id
      WHERE cr.campaign_id = $1 AND cr.is_sending_identity AND r.active`,
    [campaign.id],
  );
  if (!reps[0]?.n) problems.push("no active sending identity assigned");

  return problems;
}

/** The sending identity outreach goes out as. */
export async function sendingIdentity(campaignId: string): Promise<{
  name: string;
  email: string;
  title: string;
}> {
  const db = await getDb();
  const { rows } = await db.query<{ name: string; email: string; title: string }>(
    `SELECT r.name, r.email, r.title
       FROM campaign_reps cr JOIN reps r ON r.id = cr.rep_id
      WHERE cr.campaign_id = $1 AND cr.is_sending_identity AND r.active
      LIMIT 1`,
    [campaignId],
  );
  return rows[0] ?? { name: "the team", email: "sdr@example.com", title: "Sales Development" };
}
