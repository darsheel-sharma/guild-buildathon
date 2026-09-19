/**
 * Demo seed: four campaigns with genuinely different ICPs, prompts, knowledge
 * bases, channel mixes and policies — the three-concurrent-campaigns
 * requirement plus a draft to show the lifecycle gate.
 *
 * Two phases, deliberately separated:
 *
 *   seedIfEmpty()        static rows only. Runs inside getDb()'s init, so it
 *                        must never call anything that itself calls getDb().
 *   ensureDemoActivity() runs the real orchestrator to build history, so the
 *                        dashboards open with genuine agent runs, real prompt
 *                        version stamps and real costs rather than fake rows.
 *                        Called after the database is ready.
 */
import type { Database } from "./client";
import { EMBED_DIM, embed, toVector } from "@/core/platform/embedding";
import { AGENT_KEYS, CHANNELS } from "@/core/types";

// ── campaign definitions ───────────────────────────────────────────────────

interface SeedCampaign {
  id: string;
  name: string;
  description: string;
  owner: string;
  status: "draft" | "live" | "paused";
  icp_name: string;
  geography: string;
  objective: string;
  target_roles: string[];
  company_criteria: Record<string, unknown>;
  exclusion_criteria: string[];
  channels: string[];
  daily_send_limit: number;
  min_days_between_touches: number;
  max_touches: number;
  qualification_threshold: number;
  autonomy: string;
  conflict_policy: string;
}

const CAMPAIGNS: SeedCampaign[] = [
  {
    id: "us-saas-cto",
    name: "US SaaS CTO outreach",
    description:
      "Mid-market US SaaS engineering leaders who are spending product cycles on internal tooling.",
    owner: "maya.iyer@example.com",
    status: "live",
    icp_name: "SaaS CTO",
    geography: "United States",
    objective:
      "Book 20-minute technical calls with engineering leaders who own internal tooling budget.",
    target_roles: ["CTO", "VP Engineering", "Head of Platform", "Director of Engineering"],
    company_criteria: { industries: ["SaaS", "Software"], min_employees: 80, max_employees: 3000 },
    exclusion_criteria: ["staffing", "agency"],
    channels: ["email", "linkedin"],
    daily_send_limit: 40,
    min_days_between_touches: 3,
    max_touches: 4,
    qualification_threshold: 0.6,
    autonomy: "auto",
    conflict_policy: "first_touch_wins",
  },
  {
    id: "india-bfsi-cio",
    name: "India BFSI CIO outreach",
    description:
      "Regulated Indian banking, financial services and insurance CIOs. Compliance-first messaging, slower cadence.",
    owner: "rahul.menon@example.com",
    status: "paused",
    icp_name: "BFSI CIO",
    geography: "India",
    objective:
      "Open conversations with BFSI technology leaders about compliant internal tooling and agent deployment.",
    target_roles: ["CIO", "CTO", "Head of Digital", "Chief Digital Officer"],
    company_criteria: {
      industries: ["BFSI", "Banking", "Insurance", "Financial Services"],
      min_employees: 500,
      max_employees: 200000,
    },
    // Regulated buyers: crypto-adjacent firms are out of policy entirely.
    exclusion_criteria: ["crypto", "gaming"],
    channels: ["email", "linkedin", "voice"],
    daily_send_limit: 20,
    min_days_between_touches: 5,
    max_touches: 3,
    qualification_threshold: 0.7,
    autonomy: "auto",
    conflict_policy: "first_touch_wins",
  },
  {
    id: "voice-ai-founders",
    name: "Voice AI founders",
    description:
      "Early-stage voice and conversational AI founders. Fast, informal, multi-channel including SMS and calls.",
    owner: "maya.iyer@example.com",
    status: "live",
    icp_name: "AI founders",
    geography: "United States, United Kingdom",
    objective: "Get founders onto a live call to talk through agent orchestration and tooling.",
    target_roles: ["Founder", "Co-founder", "CEO", "CTO"],
    company_criteria: { industries: ["AI", "Voice AI", "Software"], min_employees: 5, max_employees: 200 },
    exclusion_criteria: [],
    channels: ["email", "sms", "voice"],
    daily_send_limit: 30,
    min_days_between_touches: 2,
    max_touches: 4,
    qualification_threshold: 0.55,
    autonomy: "auto",
    conflict_policy: "first_touch_wins",
  },
  {
    id: "enterprise-expansion",
    name: "Enterprise expansion",
    description:
      "Expansion into existing accounts. Every message is reviewed by the account owner before it goes out.",
    owner: "rahul.menon@example.com",
    status: "draft",
    icp_name: "Existing customers",
    geography: "Global",
    objective: "Expand usage inside accounts that already run one team on the platform.",
    target_roles: ["VP Engineering", "CIO", "Head of Operations"],
    company_criteria: { min_employees: 200, max_employees: 100000 },
    exclusion_criteria: [],
    channels: ["email"],
    daily_send_limit: 10,
    min_days_between_touches: 7,
    max_touches: 2,
    qualification_threshold: 0.5,
    // Expansion touches existing relationships: nothing sends without a human.
    autonomy: "approval_required",
    conflict_policy: "allow_both",
  },
];

