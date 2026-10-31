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

export function StatusBadge({ status }: { status: string }) {
  return <span className={cx("inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", STATUS_STYLE[status] ?? STATUS_STYLE.DISMISSED)}>{STATUS_LABEL[status] ?? status}</span>;
}

const KIND_STYLE: Record<string, string> = {
  "login failed": "text-risk-high",
  "beneficiary add": "text-risk-high",
  "password reset": "text-risk-high",
  "device change": "text-risk-high",
};

/** Chronological event list; flagged events are marked, each links to its supporting record when on the same page. */
export function Timeline({ events, linkRecords = true }: { events: TimelineEvent[]; linkRecords?: boolean }) {
  if (events.length === 0) return <p className="text-sm text-ink-3">No timed events.</p>;
  return (
    <ol className="relative space-y-0 border-l border-line pl-4">
      {events.map((e) => (
        <li key={`${e.ref.table}:${e.ref.id}`} className="relative py-1.5">
          <span aria-hidden className={cx("absolute -left-[21px] top-3 h-2.5 w-2.5 rounded-full ring-2 ring-surface", e.flagged ? "bg-risk-high" : "bg-line-strong")} />
          <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
            <span className="w-32 shrink-0 text-xs text-ink-3 tabular">{fmtTime(e.time)}</span>
            <span className={cx("w-32 shrink-0 text-xs font-medium uppercase tracking-wide", KIND_STYLE[e.kind] ?? "text-ink-2")}>{e.kind}</span>
            <span className="min-w-0 flex-1">
              {e.summary}
              {e.flagged && <span className="ml-2 text-xs font-semibold text-risk-high">flagged</span>}
            </span>
            {linkRecords ? (
              <a href={`#${refAnchor(e.ref)}`} className="font-mono text-[11px] text-accent-ink hover:underline">{e.ref.id}</a>
            ) : (
              <span className="font-mono text-[11px] text-ink-3">{e.ref.id}</span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CustomerLink({ id }: { id: string | null }) {
  if (!id) return <>—</>;
  return <Link href={`/customers/${id}`} className="font-mono text-accent-ink hover:underline">{id}</Link>;
}
