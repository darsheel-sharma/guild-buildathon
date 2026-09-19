import { getDb } from "@/core/db/client";
import { advanceCampaignClock } from "@/core/db/seed";
import { logEvent } from "@/core/platform/events";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Demo affordance, not a product feature.
 *
 * Real SDR cadence is measured in days, so after one tick every prospect is
 * correctly waiting out its follow-up gap and a reviewer sees nothing happen.
 * This backdates the campaign's own timestamps so the cadence gates open,
 * letting a multi-touch sequence be demonstrated in one sitting.
 *
 * It touches only this campaign, only timestamps, and is recorded in the event
 * log as a manual clock shift so it can never be mistaken for agent activity.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await jsonBody<{ days?: number }>(request);
    const days = Math.min(Math.max(Number(body.days ?? 3), 1), 30);

    const db = await getDb();
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM campaigns WHERE id = $1`,
      [id],
    );
    if (!rows[0]?.n) return bad("campaign not found", 404);

    await advanceCampaignClock(id, days);

    await logEvent({
      campaignId: id,
      level: "warn",
      type: "demo.clock_advanced",
      message: `${actorFrom(request)} advanced this campaign's clock by ${days} days (demo control, not agent activity)`,
      data: { days },
    });

    return ok({ days });
  } catch (err) {
    return failed(err, "advance clock");
  }
}
