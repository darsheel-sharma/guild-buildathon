import { getDb } from "@/core/db/client";
import { logEvent } from "@/core/platform/events";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Human-in-the-loop decisions. Approving a queued message releases it into the
 * outreach queue; approving a meeting moves the prospect to opportunity;
 * rejecting stops the sequence. The decision and the decider are recorded.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const actor = actorFrom(request);
    const body = await jsonBody<{ decision?: string }>(request);
    const decision = body.decision;
    if (decision !== "approved" && decision !== "rejected") {
      return bad("decision must be 'approved' or 'rejected'");
    }

    const db = await getDb();
    const { rows } = await db.query<{
      campaign_id: string;
      campaign_prospect_id: string | null;
      kind: string;
      status: string;
    }>(`SELECT campaign_id, campaign_prospect_id, kind, status FROM approvals WHERE id = $1`, [id]);
    const approval = rows[0];
    if (!approval) return bad("approval not found", 404);
    if (approval.status !== "pending") return bad("approval already decided", 409);

    await db.query(
      `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
      [id, decision, actor],
    );

    const cpId = approval.campaign_prospect_id;
    if (cpId) {
      if (decision === "rejected") {
        await db.query(
          `UPDATE campaign_prospects
              SET stage = 'stopped', next_action = NULL, blocked_reason = $2, updated_at = now()
            WHERE id = $1`,
          [cpId, `${approval.kind} rejected by ${actor}`],
        );
      } else if (approval.kind === "book_meeting") {
        await db.query(
          `UPDATE campaign_prospects
              SET stage = 'opportunity', next_action = NULL, outcome = 'meeting_booked',
                  updated_at = now()
            WHERE id = $1`,
          [cpId],
        );
      } else if (approval.kind === "qualification") {
        await db.query(
          `UPDATE campaign_prospects
              SET stage = 'qualified', icp_verdict = 'qualified', next_action = 'outreach',
                  updated_at = now()
            WHERE id = $1`,
          [cpId],
        );
      } else {
        // An approved outbound draft goes back into the outreach queue, where
        // the next tick picks it up and sends it.
        await db.query(
          `UPDATE campaign_prospects SET next_action = 'outreach', updated_at = now()
            WHERE id = $1`,
          [cpId],
        );
      }
    }

    await logEvent({
      campaignId: approval.campaign_id,
      level: "action",
      type: `approval.${decision}`,
      message: `${actor} ${decision} a ${approval.kind.replace(/_/g, " ")} request`,
      data: { kind: approval.kind },
    });

    return ok({ status: decision });
  } catch (err) {
    return failed(err, "approval decision");
  }
}
