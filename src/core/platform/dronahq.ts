/**
 * DronaHQ as an execution backend for the intelligence layer.
 *
 * A DronaHQ agent is exposed to the outside world as a webhook-triggered
 * endpoint: the platform generates a unique URL per trigger, you call it with
 * `POST` and an `api-key` header, and it answers synchronously with JSON shaped
 * by the response schema configured on the trigger.
 *   https://docs.dronahq.com/agents/triggers/inbuilt-triggers/webhook/
 *
 * So the wiring is a URL per agent rather than a documented path we could
 * guess: set DRONAHQ_API_KEY plus DRONAHQ_AGENT_<AGENT>_URL, and that agent's
 * reasoning runs inside DronaHQ instead of here. Everything around it — the
 * campaign config, retrieval, the guard rails, the audit trail — is unchanged,
 * which is the point: DronaHQ is the agent runtime, not the whole system.
 *
 * Nothing is inferred about endpoints we have not seen documented. With no URL
 * configured for an agent this module reports itself as unconfigured and the
 * normal model path runs.
 */
import type { AgentKey } from "@/core/types";

export interface DronaHqCall {
  agent: AgentKey;
  system: string;
  prompt: string;
  /** Campaign id, passed through so DronaHQ-side logs line up with ours. */
  campaignId: string;
  /**
   * Named top-level fields, merged into the webhook body alongside
   * agent/campaign_id/system/message. DronaHQ's Variables mechanism lets a
   * payload key override a variable of the same name for that execution, so
   * this is how one shared agent definition stays campaign-isolated instead
   * of relying on the free-text prompt alone.
   */
  variables?: Record<string, unknown>;
}

export interface DronaHqResult {
  raw: unknown;
  latencyMs: number;
}

const agentEnvSlug = (agent: AgentKey) => agent.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const envKeyFor = (agent: AgentKey) => `DRONAHQ_AGENT_${agentEnvSlug(agent)}_URL`;
const apiKeyEnvKeyFor = (agent: AgentKey) => `DRONAHQ_AGENT_${agentEnvSlug(agent)}_KEY`;

export function webhookFor(agent: AgentKey): string | null {
  return process.env[envKeyFor(agent)] ?? null;
}

/**
 * Each DronaHQ agent (and its webhook trigger) is issued its own API key, so
 * the per-agent key is checked first. DRONAHQ_API_KEY is kept only as a
 * fallback for a workspace that intentionally shares one key across agents.
 */
export function apiKeyFor(agent: AgentKey): string | null {
  return process.env[apiKeyEnvKeyFor(agent)] ?? process.env.DRONAHQ_API_KEY ?? null;
}

export function isConfigured(agent: AgentKey): boolean {
  return Boolean(apiKeyFor(agent)) && Boolean(webhookFor(agent));
}

/** Which agents are currently delegated to DronaHQ. Surfaced in the UI. */
export function configuredAgents(agents: readonly AgentKey[]): AgentKey[] {
  return agents.filter(isConfigured);
}

/**
 * Invokes the agent's webhook trigger. Throws on anything other than a 2xx with
 * a JSON body — the caller treats that as a degraded run and falls back, rather
 * than letting a provider problem stop the campaign.
 */
export async function invoke(call: DronaHqCall): Promise<DronaHqResult> {
  const url = webhookFor(call.agent);
  const apiKey = apiKeyFor(call.agent);
  if (!url || !apiKey) throw new Error(`DronaHQ is not configured for the ${call.agent} agent`);

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: call.agent,
        campaign_id: call.campaignId,
        system: call.system,
        message: call.prompt,
        ...call.variables,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`DronaHQ ${call.agent} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const text = await res.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`DronaHQ ${call.agent} returned a non-JSON body: ${text.slice(0, 200)}`);
    }

    // A webhook trigger may wrap the agent output. Unwrap the common shapes
    // before handing it to schema validation.
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      for (const key of ["data", "output", "result", "response"]) {
        if (obj[key] && typeof obj[key] === "object") return { raw: obj[key], latencyMs: Date.now() - started };
      }
    }
    return { raw, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}
