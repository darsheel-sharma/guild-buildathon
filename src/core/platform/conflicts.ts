/**
 * Cross-campaign outreach guard.
 *
 * This is the check no single campaign can perform for itself: a prospect
 * belongs to the platform, so only the platform can see that two live
 * campaigns are both about to email the same person today. Every outbound
 * touch passes through `checkBeforeContact` first.
 *
 * Outcomes are one of:
 *   allow  — proceed
 *   defer  — legitimate target, wrong moment (frequency cap, daily limit)
 *   block  — must not be contacted by this campaign (suppressed, lost the
 *            duplicate-outreach tie-break, or sequence exhausted)
 */
import { getDb } from "@/core/db/client";
import { logEvent } from "./events";

export type Verdict = "allow" | "defer" | "block";

export interface ContactDecision {
  verdict: Verdict;
  reason:
    | "ok"
    | "suppressed"
    | "duplicate_outreach"
    | "frequency_cap"
    | "daily_limit"
    | "sequence_exhausted";
  detail: string;
  /** When deferring, the earliest sensible retry. */
  retryAt?: string;
}

async function recordConflict(input: {
  prospectId: string;
  campaignId: string;
  otherCampaignId: string | null;
  kind: string;
  resolution: string;
  detail: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO conflicts
       (id, prospect_id, campaign_id, other_campaign_id, kind, resolution, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(),
      input.prospectId,
      input.campaignId,
      input.otherCampaignId,
      input.kind,
      input.resolution,
      input.detail,
    ],
  );
}

