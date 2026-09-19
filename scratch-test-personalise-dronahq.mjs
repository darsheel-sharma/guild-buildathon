// Standalone test for the Personalisation / Email Agent's DronaHQ webhook.
// No dependencies (native fetch only) so it can run on its own with:
//   node scratch-test-personalise-dronahq.mjs
//
// Fill in the two values below before running.
const WEBHOOK_URL = "https://agents-backend.dronahq.com/webhook/d75ef71a-90e2-469b-b362-352a88fccfdd";
const API_KEY = "b8cf90d5-1e03-4ef5-ba3b-2ee4d83d322e";

const body = {
  agent: "personalise",
  campaign_id: "test-campaign-1",
  system: "US SaaS CTO campaign. Direct, technical tone. No fluff.",
  message: `Write outreach step 1 for this prospect.

Channel: email — 90 to 130 words, a subject line under 60 characters, one specific ask
Campaign objective: Get platform-team leaders at scaling B2B SaaS companies to book a call.
From: Alex Rivera, Account Executive

Prospect
  Jordan Kim — VP Engineering at Halcyon Labs
  B2B SaaS, US

Research
  hook:    recently raised Series B and hired 20+ engineers
  pain:    platform team did not grow with headcount, service setup is a bottleneck
  signals: hiring for platform engineering roles; recently announced a funding round

Approved knowledge — the ONLY source you may draw specifics from:
(case studies, product one-pager, example emails, objection handling, voice and rules
would be retrieved here in the real run)

Rules
  - Every concrete claim (customer name, metric, capability) must appear in the
    knowledge above. If it is not there, write the message without it.
  - No invented mutual connections, no fake urgency, no "I noticed you" openers
    that are not backed by a research signal.
  - One ask, easy to say yes to.
  - List the knowledge titles you actually used in knowledge_used.`,
  // Named variables — must match this agent's declared Variables panel.
  campaign_name: "US SaaS CTO",
  prompt_version: "test-v1",
  sender_identity: { name: "Alex Rivera", title: "Account Executive" },
  channel_rules: {
    channel: "email",
    enabled: true,
    enabled_channels: ["email", "linkedin"],
    limit: "90 to 130 words, a subject line under 60 characters, one specific ask",
    sequence_step: 1,
  },
  product_positioning: "Get platform-team leaders at scaling B2B SaaS companies to book a call.",
};

const res = await fetch(WEBHOOK_URL, {
  method: "POST",
  headers: { "api-key": API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log("HTTP status:", res.status);
const text = await res.text();
console.log("Raw response body:");
console.log(text);

try {
  const json = JSON.parse(text);
  console.log("\nParsed JSON:");
  console.log(JSON.stringify(json, null, 2));
} catch {
  console.log("\n(response was not valid JSON)");
}
