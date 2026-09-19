import type { ReactNode } from "react";

/** Live vs paused has to be unmistakable at a glance, not a colour guess. */
export function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    live: "bg-emerald-50 text-emerald-800 border-emerald-300",
    paused: "bg-amber-50 text-amber-900 border-amber-300",
    draft: "bg-neutral-100 text-neutral-700 border-neutral-300",
    completed: "bg-sky-50 text-sky-900 border-sky-300",
    archived: "bg-neutral-100 text-neutral-500 border-neutral-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${
        styles[status] ?? styles.draft
      }`}
    >
      {status === "live" && (
        <span className="size-1.5 rounded-full bg-emerald-600" aria-hidden="true" />
      )}
      {status === "paused" && (
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      )}
      {status}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  subtitle,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface">
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div>
            {title && <h2 className="text-[13px] font-medium">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="nums mt-1 text-xl">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-faint">{hint}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
}) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-700",
    good: "bg-emerald-50 text-emerald-800",
    warn: "bg-amber-50 text-amber-900",
    bad: "bg-rose-50 text-rose-900",
    info: "bg-sky-50 text-sky-900",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Horizontal funnel bar. Width is relative to the widest stage. */
export function FunnelBar({
  label,
  value,
  max,
  tone = "bg-neutral-800",
}: {
  label: string;
  value: number;
  max: number;
  tone?: string;
}) {
  const pct = max > 0 ? Math.max(value > 0 ? 3 : 0, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 shrink-0 text-xs capitalize text-ink-soft">{label}</div>
      <div className="h-4 flex-1 overflow-hidden rounded bg-neutral-100">
        <div className={`h-full rounded ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="nums w-10 shrink-0 text-right text-xs">{value}</div>
    </div>
  );
}

export const money = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
export const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

export function when(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
