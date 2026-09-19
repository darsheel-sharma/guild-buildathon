import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, EvalPanel, PauseToggle, RunPanel } from "@/components/actions";
import { Badge, Card, FunnelBar, Stat, StatusPill, money, pct, when } from "@/components/ui";
import { activationBlockers, getCampaign } from "@/core/platform/campaigns";
import { channelTransports } from "@/core/platform/channels";
import { listConflicts } from "@/core/platform/conflicts";
import { getPauseState, isKillSwitchOn } from "@/core/platform/control";
import { listEvents } from "@/core/platform/events";
import { campaignReps, pendingApprovals, prospectRows, recentRuns, threads } from "@/core/platform/inspect";
import { listDocs } from "@/core/platform/knowledge";
import { campaignMetrics } from "@/core/platform/metrics";
import { evalHistory } from "@/orchestrator/evals";
import { AGENT_KEYS, AGENT_LABELS, CHANNELS, STAGES } from "@/core/types";

export const dynamic = "force-dynamic";

const STAGE_TONE: Record<string, string> = {
  opportunity: "bg-emerald-50 text-emerald-800",
  meeting: "bg-emerald-50 text-emerald-800",
  engaged: "bg-sky-50 text-sky-900",
  contacted: "bg-neutral-100 text-neutral-700",
  qualified: "bg-violet-50 text-violet-900",
  researched: "bg-neutral-100 text-neutral-700",
  discovered: "bg-neutral-100 text-neutral-500",
  rejected: "bg-rose-50 text-rose-900",
  stopped: "bg-amber-50 text-amber-900",
};

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) notFound();

  const [
    metrics,
    pauses,
    kill,
    blockers,
    runs,
    convos,
    approvals,
    prospects,
    conflicts,
    reps,
    docs,
    evals,
    events,
  ] = await Promise.all([
    campaignMetrics(id),
    getPauseState(id),
    isKillSwitchOn(),
    activationBlockers(campaign),
    recentRuns(id, 18),
    threads(id, 4),
    pendingApprovals(id),
    prospectRows(id, 30),
    listConflicts(id, 8),
    campaignReps(id),
    listDocs(id),
    evalHistory(id, 3),
    listEvents(id, 12),
  ]);

  const transports = channelTransports();
  const maxFunnel = Math.max(1, ...STAGES.map((s) => metrics.funnelReached[s]));
  const campaignDocs = docs.filter((d) => d.campaign_id === id);
  const globalDocs = docs.filter((d) => !d.campaign_id);

  return (
    <div className="space-y-5">
      {/* header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Link href="/" className="text-xs text-ink-faint hover:text-ink">
              Campaigns
            </Link>
            <span className="text-xs text-ink-faint">/</span>
            <h1 className="text-lg font-medium">{campaign.name}</h1>
            <StatusPill status={campaign.status} />
          </div>
          <p className="mt-1.5 max-w-3xl text-[13px] text-ink-soft">{campaign.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
            <span>{campaign.icp_name}</span>
            <span>·</span>
            <span>{campaign.geography}</span>
            <span>·</span>
            <span>{campaign.owner}</span>
            <span>·</span>
            <span>{campaign.channels.join(", ")}</span>
            {campaign.autonomy === "approval_required" && <Badge tone="info">approval required</Badge>}
            {campaign.variant_of && (
              <Link href={`/campaigns/${campaign.variant_of}`} className="underline">
                variant of another campaign
              </Link>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/campaigns/${id}/prompts`}
            className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs hover:bg-neutral-50"
          >
            Prompts & versions
          </Link>
          <ActionButton url={`/api/campaigns/${id}/duplicate`} variant="quiet">
            Duplicate as variant
          </ActionButton>
          {campaign.status === "live" ? (
            <ActionButton
              url={`/api/campaigns/${id}/lifecycle`}
              body={{ status: "paused" }}
              variant="danger"
              title="Stops all autonomous execution for this campaign only"
            >
              Pause campaign
            </ActionButton>
          ) : campaign.status === "paused" ? (
            <ActionButton
              url={`/api/campaigns/${id}/lifecycle`}
              body={{ status: "live" }}
              variant="good"
            >
              Resume campaign
            </ActionButton>
          ) : campaign.status === "draft" ? (
            <ActionButton
              url={`/api/campaigns/${id}/lifecycle`}
              body={{ status: "live" }}
              variant="primary"
              confirm="Activate this campaign? Agents will begin contacting prospects."
            >
              Activate campaign
            </ActionButton>
          ) : null}
          {(campaign.status === "live" || campaign.status === "paused") && (
            <ActionButton
              url={`/api/campaigns/${id}/lifecycle`}
              body={{ status: "completed" }}
              variant="quiet"
            >
              Complete
            </ActionButton>
          )}
        </div>
      </div>

      {/* state banners --------------------------------------------------- */}
      {kill.on && (
        <p className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-[13px] text-rose-900">
          The global kill switch is engaged, so nothing in this campaign will execute regardless of
          its status. {kill.reason}
        </p>
      )}
      {campaign.status === "paused" && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900">
          Paused. Autonomous execution has stopped, and everything below — prospects, conversations,
          decision history — is retained exactly as it was. Resuming picks up where it left off.
        </p>
      )}
      {campaign.status === "draft" && (
        <div className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px]">
          <strong className="font-medium">Pre-flight check.</strong>{" "}
          {blockers.length === 0 ? (
            <span className="text-emerald-800">
              Ready to activate: prompts, knowledge, channels and a sending identity are all in
              place.
            </span>
          ) : (
            <span className="text-amber-900">
              Cannot activate yet — {blockers.join("; ")}.
            </span>
          )}
        </div>
      )}

      {/* stats ----------------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Prospects" value={metrics.totals.prospects} />
        <Stat
          label="Outreach"
          value={metrics.totals.outreach}
          hint={`${pct(metrics.rates.replyRate)} reply rate`}
        />
        <Stat
          label="Replies"
          value={metrics.totals.replies}
          hint={`${metrics.totals.positiveReplies} positive`}
        />
        <Stat label="Meetings" value={metrics.totals.meetings} />
        <Stat
          label="Cost / qualified"
          value={money(metrics.rates.costPerQualified)}
          hint={`${money(metrics.totals.costUsd)} total`}
        />
        <Stat
          label="Agent runs"
          value={metrics.totals.liveRuns + metrics.totals.simulatedRuns}
          hint={
            metrics.totals.liveRuns
              ? `${metrics.totals.liveRuns} live model calls`
              : "all simulated"
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        {/* funnel ------------------------------------------------------- */}
        <Card
          title="Prospect funnel"
          subtitle="Cumulative: how many prospects reached each stage or beyond."
        >
          <div className="space-y-1.5">
            {STAGES.map((stage) => (
              <FunnelBar
                key={stage}
                label={stage}
                value={metrics.funnelReached[stage]}
                max={maxFunnel}
                tone={
                  stage === "meeting" || stage === "opportunity"
                    ? "bg-emerald-600"
                    : stage === "engaged"
                      ? "bg-sky-600"
                      : "bg-neutral-700"
                }
              />
            ))}
          </div>
          <div className="mt-3 flex gap-4 border-t border-line pt-2.5 text-[11px] text-ink-soft">
            <span>
              rejected by ICP: <strong className="nums">{metrics.funnel.rejected}</strong>
            </span>
            <span>
              sequence stopped: <strong className="nums">{metrics.funnel.stopped}</strong>
            </span>
            <span>
              qualification rate: <strong>{pct(metrics.rates.qualificationRate)}</strong>
            </span>
          </div>
        </Card>

        {/* controls ----------------------------------------------------- */}
        <Card
          title="Operational control"
          subtitle="Campaign, agent and channel pause are independent levers."
        >
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-faint">
                Agents
              </div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {AGENT_KEYS.map((agent) => (
                  <PauseToggle
                    key={agent}
                    campaignId={id}
                    kind="agent"
                    name={agent}
                    label={AGENT_LABELS[agent]}
                    paused={pauses.agents[agent] ?? false}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-faint">
                Channels
              </div>
              <div className="grid grid-cols-2 gap-1">
                {CHANNELS.map((channel) => {
                  const enabled = campaign.channels.includes(channel);
                  return (
                    <PauseToggle
                      key={channel}
                      campaignId={id}
                      kind="channel"
                      name={channel}
                      label={`${channel}${transports[channel] === "simulated" ? " (sim)" : ""}`}
                      paused={pauses.channels[channel] ?? false}
                      disabled={!enabled}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* run ------------------------------------------------------------- */}
      <Card
        title="Agent execution"
        subtitle="Runs the real pipeline: replies first, then research, qualification and outreach."
      >
        <RunPanel campaignId={id} />
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
          <ActionButton url={`/api/campaigns/${id}/fast-forward`} body={{ days: 3 }} variant="quiet">
            Advance clock 3 days
          </ActionButton>
          <span className="text-[11px] text-ink-faint">
            Demo control, not agent activity. This campaign waits{" "}
            {campaign.min_days_between_touches} days between touches, so the follow-up sequence
            cannot otherwise be shown in one sitting. It only shifts this campaign&apos;s
            timestamps, and the shift is recorded in the activity log.
          </span>
        </div>
      </Card>

      {/* approvals ------------------------------------------------------- */}
      {approvals.length > 0 && (
        <Card
          title={`Waiting on a human (${approvals.length})`}
          subtitle="The agents stopped and asked. Nothing moves on these until someone decides."
        >
          <ul className="space-y-2">
            {approvals.map((a) => {
              const payload =
                typeof a.payload === "string" ? JSON.parse(a.payload) : (a.payload ?? {});
              return (
                <li key={a.id} className="rounded-lg border border-line px-3 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="text-[13px] font-medium">
                        {a.kind.replace(/_/g, " ")}
                        {a.prospect_name ? ` — ${a.prospect_name}` : ""}
                      </span>
                      <p className="mt-0.5 text-xs text-ink-soft">{a.reason}</p>
                    </div>
                    <div className="flex gap-2">
                      <ActionButton
                        url={`/api/approvals/${a.id}`}
                        body={{ decision: "approved" }}
                        variant="good"
                      >
                        Approve
                      </ActionButton>
                      <ActionButton
                        url={`/api/approvals/${a.id}`}
                        body={{ decision: "rejected" }}
                        variant="danger"
                      >
                        Reject
                      </ActionButton>
                    </div>
                  </div>
                  {typeof payload.body === "string" && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-[11px] text-ink-soft">
                      {payload.subject ? `Subject: ${payload.subject}\n\n` : ""}
                      {payload.body}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* conversations --------------------------------------------------- */}
      <Card
        title="Conversations"
        subtitle="One thread per prospect across every channel — this is what makes it one SDR."
      >
        {convos.length === 0 ? (
          <p className="text-xs text-ink-faint">
            No messages yet. Run the agents to start outreach.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {convos.map((t) => (
              <div key={t.cpId} className="rounded-lg border border-line">
                <div className="flex items-baseline justify-between gap-2 border-b border-line px-3 py-2">
                  <div>
                    <div className="text-[13px] font-medium">{t.prospect}</div>
                    <div className="text-[11px] text-ink-faint">
                      {t.title} · {t.company}
                    </div>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${
                      STAGE_TONE[t.stage] ?? STAGE_TONE.discovered
                    }`}
                  >
                    {t.stage}
                  </span>
                </div>
                <div className="max-h-72 space-y-2 overflow-auto px-3 py-2.5">
                  {t.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-lg px-2.5 py-2 text-[12px] ${
                        m.direction === "inbound"
                          ? "border border-sky-200 bg-sky-50"
                          : "border border-line bg-neutral-50"
                      }`}
                    >
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
                        <span>{m.direction === "inbound" ? "reply" : "sent"}</span>
                        <span>·</span>
                        <span>{m.channel}</span>
                        {m.intent && (
                          <>
                            <span>·</span>
                            <span>{m.intent}</span>
                          </>
                        )}
                        <span className="ml-auto normal-case">{when(m.created_at)}</span>
                      </div>
                      {m.subject && <div className="font-medium">{m.subject}</div>}
                      <p className="whitespace-pre-wrap text-ink-soft">{m.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* audit trail ----------------------------------------------------- */}
      <Card
        title="Agent runs"
        subtitle="Every action, with the prompt version and harness hash that produced it."
      >
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-3xl border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Prospect</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="px-3 py-2 font-medium">Grounded in</th>
                <th className="px-3 py-2 font-medium">Config</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 text-right font-medium">Latency</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const retrieved =
                  typeof r.retrieved === "string" ? JSON.parse(r.retrieved) : (r.retrieved ?? []);
                return (
                  <tr key={r.id} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2 text-ink-faint">{when(r.created_at)}</td>
                    <td className="px-3 py-2">{r.agent_key}</td>
                    <td className="px-3 py-2 text-ink-soft">{r.prospect_name ?? "—"}</td>
                    <td className="px-3 py-2">
                      {r.status === "skipped" || r.status === "degraded" ? (
                        <Badge tone={r.status === "degraded" ? "warn" : "neutral"}>
                          {r.status}
                        </Badge>
                      ) : null}{" "}
                      {r.summary}
                      {r.error && (
                        <span className="block text-[10px] text-amber-800">{r.error}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-ink-faint">
                      {retrieved.length
                        ? retrieved
                            .map(
                              (c: { title: string; similarity: number }) =>
                                `${c.title} (${c.similarity.toFixed(2)})`,
                            )
                            .join(", ")
                        : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-ink-faint">
                      {r.prompt_scope ? `${r.prompt_scope} v${r.prompt_version}` : "—"} ·{" "}
                      {r.harness_hash || "—"}
                      <span className="block">
                        {r.mode === "live" ? r.model : `${r.model} (simulated)`}
                      </span>
                    </td>
                    <td className="nums px-3 py-2 text-right text-ink-soft">
                      {money(Number(r.cost_usd))}
                    </td>
                    <td className="nums px-4 py-2 text-right text-ink-faint">{r.latency_ms}ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {metrics.totals.simulatedRuns > 0 && metrics.totals.liveRuns === 0 && (
          <p className="mt-2 text-[11px] text-ink-faint">
            All runs above are simulated: no model credential is configured, so agents used their
            deterministic stand-ins. Costs are priced estimates, not spend.
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* agent activity ---------------------------------------------- */}
        <Card title="Agent activity" subtitle="Per-agent volume, spend and latency.">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 font-medium">Agent</th>
                <th className="py-1.5 text-right font-medium">Done</th>
                <th className="py-1.5 text-right font-medium">Degraded</th>
                <th className="py-1.5 text-right font-medium">Skipped</th>
                <th className="py-1.5 text-right font-medium">Spend</th>
                <th className="py-1.5 text-right font-medium">Avg</th>
              </tr>
            </thead>
            <tbody>
              {metrics.agents.map((a) => (
                <tr key={a.agent} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5">
                    {AGENT_LABELS[a.agent]}
                    {pauses.agents[a.agent] && <Badge tone="warn">paused</Badge>}
                  </td>
                  <td className="nums py-1.5 text-right">{a.completed}</td>
                  <td className="nums py-1.5 text-right">{a.degraded || "—"}</td>
                  <td className="nums py-1.5 text-right">{a.skipped || "—"}</td>
                  <td className="nums py-1.5 text-right text-ink-soft">{money(a.costUsd)}</td>
                  <td className="nums py-1.5 text-right text-ink-faint">{a.avgLatencyMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* channels ----------------------------------------------------- */}
        <Card title="Channel activity" subtitle="Outbound and inbound per channel.">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 font-medium">Channel</th>
                <th className="py-1.5 font-medium">Enabled</th>
                <th className="py-1.5 font-medium">Transport</th>
                <th className="py-1.5 text-right font-medium">Sent</th>
                <th className="py-1.5 text-right font-medium">Received</th>
              </tr>
            </thead>
            <tbody>
              {metrics.channels.map((c) => (
                <tr key={c.channel} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 capitalize">{c.channel}</td>
                  <td className="py-1.5">
                    {campaign.channels.includes(c.channel) ? (
                      pauses.channels[c.channel] ? (
                        <Badge tone="warn">paused</Badge>
                      ) : (
                        <Badge tone="good">on</Badge>
                      )
                    ) : (
                      <span className="text-ink-faint">off</span>
                    )}
                  </td>
                  <td className="py-1.5 text-[11px] text-ink-faint">{transports[c.channel]}</td>
                  <td className="nums py-1.5 text-right">{c.outbound}</td>
                  <td className="nums py-1.5 text-right">{c.inbound}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* conflicts + measurement ----------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Cross-campaign conflicts"
          subtitle={`Policy: ${campaign.conflict_policy.replace(/_/g, " ")}. Only the platform can see these.`}
        >
          {conflicts.length === 0 ? (
            <p className="text-xs text-ink-faint">
              No collisions yet. A conflict is recorded when this campaign meets a prospect another
              campaign is already working, or one on the global suppression list.
            </p>
          ) : (
            <ul className="space-y-1.5 text-[12px]">
              {conflicts.map((k) => (
                <li key={k.id} className="flex items-baseline gap-2">
                  <Badge tone={k.resolution.startsWith("blocked") ? "bad" : "warn"}>
                    {k.resolution.startsWith("blocked") ? "blocked" : "allowed"}
                  </Badge>
                  <span className="font-medium">{k.prospect_name}</span>
                  <span className="flex-1 text-ink-soft">{k.detail}</span>
                  <span className="text-[10px] text-ink-faint">{when(k.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Measurement"
          subtitle="Golden-set accuracy for the ICP agent, scored against the live prompt."
        >
          <EvalPanel campaignId={id} />
          {evals.length > 0 && (
            <div className="mt-3 border-t border-line pt-2.5">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                Previous runs
              </div>
              <ul className="space-y-1 text-[11px]">
                {evals.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2">
                    <span className="nums">
                      {e.passed}/{e.total}
                    </span>
                    <span className="text-ink-faint">
                      qualify prompt v{e.prompt_version ?? "?"}
                    </span>
                    <span className="ml-auto text-ink-faint">{when(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[11px]">
            <dt className="text-ink-faint">Cost per meeting</dt>
            <dd className="nums text-right">{money(metrics.rates.costPerMeeting)}</dd>
            <dt className="text-ink-faint">Positive reply rate</dt>
            <dd className="nums text-right">{pct(metrics.rates.positiveRate)}</dd>
            <dt className="text-ink-faint">Meeting rate per touch</dt>
            <dd className="nums text-right">{pct(metrics.rates.meetingRate)}</dd>
          </dl>
        </Card>
      </div>

      {/* prospects ------------------------------------------------------- */}
      <Card
        title="Prospects"
        subtitle="Scored against this campaign's criteria — the same person can score differently elsewhere."
      >
        <div className="-mx-4 max-h-96 overflow-auto">
          <table className="w-full min-w-3xl border-collapse text-[12px]">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2 font-medium">Prospect</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 text-right font-medium">Fit</th>
                <th className="px-3 py-2 font-medium">Why</th>
                <th className="px-3 py-2 text-right font-medium">Touches</th>
                <th className="px-4 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {prospects.map((p) => {
                const reasons: string[] =
                  typeof p.icp_reasons === "string"
                    ? JSON.parse(p.icp_reasons)
                    : (p.icp_reasons ?? []);
                return (
                  <tr key={p.cp_id} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2">
                      <div>{p.full_name}</div>
                      <div className="text-[10px] text-ink-faint">{p.title}</div>
                    </td>
                    <td className="px-3 py-2 text-ink-soft">
                      {p.company}
                      <div className="text-[10px] text-ink-faint">
                        {p.geography} · {p.employee_count}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${
                          STAGE_TONE[p.stage] ?? STAGE_TONE.discovered
                        }`}
                      >
                        {p.stage}
                      </span>
                    </td>
                    <td className="nums px-3 py-2 text-right">
                      {p.icp_score === null ? "—" : Number(p.icp_score).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-ink-faint">{reasons[0] ?? "—"}</td>
                    <td className="nums px-3 py-2 text-right">
                      {p.touches}
                      {p.last_channel && (
                        <span className="block text-[10px] text-ink-faint">{p.last_channel}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-[10px] text-amber-800">
                      {p.blocked_reason ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* config, knowledge, reps, events ---------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Campaign configuration" subtitle="Campaign-level, isolated from every other.">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[12px]">
            <dt className="text-ink-faint">Target roles</dt>
            <dd className="text-right">{campaign.target_roles.join(", ") || "—"}</dd>
            <dt className="text-ink-faint">Company criteria</dt>
            <dd className="text-right">
              {JSON.stringify(campaign.company_criteria).replace(/[{}"]/g, "").replace(/,/g, ", ")}
            </dd>
            <dt className="text-ink-faint">Exclusions</dt>
            <dd className="text-right">{campaign.exclusion_criteria.join(", ") || "none"}</dd>
            <dt className="text-ink-faint">Qualification threshold</dt>
            <dd className="nums text-right">{campaign.qualification_threshold}</dd>
            <dt className="text-ink-faint">Daily send limit</dt>
            <dd className="nums text-right">{campaign.daily_send_limit}</dd>
            <dt className="text-ink-faint">Cadence</dt>
            <dd className="nums text-right">
              {campaign.min_days_between_touches}d gap, max {campaign.max_touches}
            </dd>
            <dt className="text-ink-faint">Autonomy</dt>
            <dd className="text-right">{campaign.autonomy.replace(/_/g, " ")}</dd>
            <dt className="text-ink-faint">Conflict policy</dt>
            <dd className="text-right">{campaign.conflict_policy.replace(/_/g, " ")}</dd>
          </dl>
        </Card>

        <Card
          title="Knowledge base"
          subtitle={`${campaignDocs.length} campaign documents, ${globalDocs.length} global.`}
        >
          <ul className="space-y-1 text-[12px]">
            {docs.map((d) => (
              <li key={d.id} className="flex items-baseline gap-2">
                <Badge tone={d.campaign_id ? "info" : "neutral"}>
                  {d.campaign_id ? "campaign" : "global"}
                </Badge>
                <span className="flex-1 truncate">{d.title}</span>
                <span className="text-[10px] text-ink-faint">
                  {d.kind} · {d.chunks} chunks
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-[11px] text-ink-faint">
            Retrieval for this campaign sees campaign documents plus global ones, never another
            campaign&apos;s. Chunks are embedded and searched with pgvector.
          </p>
        </Card>

        <Card title="Representatives" subtitle="Who this campaign sends as.">
          <ul className="space-y-2 text-[12px]">
            {reps.map((r) => (
              <li key={r.id} className="rounded-lg border border-line px-2.5 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{r.name}</span>
                  {r.is_sending_identity && <Badge tone="good">sending identity</Badge>}
                </div>
                <div className="mt-0.5 text-[10px] text-ink-faint">
                  {r.title} · {r.email}
                </div>
                <div className="mt-0.5 text-[10px] text-ink-faint">
                  {r.working_hours} {r.timezone} · {r.daily_limit}/day
                  {r.other_campaigns > 0 &&
                    ` · also on ${r.other_campaigns} other campaign${r.other_campaigns > 1 ? "s" : ""}`}
                </div>
              </li>
            ))}
            {reps.length === 0 && (
              <li className="text-xs text-amber-800">
                No rep assigned — this campaign cannot be activated until one is.
              </li>
            )}
          </ul>
        </Card>
      </div>

      <Card title="Campaign activity" subtitle="Decisions, pauses and escalations for this campaign.">
        <ul className="space-y-1.5">
          {events.map((e) => (
            <li key={e.id} className="flex items-baseline gap-2.5 text-[12px]">
              <span className="w-14 shrink-0 text-[10px] text-ink-faint">{when(e.created_at)}</span>
              <span className="flex-1">{e.message}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">{e.type}</span>
            </li>
          ))}
          {events.length === 0 && <li className="text-xs text-ink-faint">Nothing yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
