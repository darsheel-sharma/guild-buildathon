// Standalone integration probe for the Outreach Strategy DronaHQ agent.
// Native fetch only, no node_modules dependency. Run with: node <this file>

import { readFileSync } from "node:fs";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv(".env");
const URL = env.DRONAHQ_AGENT_OUTREACH_URL;
const KEY = env.DRONAHQ_AGENT_OUTREACH_KEY || env.DRONAHQ_API_KEY;

if (!URL || !KEY) {
  console.error("Missing DRONAHQ_AGENT_OUTREACH_URL or a resolvable key in .env");
  process.exit(1);
}

const campaign = {
  id: "us-saas-cto",
  name: "US SaaS CTO outreach",
  icp_name: "SaaS CTO",
  channels: ["email", "linkedin"],
  min_days_between_touches: 3,
  max_touches: 4,
  conflict_policy: "first_touch_wins",
  daily_send_limit: 40,
  owner: "maya.iyer@example.com",
};

const prospect = {
  full_name: "Jordan Reyes",
  title: "CTO",
  company: "Northwind Analytics",
  geography: "United States",
};

const enabled = campaign.channels;
const step = 1;
const icpScore = 0.85;
const lastChannel = null;
const lastTouchAt = null;

const SYSTEM = `You are the SDR system for a campaign selling an internal-tooling and agent platform to US mid-market SaaS engineering leaders.`;

function buildPrompt() {
  return `Decide the next outreach action for this prospect.

Campaign:         ${campaign.name}
Enabled channels: ${enabled.join(", ")}
Cadence policy:   at least ${campaign.min_days_between_touches} days between touches, at most ${campaign.max_touches} touches
Sequence step:    ${step}
ICP fit score:    ${icpScore}
Last channel:     ${lastChannel ?? "none yet"}
Last touch:       ${lastTouchAt ?? "never"}

Playbook (retrieved):
(none for this standalone test)

Prospect: ${prospect.full_name}, ${prospect.title} at ${prospect.company} (${prospect.geography})
Research signals: none

Pick exactly one enabled channel. Do not repeat the channel used for the last
touch unless it is the only one enabled. Reserve voice and SMS for fit scores
above 0.75. If contacting now would be wrong, set should_contact false and say
how many days to wait.`;
}

// Mirrors src/agents/outreach.ts
const VALID_CHANNELS = new Set(["email", "linkedin", "sms", "voice"]);

function makeOutreachNormalizer(opts) {
  const fallbackChannel =
    (opts.lastChannel && opts.enabled.length > 1
      ? opts.enabled.find((c) => c !== opts.lastChannel)
      : opts.enabled[0]) ?? opts.enabled[0] ?? "email";

  return function normalizeOutreachPlan(raw) {
    if (!raw || typeof raw !== "object") return raw;
    let obj = raw;

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

    let freeText = null;
    if (typeof obj.response === "string") {
      const text = obj.response.trim();
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") obj = parsed;
        else throw new Error("not an object");
      } catch {
        freeText = text;
      }
    }

    if (freeText !== null) {
      const actionMatch = freeText.match(/\b(CONTACT|WAIT|SKIP|ESCALATE)\b/i);
      if (!actionMatch) {
        throw new Error(`DronaHQ Outreach Strategy Agent returned unparseable text: ${freeText.slice(0, 200)}`);
      }
      const action = actionMatch[1].toUpperCase();
      const channelMatch = freeText.match(/\b(email|linkedin|sms|voice)\b/i);
      const channel =
        channelMatch && VALID_CHANNELS.has(channelMatch[1].toLowerCase())
          ? channelMatch[1].toLowerCase()
          : fallbackChannel;
      return {
        channel,
        should_contact: action === "CONTACT",
        rationale: freeText.slice(0, 400),
        wait_days: action === "CONTACT" ? 0 : action === "WAIT" ? 1 : 30,
        sequence_step: opts.step,
        action: action.toLowerCase(),
        human_approval_required: action === "ESCALATE",
        _note: "FREE TEXT FALLBACK - Structured Output likely not enforcing the schema",
      };
    }

    const hasAnyPlanField =
      "action" in obj || "channel" in obj || "send_at" in obj || "planned_sequence" in obj || "reason" in obj;
    if (!hasAnyPlanField) {
      throw new Error(`DronaHQ Outreach Strategy Agent did not return a plan (got: ${JSON.stringify(obj).slice(0, 200)})`);
    }

    const actionRaw = String(obj.action ?? "").toUpperCase();
    const action = ["CONTACT", "WAIT", "SKIP", "ESCALATE"].includes(actionRaw) ? actionRaw : "WAIT";

    const channelRaw = typeof obj.channel === "string" ? obj.channel.toLowerCase() : null;
    const channel = channelRaw && VALID_CHANNELS.has(channelRaw) ? channelRaw : fallbackChannel;

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
      .filter(Boolean)
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
          ? obj.priority.toLowerCase()
          : undefined,
      flags: Array.isArray(obj.flags) ? obj.flags.filter((f) => typeof f === "string") : undefined,
      planned_sequence: Array.isArray(obj.planned_sequence)
        ? obj.planned_sequence.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        : undefined,
    };
  };
}

