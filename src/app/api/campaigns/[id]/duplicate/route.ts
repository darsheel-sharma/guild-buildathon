import { getDb } from "@/core/db/client";
import { createCampaign, getCampaign } from "@/core/platform/campaigns";
import { listVersions, saveVersion, type Scope } from "@/core/platform/prompts";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Duplicate a campaign into an A/B variant: same targeting, its own copy of
 * every active prompt, its own state. The copy starts as a draft, and the
 * prospect pool is copied so the two arms are actually comparable.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const actor = actorFrom(request);
    const body = await jsonBody<{ name?: string; overrides?: Record<string, unknown> }>(request);

    const source = await getCampaign(id);
    if (!source) return bad("campaign not found", 404);

    const overrides = body.overrides ?? {};
    const variant = await createCampaign({
      name: body.name?.trim() || `${source.name} — variant B`,
      description: `Variant of "${source.name}" for comparison.`,
      owner: source.owner,
      icp_name: source.icp_name,
      geography: source.geography,
      objective: source.objective,
      target_roles: source.target_roles,
      company_criteria: source.company_criteria,
      exclusion_criteria: source.exclusion_criteria,
      channels: (overrides.channels as typeof source.channels) ?? source.channels,
      daily_send_limit: source.daily_send_limit,
      min_days_between_touches: source.min_days_between_touches,
      max_touches: source.max_touches,
      qualification_threshold:
        (overrides.qualification_threshold as number) ?? source.qualification_threshold,
      autonomy: source.autonomy,
      conflict_policy: source.conflict_policy,
      variant_of: source.id,
    });

    // Prompts are copied, not shared. Editing the variant must never change the
    // original — that is the reason versions belong to exactly one campaign.
    for (const version of await listVersions(id)) {
      if (!version.active) continue;
      await saveVersion({
        campaignId: variant.id,
        scope: version.scope as Scope,
        content: version.content,
        note: `Copied from "${source.name}" v${version.version}`,
        author: actor,
        activate: true,
      });
    }

    const db = await getDb();
    await db.query(
      `INSERT INTO campaign_reps (campaign_id, rep_id, is_sending_identity)
       SELECT $1, rep_id, is_sending_identity FROM campaign_reps WHERE campaign_id = $2
       ON CONFLICT DO NOTHING`,
      [variant.id, id],
    );
    await db.query(
      `INSERT INTO campaign_prospects (id, campaign_id, prospect_id, stage, next_action)
       SELECT md5(random()::text || clock_timestamp()::text), $1, prospect_id, 'discovered', 'research'
         FROM campaign_prospects WHERE campaign_id = $2
       ON CONFLICT DO NOTHING`,
      [variant.id, id],
    );

    return ok({ campaign: variant });
  } catch (err) {
    return failed(err, "duplicate campaign");
  }
}
