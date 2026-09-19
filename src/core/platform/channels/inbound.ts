/**
 * Inbound simulation.
 *
 * Real deployments receive replies through provider webhooks (Gmail push,
 * Twilio status callbacks, the LinkedIn worker). Those paths write straight
 * into `messages` with direction 'inbound'.
 *
 * Offline there are no webhooks, so this module manufactures replies for
 * messages that were sent on a *simulated* transport — never for a live one,
 * where inventing a reply would be a lie about a real prospect. Outcomes are
 * seeded off the message id, so the same demo replays identically.
 */
import { getDb } from "@/core/db/client";
import type { Channel } from "@/core/types";
import { rngFor } from "../llm";

interface Pending {
  id: string;
  campaign_id: string;
  campaign_prospect_id: string;
  channel: Channel;
  subject: string;
  full_name: string;
  company: string;
}

type ReplyKind = "meeting" | "interested" | "objection" | "referral" | "decline" | "unsubscribe";

const WEIGHTS: [ReplyKind, number][] = [
  ["meeting", 0.16],
  ["interested", 0.2],
  ["objection", 0.26],
  ["referral", 0.1],
  ["decline", 0.22],
  ["unsubscribe", 0.06],
];

function pickKind(r: number): ReplyKind {
  let acc = 0;
  for (const [kind, weight] of WEIGHTS) {
    acc += weight;
    if (r <= acc) return kind;
  }
  return "decline";
}

function bodyFor(kind: ReplyKind, p: Pending): string {
  const first = p.full_name.split(" ")[0];
  switch (kind) {
    case "meeting":
      return `Happy to talk. Tuesday or Thursday afternoon works on my side — send an invite and I will make sure my platform lead joins too.\n\n${first}`;
    case "interested":
      return `This is timely. Can you send over how the rollout usually looks and whether you have anyone in our segment live today?\n\n${first}`;
    case "objection":
      return `We already run something similar in-house at ${p.company}, and the last vendor review stalled on data residency. Hard to justify another tool this quarter.\n\n${first}`;
    case "referral":
      return `Not my area any more — ${first === "Priya" ? "Arun" : "Meera"} now owns this. I have copied them; talk to them directly.`;
    case "decline":
      return `Thanks, but this is not a priority for us right now.`;
    case "unsubscribe":
      return `Please remove me from your list and do not contact me again.`;
  }
}

/**
 * Materialises replies that are "due": one tick after the outbound message,
 * for simulated sends that have not been replied to yet.
 * Returns how many arrived.
 */
export async function materialiseReplies(campaignId: string, limit = 6): Promise<number> {
  const db = await getDb();
  const { rows: pending } = await db.query<Pending>(
    `SELECT m.id, m.campaign_id, m.campaign_prospect_id, m.channel, m.subject,
            p.full_name, p.company
       FROM messages m
       JOIN campaign_prospects cp ON cp.id = m.campaign_prospect_id
       JOIN prospects p ON p.id = cp.prospect_id
      WHERE m.campaign_id = $1
        AND m.direction = 'outbound'
        AND m.provider LIKE 'simulated%'
        -- On an outbound row, handled means the simulator has already decided
        -- whether this message gets a reply. Without it, the oldest messages
        -- that lost their coin flip would be re-evaluated with the same seed on
        -- every tick and, because the flip is deterministic, would fail forever
        -- while occupying the whole LIMIT window -- so no later message would
        -- ever be considered.
        AND NOT m.handled
        AND cp.stage NOT IN ('rejected', 'stopped', 'meeting', 'opportunity')
        -- A real prospect does not reply forever. Two inbound messages is the
        -- ceiling per thread, which also stops an endless send/reply loop.
        AND (
          SELECT COUNT(*) FROM messages r
           WHERE r.campaign_prospect_id = m.campaign_prospect_id
             AND r.direction = 'inbound'
        ) < 2
      ORDER BY m.created_at ASC
      LIMIT $2`,
    [campaignId, limit],
  );

  let arrived = 0;
  for (const msg of pending) {
    // Decided exactly once per outbound message, whichever way it goes.
    await db.query(`UPDATE messages SET handled = true WHERE id = $1`, [msg.id]);

    const rng = rngFor(`reply:${msg.id}`);
    // Roughly a third of touches get any response at all.
    if (!rng.chance(0.34)) continue;
    const kind = pickKind(rng.next());
    await db.query(
      `INSERT INTO messages
         (id, campaign_id, campaign_prospect_id, direction, channel, subject, body,
          status, provider, provider_ref)
       VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'received', 'simulated-inbound', $7)`,
      [
        crypto.randomUUID(),
        msg.campaign_id,
        msg.campaign_prospect_id,
        msg.channel,
        msg.subject ? `Re: ${msg.subject}` : "",
        bodyFor(kind, msg),
        `sim-in_${msg.id.slice(0, 8)}`,
      ],
    );
    arrived += 1;
  }
  return arrived;
}
