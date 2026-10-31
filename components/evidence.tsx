import Link from "next/link";
import type { Ref, Rule } from "@/lib/detect/types";
import { PK } from "@/lib/queries";
import { Mono, cx, fmtAmount, fmtTime } from "@/components/ui";

export const refAnchor = (r: Ref) => `ref-${r.table}-${r.id}`;

const TABLE_LABELS: Record<Ref["table"], string> = {
  customers: "Customers", accounts: "Accounts", transactions: "Transactions", login_events: "Device & login events", loan_applications: "Loan applications", insurance_claims: "Insurance claims",
};

/** Columns shown for each source table, in order. */
const COLUMNS: Record<Ref["table"], [string, string, ((v: unknown) => string)?][]> = {
  customers: [["customer_id", "Customer"], ["full_name", "Name"], ["phone", "Phone"], ["email", "Email"], ["address", "Address"], ["dob", "Born"], ["national_id", "National ID"], ["declared_income", "Income", fmtAmount], ["onboarding_date", "Onboarded", (v) => String(v ?? "").slice(0, 10)]],
  accounts: [["account_id", "Account"], ["customer_id", "Customer"], ["product", "Product"], ["account_type", "Type"], ["opened_at", "Opened", (v) => String(v ?? "").slice(0, 10)]],
  transactions: [["transaction_id", "Transaction"], ["timestamp", "Time (UTC)", (v) => fmtTime(String(v))], ["account_id", "From"], ["beneficiary_account", "To"], ["amount", "Amount", fmtAmount], ["channel", "Channel"], ["type", "Type"], ["status", "Status"]],
  login_events: [["event_id", "Event"], ["timestamp", "Time (UTC)", (v) => fmtTime(String(v))], ["customer_id", "Customer"], ["device_id", "Device"], ["ip_address", "IP"], ["geo", "Location"], ["outcome", "Outcome"], ["event_type", "Action"]],
  insurance_claims: [["claim_id", "Claim"], ["submitted_at", "Submitted (UTC)", (v) => fmtTime(String(v))], ["customer_id", "Customer"], ["policy_id", "Policy"], ["claim_type", "Type"], ["incident_date", "Incident", (v) => String(v ?? "").slice(0, 10)], ["claim_amount", "Amount", fmtAmount], ["sum_insured", "Sum insured", fmtAmount], ["provider_id", "Provider"], ["payout_account", "Payout account"], ["document_hash", "Document"]],
  loan_applications: [["application_id", "Application"], ["submitted_at", "Submitted (UTC)", (v) => fmtTime(String(v))], ["customer_id", "Customer"], ["device_id", "Device"], ["requested_amount", "Amount", fmtAmount], ["declared_income", "Stated income", fmtAmount], ["payout_account", "Payout account"], ["status", "Status"]],
};

export function RuleTable({ signals, mitigations }: { signals: Rule[]; mitigations: Rule[] }) {
  const rows = [...signals.map((r) => ({ ...r, sign: 1 })), ...mitigations.map((r) => ({ ...r, sign: -1 }))];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-line text-xs text-ink-3">
          <tr><th className="py-2 pr-3 font-medium">Factor</th><th className="py-2 pr-3 text-right font-medium">Weight</th><th className="py-2 pr-3 font-medium">Why</th><th className="py-2 font-medium">Evidence</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              <td className="py-2 pr-3">
                <div className="font-medium">{r.label}</div>
                <div className="font-mono text-[11px] text-ink-3">{r.code}</div>
              </td>
              <td className={cx("whitespace-nowrap py-2 pr-3 text-right font-semibold tabular", r.sign > 0 ? "text-risk-high" : "text-good-ink")}>
                {r.sign > 0 ? "+" : "−"}{r.weight}
                <div className="text-[11px] font-normal text-ink-3">{r.sign > 0 ? "risk" : "context"}</div>
              </td>
              <td className="py-2 pr-3 text-ink-2">{r.detail}</td>
              <td className="py-2">
                <div className="flex max-w-[16rem] flex-wrap gap-1">
                  {r.evidence.slice(0, 6).map((e) => (
                    <a key={`${e.table}:${e.id}`} href={`#${refAnchor(e)}`} className="rounded border border-line px-1 font-mono text-[11px] text-accent-ink hover:bg-surface-2">{e.id}</a>
                  ))}
                  {r.evidence.length > 6 && <span className="text-[11px] text-ink-3">+{r.evidence.length - 6}</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Supporting source records grouped by table, each with the file and row it was imported from. */
export function EvidenceTables({ refs, rows, primary }: { refs: Ref[]; rows: Map<string, Record<string, unknown>>; primary?: Ref }) {
  const tables = (Object.keys(TABLE_LABELS) as Ref["table"][]).filter((t) => refs.some((r) => r.table === t));
  return (
    <div className="space-y-5">
      {tables.map((t) => {
        const list = refs.filter((r) => r.table === t);
        const cols = COLUMNS[t];
        return (
          <div key={t}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{TABLE_LABELS[t]} <span className="font-normal">({list.length})</span></h3>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-surface-2 text-ink-3">
                  <tr>{cols.map(([, h]) => <th key={h} className="px-2.5 py-1.5 font-medium">{h}</th>)}<th className="px-2.5 py-1.5 font-medium">Source</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((r) => {
                    const row = rows.get(`${r.table}:${r.id}`);
                    const isPrimary = primary && primary.table === r.table && primary.id === r.id;
                    return (
                      <tr key={r.id} id={refAnchor(r)} className={cx("scroll-mt-24 target:bg-accent-wash", isPrimary && "bg-accent-wash/60")}>
                        {row ? cols.map(([k, , f]) => (
                          <td key={k} className="whitespace-nowrap px-2.5 py-1.5">
                            {k === PK[t] || k === "customer_id" ? <IdLink table={k === "customer_id" ? "customers" : t} id={String(row[k] ?? "")} /> : f ? f(row[k]) : String(row[k] ?? "—")}
                            {k === PK[t] && isPrimary && <span className="ml-1 text-[10px] font-semibold text-accent-ink">PRIMARY</span>}
                          </td>
                        )) : <td colSpan={cols.length} className="px-2.5 py-1.5 text-risk-high">Record {r.id} not found</td>}
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-ink-3">{row ? <Mono>{String(row.source_file)}:{String(row.source_row)}</Mono> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IdLink({ table, id }: { table: Ref["table"]; id: string }) {
  if (!id) return <>—</>;
  if (table === "customers") return <Link href={`/customers/${id}`} className="font-mono text-accent-ink hover:underline">{id}</Link>;
  return <Mono>{id}</Mono>;
}