// ── prompts ────────────────────────────────────────────────────────────────

const SHARED_GUARDRAILS = `Guardrails that override anything else in this prompt:
- Never state a customer name, metric, integration or capability that is not in the retrieved knowledge.
- Never claim a mutual connection, a referral, or a prior conversation that is not in the thread.
- If a prospect asks to stop, opts out, or mentions legal or compliance escalation, stop and hand off to a human.
- Prefer saying less over inventing specifics. Low confidence is an acceptable output.`;

const CAMPAIGN_PROMPTS: Record<string, string> = {
  "us-saas-cto": `You are the SDR system for a campaign selling an internal-tooling and agent platform to US mid-market SaaS engineering leaders.

Audience: CTOs, VPs of Engineering and Heads of Platform at 80–3000 person software companies in the United States.
Voice: direct, peer-to-peer, technically literate. No marketing adjectives, no exclamation marks.
Frame: engineering time spent on internal admin panels is the cost, not licence spend.
Ask: a 20-minute technical walkthrough.

${SHARED_GUARDRAILS}`,

  "india-bfsi-cio": `You are the SDR system for a campaign selling compliant internal tooling and agent deployment to Indian BFSI technology leaders.

Audience: CIOs, CTOs and Heads of Digital at Indian banks, insurers and financial services firms above 500 employees.
Voice: formal, measured, compliance-first. Use full titles. Never imply urgency or scarcity.
Frame: deployment model, data residency and auditability come before features. Assume a procurement process and a security review.
Ask: an introductory conversation, not a demo.

Extra constraint for this campaign: never make a claim about regulatory certification or data residency unless it appears verbatim in the retrieved knowledge. This audience will check.

${SHARED_GUARDRAILS}`,

  "voice-ai-founders": `You are the SDR system for a campaign selling agent orchestration and tooling to early-stage voice and conversational AI founders.

Audience: founders and CTOs at 5–200 person AI companies in the US and UK.
Voice: short, informal, founder-to-founder. Lowercase subject lines are fine. One idea per message.
Frame: they are already building agents — the pitch is the boring infrastructure around them (tooling, state, human handoff), not the model layer.
Ask: a live call, this week if possible.

${SHARED_GUARDRAILS}`,

  "enterprise-expansion": `You are the SDR system for expansion inside accounts that already use the platform.

Audience: adjacent teams and leaders inside existing customers.
Voice: warm, low-pressure, aware that a relationship already exists. Never pitch as if this is a first contact.
Frame: what the team already live on the platform achieved, and which adjacent workflow is the obvious next one.
Ask: an internal introduction to the adjacent team.

Every message in this campaign is reviewed by the account owner before it sends. Write accordingly: no speculation about the account's internal politics.

${SHARED_GUARDRAILS}`,
};

const AGENT_PROMPTS: Record<string, Partial<Record<(typeof AGENT_KEYS)[number], string>>> = {
  "us-saas-cto": {
    research: `Build prospect context for a technical buyer. Prioritise signals an engineering leader would recognise: hiring for platform roles, public engineering writing, migration announcements, headcount growth relative to tooling maturity. Ignore generic company boilerplate. Cap confidence at 0.7 when the only inputs are the prospect record and firmographics.`,
    qualify: `Score fit against the SaaS CTO ICP. Weight decision authority over company size: a Head of Platform at 300 people outranks a CTO at 3000 who does not own tooling budget. Reject staffing firms and agencies outright. Anything between 0.4 and the threshold is needs_review, not a guess.`,
    personalise: `Write like an engineer who has done this job. Lead with the operational problem, not the product. No "I noticed you" unless a research signal backs it. One specific ask. Under 130 words for email, under 60 for LinkedIn.`,
    converse: `Read replies with a bias toward stopping. "Not now" with no objection is a stop, not a nurture. A technical objection is worth answering once, with a specific mechanism rather than a benefit claim.`,
  },
  "india-bfsi-cio": {
    research: `Focus on regulatory posture, deployment model and existing vendor landscape. Note whether the institution is public sector, private sector or an NBFC — it changes the procurement path entirely. Never infer a compliance certification from industry alone.`,
    qualify: `Score fit against the BFSI CIO ICP with a high bar (threshold 0.7). Title seniority and institution size both matter here; a digital lead at a small NBFC is not a qualified CIO conversation. Crypto and gaming adjacency is an automatic rejection regardless of other fit.`,
    personalise: `Formal register, full titles, no contractions. Lead with deployment model and auditability. Do not offer a demo in a first touch — offer a conversation. Never mention a certification, residency guarantee or regulator by name unless it is in the retrieved knowledge verbatim.`,
    converse: `Expect procurement and security questions rather than product objections. Any mention of a security review, legal, or a regulator is an immediate escalation to a human — do not attempt to answer it.`,
    voice: `Calls to this audience are introductions, not pitches. Identify yourself and the institution you are calling about within the first sentence. If a gatekeeper answers, capture the correct contact and end the call politely. Escalate to a human the moment compliance, pricing or legal is raised.`,
  },
  "voice-ai-founders": {
    research: `Founders move fast and have public footprints — prioritise what they have shipped, written or demoed. Team size and stage matter more than industry classification. Two sharp signals beat five vague ones.`,
    qualify: `Lower bar than the enterprise campaigns (threshold 0.55): early-stage founders are worth a conversation even on partial fit. Founder or CTO title plus an AI company under 200 people is enough. Reject only on clear mismatch.`,
    personalise: `Short. Lowercase subject lines are fine. Assume they already know the model layer — talk about the unglamorous parts: tool calling, state, human handoff, evals. No corporate voice. SMS under 160 characters with an opt-out.`,
    converse: `Founders reply fast and bluntly. Match it. If they ask a technical question, answer the question; do not redirect to a call. A one-word decline is a stop.`,
  },
  "enterprise-expansion": {
    qualify: `These are existing accounts, so fit is mostly about the adjacent team's workflow rather than firmographics. Be generous on score but flag anything where the account relationship is unclear as needs_review.`,
    personalise: `Reference the team already using the platform, without claiming internal knowledge you do not have. Ask for an introduction, not a meeting. This draft goes to a human for review, so leave any uncertain claim out rather than guessing.`,
  },
};

