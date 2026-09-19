import { tickAll } from "@/orchestrator/engine";
import { failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Ticks every campaign. Live ones advance; paused and draft ones come back with
 * the reason they were skipped, which is the point of running them together.
 */
export async function POST(request: Request) {
  try {
    const body = await jsonBody<{ budget?: number }>(request);
    const budget = Math.min(Math.max(Number(body.budget ?? 5), 1), 25);
    return ok({ results: await tickAll(budget) });
  } catch (err) {
    return failed(err, "run all campaigns");
  }
}