export async function checkBeforeContact(opts: {
  campaignId: string;
  prospectId: string;
  /**
   * 'cold' runs every check. 'reply' is answering a message the prospect sent,
   * so the duplicate-outreach tie-break, the cadence gap and the sequence
   * budget do not apply — but an opt-out and the daily budget still do.
   */
  context?: "cold" | "reply";
}): Promise<ContactDecision> {
  const db = await getDb();
  const context = opts.context ?? "cold";

  const { rows: cfgRows } = await db.query<{
    name: string;
    conflict_policy: string;
    daily_send_limit: number;
    min_days_between_touches: number;
    max_touches: number;
    created_at: string;
  }>(
    `SELECT name, conflict_policy, daily_send_limit, min_days_between_touches,
            max_touches, created_at
       FROM campaigns WHERE id = $1`,
    [opts.campaignId],
  );
  const cfg = cfgRows[0];
  if (!cfg) return { verdict: "block", reason: "ok", detail: "campaign not found" };

  // 1. Global do-not-contact. Always wins, regardless of campaign config.
  const { rows: suppressed } = await db.query<{ reason: string }>(
    `SELECT s.reason
       FROM suppression_list s
       JOIN prospects p ON p.email = s.email
      WHERE p.id = $1`,
    [opts.prospectId],
  );
  if (suppressed[0]) {
    await recordConflict({
      prospectId: opts.prospectId,
      campaignId: opts.campaignId,
      otherCampaignId: null,
      kind: "suppressed",
      resolution: "blocked",
      detail: suppressed[0].reason,
    });
    return {
      verdict: "block",
      reason: "suppressed",
      detail: `on the global do-not-contact list (${suppressed[0].reason})`,
    };
  }

  // 2. This campaign's own sequence budget. Cold outreach only — a reply is
  //     part of a conversation, not another step in the sequence.
  const { rows: mine } = context === "cold"
    ? await db.query<{
    touches: number;
    last_touch_at: string | null;
  }>(
        `SELECT touches, last_touch_at FROM campaign_prospects
          WHERE campaign_id = $1 AND prospect_id = $2`,
        [opts.campaignId, opts.prospectId],
      )
    : { rows: [] };
  if (mine[0] && mine[0].touches >= cfg.max_touches) {
    return {
      verdict: "block",
      reason: "sequence_exhausted",
      detail: `${mine[0].touches} of ${cfg.max_touches} touches already used`,
    };
  }

  // 3. Same prospect, another campaign. `created_at` is the tie-break for
  //    first_touch_wins: the campaign that started the relationship keeps it.
  const { rows: others } = context === "cold"
    ? await db.query<{
    campaign_id: string;
    name: string;
    touches: number;
    last_touch_at: string | null;
    status: string;
    created_at: string;
  }>(
    `SELECT cp.campaign_id, c.name, cp.touches, cp.last_touch_at, c.status, cp.created_at
       FROM campaign_prospects cp
       JOIN campaigns c ON c.id = cp.campaign_id
      WHERE cp.prospect_id = $1
        AND cp.campaign_id <> $2
        AND cp.touches > 0
        AND c.status IN ('live', 'paused')
      ORDER BY cp.last_touch_at DESC NULLS LAST`,
        [opts.prospectId, opts.campaignId],
      )
    : { rows: [] };

  if (context === "cold" && others.length) {
    const other = others[0];
    if (cfg.conflict_policy === "first_touch_wins") {
      await recordConflict({
        prospectId: opts.prospectId,
        campaignId: opts.campaignId,
        otherCampaignId: other.campaign_id,
        kind: "duplicate_outreach",
        resolution: "blocked_first_touch_wins",
        detail: `${other.name} contacted this prospect first`,
      });
      await logEvent({
        campaignId: opts.campaignId,
        level: "warn",
        type: "conflict.duplicate_outreach",
        message: `Skipped a prospect already in outreach from ${other.name}`,
        data: { policy: cfg.conflict_policy, otherCampaign: other.name },
      });
      return {
        verdict: "block",
        reason: "duplicate_outreach",
        detail: `already in outreach from ${other.name} (policy: first touch wins)`,
      };
    }

    // allow_both / priority_campaign still record the collision so a manager
    // can see how often campaigns are stepping on each other.
    await recordConflict({
      prospectId: opts.prospectId,
      campaignId: opts.campaignId,
      otherCampaignId: other.campaign_id,
      kind: "duplicate_outreach",
      resolution: `allowed_${cfg.conflict_policy}`,
      detail: `also in outreach from ${other.name}`,
    });
  }

  // 4. Contact frequency across every campaign. A prospect does not care which
  //    campaign the message came from, so the cap is measured platform-wide.
  const { rows: freq } = await db.query<{ last: string | null }>(
    `SELECT MAX(m.created_at) AS last
       FROM messages m
       JOIN campaign_prospects cp ON cp.id = m.campaign_prospect_id
      WHERE cp.prospect_id = $1 AND m.direction = 'outbound'`,
    [opts.prospectId],
  );
  const last = freq[0]?.last ? new Date(freq[0].last) : null;
  if (context === "cold" && last) {
    const days = (Date.now() - last.getTime()) / 86_400_000;
    if (days < cfg.min_days_between_touches) {
      const retryAt = new Date(
        last.getTime() + cfg.min_days_between_touches * 86_400_000,
      ).toISOString();
      return {
        verdict: "defer",
        reason: "frequency_cap",
        detail: `last contacted ${days.toFixed(1)}d ago, cap is ${cfg.min_days_between_touches}d`,
        retryAt,
      };
    }
  }

  // 5. Campaign daily send budget.
  const { rows: today } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM messages
      WHERE campaign_id = $1 AND direction = 'outbound'
        AND created_at >= date_trunc('day', now())`,
    [opts.campaignId],
  );
  if ((today[0]?.n ?? 0) >= cfg.daily_send_limit) {
    return {
      verdict: "defer",
      reason: "daily_limit",
      detail: `daily send limit of ${cfg.daily_send_limit} reached`,
      retryAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  return { verdict: "allow", reason: "ok", detail: "" };
}

export interface ConflictRow {
  id: string;
  kind: string;
  resolution: string;
  detail: string;
  created_at: string;
  prospect_name: string;
  prospect_email: string;
  other_campaign: string | null;
}

export async function listConflicts(campaignId: string, limit = 20): Promise<ConflictRow[]> {
  const db = await getDb();
  const { rows } = await db.query<ConflictRow>(
    `SELECT k.id, k.kind, k.resolution, k.detail, k.created_at,
            p.full_name AS prospect_name, p.email AS prospect_email,
            o.name AS other_campaign
       FROM conflicts k
       JOIN prospects p ON p.id = k.prospect_id
       LEFT JOIN campaigns o ON o.id = k.other_campaign_id
      WHERE k.campaign_id = $1
      ORDER BY k.created_at DESC
      LIMIT $2`,
    [campaignId, limit],
  );
  return rows;
}
