import { runQualifyEval } from "@/orchestrator/evals";
import { bad, failed, ok } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scores the live qualify configuration against the campaign's golden set. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await runQualifyEval(id);
    if (!result) return bad("no golden-set cases for this campaign", 404);
    return ok(result);
  } catch (err) {
    return failed(err, "eval run");
  }
}
