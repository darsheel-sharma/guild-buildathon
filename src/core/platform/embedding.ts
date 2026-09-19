/**
 * Embeddings for the knowledge layer.
 *
 * Two implementations behind one function:
 *
 *  - Live: a real embedding model through the AI Gateway when a key is present.
 *  - Local: a hashed bag-of-words projection. Deterministic, dependency-free
 *    and genuinely useful — cosine over hashed term frequencies behaves like a
 *    crude TF-IDF, so retrieval demonstrably ranks the right playbook chunk
 *    without any credential. It is not semantic, and the UI says so.
 *
 * EMBED_DIM is baked into the schema, so changing it needs a fresh database.
 */
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 256);

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "be", "been", "it", "that", "this", "as", "at", "by", "from",
  "we", "our", "you", "your", "they", "their", "has", "have", "but", "not",
]);

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** FNV-1a. Stable across processes, unlike String.prototype.hashCode games. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function localEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const tokens = tokenise(text);
  for (const token of tokens) {
    const h = hash(token);
    // Two buckets per token with opposite signs: halves the collision damage.
    vec[h % EMBED_DIM] += 1;
    vec[(h >>> 8) % EMBED_DIM] -= 0.5;
    // Bigram-ish boost so "objection handling" ranks above two loose matches.
    const stem = token.slice(0, 5);
    vec[hash(stem) % EMBED_DIM] += 0.4;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

export function hasLiveEmbeddings(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY) && Boolean(process.env.EMBED_MODEL);
}

export async function embed(text: string): Promise<number[]> {
  if (hasLiveEmbeddings()) {
    try {
      const { embed: aiEmbed } = await import("ai");
      const { embedding } = await aiEmbed({
        model: process.env.EMBED_MODEL as string,
        value: text,
      });
      if (embedding.length !== EMBED_DIM) {
        throw new Error(
          `EMBED_DIM is ${EMBED_DIM} but the model returned ${embedding.length}. ` +
            `Set EMBED_DIM=${embedding.length} and recreate the database.`,
        );
      }
      return embedding;
    } catch (err) {
      // A broken embedding provider must not take the whole campaign down.
      console.warn("[embedding] live call failed, using local projection:", err);
    }
  }
  return localEmbed(text);
}

/** pgvector accepts its literal as a bracketed string. */
export function toVector(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(6) : "0")).join(",")}]`;
}
