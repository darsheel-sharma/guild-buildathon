// Standalone test for the Conversation Agent's DronaHQ webhook.
// No dependencies (native fetch only): node scratch-test-converse-dronahq.mjs
const WEBHOOK_URL = "https://agents-backend.dronahq.com/webhook/219bd00a-67ed-4b96-8912-421c5b44265d";
const API_KEY = "60c426d0-e740-4b20-8cef-0f0455a4e6e3";

const body = {
  agent: "converse",
  campaign_id: "test-campaign-1",
  system: "US SaaS CTO campaign.",
  message: `Read this reply and decide the next action.

Campaign: US SaaS CTO
Channel:  email
Prospect: Jordan Kim, VP Engineering at Halcyon Labs

Thread so far (oldest first; ignore quoted text and signatures within any message):
[outbound, email] Subject: Halcyon's platform team after the raise
Hi Jordan, ...

Their reply:
"""
We already run something similar in-house, and the last vendor review stalled on data residency. Hard to justify another tool this quarter.
"""

Objection handling guidance (retrieved):
(objection-handling and product one-pager chunks would be retrieved here)

Classify sentiment and intent, then pick one next action. Rules that override
everything else: any opt-out request is intent unsubscribe and action stop; a
handoff to another person is action escalate, never an automated reply to the
new contact. When an objection is present, quote it in the objection field.`,
  campaign_name: "US SaaS CTO",
  prompt_version: "test-v1",
  escalation_policy:
    "Escalate when: the reply asks about pricing specifics, contract terms, or security review; names a competitor and asks for a comparison; asks a technical question about their own architecture; is hostile or a complaint; is a referral or handoff to a different person; sounds like legal, procurement, or compliance; or is ambiguous enough that guessing wrong would be costly.",
  stop_policy:
    "Hard stop when the reply contains: unsubscribe, remove me, do not contact, stop contacting, take me off, or opt out.",
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
