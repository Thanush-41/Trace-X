import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Search } from "lucide-react";
import { StatusBadge } from "@/components/case-bits";
import { Card, Empty, FilterChips, LevelBadge, Pill, PageHeader, buttonClass, cx, fmtTime, inputClass } from "@/components/ui";
import { DETECTORS } from "@/lib/policy";
import { listAlerts, type AlertFilters, type AlertListRow } from "@/lib/queries";

export const metadata: Metadata = { title: "Alerts" };

const VIEWS = [
  ["actionable", "Actionable", "High + Medium risk; each is in a case"],
  ["monitored", "Monitored", "Low risk; kept with the reasons it was not escalated"],
  ["all", "All", "Every finding in the latest run"],
] as const;
const STATUSES = [
  ["", "Any status"],
  ["OPEN", "Unreviewed"],
  ["REQUIRES_INVESTIGATION", "Requires investigation"],
  ["ESCALATED", "Escalated"],
  ["FALSE_POSITIVE", "False positive"],
  ["DISMISSED", "Dismissed"],
  ["NO_CASE", "No case"],
] as const;
const FILTER_KEYS = ["customer", "transaction", "product", "level", "detector", "case_status", "from", "to", "q"] as const;
const LABELS: Record<string, string> = {
  customer: "Customer", transaction: "Transaction", product: "Product", level: "Risk", detector: "Detector", case_status: "Status", from: "From", to: "To", q: "Search",
};
const STATUS_LABEL = Object.fromEntries(STATUSES) as Record<string, string>;

