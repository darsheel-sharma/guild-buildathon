/**
 * The orchestrator: the loop that makes a campaign's config actually happen.
 *
 * A tick walks one campaign's queue in priority order — replies first, because
 * a waiting human beats a cold prospect — and runs the right agent for each
 * item. Three rules hold throughout:
 *
 *   1. `gate()` is re-checked before every step and again immediately before
 *      every send. A pause mid-tick stops the next step, not the next tick.
 *   2. Nothing leaves the platform without passing `checkBeforeContact`.
 *   3. Every step is recorded — as an agent run, a message, an event, or all
 *      three — so the dashboard is a view of reality rather than a summary.
 *
 * Agents are stateless; all durable state is the rows this file writes.
 */
import { getDb } from "@/core/db/client";
import { decideFollowup } from "@/agents/followup";
import { draftMessage } from "@/agents/personalise";
import { planOutreach } from "@/agents/outreach";
import { qualifyProspect } from "@/agents/qualify";
import { readReply } from "@/agents/converse";
import { researchProspect } from "@/agents/research";
import { planCall } from "@/agents/voice";
import { getCampaign, sendingIdentity } from "@/core/platform/campaigns";
import { send } from "@/core/platform/channels";
import { materialiseReplies } from "@/core/platform/channels/inbound";
import { canSend, gate } from "@/core/platform/control";
import { checkBeforeContact } from "@/core/platform/conflicts";
import { logEvent } from "@/core/platform/events";
import type { Mode } from "@/core/platform/llm";
import type {
  AgentKey,
  Campaign,
  Channel,
  Prospect,
  ResearchOutput,
} from "@/core/types";

export interface StepLog {
  agent: AgentKey | "platform";
  prospect: string;
  action: string;
  detail: string;
  status: "ok" | "skipped" | "blocked" | "error";
  mode?: Mode;
}

export interface TickResult {
  campaignId: string;
  campaignName: string;
  ran: boolean;
  blocked?: { reason: string; detail: string };
  steps: StepLog[];
  repliesReceived: number;
  costUsd: number;
}

interface WorkRow {
  cp_id: string;
  stage: string;
  touches: number;
  last_channel: Channel | null;
  last_touch_at: string | null;
  icp_score: string | number | null;
  research: ResearchOutput | null;
  prospect_id: string;
  email: string;
  full_name: string;
  title: string;
  company: string;
  company_domain: string;
  industry: string;
  geography: string;
  employee_count: number;
  linkedin_url: string;
  phone: string;
  source: string;
}

const PROSPECT_COLUMNS = `
  cp.id AS cp_id, cp.stage, cp.touches, cp.last_channel, cp.last_touch_at,
  cp.icp_score, cp.research,
  p.id AS prospect_id, p.email, p.full_name, p.title, p.company,
  p.company_domain, p.industry, p.geography, p.employee_count,
  p.linkedin_url, p.phone, p.source`;

function toProspect(row: WorkRow): Prospect {
  return {
    id: row.prospect_id,
    email: row.email,
    full_name: row.full_name,
    title: row.title,
    company: row.company,
    company_domain: row.company_domain,
    industry: row.industry,
    geography: row.geography,
    employee_count: Number(row.employee_count),
    linkedin_url: row.linkedin_url,
    phone: row.phone,
    source: row.source,
  };
}

