import type { AlertRow } from "@/lib/queries";
import type { TimelineEvent } from "@/lib/cases";
import type { Ref, Rule } from "@/lib/detect/types";

export type BriefLine = { text: string; cites: Ref[] };
export type Brief = { summary: BriefLine[]; nextChecks: BriefLine[]; method: string };

/** Follow-up an investigator would do for each signal, with the evidence it applies to. */
const CHECKS: Record<string, (r: Rule) => string> = {
  SHARED_PAYOUT_ACCOUNT: () => "Confirm with the bank who owns the shared payout account and freeze pending disbursements or settlements to it",
  SHARED_MONEY_TRAIL: () => "Trace the shared payout or beneficiary account and confirm its owner",
  MULE_FAN_IN: () => "Ask the receiving bank to review the beneficiary account for mule activity",
  DRAIN: () => "Check whether the account balance was emptied and place a hold on further outflows",
  NEW_DEVICE: () => "Call the customer on their registered number to confirm the new device and recent changes",
  NEW_IP_OR_GEO: () => "Compare the login location with the customer's known locations and travel",
  FAILED_BURST: () => "Check whether credentials were reset or a SIM swap was reported around the failed logins",
  SENSITIVE_ACTION: () => "Review the password, device or beneficiary change and reverse it if the customer did not make it",
  OUTBOUND_AFTER: () => "Request a recall of the transfer made right after the suspicious login",
  PRECEDED_BY_LOGIN_RISK: () => "Treat the transfer as possibly unauthorised until the customer confirms it",
  ID_REUSE: () => "Re-verify the identity documents behind the shared national ID with the issuing source",
  SHARED_CONTACT: () => "Verify the shared phone or email with each customer",
  IMPLAUSIBLE_ATTRIBUTES: () => "Re-check the date of birth and KYC documents for the implausible profile",
  CLUSTERED_ONBOARDING: () => "Review the onboarding channel and agent for the profiles opened together",
  INCOME_MISMATCH: () => "Verify the stated income with salary slips or the employer",
  SHARED_DEVICE: () => "Check which other applications were submitted from the same device",
  APPLICATION_VELOCITY: () => "Hold pending applications from the linked group until reviewed",
  DUPLICATE_DOCUMENT: () => "Ask the provider for the original invoice and check it against both claims",
  DUPLICATE_INCIDENT: () => "Check with the other insurer or policy whether the same loss was already paid",
  EARLY_CLAIM: () => "Check the proposal form and pre-existing conditions for the newly started policy",
  NEAR_SUM_INSURED: () => "Have a surveyor or medical reviewer validate the claimed amount",
  LATE_REPORTING: () => "Ask the claimant to explain the reporting delay and obtain contemporaneous records",
  PROVIDER_SAME_DAY: () => "Review the provider's other claims around the same dates",
  AMOUNT_OUTLIER: () => "Confirm the purpose of the unusually large transfer with the customer",
  RAPID_SUCCESSION: () => "Review the burst of transfers for structuring",
  ML_ANOMALY: (r) => `Review why the model ranks this transfer as unusual (${r.detail.split("; most unusual: ")[1] ?? "see detail"})`,
  ML_ONLY: () => "Review the model-only transfer manually; no rule explains it",
};

const uniqueRefs = (refs: Ref[]) => [...new Map(refs.map((r) => [`${r.table}:${r.id}`, r])).values()];

/**
 * Investigator brief built only from the case's stored alerts, signals, mitigations and timeline.
 * Deterministic: the same case always produces the same text, and every line cites the records it uses.
 */
export function buildBrief(c: { category: string; level: string; score: number; primary_customer_id: string | null }, alerts: AlertRow[], timeline: TimelineEvent[]): Brief {
  const summary: BriefLine[] = [];
  const members = alerts.filter((a) => a.detector !== "FD-06");
  const lead = alerts.find((a) => a.detector === "FD-06") ?? alerts[0];
  const products = [...new Set(alerts.flatMap((a) => a.products))].sort();
  const customers = [...new Set(alerts.flatMap((a) => a.customer_ids))];

  summary.push({
    text: `${c.category} case, ${c.level} risk (${c.score}/100), built from ${members.length} alert${members.length === 1 ? "" : "s"} by ${new Set(members.map((a) => a.detector)).size} detector(s) across ${products.join(", ")}.`,
    cites: alerts.map((a) => a.primary_ref),
  });
  summary.push({
    text: `${customers.length} customer${customers.length === 1 ? "" : "s"} involved${c.primary_customer_id ? `, centred on ${c.primary_customer_id}` : ""}${customers.length > 1 ? ` (also ${customers.filter((x) => x !== c.primary_customer_id).slice(0, 4).join(", ")}${customers.length > 5 ? "…" : ""})` : ""}.`,
    cites: customers.slice(0, 6).map((id) => ({ table: "customers", id })),
  });
  const signals = members.flatMap((a) => a.signals).filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight);
  const topSignals = [...new Map(signals.map((s) => [s.code, s])).values()].slice(0, 3);
  if (topSignals.length) {
    summary.push({ text: `Strongest evidence: ${topSignals.map((s) => `${s.label.toLowerCase()} (${s.detail.replace(/\.$/, "")})`).join("; ")}.`, cites: uniqueRefs(topSignals.flatMap((s) => s.evidence)).slice(0, 8) });
  }
  const mitigations = [...new Map(members.flatMap((a) => a.mitigations).map((m) => [m.code, m])).values()];
  summary.push(mitigations.length
    ? { text: `Legitimate context found: ${mitigations.map((m) => `${m.label.toLowerCase()} (−${m.weight})`).join("; ")}.`, cites: uniqueRefs(mitigations.flatMap((m) => m.evidence)).slice(0, 6) }
    : { text: "No legitimate context (household, established payee, normal range, known device) was found to offset the risk.", cites: [] });
  if (timeline.length) {
    const flagged = timeline.filter((e) => e.flagged);
    const first = timeline[0];
    const last = timeline[timeline.length - 1];
    summary.push({
      text: `Activity spans ${first.time.slice(0, 10)} to ${last.time.slice(0, 10)}${flagged.length ? `; flagged events in order: ${flagged.slice(0, 4).map((e) => `${e.kind} on ${e.time.slice(0, 10)}`).join(" → ")}` : ""}.`,
      cites: (flagged.length ? flagged : [first, last]).slice(0, 6).map((e) => e.ref),
    });
  }

  const nextChecks: BriefLine[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    const make = CHECKS[s.code];
    if (!make) continue;
    const text = make(s);
    if (seen.has(text)) continue;
    seen.add(text);
    nextChecks.push({ text, cites: s.evidence.slice(0, 4) });
    if (nextChecks.length >= 5) break;
  }
  if (lead?.floor_note) nextChecks.push({ text: `Note the severity floor: ${lead.floor_note}`, cites: [lead.primary_ref] });
  return { summary, nextChecks, method: "Generated from this case's stored signals and records with a fixed template; no external model and no information beyond the evidence." };
}
