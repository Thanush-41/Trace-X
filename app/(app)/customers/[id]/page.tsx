import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Timeline } from "@/components/case-bits";
import { Card, LevelBadge, Mono, Pill, fmtAmount, fmtTime } from "@/components/ui";
import { getCustomerProfile } from "@/lib/customers";

export const metadata: Metadata = { title: "Customer" };

export default function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-3">Loading customer…</p>}>
      <Customer params={params} />
    </Suspense>
  );
}

async function Customer({ params }: { params: PageProps<"/customers/[id]">["params"] }) {
  const { id } = await params;
  const data = await getCustomerProfile(id);
  if (!data) notFound();
  const { customer: c, accounts, devices, loans, claims, alerts, cases, timeline, timelineTotal, counts } = data;
  const s = (k: string) => (c?.[k] === null || c?.[k] === undefined || c?.[k] === "" ? "—" : String(c[k]));
  const actionable = alerts.filter((a) => a.level !== "Low");

  return (
    <div className="space-y-5">
      <div>
        <Link href="/customers" className="text-sm text-accent-ink hover:underline">← Customers</Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{c ? s("full_name") : "Unknown customer"} <Mono className="text-ink-2">{id}</Mono></h1>
        {!c && <p className="mt-1 text-sm text-risk-high">No customer profile was imported for this ID; activity below comes from other systems.</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {actionable.length > 0 ? <Pill tone="bad">{actionable.length} open-risk alert{actionable.length === 1 ? "" : "s"}</Pill> : <Pill tone="good">No High/Medium alerts</Pill>}
          {cases.map((k) => <Link key={k.case_id} href={`/cases/${k.case_id}`}><Pill tone="accent">{k.case_id}</Pill></Link>)}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Profile">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {[["Phone", "phone"], ["Email", "email"], ["Address", "address"], ["City", "city"], ["Date of birth", "dob"], ["National ID", "national_id"], ["Occupation", "occupation"], ["Declared income", "declared_income"], ["Onboarded", "onboarding_date"], ["Channel", "onboarding_channel"], ["KYC", "kyc_status"]].map(([label, k]) => (
              <div key={k} className="contents">
                <dt className="text-ink-2">{label}</dt>
                <dd className="min-w-0 break-words">{k === "onboarding_date" ? s(k).slice(0, 10) : k === "declared_income" && c?.[k] ? fmtAmount(c[k]) : s(k)}</dd>
              </div>
            ))}
          </dl>
          {c && <p className="mt-3 text-xs text-ink-3">Source: <Mono>{s("source_file")}:{s("source_row")}</Mono></p>}
        </Card>

        <Card title={`Devices (${devices.length})`} className="lg:col-span-2" padded={false}>
          {devices.length === 0 ? <p className="p-4 text-sm text-ink-3">No device activity.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b border-line text-xs text-ink-3"><tr>{["Device", "Uses", "First seen", "Last seen", "Also used by"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">
                  {devices.map((d) => (
                    <tr key={d.device_id}>
                      <td className="px-4 py-2 font-mono text-xs">{d.device_id}</td>
                      <td className="px-4 py-2 tabular">{d.uses}</td>
                      <td className="px-4 py-2 text-xs text-ink-2 tabular">{fmtTime(d.first)}</td>
                      <td className="px-4 py-2 text-xs text-ink-2 tabular">{fmtTime(d.last)}</td>
                      <td className="px-4 py-2 text-xs">
                        {d.others.length === 0 ? <span className="text-ink-3">only this customer</span> : (
                          <span className="flex flex-wrap gap-1">{d.others.map((o) => <Link key={o} href={`/customers/${o}`} className="rounded border border-line px-1 font-mono text-accent-ink hover:bg-surface-2">{o}</Link>)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Accounts (${accounts.length})`} padded={false}>
          {accounts.length === 0 ? <p className="p-4 text-sm text-ink-3">No accounts imported.</p> : (
            <ul className="divide-y divide-line text-sm">
              {accounts.map((a) => (
                <li key={String(a.account_id)} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <Mono>{String(a.account_id)}</Mono><Pill tone="accent">{String(a.product)}</Pill>
                  <span className="text-xs text-ink-2">{String(a.account_type ?? "")} · opened {String(a.opened_at).slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Loan applications (${loans.length})`} padded={false}>
          {loans.length === 0 ? <p className="p-4 text-sm text-ink-3">No loan applications.</p> : (
            <ul className="divide-y divide-line text-sm">
              {loans.map((l) => (
                <li key={String(l.application_id)} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <Mono>{String(l.application_id)}</Mono>
                  <span>{fmtAmount(l.requested_amount)}</span>
                  <span className="text-xs text-ink-2">payout {String(l.payout_account)} · {fmtTime(String(l.submitted_at))} · {String(l.status ?? "")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {claims.length > 0 && (
        <Card title={`Insurance claims (${claims.length})`} padded={false}>
          <ul className="divide-y divide-line text-sm">
            {claims.map((k) => (
              <li key={String(k.claim_id)} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <Mono>{String(k.claim_id)}</Mono><Pill tone="accent">{String(k.claim_type)}</Pill>
                <span>{fmtAmount(k.claim_amount)}</span>
                <span className="text-xs text-ink-2">policy {String(k.policy_id)} · loss {String(k.incident_date).slice(0, 10)} · payout {String(k.payout_account)}{k.provider_id ? ` · ${String(k.provider_id)}` : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`Alerts mentioning this customer (${alerts.length})`} padded={false}>
        {alerts.length === 0 ? <p className="p-4 text-sm text-ink-3">None in the latest run.</p> : (
          <ul className="divide-y divide-line">
            {alerts.map((a) => (
              <li key={a.alert_id}>
                <Link href={`/alerts/${a.alert_id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                  <LevelBadge level={a.level} score={a.score} /><Pill>{a.detector}</Pill><span className="text-sm">{a.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Unified timeline · ${counts.logins} logins, ${counts.transactions} transactions, ${counts.loans} loan applications, ${counts.claims} claims`}>
        <Timeline events={timeline} linkRecords={false} />
        {timelineTotal > timeline.length && <p className="mt-3 text-xs text-ink-3">Showing the latest {timeline.length} of {timelineTotal} events.</p>}
      </Card>
    </div>
  );
}
