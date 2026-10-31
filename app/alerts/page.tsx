import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Empty, LevelBadge, Pill, PageHeader, buttonClass, cx, fmtTime, inputClass } from "@/components/ui";
import { DETECTORS } from "@/lib/policy";
import { listAlerts, type AlertFilters } from "@/lib/queries";

export const metadata: Metadata = { title: "Alerts" };

const VIEWS = [
  ["actionable", "Actionable risk (High + Medium)"],
  ["monitored", "Monitored signals (Low)"],
  ["all", "All"],
] as const;
const FILTER_KEYS = ["customer", "transaction", "product", "level", "detector", "case_status", "from", "to", "q"] as const;

export default function AlertsPage({ searchParams }: PageProps<"/alerts">) {
  return (
    <>
      <PageHeader
        title="Fraud alerts"
        description="Every finding from the latest detection run, with its risk level. Open one to see why it was flagged and the records behind it."
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
  const view = (["actionable", "monitored", "all"].includes(get("view")) ? get("view") : "actionable") as AlertFilters["view"];
  const filters: AlertFilters = { view };
  for (const k of FILTER_KEYS) if (get(k)) filters[k] = get(k);
  const { run, alerts, total } = await listAlerts(filters);

  const qs = (overrides: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (filters[k]) p.set(k, filters[k]!);
    for (const [k, v] of Object.entries(overrides)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    return `/alerts?${p.toString()}`;
  };
  const activeFilters = FILTER_KEYS.filter((k) => filters[k]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
        {VIEWS.map(([v, label]) => (
          <Link key={v} href={qs({ view: v })} role="tab" aria-selected={view === v}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm", view === v ? "border-accent font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink")}>
            {label}
          </Link>
        ))}
      </div>

      <form method="get" action="/alerts" className="grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-9">
        <input type="hidden" name="view" value={view} />
        <Field label="Customer ID" className="lg:col-span-1"><input name="customer" defaultValue={filters.customer} placeholder="CUS…" className={inputClass} /></Field>
        <Field label="Transaction ID" className="lg:col-span-1"><input name="transaction" defaultValue={filters.transaction} placeholder="TXN…" className={inputClass} /></Field>
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
        <Field label="Case status">
          <select name="case_status" defaultValue={filters.case_status ?? ""} className={inputClass}>
            <option value="">Any</option>
            <option value="OPEN">Open</option>
            <option value="REQUIRES_INVESTIGATION">Requires investigation</option>
            <option value="ESCALATED">Escalated</option>
            <option value="FALSE_POSITIVE">False positive</option>
            <option value="DISMISSED">Dismissed</option>
            <option value="NO_CASE">No case</option>
          </select>
        </Field>
        <Field label="From"><input type="date" name="from" defaultValue={filters.from} className={inputClass} /></Field>
        <Field label="To"><input type="date" name="to" defaultValue={filters.to} className={inputClass} /></Field>
        <div className="flex items-end gap-2">
          <button type="submit" className={cx(buttonClass("primary"), "flex-1")}>Filter</button>
          {activeFilters.length > 0 && <Link href={`/alerts?view=${view}`} className={buttonClass()}>Clear</Link>}
        </div>
      </form>

      {!run ? (
        <Empty title="No detection run yet">Load or upload data, then run detection from the dashboard or ingestion page.</Empty>
      ) : (
        <Card padded={false} title={<>{total} alert{total === 1 ? "" : "s"}{activeFilters.length ? " matching filters" : ""}{alerts.length < total ? ` (showing ${alerts.length})` : ""}</>}>
          {alerts.length === 0 ? (
            <p className="p-4 text-sm text-ink-3">No alerts match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="border-b border-line text-xs text-ink-3">
                  <tr>{["Risk", "Detector", "What happened", "Customers", "Products", "Event time (UTC)", "Top reason"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {alerts.map((a) => {
                    const top = [...a.signals].sort((x, y) => y.weight - x.weight)[0];
                    return (
                      <tr key={a.alert_id} className="hover:bg-surface-2">
                        <td className="px-4 py-2.5"><Link href={`/alerts/${a.alert_id}`}><LevelBadge level={a.level} score={a.score} /></Link></td>
                        <td className="px-4 py-2.5"><Pill title={a.category}>{a.detector}</Pill></td>
                        <td className="max-w-xs px-4 py-2.5">
                          <Link href={`/alerts/${a.alert_id}`} className="font-medium hover:underline">{a.title}</Link>
                          <div className="text-xs text-ink-3">{a.category}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-ink-2">{a.customer_ids.slice(0, 2).join(", ")}{a.customer_ids.length > 2 ? ` +${a.customer_ids.length - 2}` : ""}</td>
                        <td className="px-4 py-2.5 text-xs text-ink-2">{a.products.join(", ")}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-2 tabular">{fmtTime(a.event_time)}</td>
                        <td className="max-w-[14rem] px-4 py-2.5 text-xs text-ink-2">{top?.label}{a.mitigations.length > 0 && <span className="text-good-ink"> · −{a.mitigations.reduce((s, m) => s + m.weight, 0)} context</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx("block text-sm", className)}>
      <span className="mb-1 block text-xs text-ink-2">{label}</span>
      {children}
    </label>
  );
}