async function setStage(cpId: string, stage: string, patch: Record<string, unknown> = {}) {
  const db = await getDb();
  const sets = ["stage = $2", "updated_at = now()"];
  const params: unknown[] = [cpId, stage];
  for (const [key, value] of Object.entries(patch)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  await db.query(`UPDATE campaign_prospects SET ${sets.join(", ")} WHERE id = $1`, params);
}

async function createApproval(input: {
  campaignId: string;
  cpId: string;
  kind: string;
  reason: string;
  payload: Record<string, unknown>;
}) {
  const db = await getDb();
  await db.query(
    `INSERT INTO approvals (id, campaign_id, campaign_prospect_id, kind, reason, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      crypto.randomUUID(),
      input.campaignId,
      input.cpId,
      input.kind,
      input.reason,
      JSON.stringify(input.payload),
    ],
  );
}

// ── outbound ───────────────────────────────────────────────────────────────

/**
 * Draft and deliver one touch. Returns a step log; the caller does not need to
 * know which channel or agent was involved.
 */
async function deliverTouch(
  campaign: Campaign,
  row: WorkRow,
  opts: {
    channel: Channel;
    sequenceStep: number;
    objection?: string;
    /** engaged prospects stay engaged; cold ones move to contacted */
    nextStage: string;
    /**
     * 'reply' skips the cold-outreach checks but still honours opt-outs and the
     * daily budget. The caller in phaseOutreach has already run the full cold
     * check, so it passes 'prechecked' to avoid recording a conflict twice.
     */
    guard: "reply" | "prechecked";
  },
): Promise<{ step: StepLog; cost: number }> {
  const prospect = toProspect(row);
  const identity = await sendingIdentity(campaign.id);

  // Every send passes the platform guard, whichever path reached it. A reply
  // to someone who has since opted out must not go out either.
  if (opts.guard === "reply") {
    const decision = await checkBeforeContact({
      campaignId: campaign.id,
      prospectId: prospect.id,
      context: "reply",
    });
    if (decision.verdict !== "allow") {
      return {
        cost: 0,
        step: {
          agent: "platform",
          prospect: prospect.full_name,
          action: `reply withheld (${decision.reason})`,
          detail: decision.detail,
          status: "blocked",
        },
      };
    }
  }

  // Re-check the gate for this specific channel, right before we commit to it.
  const channelGate = await canSend(campaign.id, opts.channel);
  if (!channelGate.allowed) {
    return {
      cost: 0,
      step: {
        agent: "platform",
        prospect: prospect.full_name,
        action: `hold ${opts.channel}`,
        detail: channelGate.detail ?? channelGate.reason ?? "blocked",
        status: "blocked",
      },
    };
  }

  let subject = "";
  let body = "";
  let cost = 0;
  let mode: Mode = "simulated";
  let agent: AgentKey = "personalise";

  if (opts.channel === "voice") {
    agent = "voice";
    const plan = await planCall(campaign, prospect, {
      campaignProspectId: row.cp_id,
      research: row.research,
      senderName: identity.name,
    });
    body = plan.output.opening;
    cost += plan.costUsd;
    mode = plan.mode;
  } else {
    const draft = await draftMessage(campaign, prospect, {
      campaignProspectId: row.cp_id,
      channel: opts.channel,
      sequenceStep: opts.sequenceStep,
      research: row.research,
      senderName: identity.name,
      senderTitle: identity.title,
      objection: opts.objection,
    });
    subject = draft.output.subject;
    body = draft.output.body;
    cost += draft.costUsd;
    mode = draft.mode;
  }

  // Human-in-the-loop: an approval-required campaign queues the draft instead
  // of sending it. Nothing is delivered until someone decides.
  if (campaign.autonomy === "approval_required") {
    await createApproval({
      campaignId: campaign.id,
      cpId: row.cp_id,
      kind: "outbound_message",
      reason: `${opts.channel} step ${opts.sequenceStep} awaiting approval`,
      payload: { channel: opts.channel, subject, body },
    });
    await setStage(row.cp_id, row.stage, { next_action: "awaiting_approval" });
    return {
      cost,
      step: {
        agent,
        prospect: prospect.full_name,
        action: "queued for approval",
        detail: `${opts.channel} draft held: campaign runs in approval-required mode`,
        status: "skipped",
        mode,
      },
    };
  }

  const result = await send({
    channel: opts.channel,
    to: {
      name: prospect.full_name,
      email: prospect.email,
      phone: prospect.phone,
      linkedin: prospect.linkedin_url,
    },
    from: identity,
    subject,
    body,
    seed: `${row.cp_id}:${opts.sequenceStep}`,
  });

  const db = await getDb();
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, campaign_prospect_id, direction, channel, subject, body,
        status, provider, provider_ref, sequence_step, handled)
     VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8,$9,$10,false)`,
    [
      crypto.randomUUID(),
      campaign.id,
      row.cp_id,
      opts.channel,
      subject,
      result.transcript ? `${body}\n\n${result.transcript}` : body,
      result.status,
      result.provider,
      result.providerRef,
      opts.sequenceStep,
    ],
  );

  if (result.status === "failed") {
    await logEvent({
      campaignId: campaign.id,
      level: "error",
      type: "outreach.failed",
      message: `${opts.channel} send failed for ${prospect.full_name}`,
      data: { error: result.error },
    });
    return {
      cost,
      step: {
        agent,
        prospect: prospect.full_name,
        action: `${opts.channel} send failed`,
        detail: result.error ?? "provider error",
        status: "error",
        mode,
      },
    };
  }

  await setStage(row.cp_id, opts.nextStage, {
    touches: row.touches + 1,
    last_touch_at: new Date().toISOString(),
    last_channel: opts.channel,
    next_action: "await_reply",
    blocked_reason: null,
  });

  return {
    cost,
    step: {
      agent,
      prospect: prospect.full_name,
      action: `sent ${opts.channel}`,
      detail: subject || body.slice(0, 80),
      status: "ok",
      mode,
    },
  };
}

// ── phases ─────────────────────────────────────────────────────────────────

async function phaseReplies(campaign: Campaign, budget: number): Promise<{ steps: StepLog[]; cost: number }> {
  const steps: StepLog[] = [];
  let cost = 0;
  if (budget <= 0) return { steps, cost };

  const db = await getDb();
  const { rows } = await db.query<WorkRow & { msg_id: string; msg_body: string; msg_channel: Channel }>(
    `SELECT ${PROSPECT_COLUMNS}, m.id AS msg_id, m.body AS msg_body, m.channel AS msg_channel
       FROM messages m
       JOIN campaign_prospects cp ON cp.id = m.campaign_prospect_id
       JOIN prospects p ON p.id = cp.prospect_id
      WHERE m.campaign_id = $1 AND m.direction = 'inbound' AND NOT m.handled
      ORDER BY m.created_at ASC
      LIMIT $2`,
    [campaign.id, budget],
  );

  for (const row of rows) {
    const g = await gate({ campaignId: campaign.id, agent: "converse" });
    if (!g.allowed) {
      steps.push({
        agent: "converse",
        prospect: row.full_name,
        action: "reply not read",
        detail: g.detail ?? "gate closed",
        status: "blocked",
      });
      break;
    }

    const prospect = toProspect(row);
    const reading = await readReply(campaign, prospect, {
      campaignProspectId: row.cp_id,
      channel: row.msg_channel,
      replyBody: row.msg_body,
      threadSummary: `${row.touches} outbound touches, last on ${row.last_channel ?? "email"}`,
    });
    cost += reading.costUsd;

    await db.query(`UPDATE messages SET handled = true, sentiment = $2, intent = $3 WHERE id = $1`, [
      row.msg_id,
      reading.output.sentiment,
      reading.output.intent,
    ]);

    const action = reading.output.next_action;

    // A prospect who has already reached a meeting is a human's relationship
    // now. A later message can add information, but it must not silently
    // demote a booked meeting back down the funnel — that decision is escalated.
    if (row.stage === "meeting" || row.stage === "opportunity") {
      await createApproval({
        campaignId: campaign.id,
        cpId: row.cp_id,
        kind: "handoff",
        reason: `New ${reading.output.intent} reply on an account that already has a meeting: ${reading.output.reasoning}`,
        payload: { intent: reading.output.intent, reply: row.msg_body.slice(0, 500) },
      });
      steps.push({
        agent: "converse",
        prospect: prospect.full_name,
        action: "escalated, meeting already booked",
        detail: reading.output.reasoning,
        status: "ok",
        mode: reading.mode,
      });
      continue;
    }

    if (action === "stop") {
      // An opt-out is a platform-level fact, not a campaign-level one.
      if (reading.output.intent === "unsubscribe") {
        await db.query(
          `INSERT INTO suppression_list (id, email, reason)
           VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
          [crypto.randomUUID(), prospect.email, "opted out by reply"],
        );
      }
      await setStage(row.cp_id, "stopped", {
        outcome: reading.output.intent,
        next_action: null,
        blocked_reason: reading.output.reasoning,
      });
      await logEvent({
        campaignId: campaign.id,
        level: "warn",
        type: "conversation.stopped",
        message: `${prospect.full_name}: ${reading.output.intent} — sequence stopped`,
        data: { intent: reading.output.intent },
      });
      steps.push({
        agent: "converse",
        prospect: prospect.full_name,
        action: `stop (${reading.output.intent})`,
        detail: reading.output.reasoning,
        status: "ok",
        mode: reading.mode,
      });
      continue;
    }

    if (action === "book_meeting" || action === "escalate") {
      await createApproval({
        campaignId: campaign.id,
        cpId: row.cp_id,
        kind: action === "book_meeting" ? "book_meeting" : "handoff",
        reason: reading.output.reasoning,
        payload: { intent: reading.output.intent, reply: row.msg_body.slice(0, 500) },
      });
      await setStage(row.cp_id, action === "book_meeting" ? "meeting" : "engaged", {
        outcome: reading.output.intent,
        next_action: action === "book_meeting" ? "confirm_meeting" : "human_handoff",
      });
      await logEvent({
        campaignId: campaign.id,
        level: "action",
        type: `conversation.${action}`,
        message: `${prospect.full_name}: ${reading.output.intent} — escalated to a human`,
        data: { intent: reading.output.intent },
      });
      steps.push({
        agent: "converse",
        prospect: prospect.full_name,
        action: action === "book_meeting" ? "meeting → awaiting rep" : "escalated to rep",
        detail: reading.output.reasoning,
        status: "ok",
        mode: reading.mode,
      });
      continue;
    }

    // handle_objection / send_info / follow_up all mean: reply on the same
    // channel, with the objection (if any) fed to the writer.
    await setStage(row.cp_id, "engaged", { outcome: reading.output.intent });
    const touch = await deliverTouch(campaign, { ...row, stage: "engaged" }, {
      channel: row.msg_channel,
      sequenceStep: row.touches + 1,
      objection: reading.output.objection,
      nextStage: "engaged",
      guard: "reply",
    });
    cost += touch.cost;
    steps.push({
      agent: "converse",
      prospect: prospect.full_name,
      action: `${reading.output.intent} → ${action}`,
      detail: reading.output.reasoning,
      status: "ok",
      mode: reading.mode,
    });
    steps.push(touch.step);
  }

  return { steps, cost };
}

async function phaseResearch(campaign: Campaign, budget: number): Promise<{ steps: StepLog[]; cost: number }> {
  const steps: StepLog[] = [];
  let cost = 0;
  if (budget <= 0) return { steps, cost };

  const db = await getDb();
  const { rows } = await db.query<WorkRow>(
    `SELECT ${PROSPECT_COLUMNS}
       FROM campaign_prospects cp JOIN prospects p ON p.id = cp.prospect_id
      WHERE cp.campaign_id = $1 AND cp.stage = 'discovered'
      ORDER BY cp.created_at LIMIT $2`,
    [campaign.id, budget],
  );

  for (const row of rows) {
    const g = await gate({ campaignId: campaign.id, agent: "research" });
    if (!g.allowed) {
      steps.push({
        agent: "research",
        prospect: row.full_name,
        action: "research skipped",
        detail: g.detail ?? "gate closed",
        status: "blocked",
      });
      break;
    }
    const out = await researchProspect(campaign, toProspect(row), row.cp_id);
    cost += out.costUsd;
    await setStage(row.cp_id, "researched", {
      research: JSON.stringify(out.output),
      next_action: "qualify",
    });
    steps.push({
      agent: "research",
      prospect: row.full_name,
      action: "researched",
      detail: out.output.company_summary.slice(0, 90),
      status: "ok",
      mode: out.mode,
    });
  }
  return { steps, cost };
}

async function phaseQualify(campaign: Campaign, budget: number): Promise<{ steps: StepLog[]; cost: number }> {
  const steps: StepLog[] = [];
  let cost = 0;
  if (budget <= 0) return { steps, cost };

  const db = await getDb();
  const { rows } = await db.query<WorkRow>(
    `SELECT ${PROSPECT_COLUMNS}
       FROM campaign_prospects cp JOIN prospects p ON p.id = cp.prospect_id
      WHERE cp.campaign_id = $1 AND cp.stage = 'researched'
        AND (cp.next_action IS NULL OR cp.next_action <> 'awaiting_review')
      ORDER BY cp.created_at LIMIT $2`,
    [campaign.id, budget],
  );

  for (const row of rows) {
    const g = await gate({ campaignId: campaign.id, agent: "qualify" });
    if (!g.allowed) {
      steps.push({
        agent: "qualify",
        prospect: row.full_name,
        action: "qualification skipped",
        detail: g.detail ?? "gate closed",
        status: "blocked",
      });
      break;
    }
    const out = await qualifyProspect(campaign, toProspect(row), row.research, row.cp_id);
    cost += out.costUsd;
    const { score, verdict, reasons } = out.output;

    if (verdict === "needs_review") {
      await createApproval({
        campaignId: campaign.id,
        cpId: row.cp_id,
        kind: "qualification",
        reason: `Borderline fit at ${score} (threshold ${campaign.qualification_threshold})`,
        payload: { score, reasons },
      });
      await setStage(row.cp_id, "researched", {
        icp_score: score,
        icp_verdict: verdict,
        icp_reasons: JSON.stringify(reasons),
        next_action: "awaiting_review",
      });
    } else {
      await setStage(row.cp_id, verdict === "qualified" ? "qualified" : "rejected", {
        icp_score: score,
        icp_verdict: verdict,
        icp_reasons: JSON.stringify(reasons),
        next_action: verdict === "qualified" ? "outreach" : null,
      });
    }

    steps.push({
      agent: "qualify",
      prospect: row.full_name,
      action: verdict,
      detail: `${score} — ${reasons[0] ?? ""}`,
      status: "ok",
      mode: out.mode,
    });
  }
  return { steps, cost };
}

async function phaseOutreach(campaign: Campaign, budget: number): Promise<{ steps: StepLog[]; cost: number }> {
  const steps: StepLog[] = [];
  let cost = 0;
  if (budget <= 0) return { steps, cost };

  const db = await getDb();
  // Fresh qualified prospects first, then contacted ones due a follow-up.
  const { rows } = await db.query<WorkRow>(
    `SELECT ${PROSPECT_COLUMNS}
       FROM campaign_prospects cp JOIN prospects p ON p.id = cp.prospect_id
      WHERE cp.campaign_id = $1
        AND cp.stage IN ('qualified', 'contacted')
        AND (cp.next_action_at IS NULL OR cp.next_action_at <= now())
        AND (cp.next_action IS NULL OR cp.next_action <> 'awaiting_approval')
      ORDER BY cp.touches ASC, cp.icp_score DESC NULLS LAST
      LIMIT $2`,
    [campaign.id, budget],
  );

  for (const row of rows) {
    const prospect = toProspect(row);
    const score = Number(row.icp_score ?? 0);

    const g = await gate({ campaignId: campaign.id, agent: "outreach" });
    if (!g.allowed) {
      steps.push({
        agent: "outreach",
        prospect: prospect.full_name,
        action: "outreach skipped",
        detail: g.detail ?? "gate closed",
        status: "blocked",
      });
      break;
    }

    // A prospect already in a sequence goes through the follow-up agent first:
    // it owns the "is it time yet, and should we stop" decision.
    if (row.touches > 0) {
      const days = row.last_touch_at
        ? (Date.now() - new Date(row.last_touch_at).getTime()) / 86_400_000
        : 99;
      const { rows: replied } = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM messages
          WHERE campaign_prospect_id = $1 AND direction = 'inbound'`,
        [row.cp_id],
      );
      const decision = await decideFollowup(campaign, prospect, {
        campaignProspectId: row.cp_id,
        touches: row.touches,
        daysSinceLastTouch: days,
        everReplied: (replied[0]?.n ?? 0) > 0,
      });
      cost += decision.costUsd;

      if (decision.output.action === "stop") {
        await setStage(row.cp_id, "stopped", {
          next_action: null,
          blocked_reason: decision.output.reasoning,
        });
        steps.push({
          agent: "followup",
          prospect: prospect.full_name,
          action: "sequence stopped",
          detail: decision.output.reasoning,
          status: "ok",
          mode: decision.mode,
        });
        continue;
      }
      if (decision.output.action === "wait") {
        await setStage(row.cp_id, row.stage, {
          next_action_at: new Date(Date.now() + decision.output.wait_days * 86_400_000).toISOString(),
          next_action: "follow_up",
        });
        steps.push({
          agent: "followup",
          prospect: prospect.full_name,
          action: `waiting ${decision.output.wait_days}d`,
          detail: decision.output.reasoning,
          status: "skipped",
          mode: decision.mode,
        });
        continue;
      }
    }

    const plan = await planOutreach(campaign, prospect, {
      campaignProspectId: row.cp_id,
      touches: row.touches,
      lastChannel: row.last_channel,
      lastTouchAt: row.last_touch_at,
      icpScore: score,
      research: row.research,
    });
    cost += plan.costUsd;

    if (!plan.output.should_contact) {
      await setStage(row.cp_id, row.stage, {
        next_action_at: new Date(Date.now() + plan.output.wait_days * 86_400_000).toISOString(),
        next_action: "follow_up",
      });
      steps.push({
        agent: "outreach",
        prospect: prospect.full_name,
        action: `hold ${plan.output.wait_days}d`,
        detail: plan.output.rationale,
        status: "skipped",
        mode: plan.mode,
      });
      continue;
    }

    // Platform-level guard. This is where duplicate outreach, the global
    // suppression list and frequency caps actually bite.
    const decision = await checkBeforeContact({
      campaignId: campaign.id,
      prospectId: prospect.id,
    });
    if (decision.verdict !== "allow") {
      await setStage(row.cp_id, decision.verdict === "block" ? "stopped" : row.stage, {
        blocked_reason: `${decision.reason}: ${decision.detail}`,
        next_action_at: decision.retryAt ?? null,
        next_action: decision.verdict === "defer" ? "retry" : null,
      });
      steps.push({
        agent: "platform",
        prospect: prospect.full_name,
        action: `${decision.verdict} (${decision.reason})`,
        detail: decision.detail,
        status: "blocked",
      });
      continue;
    }

    const touch = await deliverTouch(campaign, row, {
      channel: plan.output.channel,
      sequenceStep: plan.output.sequence_step,
      nextStage: "contacted",
      guard: "prechecked",
    });
    cost += touch.cost;
    steps.push(touch.step);
  }

  return { steps, cost };
}

// ── tick ───────────────────────────────────────────────────────────────────

/**
 * Advance one campaign by up to `budget` units of work. Safe to call on any
 * campaign in any state: a non-live campaign returns `ran: false` with the
 * reason, which is exactly what the "pausing one does not stop the others"
 * demonstration relies on.
 */
export async function tick(campaignId: string, budget = 8): Promise<TickResult> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    return {
      campaignId,
      campaignName: "(unknown)",
      ran: false,
      blocked: { reason: "not_found", detail: "campaign does not exist" },
      steps: [],
      repliesReceived: 0,
      costUsd: 0,
    };
  }

  const g = await gate({ campaignId });
  if (!g.allowed) {
    return {
      campaignId,
      campaignName: campaign.name,
      ran: false,
      blocked: { reason: g.reason ?? "blocked", detail: g.detail ?? "" },
      steps: [],
      repliesReceived: 0,
      costUsd: 0,
    };
  }

  const repliesReceived = await materialiseReplies(campaign.id);

  const steps: StepLog[] = [];
  let cost = 0;
  let remaining = budget;

  for (const phase of [phaseReplies, phaseResearch, phaseQualify, phaseOutreach]) {
    if (remaining <= 0) break;
    const result = await phase(campaign, remaining);
    steps.push(...result.steps);
    cost += result.cost;
    remaining -= result.steps.filter((s) => s.status === "ok").length;
  }

  await logEvent({
    campaignId: campaign.id,
    level: "info",
    type: "tick.completed",
    message: `Tick ran ${steps.filter((s) => s.status === "ok").length} actions${
      repliesReceived ? `, ${repliesReceived} replies arrived` : ""
    }`,
    data: { steps: steps.length, cost },
  });

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    ran: true,
    steps,
    repliesReceived,
    costUsd: cost,
  };
}

/** Ticks every live campaign. Paused and draft campaigns report why they were skipped. */
export async function tickAll(budget = 6): Promise<TickResult[]> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM campaigns WHERE status IN ('live', 'paused', 'draft') ORDER BY created_at`,
  );
  const results: TickResult[] = [];
  for (const row of rows) {
    results.push(await tick(row.id, budget));
  }
  return results;
}
