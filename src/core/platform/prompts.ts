/**
 * Prompt / harness registry.
 *
 * Prompts are immutable rows, not editable fields. Saving produces a new
 * version; activating flips which version is live; rolling back is just
 * activating an older one. Two consequences that matter:
 *
 *  - Editing one campaign's prompt can never change another campaign's
 *    behaviour, because a version belongs to exactly one (campaign, scope).
 *  - Every agent run stores the `prompt_version_id` it used plus a hash of the
 *    whole harness, so "which configuration produced this outcome?" is a
 *    lookup rather than a guess.
 */
import { getDb } from "@/core/db/client";
import type { AgentKey, HarnessStamp } from "@/core/types";
import { logEvent } from "./events";

export type Scope = "campaign" | AgentKey;

export interface PromptVersion {
  id: string;
  campaign_id: string;
  scope: string;
  version: number;
  content: string;
  note: string;
  author: string;
  active: boolean;
  created_at: string;
}

export async function listVersions(campaignId: string, scope?: Scope): Promise<PromptVersion[]> {
  const db = await getDb();
  const { rows } = scope
    ? await db.query<PromptVersion>(
        `SELECT * FROM prompt_versions WHERE campaign_id = $1 AND scope = $2
          ORDER BY version DESC`,
        [campaignId, scope],
      )
    : await db.query<PromptVersion>(
        `SELECT * FROM prompt_versions WHERE campaign_id = $1
          ORDER BY scope, version DESC`,
        [campaignId],
      );
  return rows;
}

export async function getActive(campaignId: string, scope: Scope): Promise<PromptVersion | null> {
  const db = await getDb();
  const { rows } = await db.query<PromptVersion>(
    `SELECT * FROM prompt_versions
      WHERE campaign_id = $1 AND scope = $2 AND active
      LIMIT 1`,
    [campaignId, scope],
  );
  return rows[0] ?? null;
}

/** Creates version N+1 for the scope. `activate` defaults to true. */
export async function saveVersion(input: {
  campaignId: string;
  scope: Scope;
  content: string;
  note?: string;
  author: string;
  activate?: boolean;
}): Promise<PromptVersion> {
  const db = await getDb();
  const { rows: maxRows } = await db.query<{ max: number | null }>(
    `SELECT MAX(version) AS max FROM prompt_versions WHERE campaign_id = $1 AND scope = $2`,
    [input.campaignId, input.scope],
  );
  const version = (Number(maxRows[0]?.max ?? 0) || 0) + 1;
  const id = crypto.randomUUID();
  const activate = input.activate ?? true;

  if (activate) {
    await db.query(
      `UPDATE prompt_versions SET active = false
        WHERE campaign_id = $1 AND scope = $2 AND active`,
      [input.campaignId, input.scope],
    );
  }

  const { rows } = await db.query<PromptVersion>(
    `INSERT INTO prompt_versions (id, campaign_id, scope, version, content, note, author, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      input.campaignId,
      input.scope,
      version,
      input.content,
      input.note ?? "",
      input.author,
      activate,
    ],
  );

  await logEvent({
    campaignId: input.campaignId,
    level: "action",
    type: "prompt.saved",
    message: `${input.author} saved ${input.scope} prompt v${version}${activate ? " and activated it" : ""}`,
    data: { scope: input.scope, version, note: input.note ?? "" },
  });
  return rows[0];
}

/** Used for both "activate" and "roll back" — the same operation either way. */
export async function activateVersion(
  campaignId: string,
  versionId: string,
  actor: string,
): Promise<PromptVersion | null> {
  const db = await getDb();
  const { rows: target } = await db.query<PromptVersion>(
    `SELECT * FROM prompt_versions WHERE id = $1 AND campaign_id = $2`,
    [versionId, campaignId],
  );
  if (!target[0]) return null;

  await db.query(
    `UPDATE prompt_versions SET active = false
      WHERE campaign_id = $1 AND scope = $2 AND active`,
    [campaignId, target[0].scope],
  );
  const { rows } = await db.query<PromptVersion>(
    `UPDATE prompt_versions SET active = true WHERE id = $1 RETURNING *`,
    [versionId],
  );
  await logEvent({
    campaignId,
    level: "action",
    type: "prompt.activated",
    message: `${actor} activated ${target[0].scope} prompt v${target[0].version}`,
    data: { scope: target[0].scope, version: target[0].version },
  });
  return rows[0];
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface ResolvedHarness extends HarnessStamp {
  campaignPrompt: string;
  agentPrompt: string;
  /** What actually goes in the system slot: campaign policy, then agent role. */
  system: string;
}

/**
 * Resolves the harness for one (campaign, agent) pair at this instant. The
 * returned `harness_hash` covers both prompts, so any edit to either one
 * produces a visibly different stamp on subsequent runs.
 */
export async function resolveHarness(
  campaignId: string,
  agent: AgentKey,
): Promise<ResolvedHarness> {
  const [campaignPrompt, agentPrompt] = await Promise.all([
    getActive(campaignId, "campaign"),
    getActive(campaignId, agent),
  ]);

  const campaignText = campaignPrompt?.content ?? "";
  const agentText = agentPrompt?.content ?? "";
  const system = [campaignText, agentText].filter(Boolean).join("\n\n---\n\n");

  return {
    campaignPrompt: campaignText,
    agentPrompt: agentText,
    system,
    // The agent-scoped version is the one attributed to the run; the campaign
    // prompt version is recorded alongside it.
    prompt_version_id: agentPrompt?.id ?? campaignPrompt?.id ?? null,
    harness_hash: hash(system),
    campaign_prompt_version: campaignPrompt?.version ?? 0,
    agent_prompt_version: agentPrompt?.version ?? 0,
  };
}