export default function AlertsPage({ searchParams }: PageProps<"/alerts">) {
  return (
    <>
      <PageHeader
        eyebrow="Triage"
        title="Alert explorer"
        description="Risk level says how suspicious a finding is; review status says what an investigator decided. Open any alert to see why it was flagged and the records behind it."
      />
      <Suspense fallback={<p className="text-sm text-ink-3">Loading alerts…</p>}>
        <Alerts searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Alerts({ searchParams }: { searchParams: PageProps<"/alerts">["searchParams"] }) {
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const view = (["actionable", "monitored", "all"].includes(get("view")) ? get("view") : "actionable") as NonNullable<AlertFilters["view"]>;
  const filters: AlertFilters = { view };
  for (const k of FILTER_KEYS) if (get(k)) filters[k] = get(k);
  const { run, alerts, total, counts } = await listAlerts(filters);

  const qs = (overrides: Record<string, string>) => {
    const p = new URLSearchParams();
    p.set("view", view);
    for (const k of FILTER_KEYS) if (filters[k]) p.set(k, filters[k]!);
    for (const [k, v] of Object.entries(overrides)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    return `/alerts?${p.toString()}`;
  };
  const active = FILTER_KEYS.filter((k) => filters[k]);
  const chips = active.map((k) => ({
    label: `${LABELS[k]}: ${k === "case_status" ? STATUS_LABEL[filters[k]!] ?? filters[k] : k === "detector" ? `${filters[k]} ${DETECTORS[filters[k] as keyof typeof DETECTORS] ?? ""}` : filters[k]}`,
    href: qs({ [k]: "" }),
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Risk tier">
        {VIEWS.map(([v, label, hint]) => (
          <Link key={v} href={qs({ view: v })} role="tab" aria-selected={view === v} title={hint}
            className={cx("-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm", view === v ? "border-accent font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink")}>
            {label}
            <span className={cx("rounded-full px-1.5 text-xs tabular", view === v ? "bg-accent text-white" : "bg-surface-2 text-ink-2")}>{counts[v]}</span>
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Review status">
        {STATUSES.map(([v, label]) => (
          <Link key={v || "any"} href={qs({ case_status: v })} aria-pressed={(filters.case_status ?? "") === v}
            className={cx("rounded-full border px-3 py-1 text-xs", (filters.case_status ?? "") === v ? "border-accent bg-accent-wash font-medium text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>
            {label}
          </Link>
        ))}
      </div>

      <form method="get" action="/alerts" className="space-y-3 rounded-xl border border-line bg-surface p-3 shadow-card">
        <input type="hidden" name="view" value={view} />
        {filters.case_status && <input type="hidden" name="case_status" value={filters.case_status} />}
        <div className="flex gap-2">
          <label className="relative flex-1">
            <span className="sr-only">Search alerts</span>
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input name="q" defaultValue={filters.q} placeholder="Search by alert, customer, account, device or claim ID" className={cx(inputClass, "pl-8")} />
          </label>
          <button type="submit" className={buttonClass("primary")}>Apply</button>
        </div>
        <details open={active.some((k) => k !== "q" && k !== "case_status")}>
          <summary className="cursor-pointer text-xs font-medium text-accent-ink">More filters</summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
            <Field label="Customer ID"><input name="customer" defaultValue={filters.customer} placeholder="CUS…" className={inputClass} /></Field>
            <Field label="Transaction ID"><input name="transaction" defaultValue={filters.transaction} placeholder="TXN…" className={inputClass} /></Field>
            <Field label="Product">
              <select name="product" defaultValue={filters.product ?? ""} className={inputClass}>
                <option value="">Any</option>
                <option value="banking">Core banking</option>
                <option value="lending">Lending</option>
                <option value="cards">Cards</option>
                <option value="insurance">Insurance</option>
              </select>
            </Field>
            <Field label="Risk level">
              <select name="level" defaultValue={filters.level ?? ""} className={inputClass}>
                <option value="">Any</option>
                <option>High</option><option>Medium</option><option>Low</option>
              </select>
            </Field>
            <Field label="Detection type">
              <select name="detector" defaultValue={filters.detector ?? ""} className={inputClass}>
                <option value="">Any</option>
                {Object.entries(DETECTORS).map(([id, label]) => <option key={id} value={id}>{id} {label}</option>)}
              </select>
            </Field>
            <Field label="From"><input type="date" name="from" defaultValue={filters.from} className={inputClass} /></Field>
            <Field label="To"><input type="date" name="to" defaultValue={filters.to} className={inputClass} /></Field>
          </div>
        </details>
      </form>

      <FilterChips chips={chips} clearHref={`/alerts?view=${view}`} />

      {!run ? (
        <Empty title="No detection run yet">Load or upload data, then run detection from the command center or the ingestion page.</Empty>
      ) : alerts.length === 0 ? (
        <Empty title="No alerts match">Try another tab or remove a filter.</Empty>
      ) : (
        <Card padded={false} title={<>{total} alert{total === 1 ? "" : "s"}{alerts.length < total ? ` (showing ${alerts.length})` : ""}</>}>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>{["Risk", "What happened", "Customers", "Products", "Event (UTC)", "Case / review"].map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {alerts.map((a) => (
                  <tr key={a.alert_id} className="relative align-top transition-colors hover:bg-surface-2">
                    <td className="px-4 py-3"><LevelBadge level={a.level} score={a.score} /></td>
                    <td className="max-w-md px-4 py-3">
                      <Link href={`/alerts/${a.alert_id}`} className="font-medium after:absolute after:inset-0 hover:underline">{a.title}</Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                        <Pill>{a.detector}</Pill>{a.category}
                        <span className="text-ink-2">· {topReason(a)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-2">{a.customer_ids.slice(0, 2).join(", ")}{a.customer_ids.length > 2 ? ` +${a.customer_ids.length - 2}` : ""}</td>
                    <td className="px-4 py-3 text-xs text-ink-2">{a.products.join(", ")}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-2 tabular">{fmtTime(a.event_time)}</td>
                    <td className="px-4 py-3"><ReviewStatus a={a} />{a.case_id && <Link href={`/cases/${a.case_id}`} className="relative z-10 mt-1 block font-mono text-[11px] text-accent-ink hover:underline">{a.case_id} · investigate →</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line md:hidden">
            {alerts.map((a) => (
              <li key={a.alert_id}>
                <Link href={`/alerts/${a.alert_id}`} className="block space-y-1.5 px-4 py-3 hover:bg-surface-2">
                  <div className="flex items-center justify-between gap-2"><LevelBadge level={a.level} score={a.score} /><ReviewStatus a={a} /></div>
                  <div className="text-sm font-medium">{a.title}</div>
                  <div className="text-xs text-ink-3">{a.detector} {a.category} · {fmtTime(a.event_time)}</div>
                  <div className="text-xs text-ink-2">{topReason(a)}</div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function topReason(a: AlertListRow) {
  const top = [...a.signals].sort((x, y) => y.weight - x.weight)[0];
  const context = a.mitigations.reduce((s, m) => s + m.weight, 0);
  return `${top?.label ?? ""}${context ? ` · −${context} legitimate context` : ""}`;
}

function ReviewStatus({ a }: { a: AlertListRow }) {
  if (a.case_status) return <StatusBadge status={a.case_status} />;
  return <span className="text-xs text-ink-3">{a.level === "Low" ? "Monitored" : "No case"}</span>;
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx("block text-sm", className)}>
      <span className="mb-1 block text-xs text-ink-2">{label}</span>
      {children}
    </label>
  );
}