// ── knowledge base ─────────────────────────────────────────────────────────

interface SeedDoc {
  campaign: string | null;
  title: string;
  kind: string;
  body: string;
}

const DOCS: SeedDoc[] = [
  {
    campaign: null,
    title: "Platform overview",
    kind: "product",
    body: `The platform is a low-code environment for building internal tools, operational dashboards and AI agents on top of systems a company already runs. Teams connect existing databases, APIs and SaaS tools, then compose apps and agents over them without standing up new infrastructure.

Three parts. A drag-and-drop app builder for dashboards, forms and admin panels. An agentic layer for designing and deploying autonomous agents with tool calling, memory, retrieval and guardrails. A prompt-to-app mode that turns a natural-language description into a working, editable app.

Deployment is either fully managed or self-hosted inside the customer's own network, including air-gapped environments. Role-based access control, audit logging and SSO are available on every tier.`,
  },
  {
    campaign: null,
    title: "Outreach compliance rules",
    kind: "playbook",
    body: `Every outbound message must identify the sender by name and company. SMS must carry an opt-out instruction. Opt-out requests are honoured platform-wide within one business day, across every campaign, not just the campaign that received the request.

Do not contact anyone on the global suppression list. Do not contact the same person on more than one campaign in the same week. Do not claim a prior relationship, referral or mutual connection that is not recorded in the thread.`,
  },
  {
    campaign: "us-saas-cto",
    title: "SaaS CTO ICP definition",
    kind: "icp",
    body: `Qualified: engineering leaders at US software companies between 80 and 3000 employees who own the internal tooling or platform budget. Titles that qualify are CTO, VP Engineering, Head of Platform and Director of Engineering where platform sits under them.

Disqualified: staffing firms and agencies, companies under 80 employees where there is no platform function yet, and anyone whose remit is purely customer-facing product with no internal tooling ownership. A senior title without tooling ownership is a rejection, not a borderline case.

Strong signals: an open platform or internal-tools engineering role, public engineering writing about internal tooling, a recent migration off a legacy admin system.`,
  },
  {
    campaign: "us-saas-cto",
    title: "Case study: mid-market SaaS platform team",
    kind: "case_study",
    body: `A 600-person US SaaS company had four engineers maintaining internal admin panels full time. They rebuilt those panels on the platform in six weeks and moved three of the four engineers back onto product work.

The operations team now builds and edits their own tools, and requests that used to sit in the engineering backlog for a quarter are handled in days. The platform team kept ownership of data access and permissions.`,
  },
  {
    campaign: "us-saas-cto",
    title: "Example email: first touch, platform lead",
    kind: "example_message",
    body: `Subject: internal tooling without the engineering tax

Hi Dana,

You are hiring two platform engineers, which usually means the internal-tools backlog has outgrown whoever owns it today.

We give teams a way to build operational tools and agents on top of the systems they already run, so ops can self-serve and platform keeps control of data access. One 600-person SaaS team moved three of four engineers off admin panels this way.

Worth 20 minutes next week to see whether it maps to your setup?

Maya`,
  },
  {
    campaign: "us-saas-cto",
    title: "Objection handling: we build this in-house",
    kind: "objection",
    body: `The objection is almost never about capability — in-house tools usually work. It is about who maintains them next quarter.

Answer with maintenance load rather than features: ask how many engineer-days per month go into internal tools now, and who picks it up when that person moves teams. Teams that switch usually keep their in-house tools running and stop adding new ones.

Do not argue that the in-house version is bad. Do not offer a discount. Offer a comparison on one concrete workflow.`,
  },
  {
    campaign: "us-saas-cto",
    title: "Sequence playbook: US SaaS",
    kind: "playbook",
    body: `Four touches over roughly two weeks. Email first, LinkedIn second, email third with a different angle, LinkedIn fourth as a short close-the-loop note. Three clear days between touches minimum.

Never repeat the previous channel back to back. Do not call this audience cold — phone is reserved for prospects who have already engaged. Stop after four touches with no reply; a fifth converts nothing and costs deliverability.`,
  },
  {
    campaign: "india-bfsi-cio",
    title: "BFSI CIO ICP definition",
    kind: "icp",
    body: `Qualified: CIOs, CTOs and Heads of Digital at Indian banks, insurers, NBFCs and financial services firms above 500 employees, where the role owns technology delivery.

Disqualified: crypto and digital-asset firms, gaming and betting, and any institution where the contact does not own delivery. Institutions under 500 employees rarely have the procurement structure this campaign is built for and should score below threshold.

Public sector banks follow a tender process — a qualified conversation there is about being positioned for the next cycle, not about this quarter.`,
  },
  {
    campaign: "india-bfsi-cio",
    title: "Deployment and data residency",
    kind: "product",
    body: `The platform can be deployed inside the customer's own cloud account or data centre, including networks with no outbound internet access. In that configuration, application data and audit logs never leave the customer's infrastructure.

Available controls: single sign-on, role-based access control, per-connector data access rules, full audit logging of every agent action, and configurable retention. Model calls can be pinned to a chosen provider and region, or routed to a self-hosted model.

State only what is listed here. Any question about a specific certification or regulator must be escalated to a human.`,
  },
  {
    campaign: "india-bfsi-cio",
    title: "Objection handling: security and procurement review",
    kind: "objection",
    body: `Expect the review to be raised early. Treat it as a process question, not an obstacle: acknowledge it, offer the deployment documentation, and ask who owns the review so it can start in parallel rather than after a decision.

Never estimate how long a review will take. Never assert that the platform is compliant with a named regulation. Hand any specific certification question to a human immediately.`,
  },
  {
    campaign: "india-bfsi-cio",
    title: "Voice script: BFSI introduction call",
    kind: "voice_script",
    body: `Open by naming yourself, your company and the institution you are calling about, then ask whether it is a reasonable moment to speak for two minutes.

Qualify on three things: who owns internal application delivery, whether deployment must sit inside their own infrastructure, and whether there is an active initiative this financial year.

If a gatekeeper answers, ask for the correct contact and end politely. If pricing, legal, security review or a regulator comes up, say a colleague will follow up and end the call. Do not negotiate and do not speculate.`,
  },
  {
    campaign: "voice-ai-founders",
    title: "AI founder ICP definition",
    kind: "icp",
    body: `Qualified: founders, co-founders, CEOs and CTOs at AI or voice-AI companies between 5 and 200 people in the US or UK. Anyone shipping agents in production qualifies.

Not disqualified by stage or size — an eight-person team building voice agents is a good conversation. Reject only on clear mismatch: no AI product, or a role with no technical or founding authority.`,
  },
  {
    campaign: "voice-ai-founders",
    title: "What founders actually care about",
    kind: "product",
    body: `Founders building agents have the model layer handled. What breaks is everything around it: tool calling that fails halfway, no durable state between turns, no human handoff, no way to tell whether a prompt change made things better or worse.

The platform provides the orchestration layer — tool definitions, retrieval, memory, guardrails, versioned prompts and evaluation — so the team keeps building their product instead of rebuilding the harness.`,
  },
  {
    campaign: "voice-ai-founders",
    title: "Example email: founder first touch",
    kind: "example_message",
    body: `Subject: the boring part of agents

Hey Sam,

You are shipping voice agents, so you already have the model layer figured out. The part that usually hurts is the harness around it — durable state, tool calls that fail cleanly, human handoff, knowing whether a prompt change helped.

That is what we do. Happy to show you how it fits in 20 minutes.

Worth a call this week?

Maya`,
  },
  {
    campaign: "voice-ai-founders",
    title: "Objection handling: we already built our own harness",
    kind: "objection",
    body: `Most of them have. Ask what happens when a tool call fails mid-conversation, and how they know a prompt change improved anything.

The switching argument is evaluation and versioning, not orchestration — teams rebuild the loop happily, then discover they have no way to measure it. Offer to compare on one workflow. Do not suggest ripping anything out.`,
  },
  {
    campaign: "voice-ai-founders",
    title: "Sequence playbook: founders",
    kind: "playbook",
    body: `Four touches, two days apart, fast. Email first. SMS or a call only once fit score is above 0.75 — founders tolerate a call, but only when the fit is obvious.

Match their energy: if they reply in six words, reply in six words. Stop immediately on any decline; this audience talks to each other.`,
  },
  {
    campaign: "enterprise-expansion",
    title: "Expansion playbook",
    kind: "playbook",
    body: `Two touches maximum, a week apart, email only. The ask is an internal introduction to the adjacent team, never a meeting with the person you are writing to.

Reference what the team already on the platform achieved, in their words where possible. Every draft is reviewed by the account owner before sending — if a claim needs checking, leave it out and let the reviewer add it.`,
  },
];

