// Standalone integration probe for the Lead Research & Enrichment DronaHQ agent.
// Native fetch only, no node_modules dependency. Run with: node <this file>

import { readFileSync } from "node:fs";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv(".env");
const URL = env.DRONAHQ_AGENT_RESEARCH_URL;
const KEY = env.DRONAHQ_AGENT_RESEARCH_KEY || env.DRONAHQ_API_KEY;

if (!URL || !KEY) {
  console.error("Missing DRONAHQ_AGENT_RESEARCH_URL or a resolvable key in .env");
  process.exit(1);
}

const campaign = {
  id: "us-saas-cto",
  name: "US SaaS CTO outreach",
  icp_name: "SaaS CTO",
  geography: "United States",
  objective: "Book 20-minute technical calls with engineering leaders who own internal tooling budget.",
};

const prospect = {
  full_name: "Jordan Reyes",
  title: "CTO",
  company: "Northwind Analytics",
  company_domain: "northwindanalytics.com",
  industry: "SaaS",
  employee_count: 620,
  geography: "United States",
};

const SYSTEM = `You are the SDR system for a campaign selling an internal-tooling and agent platform to US mid-market SaaS engineering leaders.

Audience: CTOs, VPs of Engineering and Heads of Platform at 80-3000 person software companies in the United States.
Voice: direct, peer-to-peer, technically literate. No marketing adjectives, no exclamation marks.
Frame: engineering time spent on internal admin panels is the cost, not licence spend.
Ask: a 20-minute technical walkthrough.`;

function buildPrompt() {
  return `Research this prospect for the campaign "${campaign.name}".

Campaign objective: ${campaign.objective}
ICP: ${campaign.icp_name} - ${campaign.geography}

Prospect
  name:      ${prospect.full_name}
  title:     ${prospect.title}
  company:   ${prospect.company} (${prospect.company_domain})
  industry:  ${prospect.industry}
  size:      ${prospect.employee_count} employees
  location:  ${prospect.geography}

What we sell (retrieved knowledge):
(none for this standalone test - normally retrieved from the campaign knowledge base)

Build structured context. Every personalisation hook must be traceable to the
prospect record or the retrieved knowledge above - if you cannot ground a claim,
leave it out and lower your confidence. Do not invent funding rounds, named
customers, or headcount figures.`;
}

// Mirrors src/agents/research.ts
function fieldValue(field) {
  if (field && typeof field === "object" && "value" in field) return field.value;
  return field;
}

function summariseFields(obj) {
  if (!obj || typeof obj !== "object") return null;
  const parts = [];
  for (const [key, field] of Object.entries(obj)) {
    const v = fieldValue(field);
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${key.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  return parts.length ? parts.join("; ") : null;
}

const CONFIDENCE_WORDS = { high: 0.85, medium: 0.6, low: 0.3 };

function toStringArray(value, max) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string" && v.length > 0).slice(0, max);
}

function normalizeResearchDossier(raw) {
  if (!raw || typeof raw !== "object") return raw;
  let obj = raw;

  if (
    typeof obj.company_summary === "string" &&
    typeof obj.role_summary === "string" &&
    Array.isArray(obj.signals) &&
    typeof obj.confidence === "number"
  ) {
    return obj;
  }

  if (typeof obj.response === "string") {
    const text = obj.response.trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") obj = parsed;
      else throw new Error("not an object");
    } catch {
      return {
        company_summary: text.slice(0, 400) || "no dossier text returned",
        role_summary: "",
        signals: [],
        pain_hypotheses: [],
        personalisation_hooks: [],
        tech_stack: [],
        confidence: 0.3,
        _note: "FREE TEXT FALLBACK - Structured Output likely not enforcing the schema",
      };
    }
  }

  const hasAnyDossierField =
    "company" in obj || "person" in obj || "signals" in obj || "talking_points" in obj ||
    "overall_confidence" in obj || "cache_hit" in obj;
  if (!hasAnyDossierField) {
    throw new Error(`DronaHQ Lead Research Agent did not return a dossier (got: ${JSON.stringify(obj).slice(0, 200)})`);
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
    pain_hypotheses: [],
    personalisation_hooks: toStringArray(obj.talking_points, 4),
    tech_stack: toStringArray(fieldValue(obj.company?.tech_stack), 6),
    confidence,
  };
}

function unwrap(raw) {
  if (raw && typeof raw === "object") {
    for (const key of ["data", "output", "result"]) {
      if (raw[key] && typeof raw[key] === "object") return raw[key];
    }
  }
  return raw;
}

function validate(obj) {
  const errs = [];
  if (typeof obj?.company_summary !== "string") errs.push("company_summary invalid");
  if (typeof obj?.role_summary !== "string") errs.push("role_summary invalid");
  if (!Array.isArray(obj?.signals)) errs.push("signals invalid");
  if (!Array.isArray(obj?.pain_hypotheses)) errs.push("pain_hypotheses invalid");
  if (!Array.isArray(obj?.personalisation_hooks)) errs.push("personalisation_hooks invalid");
  if (!Array.isArray(obj?.tech_stack)) errs.push("tech_stack invalid");
  if (typeof obj?.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) errs.push("confidence invalid");
  return errs;
}

const run = async () => {
  const body = {
    agent: "research",
    campaign_id: campaign.id,
    system: SYSTEM,
    message: buildPrompt(),
    campaign_name: campaign.icp_name,
    research_focus: campaign.objective,
    prompt_version: "test-harness-v0",
  };

  console.log("Sending one request...");
  const started = Date.now();
  let res;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { "api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.log(`FETCH ERROR: ${err.message}`);
    return;
  }
  const latency = Date.now() - started;
  const text = await res.text();
  console.log(`HTTP ${res.status} in ${latency}ms`);
  if (!res.ok) {
    console.log(`Body: ${text.slice(0, 800)}`);
    return;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    console.log(`Non-JSON body: ${text.slice(0, 800)}`);
    return;
  }
  console.log("Raw response:", JSON.stringify(raw, null, 2).slice(0, 2000));
  const unwrapped = unwrap(raw);
  let normalized;
  try {
    normalized = normalizeResearchDossier(unwrapped);
  } catch (err) {
    console.log(`NORMALIZE THREW (would degrade to fallback): ${err.message}`);
    return;
  }
  console.log("Normalized:", JSON.stringify(normalized, null, 2));
  const errs = validate(normalized);
  console.log(errs.length ? `SCHEMA FAIL: ${errs.join("; ")}` : "PASS: matches ResearchOutput schema");
};

run();
