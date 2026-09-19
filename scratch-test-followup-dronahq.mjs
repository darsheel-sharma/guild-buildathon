// Standalone test for the Follow-up Agent's DronaHQ webhook.
// No dependencies (native fetch only): node scratch-test-followup-dronahq.mjs
const WEBHOOK_URL = "https://agents-backend.dronahq.com/webhook/cb0e62c2-65e0-4acb-8964-f5e58fd6c5bb";
const API_KEY = "cb45d832-7696-465c-bd65-9e5309f1e18e";

const body = {
  agent: "followup",
  campaign_id: "test-campaign-1",
  system: "US SaaS CTO campaign.",
  message: `Decide whether to follow up with this prospect.

Campaign policy: max 5 touches, at least 3 days apart
Touches so far:  2
Days since last: 4.0
Ever replied:    no
Email flagged invalid (prior bounce): no
Paused/blocked reason from last cycle, if any: (none)

Engagement data (opens, clicks, profile views): not tracked by this system.
Treat engagement_score as unavailable — null, not zero — and flag human_review
per your own rule; never estimate it from silence.

Touch history, oldest first (channel and content, so you can tell whether an
angle has already been used):
1. [outbound, email, 2026-09-10T10:00:00Z] Subject: Halcyon's platform team after the raise
Hi Jordan, saw Halcyon raised a Series B and grew the eng org...
---
2. [outbound, linkedin, 2026-09-14T10:00:00Z]
Following up on my note about the platform team keeping pace with hiring...

Dossier signals available for a new angle or a revival check:
{"signals":["recently announced a funding round","hiring for platform engineering roles"],"pain_hypotheses":["platform team did not grow with headcount"],"personalisation_hooks":["Series B and 20+ new engineers"],"role_summary":"VP Engineering owning platform and infra"}

Cadence playbook (retrieved):
(playbook chunks would be retrieved here)

Prospect: Jordan Kim, VP Engineering at Halcyon Labs

Return follow_up to send the next touch now, wait with a day count if it is too
soon, or stop if the sequence is spent. A prospect who has never replied after
the full touch budget should be stopped, not cycled.`,
  campaign_name: "US SaaS CTO",
  prompt_version: "test-v1",
  follow_up_cadence: "Channel order: email → linkedin → email → voice → sms. At least 3 days between touches. Sequence maximum: 5 touches. Widen, never narrow, the interval as the sequence progresses.",
  stop_rules: "Stop early if there has been zero recorded engagement (no opens, clicks, or replies) across at least 3 touches. Stop immediately on any suppression, unsubscribe, or two confirmed hard bounces.",
  revival_policy: "Revive a paused prospect only if the dossier contains a signal that was not present when the sequence was paused (a new funding round, a leadership change, a new hiring signal, or similar). Otherwise stop with NO_NEW_SIGNAL.",
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
