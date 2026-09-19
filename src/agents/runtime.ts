/**
 * The one path every agent takes to do anything.
 *
 * Resolve harness → retrieve knowledge → call the model → record the run.
 * Centralising it means no agent can skip retrieval, forget to stamp the
 * prompt version, or lose its cost and latency figures. The `agent_runs` row
 * written here is what the campaign dashboard and the audit trail read from.
 */
import type { z } from "zod";
import { getDb } from "@/core/db/client";
import { formatContext, retrieve } from "@/core/platform/knowledge";
import { runStructured, type Mode, type Rng, type Tier } from "@/core/platform/llm";
import { resolveHarness, type ResolvedHarness } from "@/core/platform/prompts";
import type { AgentKey, RetrievedChunk } from "@/core/types";

export interface AgentContext {
  harness: ResolvedHarness;
  chunks: RetrievedChunk[];
  /** Retrieved knowledge, pre-formatted for the prompt. */
  knowledge: string;
}

export interface AgentInvocation<T> {
  campaignId: string;
  campaignProspectId?: string | null;
  agent: AgentKey;
  tier: Tier;
  /** Omit to skip retrieval (agents that make no customer-facing decision). */
  retrievalQuery?: string;
  retrievalKinds?: string[];
  retrievalLimit?: number;
  schema: z.ZodType<T>;
  buildPrompt: (ctx: AgentContext) => string;
  simulate: (rng: Rng, ctx: AgentContext) => T;
  /** Distinguishes this invocation from other runs of the same agent. */
  seed: string;
  summarise: (output: T) => string;
  input: Record<string, unknown>;
}

export interface AgentOutcome<T> {
  output: T;
  runId: string;
  mode: Mode;
  chunks: RetrievedChunk[];
  harness: ResolvedHarness;
  costUsd: number;
  latencyMs: number;
  degraded?: string;
}

export async function runAgent<T>(inv: AgentInvocation<T>): Promise<AgentOutcome<T>> {
  const db = await getDb();
  const harness = await resolveHarness(inv.campaignId, inv.agent);

  const chunks = inv.retrievalQuery
    ? await retrieve({
        campaignId: inv.campaignId,
        query: inv.retrievalQuery,
        kinds: inv.retrievalKinds,
        limit: inv.retrievalLimit ?? 4,
      })
    : [];

  const ctx: AgentContext = { harness, chunks, knowledge: formatContext(chunks) };
  const prompt = inv.buildPrompt(ctx);

  const result = await runStructured({
    agent: inv.agent,
    campaignId: inv.campaignId,
    tier: inv.tier,
    system: harness.system || `You are the ${inv.agent} agent of an autonomous SDR.`,
    prompt,
    schema: inv.schema,
    // Seeding on the harness hash means a prompt edit changes simulated
    // behaviour too — otherwise version control would look cosmetic offline.
    seed: `${inv.agent}:${inv.seed}:${harness.harness_hash}`,
    simulate: (rng) => inv.simulate(rng, ctx),
  });

  const runId = crypto.randomUUID();
  await db.query(
    `INSERT INTO agent_runs
       (id, campaign_id, campaign_prospect_id, agent_key, status, summary, input, output,
        error, retrieved, prompt_version_id, harness_hash, model, mode,
        input_tokens, output_tokens, cost_usd, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      runId,
      inv.campaignId,
      inv.campaignProspectId ?? null,
      inv.agent,
      result.degraded ? "degraded" : "completed",
      inv.summarise(result.object),
      JSON.stringify(inv.input),
      JSON.stringify(result.object),
      result.degraded ?? null,
      JSON.stringify(
        chunks.map((c) => ({ title: c.title, kind: c.kind, similarity: c.similarity })),
      ),
      harness.prompt_version_id,
      harness.harness_hash,
      result.model,
      result.mode,
      result.inputTokens,
      result.outputTokens,
      result.costUsd,
      result.latencyMs,
    ],
  );

  return {
    output: result.object,
    runId,
    mode: result.mode,
    chunks,
    harness,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    degraded: result.degraded,
  };
}

/** Recorded when an agent could not run at all (gate closed, missing data). */
export async function recordSkippedRun(input: {
  campaignId: string;
  campaignProspectId?: string | null;
  agent: AgentKey;
  reason: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO agent_runs
       (id, campaign_id, campaign_prospect_id, agent_key, status, summary, mode)
     VALUES ($1, $2, $3, $4, 'skipped', $5, 'n/a')`,
    [
      crypto.randomUUID(),
      input.campaignId,
      input.campaignProspectId ?? null,
      input.agent,
      input.reason,
    ],
  );
}
