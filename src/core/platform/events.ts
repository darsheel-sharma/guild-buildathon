/** Append-only activity log. Everything the manager sees in the feed. */
import { getDb } from "@/core/db/client";

export type EventLevel = "info" | "warn" | "error" | "action";

export interface EventRow {
  id: string;
  campaign_id: string | null;
  level: EventLevel;
  type: string;
  message: string;
  data: Record<string, unknown>;
  created_at: string;
}

export async function logEvent(input: {
  campaignId?: string | null;
  level?: EventLevel;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO events (id, campaign_id, level, type, message, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      crypto.randomUUID(),
      input.campaignId ?? null,
      input.level ?? "info",
      input.type,
      input.message,
      JSON.stringify(input.data ?? {}),
    ],
  );
}

export async function listEvents(campaignId: string | null, limit = 40): Promise<EventRow[]> {
  const db = await getDb();
  const { rows } = campaignId
    ? await db.query<EventRow>(
        `SELECT * FROM events WHERE campaign_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [campaignId, limit],
      )
    : await db.query<EventRow>(
        `SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT $1`,
        [limit],
      );
  return rows;
}
