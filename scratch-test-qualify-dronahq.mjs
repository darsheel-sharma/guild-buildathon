// Standalone integration probe for the qualify (ICP Fitment) DronaHQ agent.
// Uses only Node built-ins (fetch) so it doesn't depend on node_modules,
// which don't resolve correctly over this bridge. Run with: node <this file>

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
const URL = env.DRONAHQ_AGENT_QUALIFY_URL;
const KEY = env.DRONAHQ_AGENT_QUALIFY_KEY || env.DRONAHQ_API_KEY;

if (!URL || !KEY) {
  console.error("Missing DRONAHQ_AGENT_QUALIFY_URL or a resolvable key in .env");
  process.exit(1);
}

const campaign = {
  id: "us-saas-cto",
  icp_name: "SaaS CTO",
  geography: "United States",
  target_roles: ["CTO", "VP Engineering", "Head of Platform", "Director of Engineering"],
  company_criteria: { industries: ["SaaS", "Software"], min_employees: 80, max_employees: 3000 },
  exclusion_criteria: ["staffing", "agency"],
  qualification_threshold: 0.6,
};

const SYSTEM = `You are the SDR system for a campaign selling an internal-tooling and agent platform to US mid-market SaaS engineering leaders.

Audience: CTOs, VPs of Engineering and Heads of Platform at 80-3000 person software companies in the United States.
Voice: direct, peer-to-peer, technically literate. No marketing adjectives, no exclamation marks.
Frame: engineering time spent on internal admin panels is the cost, not licence spend.
Ask: a 20-minute technical walkthrough.`;

// Trimmed to one case to keep this cheap to run against a live agent.
const cases = [
  {
    label: "CTO at 620-person SaaS (expect qualified)",
    prospect: { full_name: "Jordan Reyes", title: "CTO", company: "Northwind Analytics", industry: "SaaS", employee_count: 620, geography: "United States" },
    expected: "qualified",
  },
];

function buildPrompt(prospect) {
  const threshold = campaign.qualification_threshold;
  return `Qualify this prospect against the campaign ICP.

Campaign ICP: ${campaign.icp_name}
Geography:    ${campaign.geography}
Target roles: ${campaign.target_roles.join(", ")}
Company criteria: ${JSON.stringify(campaign.company_criteria)}
Exclusions:   ${campaign.exclusion_criteria.join(", ") || "none"}
Qualification threshold: ${threshold}

ICP definition and disqualifiers (retrieved):
(none for this standalone test - normally retrieved from the campaign knowledge base)

Prospect
  ${prospect.full_name} - ${prospect.title} at ${prospect.company}
  ${prospect.industry}, ${prospect.employee_count} employees, ${prospect.geography}

Research context:
(none available)

Score fit from 0 to 1 and return a verdict, citing the specific criterion behind
each reason. Rules, in order of precedence:
  1. Any exclusion match is a rejection regardless of other strengths.
  2. A title outside the target roles is a rejection, not a borderline case -
     seniority elsewhere does not substitute for owning this problem. Use the
     retrieved ICP definition to judge whether the role genuinely owns it.
  3. A miss on geography, industry or company size is needs_review, so a human
     decides whether the exception is worth making.
  4. Otherwise, at or above ${threshold} is qualified.`;
}

// Mirrors src/agents/qualify.ts
const VALID_VERDICTS = new Set(["qualified", "rejected", "needs_review"]);

