import { DETECTORS } from "@/lib/policy";
import type { DetectionContext, Login, Txn } from "./context";
import { isAmountOutlier, isNewBeneficiary, SENSITIVE_EVENTS } from "./fd01-transfer";
import { emptyEntities, fmtINR, fmtMinutes, uniqueRefs, type Finding, type Ref, type Rule } from "./types";

const MIN = 60000;
const loginRef = (l: Login): Ref => ({ table: "login_events", id: l.event_id });
const txnRef = (t: Txn): Ref => ({ table: "transactions", id: t.transaction_id });

/**
 * Sequence detector: a burst of failed logins, optionally followed by a success, scored on what
 * happened around it (which device, which network, and what the session did next).
 */
export function detectAccountTakeover(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd03.params;
  const S = ctx.policy.fd03.signals;
  const M = ctx.policy.fd03.mitigations;
  const findings: Finding[] = [];

  for (const [customer, logins] of ctx.loginsByCustomer) {
    const accounts = ctx.accountsByCustomer.get(customer) ?? [];
    let consumedUntil = -Infinity;

    for (let i = 0; i < logins.length; i++) {
      const l = logins[i];
      if (l.outcome !== "failure" || l.ts <= consumedUntil) continue;
      const failures = logins.filter((x) => x.outcome === "failure" && x.ts >= l.ts && x.ts <= l.ts + p.burstWindowMin * MIN);
      if (failures.length < p.failBurst) continue;
      const lastFailure = failures[failures.length - 1];
      const success = logins.find((x) => x.outcome === "success" && x.ts > lastFailure.ts && x.ts <= lastFailure.ts + p.burstWindowMin * MIN);
      consumedUntil = success?.ts ?? lastFailure.ts;

      const signals: Rule[] = [];
      const mitigations: Rule[] = [];
      const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[] = [], weight?: number) =>
        list.push({ code, label: defs[code].label, weight: weight ?? defs[code].weight, detail, evidence });

      const burstDef = S.FAILED_BURST;
      add(signals, "FAILED_BURST", S, `${failures.length} failed logins within ${fmtMinutes(lastFailure.ts - l.ts)}`, failures.map(loginRef),
        Math.min(burstDef.weight + (burstDef.perExtra ?? 0) * (failures.length - p.failBurst), burstDef.max ?? 100));

      const priorSuccess = logins.filter((x) => x.outcome === "success" && x.ts < l.ts);
      const knownDevices = new Set(priorSuccess.map((x) => x.device_id));
      const knownIps = new Set(priorSuccess.map((x) => x.ip_address).filter(Boolean));
      const knownGeos = new Set(priorSuccess.map((x) => x.geo).filter(Boolean));
      const pivot = success ?? lastFailure;
      let newDevice = false;

      if (success) {
        add(signals, "SUCCESS_AFTER_FAILURES", S, `Successful login ${fmtMinutes(success.ts - lastFailure.ts)} after the last failure`, [loginRef(success)]);
        if (priorSuccess.length > 0) {
          if (!knownDevices.has(success.device_id)) {
            newDevice = true;
            add(signals, "NEW_DEVICE", S, `${success.device_id} was never used by this customer before (known: ${[...knownDevices].slice(0, 3).join(", ")})`, [loginRef(success)]);
          }
          const newIp = success.ip_address && !knownIps.has(success.ip_address);
          const newGeo = success.geo && !knownGeos.has(success.geo);
          if (newIp || newGeo) {
            add(signals, "NEW_IP_OR_GEO", S, [newIp ? `new IP ${success.ip_address}` : "", newGeo ? `new location ${success.geo}` : ""].filter(Boolean).join(", "), [loginRef(success)]);
          }
        }
      }

      const windowEnd = pivot.ts + p.followOnWindowMin * MIN;
      const sensitive = success ? logins.filter((x) => SENSITIVE_EVENTS.has(x.event_type) && x.ts >= l.ts && x.ts <= windowEnd) : [];
      if (sensitive.length > 0) {
        add(signals, "SENSITIVE_ACTION", S, sensitive.map((x) => `${x.event_type.replace(/_/g, " ")} ${fmtMinutes(x.ts - pivot.ts)} after login`).join("; "), sensitive.map(loginRef));
      }
      const outbound: Txn[] = success
        ? accounts.flatMap((a) => (ctx.outByAccount.get(a.account_id) ?? []).filter((t) => t.ts > success.ts && t.ts <= windowEnd))
        : [];
      const risky = outbound.filter((t) => isNewBeneficiary(ctx, t) || isAmountOutlier(ctx, t));
      if (risky.length > 0) {
        add(signals, "OUTBOUND_AFTER", S, risky.map((t) => `${fmtINR(t.amount)} to ${isNewBeneficiary(ctx, t) ? "new beneficiary " : ""}${t.beneficiary_account} ${fmtMinutes(t.ts - success!.ts)} after login`).join("; "), risky.map(txnRef));
      }

      const raw = signals.reduce((s, r) => s + r.weight, 0);
      if (raw < ctx.policy.recordThreshold) continue;

      if (success && priorSuccess.length > 0 && knownDevices.has(success.device_id)) {
        add(mitigations, "KNOWN_DEVICE", M, `${success.device_id} has ${priorSuccess.filter((x) => x.device_id === success.device_id).length} earlier successful logins`, [loginRef(success)]);
      }
      if (sensitive.length === 0 && outbound.length === 0) add(mitigations, "NO_FOLLOW_ON", M, `No account changes or transfers within ${p.followOnWindowMin} min`);

      const entities = emptyEntities();
      entities.customers.add(customer);
      entities.devices.add(pivot.device_id);
      for (const t of risky) {
        entities.transactions.add(t.transaction_id);
        entities.accounts.add(t.account_id).add(t.beneficiary_account);
      }
      const chain = failures.length >= p.failBurst && newDevice && (sensitive.length > 0 || risky.length > 0);
      findings.push({
        detector: "FD-03",
        category: DETECTORS["FD-03"],
        title: success ? `${failures.length} failed logins then access on ${newDevice ? "a new" : "a known"} device for ${customer}` : `${failures.length} failed logins for ${customer} (no success)`,
        subject_type: "customer",
        subject_id: customer,
        primary_ref: loginRef(pivot),
        event_time: pivot.timestamp,
        signals,
        mitigations,
        evidence: uniqueRefs([{ table: "customers", id: customer }, ...signals.flatMap((s) => s.evidence), ...mitigations.flatMap((m) => m.evidence)]),
        entities,
        products: new Set(risky.length > 0 ? risky.map((t) => ctx.accounts.get(t.account_id)?.product ?? "banking") : ["banking"]),
        floor: chain ? { min: ctx.policy.floors.atoChain, note: "Failed-login burst, new device and a sensitive action or transfer form a takeover chain" } : undefined,
      });
    }
  }
  return findings;
}
