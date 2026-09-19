/**
 * Schema for the whole platform. Kept as SQL-in-TypeScript rather than a .sql
 * file so it bundles into the serverless function without a filesystem read.
 *
 * Everything is IF NOT EXISTS: migrate() is safe to run on every cold start.
 */
import { EMBED_DIM } from "@/core/platform/embedding";
import type { Database } from "./client";

const schema = (dim: number) => `
CREATE EXTENSION IF NOT EXISTS vector;

-- global platform state ----------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_control (
  id            int PRIMARY KEY DEFAULT 1,
  kill_switch   boolean NOT NULL DEFAULT false,
  kill_reason   text,
  -- Claimed exactly once, so demo history is never built twice.
  demo_seeded   boolean NOT NULL DEFAULT false,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_control_single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS suppression_list (
  id         text PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reps (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  title         text NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  daily_limit   int  NOT NULL DEFAULT 50,
  working_hours text NOT NULL DEFAULT '09:00-18:00',
  active        boolean NOT NULL DEFAULT true
);

-- campaigns (control plane) ------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id                       text PRIMARY KEY,
  name                     text NOT NULL,
  description              text NOT NULL DEFAULT '',
  owner                    text NOT NULL,
  status                   text NOT NULL DEFAULT 'draft',
  icp_name                 text NOT NULL DEFAULT '',
  geography                text NOT NULL DEFAULT '',
  objective                text NOT NULL DEFAULT '',
  target_roles             jsonb NOT NULL DEFAULT '[]',
  company_criteria         jsonb NOT NULL DEFAULT '{}',
  exclusion_criteria       jsonb NOT NULL DEFAULT '[]',
  channels                 jsonb NOT NULL DEFAULT '[]',
  daily_send_limit         int  NOT NULL DEFAULT 40,
  min_days_between_touches int  NOT NULL DEFAULT 3,
  max_touches              int  NOT NULL DEFAULT 4,
  qualification_threshold  numeric NOT NULL DEFAULT 0.6,
  autonomy                 text NOT NULL DEFAULT 'auto',
  conflict_policy          text NOT NULL DEFAULT 'first_touch_wins',
  variant_of               text REFERENCES campaigns(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_reps (
  campaign_id         text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  rep_id              text NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  is_sending_identity boolean NOT NULL DEFAULT false,
  PRIMARY KEY (campaign_id, rep_id)
);

-- Agent- and channel-level pause live in their own tables so a pause is a
-- fact about one (campaign, agent) pair, never a mutation of campaign config.
CREATE TABLE IF NOT EXISTS campaign_agent_state (
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  agent_key   text NOT NULL,
  paused      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (campaign_id, agent_key)
);

CREATE TABLE IF NOT EXISTS campaign_channel_state (
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  paused      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (campaign_id, channel)
);

-- prompt / harness registry ------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_versions (
  id           text PRIMARY KEY,
  campaign_id  text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scope        text NOT NULL,
  version      int  NOT NULL,
  content      text NOT NULL,
  note         text NOT NULL DEFAULT '',
  author       text NOT NULL DEFAULT 'system',
  active       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, scope, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_one_active
  ON prompt_versions (campaign_id, scope) WHERE active;

-- knowledge / RAG ----------------------------------------------------------
-- campaign_id NULL means global knowledge, readable by every campaign.
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id          text PRIMARY KEY,
  campaign_id text REFERENCES campaigns(id) ON DELETE CASCADE,
  title       text NOT NULL,
  kind        text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          text PRIMARY KEY,
  doc_id      text NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  ordinal     int  NOT NULL,
  content     text NOT NULL,
  embedding   vector(${dim})
);

-- prospects ----------------------------------------------------------------
-- A prospect is a person owned by the platform, not by a campaign. That is
-- what makes cross-campaign dedupe and frequency capping possible at all.
CREATE TABLE IF NOT EXISTS prospects (
  id             text PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  full_name      text NOT NULL,
  title          text NOT NULL,
  company        text NOT NULL,
  company_domain text NOT NULL DEFAULT '',
  industry       text NOT NULL DEFAULT '',
  geography      text NOT NULL DEFAULT '',
  employee_count int  NOT NULL DEFAULT 0,
  linkedin_url   text NOT NULL DEFAULT '',
  phone          text NOT NULL DEFAULT '',
  source         text NOT NULL DEFAULT 'seed',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_prospects (
  id             text PRIMARY KEY,
  campaign_id    text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id    text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  stage          text NOT NULL DEFAULT 'discovered',
  icp_score      numeric,
  icp_verdict    text,
  icp_reasons    jsonb NOT NULL DEFAULT '[]',
  research       jsonb,
  plan           jsonb,
  touches        int NOT NULL DEFAULT 0,
  last_touch_at  timestamptz,
  last_channel   text,
  next_action    text,
  next_action_at timestamptz,
  outcome        text,
  blocked_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, prospect_id)
);

-- execution history --------------------------------------------------------
-- prompt_version_id + harness_hash are the audit trail: together they answer
-- "which configuration produced this outcome?" for every single action.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                   text PRIMARY KEY,
  campaign_id          text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_prospect_id text REFERENCES campaign_prospects(id) ON DELETE CASCADE,
  agent_key            text NOT NULL,
  status               text NOT NULL,
  summary              text NOT NULL DEFAULT '',
  input                jsonb,
  output               jsonb,
  error                text,
  retrieved            jsonb NOT NULL DEFAULT '[]',
  prompt_version_id    text REFERENCES prompt_versions(id),
  harness_hash         text NOT NULL DEFAULT '',
  model                text NOT NULL DEFAULT '',
  mode                 text NOT NULL DEFAULT 'simulated',
  input_tokens         int NOT NULL DEFAULT 0,
  output_tokens        int NOT NULL DEFAULT 0,
  cost_usd             numeric NOT NULL DEFAULT 0,
  latency_ms           int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                   text PRIMARY KEY,
  campaign_id          text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_prospect_id text NOT NULL REFERENCES campaign_prospects(id) ON DELETE CASCADE,
  direction            text NOT NULL,
  channel              text NOT NULL,
  subject              text NOT NULL DEFAULT '',
  body                 text NOT NULL,
  status               text NOT NULL DEFAULT 'sent',
  provider             text NOT NULL DEFAULT 'simulated',
  provider_ref         text NOT NULL DEFAULT '',
  sentiment            text,
  intent               text,
  sequence_step        int NOT NULL DEFAULT 1,
  -- inbound:  the conversation agent has read this reply
  -- outbound: the inbound simulator has decided whether a reply comes back
  handled              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          text PRIMARY KEY,
  campaign_id text REFERENCES campaigns(id) ON DELETE CASCADE,
  level       text NOT NULL DEFAULT 'info',
  type        text NOT NULL,
  message     text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conflicts (
  id                text PRIMARY KEY,
  prospect_id       text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  campaign_id       text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  other_campaign_id text REFERENCES campaigns(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  resolution        text NOT NULL,
  detail            text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id                   text PRIMARY KEY,
  campaign_id          text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_prospect_id text REFERENCES campaign_prospects(id) ON DELETE CASCADE,
  kind                 text NOT NULL,
  reason               text NOT NULL DEFAULT '',
  payload              jsonb NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'pending',
  decided_by           text,
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- evaluation (measurement and optimisation) --------------------------------
CREATE TABLE IF NOT EXISTS eval_cases (
  id          text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  agent_key   text NOT NULL,
  label       text NOT NULL,
  input       jsonb NOT NULL,
  expected    jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id                text PRIMARY KEY,
  campaign_id       text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  agent_key         text NOT NULL,
  prompt_version_id text REFERENCES prompt_versions(id),
  total             int NOT NULL,
  passed            int NOT NULL,
  detail            jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_control ADD COLUMN IF NOT EXISTS demo_seeded boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS cp_campaign_stage    ON campaign_prospects (campaign_id, stage);
CREATE INDEX IF NOT EXISTS cp_prospect          ON campaign_prospects (prospect_id);
CREATE INDEX IF NOT EXISTS runs_campaign_time   ON agent_runs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS msgs_campaign_time   ON messages (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_campaign_time ON events (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chunks_campaign      ON knowledge_chunks (campaign_id);
`;

export async function migrate(db: Database): Promise<void> {
  await db.exec(schema(EMBED_DIM));
  await db.query(
    `INSERT INTO platform_control (id, kill_switch, updated_by)
     VALUES (1, false, 'system') ON CONFLICT (id) DO NOTHING`,
  );
}