function unwrap(raw) {
  if (raw && typeof raw === "object") {
    for (const key of ["data", "output", "result"]) {
      if (raw[key] && typeof raw[key] === "object") return raw[key];
    }
  }
  return raw;
}

function validate(obj) {
  const errs = [];
  if (!VALID_CHANNELS.has(obj?.channel)) errs.push("channel invalid");
  if (typeof obj?.should_contact !== "boolean") errs.push("should_contact invalid");
  if (typeof obj?.rationale !== "string") errs.push("rationale invalid");
  if (typeof obj?.wait_days !== "number" || obj.wait_days < 0 || obj.wait_days > 30) errs.push("wait_days invalid");
  if (typeof obj?.sequence_step !== "number" || obj.sequence_step < 1) errs.push("sequence_step invalid");
  return errs;
}

const run = async () => {
  const body = {
    agent: "outreach",
    campaign_id: campaign.id,
    system: SYSTEM,
    message: buildPrompt(),
    campaign_name: campaign.icp_name,
    prompt_version: "test-harness-v0",
    channel_config: {
      email: enabled.includes("email"),
      linkedin: enabled.includes("linkedin"),
      sms: enabled.includes("sms"),
      voice: enabled.includes("voice"),
    },
    outreach_policy: {
      min_days_between_touches: campaign.min_days_between_touches,
      max_touches: campaign.max_touches,
      conflict_policy: campaign.conflict_policy,
      daily_send_limit: campaign.daily_send_limit,
    },
    rep_context: campaign.owner,
  };

  console.log("Sending one request...");
  const started = Date.now();
  let res;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { "api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.log(`FETCH ERROR: ${err.message}`);
    return;
  }
  const latency = Date.now() - started;
  const text = await res.text();
  console.log(`HTTP ${res.status} in ${latency}ms`);
  if (!res.ok) {
    console.log(`Body: ${text.slice(0, 800)}`);
    return;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    console.log(`Non-JSON body: ${text.slice(0, 800)}`);
    return;
  }
  console.log("Raw response:", JSON.stringify(raw, null, 2).slice(0, 2000));
  const unwrapped = unwrap(raw);
  const normalize = makeOutreachNormalizer({ enabled, lastChannel, step });
  let normalized;
  try {
    normalized = normalize(unwrapped);
  } catch (err) {
    console.log(`NORMALIZE THREW (would degrade to fallback): ${err.message}`);
    return;
  }
  console.log("Normalized:", JSON.stringify(normalized, null, 2));
  const errs = validate(normalized);
  console.log(errs.length ? `SCHEMA FAIL: ${errs.join("; ")}` : "PASS: matches OutreachPlan schema");
};

run();