function parseIcpFitmentText(text) {
  const verdictMatch = text.match(/\b(QUALIFIED|REJECTED|NEEDS[_\s-]?REVIEW)\b/i);
  if (!verdictMatch) return null;
  const verdictRaw = verdictMatch[1].toLowerCase().replace(/[\s-]+/g, "_");
  const verdict = VALID_VERDICTS.has(verdictRaw) ? verdictRaw : "needs_review";

  const scoreMatch = text.match(/fit\s*score[^0-9]*([\d.]+)/i);
  const numericScore = scoreMatch ? Number(scoreMatch[1]) : NaN;
  const score = Number.isFinite(numericScore)
    ? Math.max(0, Math.min(1, numericScore > 1 ? numericScore / 100 : numericScore))
    : 0;

  const reasons = [...text.matchAll(/^\s*[-*]\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  if (!reasons.length) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const summary = lines[lines.length - 1];
    if (summary) reasons.push(summary);
  }
  if (!reasons.length) reasons.push("DronaHQ ICP Fitment Agent returned free text with no parseable reasoning");

  return { score, verdict, reasons: reasons.slice(0, 5) };
}

function normalizeIcpFitmentOutput(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw;

  if (
    typeof obj.score === "number" &&
    typeof obj.verdict === "string" &&
    VALID_VERDICTS.has(obj.verdict) &&
    Array.isArray(obj.reasons)
  ) {
    return obj;
  }

  if (typeof obj.response === "string" && obj.response.trim()) {
    const parsed = parseIcpFitmentText(obj.response);
    if (parsed) return parsed;
  }

  const hasAnyResultField =
    "verdict" in obj || "fit_score" in obj || "criteria_breakdown" in obj ||
    "reasoning" in obj || "rejection_reason" in obj;
  if (!hasAnyResultField) {
    throw new Error(
      "DronaHQ ICP Fitment Agent did not return a scored result (got: " + JSON.stringify(obj).slice(0, 200) + ")",
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

  const reasons = [];
  if (Array.isArray(obj.criteria_breakdown)) {
    for (const item of obj.criteria_breakdown) {
      if (typeof item === "string" && item) reasons.push(item);
      else if (item && typeof item === "object") {
        const c = item;
        const parts = [c.criterion, c.result ?? c.status, c.detail ?? c.note].filter((p) => typeof p === "string" && p);
        if (parts.length) reasons.push(parts.join(": "));
      }
    }
  }
  if (typeof obj.rejection_reason === "string" && obj.rejection_reason) reasons.push(obj.rejection_reason);
  if (!reasons.length && typeof obj.reasoning === "string" && obj.reasoning) reasons.push(obj.reasoning);
  if (!reasons.length) reasons.push("DronaHQ ICP Fitment Agent did not return a reason breakdown");

  return { score, verdict, reasons: reasons.slice(0, 5) };
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
  if (typeof obj?.score !== "number" || obj.score < 0 || obj.score > 1) errs.push(`score invalid: ${JSON.stringify(obj?.score)}`);
  if (!VALID_VERDICTS.has(obj?.verdict)) errs.push(`verdict invalid: ${JSON.stringify(obj?.verdict)}`);
  if (!Array.isArray(obj?.reasons) || obj.reasons.length < 1 || obj.reasons.length > 5) errs.push(`reasons invalid: ${JSON.stringify(obj?.reasons)}`);
  return errs;
}

const run = async () => {
  let pass = 0;
  for (const c of cases) {
    console.log(`\n=== ${c.label} ===`);
    const body = {
      agent: "qualify",
      campaign_id: campaign.id,
      system: SYSTEM,
      message: buildPrompt(c.prospect),
      campaign_name: campaign.icp_name,
      icp_criteria: { geography: campaign.geography, target_roles: campaign.target_roles, company_criteria: campaign.company_criteria },
      exclusion_criteria: campaign.exclusion_criteria,
      min_score_threshold: campaign.qualification_threshold,
      prospect: c.prospect,
      research: null,
    };

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
      continue;
    }
    const latency = Date.now() - started;
    const text = await res.text();
    console.log(`HTTP ${res.status} in ${latency}ms`);
    if (!res.ok) {
      console.log(`Body: ${text.slice(0, 500)}`);
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      console.log(`Non-JSON body: ${text.slice(0, 500)}`);
      continue;
    }
    console.log("Raw response:", JSON.stringify(raw, null, 2).slice(0, 1000));
    const unwrapped = unwrap(raw);
    let normalized;
    try {
      normalized = normalizeIcpFitmentOutput(unwrapped);
    } catch (err) {
      console.log(`NORMALIZE THREW (would degrade to fallback): ${err.message}`);
      continue;
    }
    console.log("Normalized:", JSON.stringify(normalized));
    const errs = validate(normalized);
    if (errs.length) {
      console.log(`SCHEMA FAIL: ${errs.join("; ")}`);
      continue;
    }
    const ok = normalized.verdict === c.expected;
    console.log(ok ? `PASS (verdict=${normalized.verdict})` : `MISMATCH: expected ${c.expected}, got ${normalized.verdict}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${cases.length} cases matched the expected verdict.`);
};

run();
