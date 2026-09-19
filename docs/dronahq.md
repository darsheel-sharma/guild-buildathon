# Running the agents on DronaHQ

This system can delegate any of its seven agents to a DronaHQ agent instead of calling a model
directly. The rest of the platform is unchanged: campaign config, retrieval, the conflict guard, the
gates and the audit trail all still run here. DronaHQ becomes the reasoning runtime for the agents
you move over — one at a time, so you can compare.

> **Status: untested against a live workspace.** The integration is written against DronaHQ's
> documented webhook trigger, but no DronaHQ credentials were available while building, so it has
> never made a real round trip. Verify each agent after configuring it.

---

## How the integration works

DronaHQ exposes an agent to external callers through a **webhook trigger**: the platform generates a
unique URL for the trigger, you `POST` to it with an `api-key` header, and it answers synchronously
with JSON shaped by the response schema you configure on that trigger.
(<https://docs.dronahq.com/agents/triggers/inbuilt-triggers/webhook/>)

Because the URL is generated per trigger rather than following a documented path, configuration is a
URL per agent:

```bash
DRONAHQ_API_KEY=sk_...
DRONAHQ_AGENT_QUALIFY_URL=https://<generated-webhook-url>
DRONAHQ_AGENT_PERSONALISE_URL=https://<generated-webhook-url>
# ... one per agent you want to move
```

With both set for an agent, `runStructured` (`src/core/platform/llm.ts`) calls DronaHQ first. The
precedence is:

1. **DronaHQ** — if this agent has an API key and a webhook URL
2. **Direct model call** — via the AI Gateway, if a model key is set
3. **Deterministic stand-in** — always available, so the demo never breaks

Each fallback is recorded on the `agent_runs` row as `degraded`, with the reason, and surfaced in the
dashboard's agent-runs table. A misconfigured trigger degrades visibly instead of silently.

---

## What this system sends

```http
POST <your webhook URL>
api-key: sk_...
Content-Type: application/json

{
  "agent": "qualify",
  "campaign_id": "us-saas-cto",
  "system": "<the resolved harness: campaign system prompt + agent prompt>",
  "message": "<the fully-built prompt, including retrieved knowledge>"
}
```

Two things to note:

- **`system` is the resolved harness from this platform's prompt registry.** If you also write
  instructions inside the DronaHQ agent, you now have prompt text in two places and the version
  stamp on each run only describes half of it. Either keep the DronaHQ agent's own instructions
  minimal and let `system` drive it, or accept that the audit trail is partial.
- **Retrieval has already happened.** `message` contains the knowledge chunks this platform selected,
  with similarity scores. You do not need a DronaHQ knowledge base for these agents — and if you add
  one, the agent will be reasoning over two retrieval sets.

---

## What this system expects back

A JSON object matching the agent's schema. Set this as the **Standard** response type on the webhook
trigger and define the JSON Schema to match. The response is validated with Zod on arrival; a
mismatch is treated as a failed call and falls through to the next backend.

Wrapper objects are unwrapped automatically — if the body is `{"data": {...}}`, `{"output": {...}}`,
`{"result": {...}}` or `{"response": {...}}`, the inner object is used.

### Agent contracts

Schemas are defined in `src/agents/*.ts`. Reproduced here as the contract to configure in DronaHQ.

**`research`**
```json
{
  "company_summary": "string (max 400)",
  "role_summary": "string (max 300)",
  "signals": ["string"],
  "pain_hypotheses": ["string"],
  "personalisation_hooks": ["string"],
  "tech_stack": ["string"],
  "confidence": 0.0
}
```

**`qualify`**
```json
{
  "score": 0.0,
  "verdict": "qualified | rejected | needs_review",
  "reasons": ["string"]
}
```

**`outreach`**
```json
{
  "channel": "email | linkedin | sms | voice",
  "should_contact": true,
  "rationale": "string (max 400)",
  "wait_days": 0,
  "sequence_step": 1
}
```

**`personalise`**
```json
{
  "subject": "string (max 140)",
  "body": "string (max 2000)",
  "knowledge_used": ["string"]
}
```

**`converse`**
```json
{
  "sentiment": "positive | neutral | negative",
  "intent": "meeting | info | objection | referral | not_interested | unsubscribe",
  "next_action": "book_meeting | send_info | handle_objection | follow_up | stop | escalate",
  "reasoning": "string (max 400)",
  "objection": "string (max 300, optional)"
}
```

**`voice`**
```json
{
  "opening": "string (max 600)",
  "objective": "string (max 200)",
  "qualification_questions": ["string"],
  "likely_objections": ["string"],
  "escalate_if": "string (max 200)"
}
```

**`followup`**
```json
{
  "action": "follow_up | wait | stop",
  "wait_days": 0,
  "reasoning": "string (max 300)"
}
```

---

## Suggested order to move agents over

Start with `qualify`. It has the smallest schema, the clearest right answer, and a golden set already
pointed at it — run the ICP eval before and after and the comparison is immediate. `personalise` is
the most interesting one to move, because it is the agent whose output a prospect reads, but its
output is the hardest to score automatically.

Leave `converse` until last. Its `next_action` drives stop and escalation decisions, so a schema
mismatch there has the widest blast radius — though it fails safe: a rejected response falls back to
the local path rather than proceeding with a bad shape.

---

## Verifying it

1. Configure one agent's webhook URL and the API key.
2. Restart, open `/architecture`, and check that agent is listed under **DronaHQ agents**.
3. Open a campaign and press **Run agents now**.
4. In the agent runs table, the row's config column should read `dronahq/<agent>` as the model.
5. If it does not, the row will be marked `degraded` with the reason — a non-2xx, a non-JSON body,
   or the schema mismatch, quoted.
