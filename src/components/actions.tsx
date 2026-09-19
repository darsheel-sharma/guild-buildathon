"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50";

const VARIANTS = {
  primary: "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800",
  quiet: "border-line bg-surface text-ink hover:bg-neutral-50",
  danger: "border-rose-300 bg-rose-50 text-rose-900 hover:bg-rose-100",
  good: "border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100",
} as const;

/**
 * One button that POSTs and refreshes the server components. Every mutation in
 * the UI goes through this, so pending state and error surfacing are handled
 * once instead of being forgotten in eight places.
 */
export function ActionButton({
  url,
  body,
  children,
  variant = "quiet",
  confirm,
  onResult,
  title,
}: {
  url: string;
  body?: unknown;
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  confirm?: string;
  onResult?: (result: unknown) => void;
  title?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        title={title}
        disabled={busy}
        className={`${BASE} ${VARIANTS[variant]}`}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            const result = await post(url, body);
            onResult?.(result);
            startTransition(() => router.refresh());
          } catch (err) {
            setError(err instanceof Error ? err.message : "failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "working…" : children}
      </button>
      {error && <span className="max-w-xs text-[11px] text-rose-700">{error}</span>}
    </span>
  );
}

/** Global kill switch. Deliberately the loudest control on the page. */
export function KillSwitch({ on, reason }: { on: boolean; reason: string | null }) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 ${
        on ? "border-rose-300 bg-rose-50" : "border-line bg-surface"
      }`}
    >
      <div>
        <div className="text-[13px] font-medium">
          {on ? "All autonomous activity is halted" : "Global kill switch"}
        </div>
        <p className="mt-0.5 text-xs text-ink-soft">
          {on
            ? (reason ?? "Engaged from the dashboard.") +
              " No campaign can send, on any channel, until this is released."
            : "Stops every autonomous external action across every campaign, immediately."}
        </p>
      </div>
      {on ? (
        <ActionButton url="/api/control" body={{ on: false }} variant="good">
          Release
        </ActionButton>
      ) : (
        <ActionButton
          url="/api/control"
          body={{ on: true, reason: "engaged from the dashboard" }}
          variant="danger"
          confirm="Halt all autonomous outreach across every campaign?"
        >
          Engage kill switch
        </ActionButton>
      )}
    </div>
  );
}

/** Pause and resume toggles for one agent or one channel. */
export function PauseToggle({
  campaignId,
  kind,
  name,
  paused,
  label,
  disabled,
}: {
  campaignId: string;
  kind: "agent" | "channel";
  name: string;
  paused: boolean;
  label: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy || disabled}
      title={disabled ? "Channel is not enabled for this campaign" : undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await post(`/api/campaigns/${campaignId}/pause`, { [kind]: name, paused: !paused });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
      className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition disabled:opacity-40 ${
        paused
          ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
          : "border-line bg-surface hover:bg-neutral-50"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide">
        {busy ? "…" : paused ? "paused" : "running"}
      </span>
    </button>
  );
}

/** Runs a tick and shows what the agents actually did, step by step. */
export function RunPanel({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [result, setResult] = useState<null | {
    ran: boolean;
    blocked?: { reason: string; detail: string };
    repliesReceived: number;
    steps: { agent: string; prospect: string; action: string; detail: string; status: string }[];
  }>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          className={`${BASE} ${VARIANTS.primary}`}
          onClick={async () => {
            setBusy(true);
            try {
              setResult(await post(`/api/campaigns/${campaignId}/run`, { budget: 6 }));
              router.refresh();
            } catch (err) {
              setResult({
                ran: false,
                blocked: {
                  reason: "error",
                  detail: err instanceof Error ? err.message : "failed",
                },
                repliesReceived: 0,
                steps: [],
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "running agents…" : "Run agents now"}
        </button>
        <span className="text-[11px] text-ink-faint">
          Advances this campaign by up to 6 actions
        </span>
      </div>

      {result && !result.ran && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Nothing ran — {result.blocked?.detail || result.blocked?.reason}. This is the gate
          working: a campaign that is not live cannot execute.
        </p>
      )}

      {result?.ran && (
        <div className="space-y-1.5">
          {result.repliesReceived > 0 && (
            <p className="text-[11px] text-ink-soft">
              {result.repliesReceived} inbound {result.repliesReceived === 1 ? "reply" : "replies"}{" "}
              arrived and were routed to the conversation agent.
            </p>
          )}
          {result.steps.length === 0 && (
            <p className="text-xs text-ink-faint">
              No work was due. Every prospect is either finished, waiting on a cadence gap, or
              blocked by a policy.
            </p>
          )}
          {result.steps.map((step, i) => (
            <div
              key={i}
              className="flex items-baseline gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs"
            >
              <span className="w-20 shrink-0 font-mono text-[10px] text-ink-faint">
                {step.agent}
              </span>
              <span className="w-36 shrink-0 truncate">{step.prospect}</span>
              <span
                className={`w-40 shrink-0 truncate font-medium ${
                  step.status === "blocked"
                    ? "text-amber-800"
                    : step.status === "error"
                      ? "text-rose-800"
                      : step.status === "skipped"
                        ? "text-ink-faint"
                        : "text-emerald-900"
                }`}
              >
                {step.action}
              </span>
              <span className="truncate text-ink-soft">{step.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ticks every campaign at once — the isolation demonstration. */
export function RunAllPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<
    null | { campaignName: string; ran: boolean; blocked?: { detail: string }; steps: unknown[] }[]
  >(null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          className={`${BASE} ${VARIANTS.primary}`}
          onClick={async () => {
            setBusy(true);
            try {
              const json = await post("/api/run-all", { budget: 4 });
              setResults(json.results);
              router.refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "running every campaign…" : "Run all campaigns"}
        </button>
        <span className="text-[11px] text-ink-faint">
          Live campaigns advance; paused and draft campaigns report why they were skipped
        </span>
      </div>
      {results && (
        <ul className="space-y-1 text-xs">
          {results.map((r) => (
            <li key={r.campaignName} className="flex items-baseline gap-2">
              <span className="w-56 shrink-0 truncate">{r.campaignName}</span>
              {r.ran ? (
                <span className="text-emerald-900">{r.steps.length} actions</span>
              ) : (
                <span className="text-amber-800">skipped — {r.blocked?.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Golden-set evaluation for the ICP agent. */
export function EvalPanel({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | {
    passed: number;
    total: number;
    promptVersion: number;
    cases: { label: string; expected: string; actual: string; passed: boolean }[];
  }>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          className={`${BASE} ${VARIANTS.quiet}`}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(await post(`/api/campaigns/${campaignId}/eval`));
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "scoring…" : "Run ICP eval"}
        </button>
        {result && (
          <span className="text-xs">
            <strong className="nums">
              {result.passed}/{result.total}
            </strong>{" "}
            correct on qualify prompt v{result.promptVersion}
          </span>
        )}
      </div>
      {error && <p className="text-[11px] text-rose-700">{error}</p>}
      {result && (
        <ul className="space-y-1 text-[11px]">
          {result.cases.map((c) => (
            <li key={c.label} className="flex items-baseline gap-2">
              <span className={c.passed ? "text-emerald-700" : "text-rose-700"}>
                {c.passed ? "pass" : "fail"}
              </span>
              <span className="flex-1 truncate">{c.label}</span>
              <span className="text-ink-faint">
                expected {c.expected}, got {c.actual}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