// ── prospects ──────────────────────────────────────────────────────────────

interface SeedProspect {
  name: string;
  title: string;
  company: string;
  industry: string;
  geo: string;
  size: number;
  campaigns: string[];
}

/** Deliberate mix: clear fits, clear misses, borderline cases, exclusions,
 *  and one person in two live campaigns to exercise conflict handling. */
const PROSPECTS: SeedProspect[] = [
  // us-saas-cto: strong fits
  { name: "Dana Whitfield", title: "CTO", company: "Northwind Analytics", industry: "SaaS", geo: "United States", size: 620, campaigns: ["us-saas-cto"] },
  { name: "Marcus Lee", title: "VP Engineering", company: "Ledgerline", industry: "SaaS", geo: "United States", size: 340, campaigns: ["us-saas-cto"] },
  { name: "Priya Raghavan", title: "Head of Platform", company: "Quaystone Systems", industry: "Software", geo: "United States", size: 210, campaigns: ["us-saas-cto"] },
  { name: "Tom Alvarez", title: "Director of Engineering", company: "Brightpath Cloud", industry: "SaaS", geo: "United States", size: 1450, campaigns: ["us-saas-cto"] },
  { name: "Erin Foster", title: "CTO", company: "Cadence Retail Tech", industry: "Software", geo: "United States", size: 880, campaigns: ["us-saas-cto"] },
  // us-saas-cto: misses and edges
  { name: "Greg Mullen", title: "Marketing Manager", company: "Northwind Analytics", industry: "SaaS", geo: "United States", size: 620, campaigns: ["us-saas-cto"] },
  { name: "Sofia Marchetti", title: "CTO", company: "Talentbridge Staffing", industry: "Staffing", geo: "United States", size: 400, campaigns: ["us-saas-cto"] },
  { name: "Liam Novak", title: "VP Engineering", company: "Halden Software", industry: "SaaS", geo: "Germany", size: 300, campaigns: ["us-saas-cto"] },
  { name: "Ava Brennan", title: "CTO", company: "Tinyloop", industry: "SaaS", geo: "United States", size: 22, campaigns: ["us-saas-cto"] },

  // india-bfsi-cio
  { name: "Rajesh Kulkarni", title: "CIO", company: "Meridian Bank", industry: "Banking", geo: "India", size: 24000, campaigns: ["india-bfsi-cio"] },
  { name: "Anita Deshpande", title: "Chief Digital Officer", company: "Sahyadri Insurance", industry: "Insurance", geo: "India", size: 7600, campaigns: ["india-bfsi-cio"] },
  { name: "Vikram Nair", title: "CTO", company: "Kaveri Financial Services", industry: "Financial Services", geo: "India", size: 3100, campaigns: ["india-bfsi-cio"] },
  { name: "Shalini Gupta", title: "Head of Digital", company: "Arthveda NBFC", industry: "Financial Services", geo: "India", size: 420, campaigns: ["india-bfsi-cio"] },
  { name: "Karthik Subramanian", title: "CTO", company: "BlockBharat Digital Assets", industry: "Crypto", geo: "India", size: 180, campaigns: ["india-bfsi-cio"] },
  { name: "Neha Bhatt", title: "CIO", company: "Trident General Insurance", industry: "Insurance", geo: "India", size: 5200, campaigns: ["india-bfsi-cio"] },

  // voice-ai-founders
  { name: "Sam Okonkwo", title: "Founder", company: "Larkvoice", industry: "Voice AI", geo: "United States", size: 14, campaigns: ["voice-ai-founders"] },
  { name: "Jules Fontaine", title: "Co-founder & CTO", company: "Reverb Agents", industry: "Voice AI", geo: "United Kingdom", size: 9, campaigns: ["voice-ai-founders"] },
  { name: "Hana Sato", title: "CEO", company: "Tonewell AI", industry: "AI", geo: "United States", size: 38, campaigns: ["voice-ai-founders"] },
  { name: "Ben Kerrigan", title: "Founder", company: "Sidecar Speech", industry: "Voice AI", geo: "United States", size: 6, campaigns: ["voice-ai-founders"] },
  { name: "Ines Duarte", title: "CTO", company: "Corvid Labs", industry: "AI", geo: "United Kingdom", size: 120, campaigns: ["voice-ai-founders"] },
  { name: "Oliver Reid", title: "Head of Growth", company: "Tonewell AI", industry: "AI", geo: "United States", size: 38, campaigns: ["voice-ai-founders"] },

  // The same person, two live campaigns: a SaaS CTO who also founded an AI
  // company. Both campaigns want them; first_touch_wins decides.
  { name: "Elena Voss", title: "CTO", company: "Harborline AI", industry: "AI", geo: "United States", size: 150, campaigns: ["us-saas-cto", "voice-ai-founders"] },

  // enterprise-expansion (draft)
  { name: "Grace Lindqvist", title: "VP Engineering", company: "Northwind Analytics", industry: "SaaS", geo: "United States", size: 620, campaigns: ["enterprise-expansion"] },
  { name: "Daniel Osei", title: "Head of Operations", company: "Brightpath Cloud", industry: "SaaS", geo: "United States", size: 1450, campaigns: ["enterprise-expansion"] },
];

