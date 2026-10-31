import type { Metadata } from "next";
import { Card, PageHeader, Pill } from "@/components/ui";
import { DETECTORS, policy, type RuleDef } from "@/lib/policy";

export const metadata: Metadata = { title: "Rules" };

const DESCRIPTIONS: Record<string, string> = {
  fd01: "Each outgoing transfer, compared with the account's own history (baseline excludes the last 24 h).",
  fd02: "Each device used by two or more customers, across logins and loan applications.",
  fd03: "Each burst of failed logins, or each login from a new device in a new location, scored on what the session did next.",
  fd07: "Each insurance claim, checked for duplicates, early or late reporting, shared payout accounts and provider clustering.",
  fd04: "Customer profiles that share a national ID, phone or email, scored on how independent they claim to be.",
  fd05: "Loan applications linked by a shared device, phone, email, payout account or national ID.",
};
const KEY_TO_ID: Record<string, keyof typeof DETECTORS> = { fd01: "FD-01", fd02: "FD-02", fd03: "FD-03", fd04: "FD-04", fd05: "FD-05", fd07: "FD-07" };

export default function RulesPage() {
  const detectors = (["fd01", "fd02", "fd03", "fd04", "fd05", "fd07"] as const).map((k) => ({ key: k, ...policy[k] }));
  return (
    <>
      <PageHeader
        title="Detection rules"
        description={<>Policy <span className="font-mono">v{policy.version}</span> from <span className="font-mono">config/policy.json</span>. Score = risk signals − legitimate context, clamped to 0–100.</>}
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Card><div className="text-xs text-ink-3">High</div><div className="text-lg font-semibold tabular">≥ {policy.levels.high}</div></Card>
        <Card><div className="text-xs text-ink-3">Medium</div><div className="text-lg font-semibold tabular">{policy.levels.medium}–{policy.levels.high - 1}</div></Card>
        <Card><div className="text-xs text-ink-3">Stored (Low) when raw signals ≥</div><div className="text-lg font-semibold tabular">{policy.recordThreshold}</div></Card>
        <Card><div className="text-xs text-ink-3">Hub threshold (customers per account/device)</div><div className="text-lg font-semibold tabular">&gt; {policy.hubDegree}</div></Card>
      </div>
      <div className="space-y-5">
        {detectors.map((d) => (
          <Card key={d.key} title={<>{KEY_TO_ID[d.key]} · {DETECTORS[KEY_TO_ID[d.key]]}</>}>
            <p className="mb-3 text-sm text-ink-2">{DESCRIPTIONS[d.key]}</p>
            <div className="grid gap-4 lg:grid-cols-2">
              <RuleList title="Risk signals" rules={d.signals} sign="+" />
              <RuleList title="Legitimate context" rules={d.mitigations} sign="−" />
            </div>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-xs text-accent-ink">Thresholds</summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(d.params).map(([k, v]) => <Pill key={k}><span className="font-mono">{k}</span>&nbsp;=&nbsp;{String(v)}</Pill>)}
              </div>
            </details>
          </Card>
        ))}
        <Card title="FD-06 · Cross-system organised fraud">
          <p className="text-sm text-ink-2">
            Medium/High alerts that share a customer, account, device, application or transaction (hubs excluded) are grouped into one case.
            A group spanning two or more detectors and two or more customers or products becomes an FD-06 alert scored as: strongest member
            + {policy.fd06.params.perExtraDetector} per extra detector + {policy.fd06.params.multiProductBonus} if several products are involved.
          </p>
          <p className="mt-2 text-sm text-ink-2">
            Severity floors: an account-takeover chain never drops below {policy.floors.atoChain}; a payout account shared by three or more
            unrelated customers never drops below {policy.floors.sharedPayoutRing}.
          </p>
        </Card>
      </div>
    </>
  );
}

function RuleList({ title, rules, sign }: { title: string; rules: Record<string, RuleDef>; sign: string }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      <ul className="divide-y divide-line rounded-md border border-line text-sm">
        {Object.entries(rules).map(([code, r]) => (
          <li key={code} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span>{r.label} <span className="font-mono text-[11px] text-ink-3">{code}</span></span>
            <span className={`shrink-0 font-semibold tabular ${sign === "+" ? "text-risk-high" : "text-good-ink"}`}>
              {sign}{r.weight}{r.perExtra ? ` (+${r.perExtra} each, max ${r.max})` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
