/**
 * Lead research & enrichment agent.
 *
 * Turns a thin prospect record into structured context every later agent reads:
 * what the company does, what the role owns, why now, and the specific hooks
 * personalisation is allowed to use. Cheap tier — this is extraction, not
 * customer-facing prose.
 */
import { z } from "zod";
import type { Campaign, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentOutcome } from "./runtime";

const schema = z.object({
  company_summary: z.string().max(400),
  role_summary: z.string().max(300),
  signals: z.array(z.string()).max(5),
  pain_hypotheses: z.array(z.string()).max(4),
  personalisation_hooks: z.array(z.string()).max(4),
  tech_stack: z.array(z.string()).max(6),
  confidence: z.number().min(0).max(1),
});

const SIGNALS = [
  "hiring for platform engineering roles",
  "recently announced a funding round",
  "expanding into a new region",
  "migrating off a legacy vendor",
  "published an engineering blog on scaling",
  "new compliance requirement in their market",
  "leadership change in the function",
];

const PAINS = [
  "internal tooling is built ad hoc and nobody owns it",
  "manual operational work is scaling with headcount",
  "data is trapped in systems the business team cannot query",
  "engineering time is going to admin panels instead of product",
  "reporting is assembled by hand every month",
];

export async function researchProspect(
  campaign: Campaign,
  prospect: Prospect,
  campaignProspectId: string,
): Promise<AgentOutcome<ResearchOutput>> {
  return runAgent<ResearchOutput>({
    campaignId: campaign.id,
    campaignProspectId,
    agent: "research",
    tier: "fast",
    retrievalQuery: `${prospect.industry} ${prospect.title} ${campaign.icp_name} company background use cases`,
    retrievalKinds: ["product", "case_study"],
    schema,
    seed: `${campaign.id}:${prospect.id}`,
    input: { prospect: prospect.email, icp: campaign.icp_name },
    buildPrompt: ({ knowledge }) => `Research this prospect for the campaign "${campaign.name}".

Campaign objective: ${campaign.objective}
ICP: ${campaign.icp_name} — ${campaign.geography}

Prospect
  name:      ${prospect.full_name}
  title:     ${prospect.title}
  company:   ${prospect.company} (${prospect.company_domain})
  industry:  ${prospect.industry}
  size:      ${prospect.employee_count} employees
  location:  ${prospect.geography}

What we sell (retrieved knowledge):
${knowledge}

Build structured context. Every personalisation hook must be traceable to the
prospect record or the retrieved knowledge above — if you cannot ground a claim,
leave it out and lower your confidence. Do not invent funding rounds, named
customers, or headcount figures.`,
    simulate: (rng) => {
      const signals = [rng.pick(SIGNALS), rng.pick(SIGNALS)].filter(
        (v, i, a) => a.indexOf(v) === i,
      );
      const pains = [rng.pick(PAINS), rng.pick(PAINS)].filter((v, i, a) => a.indexOf(v) === i);
      const size =
        prospect.employee_count > 2000
          ? "a large enterprise"
          : prospect.employee_count > 400
            ? "a mid-market company"
            : "a growing company";
      return {
        company_summary: `${prospect.company} is ${size} in ${prospect.industry}, operating primarily in ${prospect.geography}. Around ${prospect.employee_count} employees.`,
        role_summary: `As ${prospect.title} they own the platform and tooling decisions that this campaign speaks to, and can sign off without a committee at this company size.`,
        signals,
        pain_hypotheses: pains,
        personalisation_hooks: [
          `${prospect.company} operates in ${prospect.industry}, where ${pains[0]}`,
          `${prospect.title} is typically measured on delivery speed rather than tool count`,
        ],
        tech_stack: prospect.industry.includes("BFSI")
          ? ["Java", "Oracle", "on-prem Kubernetes"]
          : ["TypeScript", "Postgres", "AWS"],
        confidence: Number((0.55 + rng.next() * 0.35).toFixed(2)),
      };
    },
    summarise: (out) =>
      `${out.signals.length} signals, ${out.personalisation_hooks.length} hooks, confidence ${out.confidence}`,
  });
}
