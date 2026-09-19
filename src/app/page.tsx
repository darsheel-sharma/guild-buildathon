import Link from "next/link";
import { KillSwitch, RunAllPanel } from "@/components/actions";
import { Badge, Card, Stat, StatusPill, money, when } from "@/components/ui";
import { ensureDemoActivity } from "@/core/db/seed";
import { channelTransports } from "@/core/platform/channels";
import { isKillSwitchOn } from "@/core/platform/control";
import { listEvents } from "@/core/platform/events";
import { hasLiveModel, modelFor } from "@/core/platform/llm";
import { overview } from "@/core/platform/metrics";
import { CHANNELS } from "@/core/types";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  // First load after a cold start runs the real orchestrator to build history.
  await ensureDemoActivity();

  const [campaigns, kill, events] = await Promise.all([
    overview(),
    isKillSwitchOn(),
    listEvents(null, 14),
  ]);

  const transports = channelTransports();
  const live = campaigns.filter((c) => c.status === "live");
  const totals = campaigns.reduce(
    (acc, c) => ({
      prospects: acc.prospects + c.prospects,
      outreach: acc.outreach + c.outreach,
      replies: acc.replies + c.replies,
      meetings: acc.meetings + c.meetings,
      cost: acc.cost + c.costUsd,
      approvals: acc.approvals + c.pendingApprovals,
    }),
    { prospects: 0, outreach: 0, replies: 0, meetings: 0, cost: 0, approvals: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium">All campaigns</h1>
          <p className="mt-1 text-[13px] text-ink-soft">
            {live.length} live, {campaigns.length - live.length} not running.{" "}
            {hasLiveModel()
              ? `Agents are calling ${modelFor("strong")} and ${modelFor("fast")}.`
              : "Agents are running on deterministic stand-ins — no model key is configured."}
          </p>
        </div>
        <Link
          href="/architecture"
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs hover:bg-neutral-50"
        >
          How this is put together
        </Link>
      </div>

      <KillSwitch on={kill.on} reason={kill.reason} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Prospects" value={totals.prospects} />
        <Stat label="Outreach sent" value={totals.outreach} />
        <Stat label="Replies" value={totals.replies} />
        <Stat label="Meetings" value={totals.meetings} />
        <Stat label="Agent spend" value={money(totals.cost)} hint="across all campaigns" />
        <Stat label="Awaiting a human" value={totals.approvals} hint="pending approvals" />
      </div>

      <Card
        title="Campaigns"
        subtitle="Each row is an independent program: its own ICP, prompts, policies and state."
      >
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-3xl border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">ICP</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Channels</th>
                <th className="px-3 py-2 text-right font-medium">Prospects</th>
                <th className="px-3 py-2 text-right font-medium">Qualified</th>
                <th className="px-3 py-2 text-right font-medium">Outreach</th>
                <th className="px-3 py-2 text-right font-medium">Replies</th>
                <th className="px-3 py-2 text-right font-medium">Meetings</th>
                <th className="px-3 py-2 text-right font-medium">Spend</th>
                <th className="px-4 py-2 font-medium">Last run</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-line/70 last:border-0 hover:bg-neutral-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                      <span>{c.owner}</span>
                      {c.autonomy === "approval_required" && <Badge tone="info">needs approval</Badge>}
                      {c.variant_of && <Badge tone="neutral">variant</Badge>}
                      {c.pendingApprovals > 0 && (
                        <Badge tone="warn">{c.pendingApprovals} pending</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">{c.icp_name}</td>
                  <td className="px-3 py-2.5">
                    <StatusPill status={c.status} />
                  </td>
                  <td className="px-3 py-2.5 text-[11px] text-ink-soft">{c.channels.join(", ")}</td>
                  <td className="nums px-3 py-2.5 text-right">{c.prospects}</td>
                  <td className="nums px-3 py-2.5 text-right">{c.qualified}</td>
                  <td className="nums px-3 py-2.5 text-right">{c.outreach}</td>
                  <td className="nums px-3 py-2.5 text-right">{c.replies}</td>
                  <td className="nums px-3 py-2.5 text-right">{c.meetings}</td>
                  <td className="nums px-3 py-2.5 text-right text-ink-soft">{money(c.costUsd)}</td>
                  <td className="px-4 py-2.5 text-[11px] text-ink-faint">{when(c.lastActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Card
          title="Run the engine"
          subtitle="The isolation test: one click, and only the live campaigns move."
        >
          <RunAllPanel />
        </Card>

        <Card title="Channel transports" subtitle="What each channel is actually wired to.">
          <ul className="space-y-1.5 text-[13px]">
            {CHANNELS.map((channel) => (
              <li key={channel} className="flex items-center justify-between">
                <span className="capitalize">{channel}</span>
                {transports[channel] === "live" ? (
                  <Badge tone="good">live provider</Badge>
                ) : (
                  <Badge tone="neutral">simulated</Badge>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-ink-faint">
            A channel goes live the moment its credentials are set. Nothing leaves this machine
            while it says simulated, and every message row records which transport sent it.
          </p>
        </Card>
      </div>

      <Card title="Platform activity" subtitle="Every campaign, newest first.">
        {events.length === 0 ? (
          <p className="text-xs text-ink-faint">Nothing has happened yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2.5 text-[13px]">
                <span className="w-16 shrink-0 text-[11px] text-ink-faint">
                  {when(e.created_at)}
                </span>
                <span
                  className={`w-1.5 shrink-0 self-center rounded-full ${
                    e.level === "error"
                      ? "size-1.5 bg-rose-500"
                      : e.level === "warn"
                        ? "size-1.5 bg-amber-500"
                        : e.level === "action"
                          ? "size-1.5 bg-sky-500"
                          : "size-1.5 bg-neutral-300"
                  }`}
                  aria-hidden="true"
                />
                <span className="flex-1">{e.message}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{e.type}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