const REPS = [
  {
    id: "rep-maya",
    name: "Maya Iyer",
    email: "maya.iyer@example.com",
    title: "Senior SDR",
    timezone: "America/New_York",
    daily_limit: 60,
    campaigns: ["us-saas-cto", "voice-ai-founders"],
  },
  {
    id: "rep-rahul",
    name: "Rahul Menon",
    email: "rahul.menon@example.com",
    title: "Enterprise SDR",
    timezone: "Asia/Kolkata",
    daily_limit: 30,
    campaigns: ["india-bfsi-cio", "enterprise-expansion"],
  },
];

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");

// ── seeding ────────────────────────────────────────────────────────────────

export async function seedIfEmpty(db: Database): Promise<void> {
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM campaigns`);
  if ((rows[0]?.n ?? 0) > 0) return;

  for (const rep of REPS) {
    await db.query(
      `INSERT INTO reps (id, name, email, title, timezone, daily_limit)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [rep.id, rep.name, rep.email, rep.title, rep.timezone, rep.daily_limit],
    );
  }

  for (const c of CAMPAIGNS) {
    await db.query(
      `INSERT INTO campaigns
         (id, name, description, owner, status, icp_name, geography, objective,
          target_roles, company_criteria, exclusion_criteria, channels,
          daily_send_limit, min_days_between_touches, max_touches,
          qualification_threshold, autonomy, conflict_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        c.id,
        c.name,
        c.description,
        c.owner,
        // Everything starts as a draft; ensureDemoActivity() activates them
        // through the real lifecycle transitions instead of forcing status.
        "draft",
        c.icp_name,
        c.geography,
        c.objective,
        JSON.stringify(c.target_roles),
        JSON.stringify(c.company_criteria),
        JSON.stringify(c.exclusion_criteria),
        JSON.stringify(c.channels),
        c.daily_send_limit,
        c.min_days_between_touches,
        c.max_touches,
        c.qualification_threshold,
        c.autonomy,
        c.conflict_policy,
      ],
    );

    for (const agent of AGENT_KEYS) {
      await db.query(
        `INSERT INTO campaign_agent_state (campaign_id, agent_key, paused)
         VALUES ($1,$2,false) ON CONFLICT DO NOTHING`,
        [c.id, agent],
      );
    }
    for (const channel of CHANNELS) {
      await db.query(
        `INSERT INTO campaign_channel_state (campaign_id, channel, paused)
         VALUES ($1,$2,false) ON CONFLICT DO NOTHING`,
        [c.id, channel],
      );
    }

    await db.query(
      `INSERT INTO prompt_versions (id, campaign_id, scope, version, content, note, author, active)
       VALUES ($1,$2,'campaign',1,$3,'Initial campaign harness','system',true)`,
      [crypto.randomUUID(), c.id, CAMPAIGN_PROMPTS[c.id]],
    );
    for (const [agent, content] of Object.entries(AGENT_PROMPTS[c.id] ?? {})) {
      await db.query(
        `INSERT INTO prompt_versions (id, campaign_id, scope, version, content, note, author, active)
         VALUES ($1,$2,$3,1,$4,'Initial agent prompt','system',true)`,
        [crypto.randomUUID(), c.id, agent, content],
      );
    }
  }

  for (const rep of REPS) {
    for (const [i, campaignId] of rep.campaigns.entries()) {
      await db.query(
        `INSERT INTO campaign_reps (campaign_id, rep_id, is_sending_identity)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [campaignId, rep.id, i === 0 || rep.campaigns.length === 1],
      );
    }
    // The first campaign in each rep's list owns their sending identity; make
    // sure every campaign has one so activation is not blocked.
    for (const campaignId of rep.campaigns) {
      await db.query(
        `UPDATE campaign_reps SET is_sending_identity = true
          WHERE campaign_id = $1 AND rep_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM campaign_reps x
               WHERE x.campaign_id = $1 AND x.is_sending_identity)`,
        [campaignId, rep.id],
      );
    }
  }

  // Knowledge, embedded at seed time.
  for (const doc of DOCS) {
    const docId = crypto.randomUUID();
    await db.query(
      `INSERT INTO knowledge_docs (id, campaign_id, title, kind, body)
       VALUES ($1,$2,$3,$4,$5)`,
      [docId, doc.campaign, doc.title, doc.kind, doc.body],
    );
    const parts = doc.body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 40);
    for (const [i, content] of parts.entries()) {
      const vector = await embed(`${doc.title} [${doc.kind}] ${content}`);
      await db.query(
        `INSERT INTO knowledge_chunks
           (id, doc_id, campaign_id, kind, title, ordinal, content, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          crypto.randomUUID(),
          docId,
          doc.campaign,
          doc.kind,
          doc.title,
          i,
          content,
          toVector(vector),
        ],
      );
    }
  }

  // Prospects are platform-level; campaign membership is a separate row.
  for (const p of PROSPECTS) {
    const domain = `${slug(p.company).replace(/\./g, "")}.com`;
    const email = `${slug(p.name)}@${domain}`;
    const prospectId = crypto.randomUUID();
    await db.query(
      `INSERT INTO prospects
         (id, email, full_name, title, company, company_domain, industry,
          geography, employee_count, linkedin_url, phone, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'seed')
       ON CONFLICT (email) DO NOTHING`,
      [
        prospectId,
        email,
        p.name,
        p.title,
        p.company,
        domain,
        p.industry,
        p.geo,
        p.size,
        `https://linkedin.com/in/${slug(p.name).replace(/\./g, "-")}`,
        `+1${String(4155550000 + p.name.length * 137).slice(0, 10)}`,
      ],
    );
    const { rows: existing } = await db.query<{ id: string }>(
      `SELECT id FROM prospects WHERE email = $1`,
      [email],
    );
    const id = existing[0]?.id ?? prospectId;
    for (const campaignId of p.campaigns) {
      await db.query(
        `INSERT INTO campaign_prospects (id, campaign_id, prospect_id, stage, next_action)
         VALUES ($1,$2,$3,'discovered','research')
         ON CONFLICT (campaign_id, prospect_id) DO NOTHING`,
        [crypto.randomUUID(), campaignId, id],
      );
    }
  }

  // One pre-existing global opt-out, to show suppression working before any
  // campaign has touched the person.
  await db.query(
    `INSERT INTO suppression_list (id, email, reason)
     VALUES ($1, $2, 'opted out during a previous quarter')
     ON CONFLICT (email) DO NOTHING`,
    [crypto.randomUUID(), "erin.foster@cadenceretailtech.com"],
  );

  // Golden set for the ICP agent: known-correct verdicts the eval runner scores
  // the live configuration against.
  const EVALS: [string, string, string, Record<string, unknown>, string][] = [
    ["us-saas-cto", "qualify", "CTO at 620-person SaaS", { title: "CTO", industry: "SaaS", geography: "United States", employee_count: 620, company: "Northwind Analytics" }, "qualified"],
    ["us-saas-cto", "qualify", "Marketing manager, right company", { title: "Marketing Manager", industry: "SaaS", geography: "United States", employee_count: 620, company: "Northwind Analytics" }, "rejected"],
    ["us-saas-cto", "qualify", "CTO at a staffing firm", { title: "CTO", industry: "Staffing", geography: "United States", employee_count: 400, company: "Talentbridge Staffing" }, "rejected"],
    ["us-saas-cto", "qualify", "Right title, wrong geography", { title: "VP Engineering", industry: "SaaS", geography: "Germany", employee_count: 300, company: "Halden Software" }, "needs_review"],
    ["india-bfsi-cio", "qualify", "CIO at a large bank", { title: "CIO", industry: "Banking", geography: "India", employee_count: 24000, company: "Meridian Bank" }, "qualified"],
    ["india-bfsi-cio", "qualify", "Crypto firm is excluded", { title: "CTO", industry: "Crypto", geography: "India", employee_count: 180, company: "BlockBharat Digital Assets" }, "rejected"],
    ["india-bfsi-cio", "qualify", "Small NBFC below the bar", { title: "Head of Digital", industry: "Financial Services", geography: "India", employee_count: 420, company: "Arthveda NBFC" }, "needs_review"],
    ["voice-ai-founders", "qualify", "Nine-person voice AI founder", { title: "Co-founder & CTO", industry: "Voice AI", geography: "United Kingdom", employee_count: 9, company: "Reverb Agents" }, "qualified"],
    ["voice-ai-founders", "qualify", "Growth lead, outside the target roles", { title: "Head of Growth", industry: "AI", geography: "United States", employee_count: 38, company: "Tonewell AI" }, "rejected"],
    // Deliberately beyond what the offline rule engine can see: the firmographics
    // all fit, and only the remit disqualifies them. The ICP document says a
    // senior title without tooling ownership is a rejection, so a model that
    // reads the retrieved ICP should get this right where the rules cannot.
    ["us-saas-cto", "qualify", "CTO whose remit is customer-facing product only", { title: "CTO", industry: "SaaS", geography: "United States", employee_count: 900, company: "Fernpath Labs", note: "Owns the customer-facing product surface only; internal tooling and platform report to the COO." }, "rejected"],
  ];
  for (const [campaignId, agent, label, input, expected] of EVALS) {
    await db.query(
      `INSERT INTO eval_cases (id, campaign_id, agent_key, label, input, expected)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        crypto.randomUUID(),
        campaignId,
        agent,
        label,
        JSON.stringify(input),
        JSON.stringify({ verdict: expected }),
      ],
    );
  }

  console.log(
    `[seed] ${CAMPAIGNS.length} campaigns, ${PROSPECTS.length} prospects, ${DOCS.length} knowledge docs, embeddings at ${EMBED_DIM}d`,
  );
}

/**
 * Brings the demo to life by running the real orchestrator, then leaves the
 * campaigns in the state the walkthrough expects: two live, one paused with
 * its history intact, one still a draft.
 *
 * Must be called *after* getDb() resolves — it goes through the normal
 * control-plane and orchestrator paths, which open their own connections.
 */
/**
 * Demo-only clock shift: backdates one campaign's timestamps so cadence gates
 * open. Real SDR cadence is measured in days, so without this a reviewer sees
 * one touch and then a correctly-waiting queue. Used both to build the seeded
 * history and by the dashboard control, which labels it as a manual shift.
 */
export async function advanceCampaignClock(campaignId: string, days: number): Promise<void> {
  const { getDb } = await import("./client");
  const db = await getDb();
  const interval = `${days} days`;
  await db.query(
    `UPDATE messages SET created_at = created_at - $2::interval WHERE campaign_id = $1`,
    [campaignId, interval],
  );
  await db.query(
    `UPDATE campaign_prospects
        SET last_touch_at  = last_touch_at - $2::interval,
            next_action_at = CASE
              WHEN next_action_at IS NULL THEN NULL
              ELSE next_action_at - $2::interval
            END
      WHERE campaign_id = $1`,
    [campaignId, interval],
  );
}

const demoCache = globalThis as unknown as { __sdrDemo?: Promise<boolean> };

export function ensureDemoActivity(): Promise<boolean> {
  // The overview page and /api/overview can both ask for this on the same cold
  // start. Without a single shared promise they race, both see an unseeded
  // database and both build the history, doubling every number on the
  // dashboard.
  demoCache.__sdrDemo ??= buildDemoActivity();
  return demoCache.__sdrDemo;
}

async function buildDemoActivity(): Promise<boolean> {
  const { getDb } = await import("./client");
  const db = await getDb();

  // Atomic claim: whichever caller wins the UPDATE does the work, and any
  // other process starting at the same time sees no rows and returns.
  const { rows } = await db.query<{ claimed: number }>(
    `UPDATE platform_control SET demo_seeded = true
      WHERE id = 1 AND NOT demo_seeded
      RETURNING 1 AS claimed`,
  );
  if (!rows.length) return false;

  const { setStatus } = await import("@/core/platform/campaigns");
  const { tick } = await import("@/orchestrator/engine");

  // us-saas-cto and india-bfsi-cio build up real history.
  for (const id of ["us-saas-cto", "india-bfsi-cio"]) {
    const activated = await setStatus(id, "live", "seed");
    if (!activated.ok) {
      console.warn(`[seed] could not activate ${id}: ${activated.error}`);
      continue;
    }
    // Alternate ticking with a clock shift so the seeded history contains a
    // genuine multi-touch sequence with replies, rather than one touch and a
    // queue of prospects correctly waiting out their cadence gap.
    for (let i = 0; i < 7; i++) {
      await tick(id, 8);
      await advanceCampaignClock(id, 4);
    }
  }

  // The BFSI campaign is paused on purpose: its funnel, messages and decision
  // history stay visible while nothing new fires.
  await setStatus("india-bfsi-cio", "paused", "seed");

  // The founders campaign goes live with a fresh funnel so a demo tick has
  // visible work to do.
  const founders = await setStatus("voice-ai-founders", "live", "seed");
  if (!founders.ok) console.warn(`[seed] could not activate voice-ai-founders: ${founders.error}`);
  else {
    // Two ticks: research and qualification are done, outreach is not, so a
    // reviewer clicking "Run agents" immediately sees first contact happen.
    await tick("voice-ai-founders", 8);
    await tick("voice-ai-founders", 8);
  }

  // enterprise-expansion stays a draft.
  return true;
}
