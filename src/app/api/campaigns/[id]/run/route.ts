import { tick } from "@/orchestrator/engine";
import { failed, jsonBody, ok } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Advance one campaign by up to `budget` units of work. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await jsonBody<{ budget?: number }>(request);
    const budget = Math.min(Math.max(Number(body.budget ?? 6), 1), 25);
    return ok(await tick(id, budget));
  } catch (err) {
    return failed(err, "campaign tick");
  }
}
