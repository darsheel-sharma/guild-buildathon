/**
 * ICP fitment agent.
 *
 * Scores a researched prospect against *this* campaign's criteria. The same
 * person can be qualified in one campaign and rejected in another, which is the
 * whole point: the agent code is identical, only the config differs.
 *
 * The offline scorer is a real rule engine over the campaign's own targeting
 * fields rather than a random number, so campaign isolation is demonstrable
 * without a model key.
 */
import { z } from "zod";
import type { Campaign, Prospect, QualifyOutput, ResearchOutput } from "@/core/types";
import { runAgent, type AgentOutcome } from "./runtime";

const schema = z.object({
  score: z.number().min(0).max(1),
  verdict: z.enum(["qualified", "rejected", "needs_review"]),
  reasons: z.array(z.string()).min(1).max(5),
});

interface Criteria {
  industries?: string[];
  min_employees?: number;
  max_employees?: number;
}

const contains = (haystack: string, needles: string[]) =>
  needles.some((n) => haystack.toLowerCase().includes(n.toLowerCase()));

export interface FitResult {
  score: number;
  reasons: string[];
  /** Set when the prospect must be rejected outright. */
  hardFail: "exclusion" | "persona" | null;
  /** Set when objective criteria are missed and a human should decide. */
  softFail: boolean;
}

/**
 * Deterministic scoring over the campaign's targeting config.
 *
 * Three tiers rather than a flat sum, because SDR qualification is not
 * additive:
 *
 *   - An exclusion match or a wrong persona is a rejection. A senior title in
 *     the wrong function does not become a lead by scoring well elsewhere.
 *   - A miss on geography, industry or company size is objective but not
 *     automatically fatal, so it lands in needs_review for a human.
 *   - Everything else is scored and compared to the campaign threshold.
 */
export function scoreFit(campaign: Campaign, prospect: Prospect): FitResult {
  const criteria = (campaign.company_criteria ?? {}) as Criteria;
  const reasons: string[] = [];

  const haystack = `${prospect.title} ${prospect.company} ${prospect.industry} ${prospect.geography}`;
  const hitExclusion = (campaign.exclusion_criteria ?? []).find((ex) =>
    haystack.toLowerCase().includes(ex.toLowerCase()),
  );
  if (hitExclusion) {
    return {
      score: 0,
      reasons: [`matches campaign exclusion criterion "${hitExclusion}"`],
      hardFail: "exclusion",
      softFail: false,
    };
  }

  const roles = campaign.target_roles ?? [];
  const titleMatch = !roles.length || contains(prospect.title, roles);
  reasons.push(
    titleMatch
      ? `title "${prospect.title}" matches a target role`
      : `title "${prospect.title}" is not one of the target roles (${roles.join(", ")})`,
  );

  const geoMatch =
    !campaign.geography ||
    contains(
      prospect.geography,
      campaign.geography.split(/[,/]/).map((s) => s.trim()),
    );
  reasons.push(
    geoMatch
      ? `located in ${prospect.geography}, inside the campaign geography`
      : `located in ${prospect.geography}, outside ${campaign.geography}`,
  );

  const industryMatch =
    !criteria.industries?.length || contains(prospect.industry, criteria.industries);
  reasons.push(
    industryMatch
      ? `industry ${prospect.industry} is in scope`
      : `industry ${prospect.industry} is not in ${criteria.industries?.join(", ")}`,
  );

  const min = criteria.min_employees ?? 0;
  const max = criteria.max_employees ?? Number.MAX_SAFE_INTEGER;
  const sizeMatch = prospect.employee_count >= min && prospect.employee_count <= max;
  reasons.push(
    sizeMatch
      ? `${prospect.employee_count} employees fits the ${min}-${max} band`
      : `${prospect.employee_count} employees is outside the ${min}-${max} band`,
  );

  const score = Number(
    (
      (titleMatch ? 0.45 : 0) +
      (geoMatch ? 0.2 : 0) +
      (industryMatch ? 0.2 : 0) +
      (sizeMatch ? 0.15 : 0)
    ).toFixed(2),
  );

  return {
    score,
    reasons,
    hardFail: titleMatch ? null : "persona",
    softFail: !geoMatch || !industryMatch || !sizeMatch,
  };
}

/**
 * How far below threshold still counts as "close enough to check by hand"
 * rather than a clean reject. Mirrors the DronaHQ ICP Fitment Agent's own
 * rule: below threshold is REJECTED, *except* within this band of it, which
 * escalates to NEEDS_REVIEW instead. Expressed on the 0-1 score scale (the
 * agent's instructions state it as "10 points" on its 0-100 fit_score).
 */
