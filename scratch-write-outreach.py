path = "src/agents/outreach.ts"
s = open(path, encoding="utf-8").read()

old_imports = '''import { z } from "zod";
import type { Campaign, Channel, OutreachPlan, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentOutcome } from "./runtime";'''
new_imports = '''import { z } from "zod";
import type { Campaign, Channel, OutreachPlan, Prospect, ResearchOutput } from "@/core/types";
import { runAgent, type AgentContext, type AgentOutcome } from "./runtime";'''
assert old_imports in s
s = s.replace(old_imports, new_imports)

old_schema = '''const schema = z.object({
  channel: z.enum(["email", "linkedin", "sms", "voice"]),
  should_contact: z.boolean(),
  rationale: z.string().max(400),
  wait_days: z.number().min(0).max(30),
  sequence_step: z.number().min(1).max(10),
});'''
new_schema = '''const schema = z.object({
  channel: z.enum(["email", "linkedin", "sms", "voice"]),
  should_contact: z.boolean(),
  rationale: z.string().max(400),
  wait_days: z.number().min(0).max(30),
  sequence_step: z.number().min(1).max(10),
  action: z.enum(["contact", "wait", "skip", "escalate"]).optional(),
  reason: z.string().optional(),
  human_approval_required: z.boolean().optional(),
  angle: z.string().optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  flags: z.array(z.string()).optional(),
  planned_sequence: z.array(z.string()).optional(),
});

const VALID_CHANNELS = new Set(["email", "linkedin", "sms", "voice"]);

/**
 * The Outreach Strategy Agent built on DronaHQ answers with a richer decision
 * (action CONTACT/WAIT/SKIP/ESCALATE, an ISO send_at, a planned_sequence, a
 * machine-readable reason constant, human_approval_required) than this
 * codebase's OutreachPlan. The base five fields (channel/should_contact/
 * rationale/wait_days/sequence_step) are always derived so nothing existing
 * has to change; the richer fields ride along on the optional properties
 * added to OutreachPlan.
 *
 * Needs the enabled channels and last-used channel to pick a sensible
 * `channel` value for WAIT/SKIP/ESCALATE (DronaHQ's channel is null there),
 * so this is a factory rather than a standalone function.
 */
function makeOutreachNormalizer(opts: { enabled: Channel[]; lastChannel: Channel | null; step: number }) {
  const fallbackChannel: Channel =
    (opts.lastChannel && opts.enabled.length > 1
      ? opts.enabled.find((c) => c !== opts.lastChannel)
      : opts.enabled[0]) ?? opts.enabled[0] ?? "email";

  return function normalizeOutreachPlan(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    let obj = raw as Record<string, unknown>;

    // Already our shape — pass through untouched.
    if (
      typeof obj.channel === "string" &&
      VALID_CHANNELS.has(obj.channel) &&
      typeof obj.should_contact === "boolean" &&
      typeof obj.rationale === "string" &&
      typeof obj.wait_days === "number" &&
      typeof obj.sequence_step === "number"
    ) {
      return obj;
    }

    let freeText: string | null = null;
    if (typeof obj.response === "string") {
      const text = obj.response.trim();
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
        else throw new Error("not an object");
      } catch {
        freeText = text;
      }
    }

    if (freeText !== null) {
      const actionMatch = freeText.match(/\\b(CONTACT|WAIT|SKIP|ESCALATE)\\b/i);
      if (!actionMatch) {
        throw new Error(`DronaHQ Outreach Strategy Agent returned unparseable text: ${freeText.slice(0, 200)}`);
      }
      const action = actionMatch[1].toUpperCase();
      const channelMatch = freeText.match(/\\b(email|linkedin|sms|voice)\\b/i);
      const channel: Channel =
        channelMatch && VALID_CHANNELS.has(channelMatch[1].toLowerCase())
          ? (channelMatch[1].toLowerCase() as Channel)
          : fallbackChannel;
      return {
        channel,
        should_contact: action === "CONTACT",
        rationale: freeText.slice(0, 400),
        wait_days: action === "CONTACT" ? 0 : action === "WAIT" ? 1 : 30,
        sequence_step: opts.step,
        action: action.toLowerCase(),
        human_approval_required: action === "ESCALATE",
      };
    }

    const hasAnyPlanField =
      "action" in obj || "channel" in obj || "send_at" in obj || "planned_sequence" in obj || "reason" in obj;
    if (!hasAnyPlanField) {
      throw new Error(
        `DronaHQ Outreach Strategy Agent did not return a plan (got: ${JSON.stringify(obj).slice(0, 200)})`,
      );
    }

    const actionRaw = String(obj.action ?? "").toUpperCase();
    const action = ["CONTACT", "WAIT", "SKIP", "ESCALATE"].includes(actionRaw) ? actionRaw : "WAIT";

    const channelRaw = typeof obj.channel === "string" ? obj.channel.toLowerCase() : null;
    const channel: Channel = channelRaw && VALID_CHANNELS.has(channelRaw) ? (channelRaw as Channel) : fallbackChannel;

    let waitDays = 1;
    if (action === "CONTACT") {
      waitDays = 0;
    } else if (action === "WAIT" && typeof obj.send_at === "string") {
      const target = Date.parse(obj.send_at);
      if (Number.isFinite(target)) {
        waitDays = Math.max(0, Math.min(30, Math.ceil((target - Date.now()) / 86_400_000)));
      }
    } else if (action === "SKIP" || action === "ESCALATE") {
      waitDays = 30;
    }

    const rationale = [
      typeof obj.reasoning === "string" ? obj.reasoning : null,
      typeof obj.reason === "string" ? `reason: ${obj.reason}` : null,
    ]
      .filter((v): v is string => Boolean(v))
      .join(" ");

    return {
      channel,
      should_contact: action === "CONTACT",
      rationale: (rationale || `${action} decision from DronaHQ`).slice(0, 400),
      wait_days: waitDays,
      sequence_step: opts.step,
      action: action.toLowerCase(),
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
      human_approval_required:
        typeof obj.human_approval_required === "boolean" ? obj.human_approval_required : action === "ESCALATE",
      angle: typeof obj.angle === "string" ? obj.angle : undefined,
      priority:
        typeof obj.priority === "string" && ["high", "medium", "low"].includes(obj.priority.toLowerCase())
          ? (obj.priority.toLowerCase() as "high" | "medium" | "low")
          : undefined,
      flags: Array.isArray(obj.flags) ? obj.flags.filter((f): f is string => typeof f === "string") : undefined,
      planned_sequence: Array.isArray(obj.planned_sequence)
        ? obj.planned_sequence.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        : undefined,
    };
  };
}'''
assert old_schema in s
s = s.replace(old_schema, new_schema)

open(path, "w", encoding="utf-8").write(s)
print("outreach.ts: schema + normalizer added")
