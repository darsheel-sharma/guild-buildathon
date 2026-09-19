import { tickAll } from "@/orchestrator/engine";
import { failed, ok } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled execution. Point a Vercel cron (or any scheduler) at this route to
 * run campaigns without anyone opening the dashboard. Protected by CRON_SECRET
 * when one is configured — Vercel cron sends it as a bearer token.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const results = await tickAll(6);
    return ok({
      ran: results.filter((r) => r.ran).length,
      skipped: results
        .filter((r) => !r.ran)
        .map((r) => ({ campaign: r.campaignName, why: r.blocked })),
    });
  } catch (err) {
    return failed(err, "cron tick");
  }
}
