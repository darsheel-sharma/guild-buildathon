# Autonomous SDR

A multi-channel autonomous Sales Development Representative: a campaign **control plane** a human
manager drives, and an **agentic outreach engine** that researches, qualifies, contacts and follows
up with prospects inside those campaigns. Built for the IIT Madras Tech Contingent × DronaHQ Inter
Guild Buildathon.

The demo runs with **zero credentials**. Clone, `npm install`, `npm run dev` — the app boots an
in-process Postgres with pgvector, seeds four campaigns, and builds their history by running the
real orchestrator. Every external dependency (models, email, LinkedIn, SMS, voice) has a simulated
transport that activates when its credential is absent, and every run and message records which
transport produced it, so nothing simulated is ever presented as real.

---

## Contents

- [The shape of the system](#the-shape-of-the-system)
- [What it does](#what-it-does)
- [Running it](#running-it)
- [Environment variables](#environment-variables)
- [Tech stack](#tech-stack)
- [File and folder structure](#file-and-folder-structure)
- [Demo script](#demo-script)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [What works, what is partial, what is not built](#what-works-what-is-partial-what-is-not-built)

---

## The shape of the system

Three layers, not two. The control plane is not a *view* of the agents — it is the *input* to them.

```
┌─ Control plane ──────────────────────── what a human configures ─┐
│  Campaigns          Prompt registry     Controls      Dashboards │
│  ICP, targeting,    versioned,          campaign /    funnel,    │
│  policies           roll-back-able      agent /       cost,      │
│                                         channel /     audit      │
│                                         kill switch              │
└──────────────────────────────────────────────────────────────────┘
        ↓ campaign config, prompts, policies      ↑ state, cost, prompt version used
┌─ Shared platform ──────────────────── global, cross-campaign ────┐
│  Orchestrator       Conflict guard      Knowledge     Channels   │
│  queue, gates,      dedupe, frequency,  pgvector      email,     │
│  retries            suppression         retrieval     LinkedIn,  │
│                                                       SMS, voice │
└──────────────────────────────────────────────────────────────────┘
        ↓ tools, knowledge, limits                ↑ actions, telemetry
┌─ Intelligence layer ───────────────── seven agents, stateless ───┐
│  Research    Qualify    Outreach    Personalise                  │
│  Converse    Voice      Follow-up                                │
└──────────────────────────────────────────────────────────────────┘
```

**Why the middle layer has to exist.** A prospect belongs to the platform, not to a campaign. Only
the platform can see that two live campaigns are about to contact the same person this week, that
someone who opted out of one campaign must be suppressed in all of them, or that a contact-frequency
cap has been hit across campaigns. The global kill switch is one flag every gate reads.

**Agents are stateless.** Each is a pure function of *(campaign config + retrieved knowledge +
prospect context) → structured output*. All durable state is rows the orchestrator writes. That is
what makes pausing mid-execution safe, retries cheap, and offline evaluation meaningful.

The same three-layer view, rendered live with what is actually wired up, is at `/architecture`.

---

## What it does

### Control plane

| Capability | Where |
|---|---|
| Multiple concurrent campaigns, each with its own ICP, prompts, policies and state | `/` |
| Campaign lifecycle: draft → live → paused → completed / archived, with validated transitions | `src/core/platform/campaigns.ts` |
| Pre-flight check — a draft cannot go live without prompts, knowledge, channels and a sending identity | `activationBlockers()` |
| Four levels of control: campaign pause, agent pause, channel pause, global kill switch | `src/core/platform/control.ts` |
| Versioned prompt registry with diff, activate and roll back | `/campaigns/[id]/prompts` |
| Per-campaign dashboard: funnel, channel activity, agent activity, outcomes, conflicts, spend | `/campaigns/[id]` |
| Duplicate a campaign into an A/B variant with its own copy of every prompt | `POST /api/campaigns/[id]/duplicate` |
| Rep assignment, sending identity, working hours, daily limits | `campaign_reps` |
| Human-in-the-loop approvals for borderline qualification, booked meetings and handoffs | approvals panel |

### Intelligence layer

Seven agents, each with its own campaign-scoped prompt, retrieval query and model tier:

| Agent | Tier | What it decides |
|---|---|---|
| Research | fast | Structured prospect context: signals, pain hypotheses, personalisation hooks |
| Qualify | fast | ICP fitment score and verdict against *this* campaign's criteria |
| Outreach | fast | Whether, when and on which channel to make the next touch |
| Personalise | strong | The message a prospect will actually read |
| Converse | strong | Reads an inbound reply, classifies it, routes the next action |
| Voice | strong | Plans a call: opening, qualification questions, escalation trigger |
| Follow-up | fast | When to try again — and when to stop |

Every agent call goes through one path (`src/agents/runtime.ts`) that resolves the harness, retrieves
knowledge, calls the model, and writes an `agent_runs` row carrying the prompt version, harness hash,
retrieved chunks, model, mode, tokens, cost and latency. No agent can skip retrieval or forget to
stamp its configuration.

### Measurement

A golden-set evaluation scores the live ICP configuration and records the result against the prompt
version that produced it, so a prompt edit is measurable rather than a matter of taste. It currently
scores **4/5** on the US SaaS campaign — the failing case is a CTO whose remit excludes internal
tooling, which the offline rule engine cannot see and a model reading the retrieved ICP document
should get right. That gap is deliberate: an eval that always scores 100% measures nothing.

---

## Running it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The first request migrates the schema, seeds four campaigns and runs
the orchestrator to build their history — a few seconds — then the dashboard is populated.

```bash
npm run build   # production build
npm run start   # serve the production build
npm run lint
```

### Deploying

Deploys to Vercel with no configuration. Set `DATABASE_URL` to any Postgres with the `vector`
extension available (Neon, Supabase, RDS) — the schema is created on first request. Without
`DATABASE_URL` the app still runs, but PGlite is in-process, so state resets whenever the serverless
function is recycled. That is fine for a preview and wrong for anything else.

`GET /api/cron/tick` advances every live campaign; point a Vercel cron at it to run campaigns without
anyone opening the dashboard. Set `CRON_SECRET` to require a bearer token.

---

## Environment variables

Every variable is optional. See `.env.example` for the full annotated list.

| Variable | Effect when set |
|---|---|
| `DATABASE_URL` | Uses Postgres instead of in-process PGlite. Needed for real persistence. |
| `PGLITE_DATA_DIR` | Persists the local PGlite database between restarts. |
| `AI_GATEWAY_API_KEY` / `ANTHROPIC_API_KEY` | Agents make real model calls instead of using deterministic stand-ins. |
| `MODEL_FAST` / `MODEL_STRONG` | Model routing. Defaults: `anthropic/claude-haiku-4-5`, `anthropic/claude-opus-5`. |
| `EMBED_DIM` | Embedding width, baked into the schema. Default 256. Changing it needs a fresh database. |
| `DRONAHQ_API_KEY` + `DRONAHQ_AGENT_<AGENT>_URL` | Runs that agent inside DronaHQ instead of calling a model directly. See [docs/dronahq.md](docs/dronahq.md). |
| `GMAIL_ACCESS_TOKEN` | Email sends through the Gmail API instead of the simulated transport. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Real SMS, and real calls when `VOICE_AGENT_WEBHOOK_URL` is also set. |
| `LINKEDIN_SERVICE_URL` | Posts LinkedIn messages to your automation worker. |
| `CRON_SECRET` | Requires a bearer token on `/api/cron/tick`. |

Channels are decided independently, so a campaign can run live email alongside simulated voice. The
transport used is stored on every message row and labelled in the UI.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript | Server components read the core modules directly; API routes exist for mutations. |
| Styling | Tailwind CSS v4 | Light theme only — one palette that was actually checked beats two half-checked ones. |
| Database | Postgres. `pg` against `DATABASE_URL`, else PGlite in-process | One `query(sql, params)` surface over both, so the SQL is identical and the demo needs no credentials. |
| Vector search | pgvector, cosine distance | Real vector search in both drivers, not a keyword fallback pretending to be RAG. |
| Models | Vercel AI SDK with AI Gateway `provider/model` strings | Two-tier routing: cheap model for extraction, strong model for anything customer-facing. |
| Validation | Zod | Every agent output is schema-validated before it can touch the pipeline. |
| Agent runtime | DronaHQ agents (optional, per agent) | Webhook-triggered agents replace direct model calls where configured. |

No ORM. Plain SQL behind a thin typed layer — the schema is the interesting part and hiding it behind
a query builder would have made the campaign-isolation guarantees harder to read, not easier.

---

## File and folder structure

```
src/
├── app/                          Next.js routes
│   ├── page.tsx                  All-campaigns overview: KPIs, status table, kill switch
│   ├── architecture/             Live architecture view — what is actually wired up
│   ├── campaigns/[id]/           Campaign dashboard: funnel, controls, conversations, audit
│   │   └── prompts/              Prompt registry: edit, version, diff, roll back
│   └── api/                      Mutations and headless access
│       ├── overview/             Global state for anyone driving this without the UI
│       ├── control/              Global kill switch
│       ├── run-all/              Tick every campaign — the isolation demonstration
│       ├── cron/tick/            Scheduled execution
│       ├── approvals/[id]/       Human-in-the-loop decisions
│       └── campaigns/[id]/       lifecycle · pause · run · prompts · duplicate · eval · fast-forward
│
├── core/                         Control plane + shared platform. No agent logic here.
│   ├── types.ts                  Shared vocabulary: channels, agents, stages, campaign shape
│   ├── db/
│   │   ├── client.ts             One query surface over pg and PGlite
│   │   ├── migrate.ts            The whole schema, SQL-in-TypeScript, idempotent
│   │   └── seed.ts               Four campaigns, prompts, knowledge, prospects, golden set
│   └── platform/
│       ├── campaigns.ts          Campaign CRUD, lifecycle transitions, activation blockers
│       ├── control.ts            The four levels of pause, in one gate()
│       ├── prompts.ts            Versioned prompt registry and harness resolution
│       ├── conflicts.ts          Cross-campaign guard: suppression, dedupe, frequency, budget
│       ├── knowledge.ts          Campaign-scoped RAG over pgvector
│       ├── embedding.ts          Live embeddings, or a deterministic local projection
│       ├── llm.ts                Model routing, cost accounting, deterministic fallback
│       ├── dronahq.ts            DronaHQ webhook-triggered agents as an execution backend
│       ├── channels/             Email, LinkedIn, SMS, voice adapters + inbound simulation
│       ├── events.ts             Append-only activity log
│       ├── metrics.ts            Everything the dashboards count
│       └── inspect.ts            Read models: agent runs, threads, approvals, prospects, reps
│
├── agents/                       The intelligence layer. One file per agent.
│   ├── runtime.ts                The single path every agent takes to do anything
│   ├── research.ts  qualify.ts  outreach.ts  personalise.ts
│   └── converse.ts  voice.ts    followup.ts
│
├── orchestrator/
│   ├── engine.ts                 The tick loop: gates, phases, stage transitions
│   └── evals.ts                  Golden-set scoring for the ICP agent
│
├── components/                   UI: ui.tsx (presentational), actions.tsx (client mutations),
│                                 prompt-workbench.tsx (editor, versions, diff)
└── lib/api.ts                    Route-handler helpers
```

The separation that matters: **`core/` never imports from `agents/`**. Config and policy flow down;
agents read them. The orchestrator is the only thing that knows about both.

---

## Demo script

1. **`/` — all campaigns.** Three live/paused campaigns with different ICPs, channel mixes, prompt
   sets and independent funnels, plus a draft. Status is unmistakable at a glance.
2. **Run all campaigns.** Live campaigns advance; the paused and draft ones report *why* they were
   skipped. That is the isolation requirement, demonstrated in one click.
3. **Open the paused campaign.** Its prospects, conversations and decision history are all intact.
   Resume it and it continues from where it stopped.
4. **Pause one live campaign, run all again.** The other keeps working.
5. **Open a campaign → Prompts.** Edit the campaign system prompt, save a version, diff it, roll
   back. Then look at the agent runs table: every row names the prompt version and harness hash that
   produced it.
6. **Run agents now.** Watch the step log: research → qualify → outreach, replies routed to the
   conversation agent, objections answered with retrieved objection-handling material, opt-outs
   stopping the sequence and suppressing the person platform-wide.
7. **Conflicts panel.** One prospect sits in two live campaigns; first-touch-wins blocks the second.
   One prospect is on the global suppression list and is never contacted.
8. **Run ICP eval.** Scores the live configuration against the golden set and records it against the
   prompt version.
9. **Global kill switch.** Engage it, then try to run anything.

---

## Design decisions worth knowing

**Prompts are immutable versions, not editable fields.** Saving creates version N+1; rolling back is
activating an older one. A version belongs to exactly one `(campaign, scope)` pair, so editing one
campaign's prompt cannot change another's behaviour. Every agent run stores the version id and a hash
of the resolved harness, which is what makes *"which configuration produced this outcome?"* a lookup.

**The gate is checked twice.** Once before each pipeline step, and again immediately before each
send. A manager who hits pause while a tick is in flight must not get one more message out of the
door.

**Simulation is honest, not decorative.** With no credentials the agents use deterministic stand-ins
seeded on the campaign, prospect *and harness hash* — so a prompt edit changes simulated output too,
and prompt versioning is not cosmetic offline. The offline ICP scorer is a real rule engine over the
campaign's own targeting config, which is why the same person is qualified in one campaign and
rejected in another. The offline writer reads the campaign prompt for register, so the BFSI campaign
produces a formal letter and the founders campaign produces lowercase shorthand from the same code.

**Replies are not cold outreach.** The contact guard has two modes: a reply skips the
duplicate-outreach tie-break, the cadence gap and the sequence budget, but still honours opt-outs and
the daily budget. Answering someone who wrote to you is not the same decision as contacting a
stranger.

**"Advance clock" is a demo control, not a feature.** Real SDR cadence is measured in days, so
without it a reviewer sees one touch and then a correctly-waiting queue. It shifts only that
campaign's timestamps and is written to the activity log as a manual clock shift.

---

## What works, what is partial, what is not built

### Fully working

- Four concurrent campaigns with isolated config, prompts, knowledge, state, metrics and history
- Campaign lifecycle with validated transitions and activation pre-flight checks
- All four levels of operational control, enforced by a single gate in the execution path
- Versioned prompt registry: save, activate, diff, roll back, full attribution on every agent run
- Seven agents, schema-validated structured output, two-tier model routing, per-run cost and latency
- Campaign-scoped RAG over pgvector with retrieval provenance recorded on each run
- End-to-end pipeline: discover → research → qualify → contact → reply → objection handling →
  follow-up → stop / book / escalate
- Cross-campaign conflict handling: global suppression, duplicate outreach, contact frequency,
  daily budgets
- Human-in-the-loop approvals and an approval-required campaign mode
- Golden-set evaluation scored against the active prompt version
- Multi-channel coordination across email, LinkedIn, SMS and voice in one thread per prospect

### Partial

- **DronaHQ.** The seam is real and wired: set an API key and a per-agent webhook URL and that
  agent's reasoning runs inside DronaHQ, with its response schema-validated on the way back and a
  recorded fallback if it does not match. It has **not been run against a live DronaHQ workspace** —
  no credentials were available while building. [docs/dronahq.md](docs/dronahq.md) has the agent
  contract to configure on the DronaHQ side. Treat this as untested integration code.
- **Channels.** Gmail, Twilio SMS and Twilio voice are implemented against the real provider APIs but
  have only been exercised through the simulated transport. LinkedIn posts to a configurable
  automation service that this repo does not include.
- **Inbound.** Replies are simulated offline. Real deployments need provider webhooks writing
  inbound rows; that route does not exist yet.
- **Evaluation.** Golden-set scoring covers the ICP agent only. No LLM-as-judge for generated copy.
- **Lead discovery.** Prospects are seeded. There is no Apollo or equivalent enrichment connector, so
  the "find" step of the funnel is assumed rather than built.

### Not built

- **Authentication.** There is no login. The control plane trusts its caller, and the actor on every
  audited action comes from an `x-actor` header defaulting to a demo identity. Every action *is*
  attributed, which makes the gap visible rather than silent — but this must not be exposed publicly
  as-is.
- CRM sync (Salesforce / HubSpot / Sheets)
- Real calendar booking — a booked meeting raises an approval for a human instead
- A/B analytics comparing variant arms; duplication into a variant works, the comparison view does not
- Rep offboarding flow, though rep assignment and sending identity are modelled

### Known limitations

- Without `DATABASE_URL`, state lives in-process and resets on restart.
- `EMBED_DIM` is baked into the schema; changing it requires recreating the database.
- Offline embeddings are a hashed bag-of-words projection. Retrieval ranks sensibly on lexical
  overlap but is not semantic — the architecture page says so.
- Simulated costs are priced as if the calls had run, so cost-per-qualified-lead is demonstrable
  offline. The UI labels them as estimates.
