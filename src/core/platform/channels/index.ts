/**
 * Channel adapters.
 *
 * One `send()` surface for email, LinkedIn, SMS and voice. Each adapter uses
 * its real provider when the credentials are present and a simulated transport
 * when they are not — decided per channel, so a campaign can have live email
 * and simulated voice at the same time. The transport used is stored on every
 * message row, and the UI labels simulated sends explicitly.
 *
 * Nothing here decides *whether* to contact someone. That is the orchestrator's
 * job, gated by control.ts and conflicts.ts. By the time send() is called the
 * decision has already been made and audited.
 */
import type { Channel } from "@/core/types";
import { rngFor } from "../llm";

export interface SendRequest {
  channel: Channel;
  to: { name: string; email: string; phone: string; linkedin: string };
  from: { name: string; email: string; title: string };
  subject: string;
  body: string;
  /** Stable id used to seed simulated outcomes. */
  seed: string;
}

export interface SendResult {
  status: "sent" | "failed";
  provider: string;
  providerRef: string;
  transport: "live" | "simulated";
  error?: string;
  /** Voice calls come back with a transcript rather than a delivery receipt. */
  transcript?: string;
}

function ref(prefix: string, seed: string): string {
  const rng = rngFor(seed);
  return `${prefix}_${rng.int(100000, 999999)}${rng.int(100000, 999999)}`;
}

// ── email ──────────────────────────────────────────────────────────────────

async function sendEmail(req: SendRequest): Promise<SendResult> {
  const token = process.env.GMAIL_ACCESS_TOKEN;
  if (!token) {
    return {
      status: "sent",
      provider: "simulated-email",
      providerRef: ref("sim-mail", req.seed),
      transport: "simulated",
    };
  }
  // RFC 2822 message, base64url encoded, per the Gmail send API.
  const raw = [
    `From: ${req.from.name} <${req.from.email}>`,
    `To: ${req.to.name} <${req.to.email}>`,
    `Subject: ${req.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    req.body,
  ].join("\r\n");
  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) {
    return {
      status: "failed",
      provider: "gmail",
      providerRef: "",
      transport: "live",
      error: `gmail ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }
  const json = (await res.json()) as { id?: string };
  return {
    status: "sent",
    provider: "gmail",
    providerRef: json.id ?? "",
    transport: "live",
  };
}

// ── sms & voice (Twilio) ───────────────────────────────────────────────────

function twilioCreds() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  return sid && token && from ? { sid, token, from } : null;
}

async function twilioPost(
  creds: { sid: string; token: string },
  resource: "Messages" | "Calls",
  form: Record<string, string>,
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${creds.sid}/${resource}.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.sid}:${creds.token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    },
  );
  if (!res.ok) return { ok: false, error: `twilio ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const json = (await res.json()) as { sid?: string };
  return { ok: true, sid: json.sid };
}

async function sendSms(req: SendRequest): Promise<SendResult> {
  const creds = twilioCreds();
  if (!creds || !req.to.phone) {
    return {
      status: "sent",
      provider: "simulated-sms",
      providerRef: ref("sim-sms", req.seed),
      transport: "simulated",
    };
  }
  const out = await twilioPost(creds, "Messages", {
    To: req.to.phone,
    From: creds.from,
    Body: req.body,
  });
  return out.ok
    ? { status: "sent", provider: "twilio-sms", providerRef: out.sid ?? "", transport: "live" }
    : { status: "failed", provider: "twilio-sms", providerRef: "", transport: "live", error: out.error };
}

/** Deterministic transcript so a voice demo is reproducible without telephony. */
function simulateCall(req: SendRequest): string {
  const rng = rngFor(`${req.seed}:voice`);
  const outcomes = [
    `Reached ${req.to.name}. Confirmed they own the problem area. Agreed to a 20-minute call next week.`,
    `Reached ${req.to.name}. Interested but pushed on pricing; objection logged for the follow-up email.`,
    `Voicemail. Left a 25-second message referencing the earlier email and asked for a callback.`,
    `Gatekeeper answered. Captured the correct contact and scheduled a retry inside working hours.`,
  ];
  return `[simulated transcript] Opening: "${req.body.slice(0, 120)}..." — ${rng.pick(outcomes)}`;
}

async function placeCall(req: SendRequest): Promise<SendResult> {
  const creds = twilioCreds();
  const webhook = process.env.VOICE_AGENT_WEBHOOK_URL;
  if (!creds || !webhook || !req.to.phone) {
    return {
      status: "sent",
      provider: "simulated-voice",
      providerRef: ref("sim-call", req.seed),
      transport: "simulated",
      transcript: simulateCall(req),
    };
  }
  // The webhook returns TwiML that bridges the call into the voice agent; the
  // opening line is passed through so the agent knows how to start.
  const url = new URL(webhook);
  url.searchParams.set("opening", req.body.slice(0, 500));
  const out = await twilioPost(creds, "Calls", {
    To: req.to.phone,
    From: creds.from,
    Url: url.toString(),
  });
  return out.ok
    ? { status: "sent", provider: "twilio-voice", providerRef: out.sid ?? "", transport: "live" }
    : { status: "failed", provider: "twilio-voice", providerRef: "", transport: "live", error: out.error };
}

// ── LinkedIn ───────────────────────────────────────────────────────────────
// LinkedIn has no send API for cold outreach, so this posts to whatever
// automation service the team runs (a browser-automation worker in practice).

async function sendLinkedIn(req: SendRequest): Promise<SendResult> {
  const base = process.env.LINKEDIN_SERVICE_URL;
  if (!base || !req.to.linkedin) {
    return {
      status: "sent",
      provider: "simulated-linkedin",
      providerRef: ref("sim-li", req.seed),
      transport: "simulated",
    };
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LINKEDIN_SERVICE_TOKEN
          ? { Authorization: `Bearer ${process.env.LINKEDIN_SERVICE_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ profile: req.to.linkedin, message: req.body, sender: req.from.email }),
    });
    if (!res.ok) {
      return {
        status: "failed",
        provider: "linkedin-service",
        providerRef: "",
        transport: "live",
        error: `linkedin service ${res.status}`,
      };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return {
      status: "sent",
      provider: "linkedin-service",
      providerRef: json.id ?? "",
      transport: "live",
    };
  } catch (err) {
    return {
      status: "failed",
      provider: "linkedin-service",
      providerRef: "",
      transport: "live",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const ADAPTERS: Record<Channel, (req: SendRequest) => Promise<SendResult>> = {
  email: sendEmail,
  linkedin: sendLinkedIn,
  sms: sendSms,
  voice: placeCall,
};

export async function send(req: SendRequest): Promise<SendResult> {
  try {
    return await ADAPTERS[req.channel](req);
  } catch (err) {
    // A provider outage must fail one message, not the whole tick.
    return {
      status: "failed",
      provider: req.channel,
      providerRef: "",
      transport: "live",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Reported in the UI so nobody mistakes a simulated send for a real one. */
export function channelTransports(): Record<Channel, "live" | "simulated"> {
  const twilio = Boolean(twilioCreds());
  return {
    email: process.env.GMAIL_ACCESS_TOKEN ? "live" : "simulated",
    linkedin: process.env.LINKEDIN_SERVICE_URL ? "live" : "simulated",
    sms: twilio ? "live" : "simulated",
    voice: twilio && process.env.VOICE_AGENT_WEBHOOK_URL ? "live" : "simulated",
  };
}
