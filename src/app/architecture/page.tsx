import { Card } from "@/components/ui";
import { channelTransports } from "@/core/platform/channels";
import { hasLiveModel, modelFor } from "@/core/platform/llm";
import { EMBED_DIM, hasLiveEmbeddings } from "@/core/platform/embedding";
import { getDb } from "@/core/db/client";
import { configuredAgents } from "@/core/platform/dronahq";
import { AGENT_KEYS } from "@/core/types";

export const dynamic = "force-dynamic";

const LAYERS = [
  {
    name: "Control plane",
    tone: "border-violet-300 bg-violet-50",
    hint: "what a human configures",
    boxes: [
      ["Campaigns", "ICP, targeting, policies"],
      ["Prompt registry", "versioned, roll-back-able"],
      ["Controls", "campaign / agent / channel / kill"],
      ["Dashboards", "funnel, cost, audit"],
    ],
  },
  {
    name: "Shared platform",
    tone: "border-teal-300 bg-teal-50",
    hint: "global, cross-campaign",
    boxes: [
      ["Orchestrator", "queue, gates, retries"],
      ["Conflict guard", "dedupe, frequency, suppression"],
      ["Knowledge", "pgvector retrieval"],
      ["Channels", "email, LinkedIn, SMS, voice"],
    ],
  },
  {
    name: "Intelligence layer",
    tone: "border-orange-300 bg-orange-50",
    hint: "seven agents, stateless",
    boxes: [
      ["Research", "enrich prospect context"],
      ["Qualify", "ICP fitment scoring"],
      ["Outreach", "strategy + personalisation"],
      ["Respond", "conversation, voice, follow-up"],
    ],
  },
];

export default async function ArchitecturePage() {
  const db = await getDb();
  const transports = channelTransports();
  const onDronaHq = configuredAgents(AGENT_KEYS);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-medium">How this is put together</h1>
        <p className="mt-1.5 max-w-3xl text-[13px] text-ink-soft">
          Three layers, not two. The control plane is not a view of the agents — it is the input to
          them. Config flows down, state and attribution flow back up, and everything that no single
          campaign can see for itself lives in the middle.
        </p>
      </div>

      <div className="space-y-2">
        {LAYERS.map((layer, i) => (
          <div key={layer.name}>
            <div className={`rounded-xl border px-4 py-3 ${layer.tone}`}>
              <div className="mb-2.5 flex items-baseline justify-between">
                <span className="text-[13px] font-medium">{layer.name}</span>
                <span className="text-[11px] opacity-70">{layer.hint}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {layer.boxes.map(([title, sub]) => (
                  <div key={title} className="rounded-lg border border-white/70 bg-white/70 px-3 py-2">
                    <div className="text-[12px] font-medium">{title}</div>
                    <div className="text-[11px] opacity-70">{sub}</div>
                  </div>
                ))}
              </div>
            </div>
            {i < LAYERS.length - 1 && (
              <div className="flex items-center justify-center gap-10 py-1.5 text-[11px] text-ink-faint">
                <span>↓ campaign config, prompts, policies</span>
                <span>↑ funnel state, cost, prompt version used</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Why the middle layer has to exist">
          <ul className="space-y-2 text-[13px] text-ink-soft">
            <li>
              <strong className="font-medium text-ink">Prospects belong to the platform.</strong> A
              person can sit in several campaigns, so only the platform can notice that two live
              campaigns are about to contact them in the same week.
            </li>
            <li>
              <strong className="font-medium text-ink">Opt-outs are global.</strong> Someone who
              unsubscribes from one campaign is suppressed everywhere, immediately.
            </li>
            <li>
              <strong className="font-medium text-ink">
                Frequency caps are measured per person.
              </strong>{" "}
              A prospect does not care which campaign sent the message, so the cap is counted across
              all of them.
            </li>
            <li>
              <strong className="font-medium text-ink">The kill switch is one flag.</strong> Every
              gate in the system reads it, so there is exactly one place to stop everything.
            </li>
          </ul>
        </Card>

        <Card title="What is wired to what right now">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[12px]">
            <dt className="text-ink-faint">Database</dt>
            <dd className="text-right">
              {db.driver === "postgres"
                ? "Postgres via DATABASE_URL"
                : "PGlite, in-process Postgres"}
            </dd>
            <dt className="text-ink-faint">Vector search</dt>
            <dd className="text-right">pgvector, {EMBED_DIM}-dimension embeddings</dd>
            <dt className="text-ink-faint">Embeddings</dt>
            <dd className="text-right">
              {hasLiveEmbeddings() ? "live embedding model" : "local hashed projection"}
            </dd>
            <dt className="text-ink-faint">DronaHQ agents</dt>
            <dd className="text-right">
              {onDronaHq.length ? onDronaHq.join(", ") : "none configured"}
            </dd>
            <dt className="text-ink-faint">Agent models</dt>
            <dd className="text-right">
              {hasLiveModel() ? `${modelFor("strong")} / ${modelFor("fast")}` : "deterministic stand-ins"}
            </dd>
            {Object.entries(transports).map(([channel, transport]) => (
              <div key={channel} className="col-span-2 grid grid-cols-[1fr_auto] gap-x-4">
                <dt className="text-ink-faint capitalize">{channel}</dt>
                <dd className="text-right">{transport === "live" ? "live provider" : "simulated"}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-ink-faint">
            Every one of these switches to a real provider by setting a credential — the code path
            is the same either way, and each agent run and message records which mode produced it.
          </p>
        </Card>
      </div>

      <Card title="The three rules the orchestrator holds">
        <ol className="list-inside list-decimal space-y-1.5 text-[13px] text-ink-soft">
          <li>
            The gate is re-checked before every step and again immediately before every send, so a
            pause mid-tick stops the next action rather than the next tick.
          </li>
          <li>
            Nothing leaves the platform without passing the conflict guard: suppression, duplicate
            outreach, contact frequency and the daily budget.
          </li>
          <li>
            Every step is recorded as an agent run, a message, an event, or all three — the
            dashboard is a view of what happened, not a summary someone maintained.
          </li>
        </ol>
      </Card>
    </div>
  );
}
