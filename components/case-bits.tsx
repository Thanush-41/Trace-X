import Link from "next/link";
import type { TimelineEvent } from "@/lib/cases";
import { STATUS_LABEL } from "@/lib/cases";
import { cx, fmtTime } from "@/components/ui";
import { refAnchor } from "@/components/evidence";

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-accent-wash text-accent-ink",
  REQUIRES_INVESTIGATION: "bg-surface-2 text-ink ring-1 ring-inset ring-risk-medium",
  ESCALATED: "bg-surface-2 text-risk-high ring-1 ring-inset ring-risk-high",
  FALSE_POSITIVE: "bg-surface-2 text-good-ink",
  DISMISSED: "bg-surface-2 text-ink-2",
};

const PROGRESS = [
  { key: "OPEN", label: "Opened by detection" },
  { key: "REQUIRES_INVESTIGATION", label: "Requires investigation" },
  { key: "ESCALATED", label: "Escalated" },
  { key: "CLOSED", label: "Closed" },
];

/** Where the case is in the review workflow; closing as false positive or dismissed ends it. */
export function StatusProgress({ status, history }: { status: string; history: string[] }) {
  const closed = status === "FALSE_POSITIVE" || status === "DISMISSED";
  const reached = new Set(["OPEN", ...history, ...(closed ? ["CLOSED"] : [])]);
  const currentKey = closed ? "CLOSED" : status;
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Case progress">
      {PROGRESS.map((p, i) => {
        const current = p.key === currentKey;
        const done = reached.has(p.key) && !current;
        const label = p.key === "CLOSED" && closed ? `Closed · ${STATUS_LABEL[status]}` : p.label;
        return (
          <li key={p.key} className="flex items-center gap-1" aria-current={current ? "step" : undefined}>
            {i > 0 && <span aria-hidden className={cx("h-px w-4 sm:w-8", done || current ? "bg-accent" : "bg-line-strong")} />}
            <span className={cx("rounded-full border px-2.5 py-1", current ? "border-accent bg-accent text-white" : done ? "border-accent/50 bg-accent-wash text-accent-ink" : "border-line text-ink-3")}>
              {done && "✓ "}{label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={cx("inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", STATUS_STYLE[status] ?? STATUS_STYLE.DISMISSED)}>{STATUS_LABEL[status] ?? status}</span>;
}

const KIND_STYLE: Record<string, string> = {
  "login failed": "text-risk-high",
  "beneficiary add": "text-risk-high",
  "password reset": "text-risk-high",
  "device change": "text-risk-high",
};

const ROLE: Record<string, { label: string; cls: string }> = {
  trigger: { label: "Trigger", cls: "bg-risk-high text-white" },
  evidence: { label: "Evidence", cls: "bg-accent-wash text-accent-ink" },
  profile: { label: "Profile", cls: "bg-surface-2 text-ink-2 ring-1 ring-inset ring-line-strong" },
  baseline: { label: "Baseline", cls: "bg-surface-2 text-ink-3" },
};

function Row({ e, linkRecords }: { e: TimelineEvent; linkRecords: boolean }) {
  const role = e.role ? ROLE[e.role] : null;
  return (
    <li className="relative py-1.5">
      <span aria-hidden className={cx("absolute -left-[21px] top-3 h-2.5 w-2.5 rounded-full ring-2 ring-surface", e.role === "trigger" || (!e.role && e.flagged) ? "bg-risk-high" : e.role === "baseline" ? "bg-line" : "bg-line-strong")} />
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="w-32 shrink-0 text-xs text-ink-3 tabular">{fmtTime(e.time)}</span>
        {role && <span className={cx("w-16 shrink-0 rounded px-1 text-center text-[10px] font-semibold uppercase", role.cls)}>{role.label}</span>}
        <span className={cx("w-36 shrink-0 text-xs font-medium uppercase tracking-wide", KIND_STYLE[e.kind] ?? "text-ink-2")}>{e.kind}</span>
        {e.system && <span className="w-28 shrink-0 text-[11px] text-ink-3">{e.system}</span>}
        <span className="min-w-0 flex-1">
          {e.summary}
          {!e.role && e.flagged && <span className="ml-2 text-xs font-semibold text-risk-high">flagged</span>}
          {e.why && <span className="block text-[11px] text-ink-3">{e.role === "trigger" ? "This event " : "Used by: "}{e.why}</span>}
        </span>
        {linkRecords ? (
          <a href={`#${refAnchor(e.ref)}`} className="font-mono text-[11px] text-accent-ink hover:underline">{e.ref.id}</a>
        ) : (
          <span className="font-mono text-[11px] text-ink-3">{e.ref.id}</span>
        )}
      </div>
    </li>
  );
}

/**
 * Chronological event list. Normal past behaviour (baseline) is folded away by default so the story reads
 * as profile → activity → triggers; each event links to its supporting record when on the same page.
 */
export function Timeline({ events, linkRecords = true }: { events: TimelineEvent[]; linkRecords?: boolean }) {
  if (events.length === 0) return <p className="text-sm text-ink-3">No timed events.</p>;
  const main = events.filter((e) => e.role !== "baseline");
  const baseline = events.filter((e) => e.role === "baseline");
  const hasRoles = events.some((e) => e.role);
  return (
    <div className="space-y-3">
      {hasRoles && (
        <p className="text-xs text-ink-3">
          <span className="font-semibold text-risk-high">Trigger</span>: raised an alert ·{" "}
          <span className="font-semibold text-accent-ink">Evidence</span>: supports a risk signal ·{" "}
          <span className="font-semibold">Profile</span>: when a customer or account was created (KYC / onboarding, not a login) ·{" "}
          <span className="font-semibold">Baseline</span>: the customer&apos;s normal past activity, used only for comparison
        </p>
      )}
      <ol className="relative space-y-0 border-l border-line pl-4">
        {main.map((e) => <Row key={`${e.ref.table}:${e.ref.id}`} e={e} linkRecords={linkRecords} />)}
      </ol>
      {baseline.length > 0 && (
        <details className="rounded-md border border-line bg-surface-2/50 px-3 py-2">
          <summary className="cursor-pointer text-xs text-ink-2">
            {baseline.length} earlier transaction{baseline.length === 1 ? "" : "s"} used as the normal-behaviour baseline (not suspicious; shown so the comparison can be checked)
          </summary>
          <ol className="relative mt-2 space-y-0 border-l border-line pl-4">
            {baseline.map((e) => <Row key={`${e.ref.table}:${e.ref.id}`} e={e} linkRecords={linkRecords} />)}
          </ol>
        </details>
      )}
    </div>
  );
}

export function CustomerLink({ id }: { id: string | null }) {
  if (!id) return <>—</>;
  return <Link href={`/customers/${id}`} className="font-mono text-accent-ink hover:underline">{id}</Link>;
}
