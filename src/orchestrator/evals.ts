/**
 * Golden-set evaluation for the ICP agent.
 *
 * Runs the live configuration against hand-labelled cases and records the score
 * against the prompt version that produced it. That makes a prompt edit
 * measurable rather than a matter of taste: change the qualify prompt, re-run,
 * compare. It is also the honest answer to "is your agent any good" — the
 * number is on the dashboard whether it is flattering or not.
 */
import { qualifyProspect } from "@/agents/qualify";
import { getDb } from "@/core/db/client";
import { getCampaign } from "@/core/platform/campaigns";
import { getActive } from "@/core/platform/prompts";
import { logEvent } from "@/core/platform/events";
import type { Prospect } from "@/core/types";

export interface EvalCaseResult {
  label: string;
  expected: string;
  actual: string;
  score: number;
  passed: boolean;
  reason: string;
}

export interface EvalRunResult {
  campaignId: string;
  agent: string;
  total: number;
  passed: number;
  accuracy: number;
  promptVersion: number;
  cases: EvalCaseResult[];
}

function toProspect(input: Record<string, unknown>, index: number): Prospect {
  return {
    id: `eval-${index}`,
    email: `eval-${index}@example.com`,
    full_name: String(input.full_name ?? "Eval Case"),
    title: String(input.title ?? ""),
    company: String(input.company ?? ""),
    company_domain: "example.com",
    industry: String(input.industry ?? ""),
    geography: String(input.geography ?? ""),
    employee_count: Number(input.employee_count ?? 0),
    linkedin_url: "",
    phone: "",
    source: "eval",
  };
}

export async function runQualifyEval(campaignId: string): Promise<EvalRunResult | null> {
  const db = await getDb();
  const campaign = await getCampaign(campaignId);
  if (!campaign) return null;

  const { rows: cases } = await db.query<{
    id: string;
    label: string;
    input: Record<string, unknown> | string;
    expected: Record<string, unknown> | string;
  }>(
    `SELECT id, label, input, expected FROM eval_cases
      WHERE campaign_id = $1 AND agent_key = 'qualify' ORDER BY label`,
    [campaignId],
  );
  if (!cases.length) return null;

  const active = await getActive(campaignId, "qualify");
  const results: EvalCaseResult[] = [];

  for (const [i, row] of cases.entries()) {
    const input = typeof row.input === "string" ? JSON.parse(row.input) : row.input;
    const expected = typeof row.expected === "string" ? JSON.parse(row.expected) : row.expected;
    // Some cases carry context that only exists in research, not in the
    // prospect record — that is how a case can test judgement rather than
    // firmographics.
    const research = input.note
      ? {
          company_summary: String(input.note),
          role_summary: String(input.note),
          signals: [],
          pain_hypotheses: [],
          personalisation_hooks: [],
          tech_stack: [],
          confidence: 0.9,
        }
      : null;
    // campaign_prospect_id is null: an eval run is a real agent run against a
    // synthetic prospect, and it shows up in the audit trail as exactly that.
    const outcome = await qualifyProspect(campaign, toProspect(input, i), research, null);
    const actual = outcome.output.verdict;
    results.push({
      label: row.label,
      expected: String(expected.verdict),
      actual,
      score: outcome.output.score,
      passed: actual === expected.verdict,
      reason: outcome.output.reasons[0] ?? "",
    });
  }

  const passed = results.filter((r) => r.passed).length;
  await db.query(
    `INSERT INTO eval_runs (id, campaign_id, agent_key, prompt_version_id, total, passed, detail)
     VALUES ($1,$2,'qualify',$3,$4,$5,$6)`,
    [
      crypto.randomUUID(),
      campaignId,
      active?.id ?? null,
      results.length,
      passed,
      JSON.stringify(results),
    ],
  );
  await logEvent({
    campaignId,
    level: passed === results.length ? "action" : "warn",
    type: "eval.completed",
    message: `ICP eval: ${passed}/${results.length} correct on qualify prompt v${active?.version ?? 0}`,
    data: { passed, total: results.length },
  });

  return {
    campaignId,
    agent: "qualify",
    total: results.length,
    passed,
    accuracy: results.length ? passed / results.length : 0,
    promptVersion: active?.version ?? 0,
    cases: results,
  };
}

export interface EvalHistoryRow {
  id: string;
  total: number;
  passed: number;
  prompt_version: number | null;
  created_at: string;
}

export async function evalHistory(campaignId: string, limit = 5): Promise<EvalHistoryRow[]> {
  const db = await getDb();
  const { rows } = await db.query<EvalHistoryRow>(
    `SELECT e.id, e.total, e.passed, v.version AS prompt_version, e.created_at
       FROM eval_runs e
       LEFT JOIN prompt_versions v ON v.id = e.prompt_version_id
      WHERE e.campaign_id = $1
      ORDER BY e.created_at DESC LIMIT $2`,
    [campaignId, limit],
  );
  return rows.map((r) => ({ ...r, total: Number(r.total), passed: Number(r.passed) }));
}