const NEAR_MISS_BAND = 0.1;

export function verdictFor(fit: FitResult, threshold: number): QualifyOutput["verdict"] {
  if (fit.hardFail) return "rejected";
  if (fit.softFail) return "needs_review";
  if (fit.score >= threshold) return "qualified";
  if (fit.score >= threshold - NEAR_MISS_BAND) return "needs_review";
  return "rejected";
}

const VALID_VERDICTS = new Set(["qualified", "rejected", "needs_review"]);

/**
 * The agent's Structured Output isn't enforcing JSON yet, so the webhook's
 * `response` field currently arrives as free text in a consistent shape:
 *
 *   "QUALIFIED, fit score 1.0
 *
 *   - Role: ... matches the target role criteria.
 *   - Industry: ...
 *
 *   All criteria are satisfied ..."
 *
 * Parsed directly rather than waiting on the platform to enforce JSON, so the
 * pipeline works with whatever the agent actually returns today.
 */
function parseIcpFitmentText(text: string): { score: number; verdict: string; reasons: string[] } | null {
  const verdictMatch = text.match(/\b(QUALIFIED|REJECTED|NEEDS[_\s-]?REVIEW)\b/i);
  if (!verdictMatch) return null;
  const verdictRaw = verdictMatch[1].toLowerCase().replace(/[\s-]+/g, "_");
  const verdict = VALID_VERDICTS.has(verdictRaw) ? verdictRaw : "needs_review";

  const scoreMatch = text.match(/fit\s*score[^0-9]*([\d.]+)/i);
  const numericScore = scoreMatch ? Number(scoreMatch[1]) : NaN;
  const score = Number.isFinite(numericScore)
    ? Math.max(0, Math.min(1, numericScore > 1 ? numericScore / 100 : numericScore))
    : 0;

  const reasons = [...text.matchAll(/^\s*[-*•]\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  if (!reasons.length) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const summary = lines[lines.length - 1];
    if (summary) reasons.push(summary);
  }
  if (!reasons.length) reasons.push("DronaHQ ICP Fitment Agent returned free text with no parseable reasoning");

  return { score, verdict, reasons: reasons.slice(0, 5) };
}

/**
 * The ICP Fitment Agent built on DronaHQ keeps its own field names and
 * conventions (a 0-100 fit_score, an UPPERCASE verdict, a criteria_breakdown
 * array, a separate rejection_reason/reasoning) rather than this codebase's
 * QualifyOutput shape. Reconciling that here — instead of changing either
 * side to match the other — lets the DronaHQ agent stay exactly as designed.
 */
export function normalizeIcpFitmentOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;

  // Already our shape (simulate()/direct-model paths, or a future DronaHQ
  // update that matches us) — pass through untouched.
  if (
    typeof obj.score === "number" &&
    typeof obj.verdict === "string" &&
    VALID_VERDICTS.has(obj.verdict) &&
    Array.isArray(obj.reasons)
  ) {
    return obj;
  }

  // Today's actual shape: the trigger's envelope with the agent's free-text
  // answer inside `response`. Try parsing that before falling through to the
  // structured-field path below (which stays here for when Structured Output
  // gets enforced on the DronaHQ side).
  if (typeof obj.response === "string" && obj.response.trim()) {
    const parsed = parseIcpFitmentText(obj.response);
    if (parsed) return parsed;
  }

  // A webhook trigger that runs asynchronously answers with an execution
  // acknowledgment (thread_id/run_id/"started in background"), not a scored
  // result. Treating that as "no reasons given" would silently manufacture a
  // fake needs_review verdict on every call. Fail loudly instead, so this
  // degrades to the next backend and gets recorded as degraded rather than a
  // false dronahq success.
  const hasAnyResultField =
    "verdict" in obj || "fit_score" in obj || "criteria_breakdown" in obj ||
    "reasoning" in obj || "rejection_reason" in obj;
  if (!hasAnyResultField) {
    throw new Error(
      `DronaHQ ICP Fitment Agent did not return a scored result (got: ${JSON.stringify(obj).slice(0, 200)}) — ` +
        `this usually means the webhook trigger is running asynchronously and only acknowledged the run.`,
    );
  }

  const verdictRaw = String(obj.verdict ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const verdict = VALID_VERDICTS.has(verdictRaw)
    ? verdictRaw
    : verdictRaw.includes("qualif") && !verdictRaw.includes("dis")
      ? "qualified"
      : verdictRaw.includes("reject") || verdictRaw.includes("disqualif")
        ? "rejected"
        : "needs_review";

  const rawScore = obj.fit_score ?? obj.score;
  const numericScore = typeof rawScore === "number" ? rawScore : Number(rawScore ?? NaN);
  const score = Number.isFinite(numericScore)
    ? Math.max(0, Math.min(1, numericScore > 1 ? numericScore / 100 : numericScore))
    : 0;

  const reasons: string[] = [];
  if (Array.isArray(obj.criteria_breakdown)) {
    for (const item of obj.criteria_breakdown) {
      if (typeof item === "string" && item) reasons.push(item);
      else if (item && typeof item === "object") {
        const c = item as Record<string, unknown>;
        const parts = [c.criterion, c.result ?? c.status, c.detail ?? c.note].filter(
          (p) => typeof p === "string" && p,
        );
        if (parts.length) reasons.push(parts.join(": "));
      }
    }
  }
  if (typeof obj.rejection_reason === "string" && obj.rejection_reason) reasons.push(obj.rejection_reason);
  if (!reasons.length && typeof obj.reasoning === "string" && obj.reasoning) reasons.push(obj.reasoning);
  if (!reasons.length) reasons.push("DronaHQ ICP Fitment Agent did not return a reason breakdown");

  return { score, verdict, reasons: reasons.slice(0, 5) };
}

export async function qualifyProspect(
  campaign: Campaign,
  prospect: Prospect,
  research: ResearchOutput | null,
  campaignProspectId: string | null,
): Promise<AgentOutcome<QualifyOutput>> {
  const threshold = Number(campaign.qualification_threshold);

  return runAgent<QualifyOutput>({
    campaignId: campaign.id,
    campaignProspectId,
    agent: "qualify",
    tier: "fast",
    retrievalQuery: `ideal customer profile definition disqualifiers ${campaign.icp_name}`,
    retrievalKinds: ["icp", "playbook"],
    schema,
    seed: `${campaign.id}:${prospect.id}`,
    input: { prospect: prospect.email, threshold },
    // Named fields for the DronaHQ ICP Fitment Agent's {{variable.*}} bindings,
    // so the same agent definition scores each campaign against its own
    // criteria instead of one shared/static value.
    variables: {
      campaign_name: campaign.icp_name,
      icp_criteria: {
        geography: campaign.geography,
        target_roles: campaign.target_roles ?? [],
        company_criteria: campaign.company_criteria ?? {},
      },
      exclusion_criteria: campaign.exclusion_criteria ?? [],
      min_score_threshold: threshold,
      prospect: {
        full_name: prospect.full_name,
        title: prospect.title,
        company: prospect.company,
        industry: prospect.industry,
        employee_count: prospect.employee_count,
        geography: prospect.geography,
      },
      research: research ?? null,
    },
    normalize: normalizeIcpFitmentOutput,
    buildPrompt: ({ knowledge }) => `Qualify this prospect against the campaign ICP.

Campaign ICP: ${campaign.icp_name}
Geography:    ${campaign.geography}
Target roles: ${(campaign.target_roles ?? []).join(", ")}
Company criteria: ${JSON.stringify(campaign.company_criteria)}
Exclusions:   ${(campaign.exclusion_criteria ?? []).join(", ") || "none"}
Qualification threshold: ${threshold}

ICP definition and disqualifiers (retrieved):
${knowledge}

Prospect
  ${prospect.full_name} - ${prospect.title} at ${prospect.company}
  ${prospect.industry}, ${prospect.employee_count} employees, ${prospect.geography}

Research context:
${research ? JSON.stringify(research, null, 2) : "(none available)"}

Score fit from 0 to 1 and return a verdict, citing the specific criterion behind
each reason. Rules, in order of precedence:
  1. Any exclusion match is a rejection regardless of other strengths.
  2. A title outside the target roles is a rejection, not a borderline case —
     seniority elsewhere does not substitute for owning this problem. Use the
     retrieved ICP definition to judge whether the role genuinely owns it.
  3. A miss on geography, industry or company size is needs_review, so a human
     decides whether the exception is worth making.
  4. Otherwise, at or above ${threshold} is qualified.`,
    simulate: () => {
      const fit = scoreFit(campaign, prospect);
      return {
        score: fit.score,
        verdict: verdictFor(fit, threshold),
        reasons: fit.reasons.slice(0, 5),
      };
    },
    summarise: (out) => `${out.verdict} at ${out.score} (threshold ${threshold})`,
  });
}
