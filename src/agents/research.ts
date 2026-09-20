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
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";

const schema = z.object({
  company_summary: z.string().max(400),
  role_summary: z.string().max(300),
  signals: z.array(z.string()).max(5),
  pain_hypotheses: z.array(z.string()).max(4),
  personalisation_hooks: z.array(z.string()).max(4),
  tech_stack: z.array(z.string()).max(6),
  confidence: z.number().min(0).max(1),
});

/**
 * The Lead Research & Enrichment Agent built on DronaHQ answers with a
 * "prospect_dossier": provenance-tracked facts ({value, source, as_of} per
 * field) on `company` and `person`, plus signals/talking_points/unknowns/
 * flags/overall_confidence/cache_hit. That is a richer, more defensible shape
 * than this codebase's ResearchOutput, so it is kept as designed and
 * reconciled here rather than flattened on the DronaHQ side.
 */
function fieldValue(field: unknown): unknown {
  if (field && typeof field === "object" && "value" in (field as Record<string, unknown>)) {
    return (field as Record<string, unknown>).value;
  }
  return field;
}

/** Turns a {key: {value,source,as_of}, ...} object into one readable line per field. */
function summariseFields(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const parts: string[] = [];
  for (const [key, field] of Object.entries(obj as Record<string, unknown>)) {
    const v = fieldValue(field);
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${key.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  return parts.length ? parts.join("; ") : null;
}

const CONFIDENCE_WORDS: Record<string, number> = { high: 0.85, medium: 0.6, low: 0.3 };

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, max);
}

export function normalizeResearchDossier(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let obj = raw as Record<string, unknown>;

  // Already our shape (simulate()/direct-model paths) — pass through untouched.
  if (
    typeof obj.company_summary === "string" &&
    typeof obj.role_summary === "string" &&
    Array.isArray(obj.signals) &&
    typeof obj.confidence === "number"
  ) {
    return obj;
  }

  // The trigger's envelope wraps the agent's answer in `response`, which may
  // be the dossier JSON serialised as a string, or (if Structured Output
  // isn't enforcing the schema yet) free text.
  if (typeof obj.response === "string") {
    const text = obj.response.trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
      else throw new Error("not an object");
    } catch {
      // Free text with no parseable dossier in it. Returning an empty
      // dossier here would be worse than failing: it validates, so the run
      // records as a successful DronaHQ call, and every downstream agent
      // then personalises against nothing while the dashboard says it
      // worked. Throw instead, so this degrades to the model or simulated
      // path — both of which produce a real dossier — and is recorded as
      // degraded.
      throw new Error(
        `DronaHQ Lead Research Agent returned unstructured text, not a dossier: ${text.slice(0, 200)}`,
      );
    }
  }

  const hasAnyDossierField =
    "company" in obj || "person" in obj || "signals" in obj || "talking_points" in obj ||
    "overall_confidence" in obj || "cache_hit" in obj;
  if (!hasAnyDossierField) {
    throw new Error(
      `DronaHQ Lead Research Agent did not return a dossier (got: ${JSON.stringify(obj).slice(0, 200)})`,
    );
  }

  const confidenceRaw = obj.overall_confidence;
  const confidence =
    typeof confidenceRaw === "number"
      ? Math.max(0, Math.min(1, confidenceRaw))
      : (CONFIDENCE_WORDS[String(confidenceRaw ?? "").toLowerCase()] ?? 0.5);

  return {
    company_summary: summariseFields(obj.company) ?? "no verified company facts returned",
    role_summary: summariseFields(obj.person) ?? "no verified person facts returned",
    signals: toStringArray(obj.signals, 5),
    // The personalisation agent leads on a pain hypothesis, so dropping these
    // silently cost every DronaHQ-researched prospect its sharpest hook.
    pain_hypotheses: toStringArray(obj.pain_hypotheses, 4),
    personalisation_hooks: toStringArray(obj.talking_points, 4),
    // DronaHQ's schema builder cannot nest an array inside an object, so a
    // top-level tech_stack is the shape that is actually buildable there;
    // the nested form is still read for agents configured the other way.
    tech_stack: toStringArray(
      Array.isArray(obj.tech_stack)
        ? obj.tech_stack
        : fieldValue((obj.company as Record<string, unknown> | undefined)?.tech_stack),
      6,
    ),
    confidence,
  };
}

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
    // Named fields for the DronaHQ agent's {{variable.*}} bindings.
    // prompt_version needs the resolved harness, so this is the function form.
    variables: (ctx: AgentContext) => ({
      campaign_name: campaign.icp_name,
      research_focus: campaign.objective,
      prompt_version: ctx.harness.prompt_version_id,
    }),
    normalize: normalizeResearchDossier,
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

Build structured context. Every signal and personalisation hook must be
traceable to the prospect record, the retrieved knowledge above, or a source you
actually verified — if you cannot ground a claim, leave it out and lower your
confidence. Do not invent funding rounds, named customers, or headcount figures.

pain_hypotheses are the exception: they are explicitly inferences, not facts.
State each as a hypothesis this company plausibly has given its size, industry
and the signals you found, and keep them to problems this product addresses.`,
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
