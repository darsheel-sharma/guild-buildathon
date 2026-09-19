/**
 * Model access for the intelligence layer.
 *
 * Two tiers, routed per agent rather than per campaign: extraction and
 * classification go to the cheap model, anything a prospect will read goes to
 * the strong one. `runStructured` is the only way an agent reaches a model, so
 * cost, latency, token counts and the live/simulated flag are recorded in one
 * place for every call.
 *
 * With no API key the same call returns the agent's own `simulate()` output,
 * seeded deterministically. The pipeline is then fully exercisable offline and
 * the UI labels every run as simulated.
 */
import type { z } from "zod";
import type { AgentKey } from "@/core/types";
import { invoke, isConfigured } from "./dronahq";

export type Tier = "fast" | "strong";
export type Mode = "live" | "simulated" | "dronahq";

/** USD per million tokens. Verified against the Claude API pricing table. */
const PRICES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10 },
  "anthropic/claude-opus-5": { input: 5, output: 25 },
};

const FALLBACK_PRICE = { input: 2, output: 10 };

export function modelFor(tier: Tier): string {
  return tier === "fast"
    ? (process.env.MODEL_FAST ?? "anthropic/claude-haiku-4-5")
    : (process.env.MODEL_STRONG ?? "anthropic/claude-opus-5");
}

export function hasLiveModel(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY ?? process.env.ANTHROPIC_API_KEY);
}

export function priceOf(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? FALLBACK_PRICE;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// ── deterministic RNG ──────────────────────────────────────────────────────
// Simulated agent output must be stable: the same prospect and the same prompt
// version produce the same decision on every run, so the demo is reproducible
// and the eval harness means something.

export interface Rng {
  next(): number;
  pick<T>(items: readonly T[]): T;
  int(min: number, max: number): number;
  chance(p: number): boolean;
}

export function rngFor(seed: string): Rng {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let state = h || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: (items) => items[Math.floor(next() * items.length) % items.length],
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
  };
}

export interface StructuredCall<T> {
  /** Which agent is calling — decides whether DronaHQ handles it. */
  agent: AgentKey;
  campaignId: string;
  tier: Tier;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Deterministic stand-in used when no model credential is configured. */
  simulate: (rng: Rng) => T;
  /** Stable seed — usually campaign + prospect + agent + prompt version. */
  seed: string;
  maxOutputTokens?: number;
  /** Named fields forwarded to DronaHQ's Variables mechanism (see dronahq.ts). */
  variables?: Record<string, unknown>;
  /**
   * Reshapes a DronaHQ agent's raw response into this call's schema before
   * validation. DronaHQ-side agents are free to use their own field names and
   * conventions (e.g. a 0-100 score, an uppercase verdict) — this is the one
   * place that difference gets reconciled, so the rest of the pipeline never
   * has to know which backend answered.
   */
  normalize?: (raw: unknown) => unknown;
}

export interface StructuredResult<T> {
  object: T;
  model: string;
  mode: Mode;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Set when a live call failed and the deterministic path was used instead. */
  degraded?: string;
}

/** Rough token estimate, used only to price simulated runs. */
const estimate = (text: string) => Math.ceil(text.length / 4);

export async function runStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const model = modelFor(call.tier);
  const started = Date.now();
  let degradedFrom: string | undefined;

  // Preference order: DronaHQ when this agent is deployed there, then a direct
  // model call, then the deterministic stand-in. Each fallback is recorded on
  // the run rather than swallowed.
  if (isConfigured(call.agent)) {
    try {
      const { raw, latencyMs } = await invoke({
        agent: call.agent,
        system: call.system,
        prompt: call.prompt,
        campaignId: call.campaignId,
        variables: call.variables,
      });
      // The agent's response schema is configured in DronaHQ, so it is not
      // guaranteed to match ours. Normalize first (if this agent needs it),
      // then validate — a misconfigured trigger still degrades visibly
      // instead of poisoning the pipeline with a bad shape.
      const normalized = call.normalize ? call.normalize(raw) : raw;
      const parsed = call.schema.safeParse(normalized);
      if (!parsed.success) {
        throw new Error(`response did not match the expected schema: ${parsed.error.message.slice(0, 200)}`);
      }
      const inputTokens = estimate(call.system + call.prompt);
      const outputTokens = estimate(JSON.stringify(parsed.data));
      return {
        object: parsed.data,
        model: `dronahq/${call.agent}`,
        mode: "dronahq",
        inputTokens,
        outputTokens,
        // Model spend happens inside DronaHQ, so it is not ours to price.
        costUsd: 0,
        latencyMs,
      };
    } catch (err) {
      degradedFrom = `dronahq: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (hasLiveModel()) {
    try {
      const { generateObject } = await import("ai");
      const result = await generateObject({
        model,
        schema: call.schema,
        system: call.system,
        prompt: call.prompt,
        maxOutputTokens: call.maxOutputTokens ?? 2000,
        maxRetries: 1,
      });
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      return {
        object: result.object as T,
        model,
        mode: "live",
        inputTokens,
        outputTokens,
        costUsd: priceOf(model, inputTokens, outputTokens),
        latencyMs: Date.now() - started,
        degraded: degradedFrom,
      };
    } catch (err) {
      // Malformed output, schema mismatch, rate limit, provider outage: the
      // campaign keeps running on the deterministic path and the run is
      // recorded as degraded so the manager can see it happened.
      const degraded = err instanceof Error ? err.message : String(err);
      const object = call.simulate(rngFor(call.seed));
      const inputTokens = estimate(call.system + call.prompt);
      const outputTokens = estimate(JSON.stringify(object));
      return {
        object,
        model,
        mode: "simulated",
        inputTokens,
        outputTokens,
        costUsd: 0,
        latencyMs: Date.now() - started,
        degraded: [degradedFrom, degraded].filter(Boolean).join("; "),
      };
    }
  }

  const object = call.simulate(rngFor(call.seed));
  const inputTokens = estimate(call.system + call.prompt);
  const outputTokens = estimate(JSON.stringify(object));
  return {
    object,
    model,
    mode: "simulated",
    inputTokens,
    outputTokens,
    // Priced as if it had run, so cost-per-qualified-lead is demonstrable
    // offline. The UI labels these figures as estimated.
    costUsd: priceOf(model, inputTokens, outputTokens),
    latencyMs: Date.now() - started,
    degraded: degradedFrom,
  };
}
