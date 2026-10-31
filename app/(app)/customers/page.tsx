import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Search } from "lucide-react";
import { Card, Empty, LevelBadge, PageHeader, buttonClass, cx, fmtInt, inputClass } from "@/components/ui";
import { listCustomers } from "@/lib/customers";
import type { Level } from "@/lib/policy";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage({ searchParams }: PageProps<"/customers">) {
  return (
    <>
      <PageHeader
        eyebrow="Customer intelligence"
        title="Customers"
        description="Every imported customer with their accounts, devices and risk across systems. Open one for the unified timeline and the people they are linked to."
      />
      <Suspense fallback={<p className="text-sm text-ink-3">Loading customers…</p>}>
        <Customers searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Customers({ searchParams }: { searchParams: PageProps<"/customers">["searchParams"] }) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const flagged = sp.flagged === "1";
  const { rows, total } = await listCustomers(q, flagged);

  return (
    <div className="space-y-4">
      <form method="get" action="/customers" className="flex flex-wrap gap-2 rounded-xl border border-line bg-surface p-3 shadow-card">
        <label className="relative min-w-[16rem] flex-1">
          <span className="sr-only">Search customers</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input name="q" defaultValue={q} placeholder="Name, customer ID, phone, email, account or device" className={cx(inputClass, "pl-8")} />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" name="flagged" value="1" defaultChecked={flagged} className="accent-[var(--accent)]" />
          Only with actionable alerts
        </label>
        <button type="submit" className={buttonClass("primary")}>Search</button>
      </form>

      {rows.length === 0 ? (
        <Empty title={q || flagged ? "No customers match" : "No customers imported yet"}>
          {q || flagged ? "Try a different search." : <Link href="/ingest" className="text-accent-ink hover:underline">Import customer data</Link>}
        </Empty>
      ) : (
        <Card padded={false} title={`${fmtInt(total)} customer${total === 1 ? "" : "s"}${rows.length < total ? ` (showing ${rows.length})` : ""}`}>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>{["Customer", "City", "Onboarded", "Products", "Accounts", "Devices", "Risk"].map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.customer_id} className="relative hover:bg-surface-2">
                    <td className="px-4 py-2.5">
                      <Link href={`/customers/${r.customer_id}`} className="font-medium after:absolute after:inset-0 hover:underline">{r.full_name}</Link>
                      <div className="font-mono text-xs text-ink-3">{r.customer_id}</div>
                    </td>
                    <td className="px-4 py-2.5 text-ink-2">{r.city ?? "—"}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-2 tabular">{r.onboarding_date?.slice(0, 10) ?? "—"}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-2">{r.products?.split(",").join(", ") ?? "—"}</td>
                    <td className="px-4 py-2.5 tabular">{r.accounts}</td>
                    <td className="px-4 py-2.5 tabular">{r.devices}</td>
                    <td className="px-4 py-2.5">
                      {r.top_level ? <span className="inline-flex items-center gap-2"><LevelBadge level={r.top_level as Level} />{r.actionable > 0 && <span className="text-xs text-ink-2">{r.actionable} actionable</span>}</span> : <span className="text-xs text-ink-3">No alerts</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line md:hidden">
            {rows.map((r) => (
              <li key={r.customer_id}>
                <Link href={`/customers/${r.customer_id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.full_name}</span>
                    <span className="block text-xs text-ink-3">{r.customer_id} · {r.accounts} accounts · {r.devices} devices</span>
                  </span>
                  {r.top_level ? <LevelBadge level={r.top_level as Level} /> : <span className="text-xs text-ink-3">No alerts</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
