import { setStatus } from "@/core/platform/campaigns";
import { CAMPAIGN_STATUSES, type CampaignStatus } from "@/core/types";
import { actorFrom, bad, failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Draft, live, paused, completed, archived. Transitions are validated in core. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await jsonBody<{ status?: string }>(request);
    const next = body.status as CampaignStatus;
    if (!CAMPAIGN_STATUSES.includes(next)) {
      return bad(`status must be one of ${CAMPAIGN_STATUSES.join(", ")}`);
    }
    const result = await setStatus(id, next, actorFrom(request));
    if (!result.ok) return bad(result.error ?? "transition refused", 409);
    return ok({ campaign: result.campaign });
  } catch (err) {
    return failed(err, "campaign lifecycle");
  }
}
