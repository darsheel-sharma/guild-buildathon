/**
 * Campaign knowledge and retrieval.
 *
 * Chunks are scoped: `campaign_id = NULL` is global (company boilerplate,
 * compliance rules), a set id is campaign-private (that ICP's playbook,
 * objection handling, example emails). A retrieval for campaign X sees global
 * plus X, never campaign Y — the same isolation rule as prompts.
 *
 * Agents call `retrieve()` before generating anything customer-facing, and the
 * chunks that came back are stored on the agent run so a manager can see what
 * the copy was actually grounded in.
 */
import { getDb } from "@/core/db/client";
import type { RetrievedChunk } from "@/core/types";
import { embed, toVector } from "./embedding";

export interface KnowledgeDoc {
  id: string;
  campaign_id: string | null;
  title: string;
  kind: string;
  body: string;
}

/** Paragraph-level chunking: these documents are short and already sectioned. */
function chunk(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);
}

export async function addDoc(input: {
  campaignId: string | null;
  title: string;
  kind: string;
  body: string;
}): Promise<string> {
  const db = await getDb();
  const docId = crypto.randomUUID();
  await db.query(
    `INSERT INTO knowledge_docs (id, campaign_id, title, kind, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [docId, input.campaignId, input.title, input.kind, input.body],
  );

  const parts = chunk(input.body);
  for (const [i, content] of parts.entries()) {
    // Title and kind ride along in the embedded text so a query like
    // "objection handling" matches the chunk even when the body never says it.
    const vector = await embed(`${input.title} [${input.kind}] ${content}`);
    await db.query(
      `INSERT INTO knowledge_chunks
         (id, doc_id, campaign_id, kind, title, ordinal, content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(),
        docId,
        input.campaignId,
        input.kind,
        input.title,
        i,
        content,
        toVector(vector),
      ],
    );
  }
  return docId;
}

export async function retrieve(opts: {
  campaignId: string;
  query: string;
  limit?: number;
  kinds?: string[];
}): Promise<RetrievedChunk[]> {
  const db = await getDb();
  const vector = toVector(await embed(opts.query));
  const limit = opts.limit ?? 4;

  const kindFilter = opts.kinds?.length ? `AND kind = ANY($4)` : "";
  const params: unknown[] = [vector, opts.campaignId, limit];
  if (opts.kinds?.length) params.push(opts.kinds);

  const { rows } = await db.query<RetrievedChunk>(
    `SELECT id, title, kind, content,
            1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_chunks
      WHERE (campaign_id = $2 OR campaign_id IS NULL)
        AND embedding IS NOT NULL
        ${kindFilter}
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    params,
  );

  // A near-zero score means nothing in the knowledge base is relevant. Passing
  // it to the model as "context" is how hallucinated case studies happen, so
  // weak matches are dropped instead.
  return rows
    .map((r) => ({ ...r, similarity: Number(r.similarity) }))
    .filter((r) => r.similarity > 0.05);
}

export async function listDocs(campaignId: string): Promise<(KnowledgeDoc & { chunks: number })[]> {
  const db = await getDb();
  const { rows } = await db.query<KnowledgeDoc & { chunks: number }>(
    `SELECT d.id, d.campaign_id, d.title, d.kind, d.body,
            (SELECT COUNT(*)::int FROM knowledge_chunks c WHERE c.doc_id = d.id) AS chunks
       FROM knowledge_docs d
      WHERE d.campaign_id = $1 OR d.campaign_id IS NULL
      ORDER BY d.campaign_id NULLS FIRST, d.kind, d.title`,
    [campaignId],
  );
  return rows;
}

/** Compact context block for a prompt, with provenance the model can cite. */
export function formatContext(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return "(no relevant knowledge found — do not invent specifics)";
  return chunks
    .map((c, i) => `[${i + 1}] ${c.title} (${c.kind}, score ${c.similarity.toFixed(2)})\n${c.content}`)
    .join("\n\n");
}
