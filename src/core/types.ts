/** Shared vocabulary for all three layers. */

export const CHANNELS = ["email", "linkedin", "sms", "voice"] as const;
export type Channel = (typeof CHANNELS)[number];

export const AGENT_KEYS = [
  "research",
  "qualify",
  "outreach",
  "personalise",
  "converse",
  "voice",
  "followup",
] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_LABELS: Record<AgentKey, string> = {
  research: "Lead research & enrichment",
  qualify: "ICP fitment",
  outreach: "Outreach strategy",
  personalise: "Personalisation",
  converse: "Conversation",
  voice: "Voice SDR",
  followup: "Follow-up",
};

export const CAMPAIGN_STATUSES = ["draft", "live", "paused", "completed", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** The funnel the campaign dashboard reports on, in order. */
export const STAGES = [
  "discovered",
  "researched",
  "qualified",
  "contacted",
  "engaged",
  "meeting",
  "opportunity",
] as const;
export type Stage = (typeof STAGES)[number];

/** Terminal stages, excluded from the funnel chart. */
export const TERMINAL_STAGES = ["rejected", "stopped"] as const;
export type TerminalStage = (typeof TERMINAL_STAGES)[number];

export type AnyStage = Stage | TerminalStage;

export interface Campaign {
  id: string;
  name: string;
  description: string;
  owner: string;
  status: CampaignStatus;
  icp_name: string;
  geography: string;
  objective: string;
  target_roles: string[];
  company_criteria: Record<string, unknown>;
  exclusion_criteria: string[];
  channels: Channel[];
  daily_send_limit: number;
  min_days_between_touches: number;
  max_touches: number;
  qualification_threshold: number;
  autonomy: "auto" | "approval_required";
  conflict_policy: "first_touch_wins" | "priority_campaign" | "allow_both";
  variant_of: string | null;
  created_at: string;
  updated_at: string;
}

export interface Prospect {
  id: string;
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

export interface CampaignProspect {
  id: string;
  campaign_id: string;
  prospect_id: string;
  stage: AnyStage;
  icp_score: number | null;
  icp_verdict: string | null;
  icp_reasons: string[];
  research: ResearchOutput | null;
  plan: OutreachPlan | null;
  touches: number;
  last_touch_at: string | null;
  last_channel: Channel | null;
  next_action: string | null;
  next_action_at: string | null;
  outcome: string | null;
  blocked_reason: string | null;
  updated_at: string;
}

export interface ResearchOutput {
  company_summary: string;
  role_summary: string;
  signals: string[];
  pain_hypotheses: string[];
  personalisation_hooks: string[];
  tech_stack: string[];
  confidence: number;
}

export interface QualifyOutput {
  score: number;
  verdict: "qualified" | "rejected" | "needs_review";
  reasons: string[];
}

export interface OutreachPlan {
  channel: Channel;
  should_contact: boolean;
  rationale: string;
  wait_days: number;
  sequence_step: number;
  // Richer decision detail from the DronaHQ Outreach Strategy Agent, kept
  // optional so nothing that reads the base five fields above has to change.
  action?: "contact" | "wait" | "skip" | "escalate";
  reason?: string;
  human_approval_required?: boolean;
  angle?: string;
  priority?: "high" | "medium" | "low";
  flags?: string[];
  planned_sequence?: string[];
}

export interface DraftedMessage {
  subject: string;
  body: string;
  knowledge_used: string[];
  personalisation_basis?: string;
  word_count?: number;
  requires_review?: boolean;
  unverified_claims?: string[];
  flags?: string[];
}

export interface ReplyReading {
  sentiment: "positive" | "neutral" | "negative";
  intent:
    | "meeting"
    | "info"
    | "objection"
    | "referral"
    | "not_interested"
    | "unsubscribe"
    | "deferred"
    | "complaint"
    | "auto_reply"
    | "bounce"
    | "unclear";
  next_action:
    | "book_meeting"
    | "send_info"
    | "handle_objection"
    | "follow_up"
    | "stop"
    | "escalate"
    | "pause";
  reasoning: string;
  objection?: string;
  /** Exact phrase from the reply that drove the classification. */
  trigger_phrase?: string;
  /** Instructions for the personalisation agent; set only when next_action is respond-like. */
  response_brief?: string;
  /** Set only when next_action is "pause" — how long to hold before retrying. */
  resume_after_days?: number;
  /** Anything actionable pulled from the reply: availability, a referred name, a timeline, a changed role. */
  extracted?: string[];
  confidence?: "high" | "medium" | "low";
  human_review?: boolean;
  flags?: string[];
}

/** Every agent action is stamped with the exact configuration that produced it. */
export interface HarnessStamp {
  prompt_version_id: string | null;
  harness_hash: string;
  campaign_prompt_version: number;
  agent_prompt_version: number;
}

export interface RetrievedChunk {
  id: string;
  title: string;
  kind: string;
  content: string;
  similarity: number;
}
