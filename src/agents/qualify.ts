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

export function verdictFor(fit: FitResult, threshold: number): QualifyOutput["verdict"] {
  if (fit.hardFail) return "rejected";
  if (fit.softFail) return "needs_review";
  return fit.score >= threshold ? "qualified" : "needs_review";
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
