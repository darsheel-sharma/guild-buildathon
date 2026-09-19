path = "src/agents/research.ts"
s = open(path, encoding="utf-8").read()

old_imports = '''import { z } from "zod";
import type { Campaign, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentOutcome } from "./runtime";'''
new_imports = '''import { z } from "zod";
import type { Campaign, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";'''
assert old_imports in s
s = s.replace(old_imports, new_imports)

old_schema_end = '''const schema = z.object({
  company_summary: z.string().max(400),
  role_summary: z.string().max(300),
  signals: z.array(z.string()).max(5),
  pain_hypotheses: z.array(z.string()).max(4),
  personalisation_hooks: z.array(z.string()).max(4),
  tech_stack: z.array(z.string()).max(6),
  confidence: z.number().min(0).max(1),
});'''
new_schema_end = '''const schema = z.object({
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
      // Free text: no reliable structure to parse, so this is a low-confidence
      // stand-in rather than a fabricated dossier.
      return {
        company_summary: text.slice(0, 400) || "no dossier text returned",
        role_summary: "",
        signals: [],
        pain_hypotheses: [],
        personalisation_hooks: [],
        tech_stack: [],
        confidence: 0.3,
      };
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
    // This agent deliberately stays factual — pain hypotheses are out of its
    // scope, not something DronaHQ failed to return.
    pain_hypotheses: [],
    personalisation_hooks: toStringArray(obj.talking_points, 4),
    tech_stack: toStringArray(fieldValue((obj.company as Record<string, unknown> | undefined)?.tech_stack), 6),
    confidence,
  };
}'''
assert old_schema_end in s
s = s.replace(old_schema_end, new_schema_end)

open(path, "w", encoding="utf-8").write(s)
print("research.ts: normalizer added")
