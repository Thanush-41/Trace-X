import { DETECTORS } from "@/lib/policy";
import type { DetectionContext, Login, Txn } from "./context";
import { isAmountOutlier, isNewBeneficiary, SENSITIVE_EVENTS } from "./fd01-transfer";
import { emptyEntities, fmtINR, fmtMinutes, uniqueRefs, type Finding, type Ref, type Rule } from "./types";

const MIN = 60000;
const loginRef = (l: Login): Ref => ({ table: "login_events", id: l.event_id });
const txnRef = (t: Txn): Ref => ({ table: "transactions", id: t.transaction_id });

/**
 * Sequence detector. A session is anchored on either a burst of failed logins (brute force / credential
 * stuffing) or a successful login from a device and location the customer has never used (phished
 * credentials, no failures). It is then scored on the device, network and what the session did next.
 */
export function detectAccountTakeover(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd03.params;
  const findings: Finding[] = [];

  for (const [customer, logins] of ctx.loginsByCustomer) {
    let consumedUntil = -Infinity;
    for (const l of logins) {
      if (l.ts <= consumedUntil) continue;
      if (l.outcome === "failure") {
        const failures = logins.filter((x) => x.outcome === "failure" && x.ts >= l.ts && x.ts <= l.ts + p.burstWindowMin * MIN);
        if (failures.length < p.failBurst) continue;
        const last = failures[failures.length - 1];
        const success = logins.find((x) => x.outcome === "success" && x.ts > last.ts && x.ts <= last.ts + p.burstWindowMin * MIN);
        consumedUntil = success?.ts ?? last.ts;
        const f = scoreSession(ctx, customer, logins, l.ts, failures, success);
        if (f) findings.push(f);
      } else {
        const prior = logins.filter((x) => x.outcome === "success" && x.ts < l.ts);
        if (prior.length === 0 || prior.some((x) => x.device_id === l.device_id)) continue;
        const newPlace = l.geo ? !prior.some((x) => x.geo === l.geo) : !!l.ip_address && !prior.some((x) => x.ip_address === l.ip_address);
        if (!newPlace) continue;
        consumedUntil = l.ts + p.followOnWindowMin * MIN;
        const f = scoreSession(ctx, customer, logins, l.ts, [], l);
        if (f) findings.push(f);
      }
    }
  }
  return findings;
}

function scoreSession(ctx: DetectionContext, customer: string, logins: Login[], start: number, failures: Login[], success: Login | undefined): Finding | null {
  const p = ctx.policy.fd03.params;
  const S = ctx.policy.fd03.signals;
  const M = ctx.policy.fd03.mitigations;
  const accounts = ctx.accountsByCustomer.get(customer) ?? [];
  const signals: Rule[] = [];
  const mitigations: Rule[] = [];
  const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[] = [], weight?: number) =>
    list.push({ code, label: defs[code].label, weight: weight ?? defs[code].weight, detail, evidence });

  if (failures.length > 0) {
    const def = S.FAILED_BURST;
    add(signals, "FAILED_BURST", S, `${failures.length} failed logins within ${fmtMinutes(failures[failures.length - 1].ts - failures[0].ts)}`, failures.map(loginRef),
      Math.min(def.weight + (def.perExtra ?? 0) * (failures.length - p.failBurst), def.max ?? 100));
  }
  const priorSuccess = logins.filter((x) => x.outcome === "success" && x.ts < start);
  const knownDevices = new Set(priorSuccess.map((x) => x.device_id));
  const pivot = success ?? failures[failures.length - 1];
  let newDevice = false;
  let newPlace = false;

  if (success) {
    if (failures.length) add(signals, "SUCCESS_AFTER_FAILURES", S, `Successful login ${fmtMinutes(success.ts - failures[failures.length - 1].ts)} after the last failure`, [loginRef(success)]);
    if (priorSuccess.length > 0) {
      if (!knownDevices.has(success.device_id)) {
        newDevice = true;
        add(signals, "NEW_DEVICE", S, `${success.device_id} was never used by this customer before (known: ${[...knownDevices].slice(0, 3).join(", ")})`, [loginRef(success)]);
      }
      const newIp = !!success.ip_address && !priorSuccess.some((x) => x.ip_address === success.ip_address);
      const newGeo = !!success.geo && !priorSuccess.some((x) => x.geo === success.geo);
      newPlace = newGeo || (!success.geo && newIp);
      if (newIp || newGeo) {
        add(signals, "NEW_IP_OR_GEO", S, [newIp ? `new IP ${success.ip_address}` : "", newGeo ? `new location ${success.geo} (usual: ${[...new Set(priorSuccess.map((x) => x.geo).filter(Boolean))].slice(0, 2).join(", ")})` : ""].filter(Boolean).join(", "), [loginRef(success)]);
      }
    }
  }

  const windowEnd = pivot.ts + p.followOnWindowMin * MIN;
  // Includes a password reset just before the login: reset-then-login is the usual phishing pattern.
  const sensitive = success ? logins.filter((x) => SENSITIVE_EVENTS.has(x.event_type) && x.ts >= start - p.burstWindowMin * MIN && x.ts <= windowEnd) : [];
  if (sensitive.length > 0) {
    add(signals, "SENSITIVE_ACTION", S, sensitive.map((x) => `${x.event_type.replace(/_/g, " ")} ${x.ts >= pivot.ts ? `${fmtMinutes(x.ts - pivot.ts)} after` : `${fmtMinutes(pivot.ts - x.ts)} before`} login`).join("; "), sensitive.map(loginRef));
  }
  const outbound: Txn[] = success ? accounts.flatMap((a) => (ctx.outByAccount.get(a.account_id) ?? []).filter((t) => t.ts > success.ts && t.ts <= windowEnd)) : [];
  const risky = outbound.filter((t) => isNewBeneficiary(ctx, t) || isAmountOutlier(ctx, t));
  if (risky.length > 0) {
    add(signals, "OUTBOUND_AFTER", S, risky.map((t) => `${fmtINR(t.amount)} to ${isNewBeneficiary(ctx, t) ? "new beneficiary " : ""}${t.beneficiary_account} ${fmtMinutes(t.ts - success!.ts)} after login`).join("; "), risky.map(txnRef));
  }

  const raw = signals.reduce((s, r) => s + r.weight, 0);
  if (raw < ctx.policy.recordThreshold) return null;

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
  const followOn = sensitive.length > 0 || risky.length > 0;
  const chain = newDevice && followOn && (failures.length >= p.failBurst || newPlace);
  const how = failures.length ? `${failures.length} failed logins then access` : "Access";
  return {
    detector: "FD-03",
    category: DETECTORS["FD-03"],
    title: success
      ? `${how} on ${newDevice ? "a new" : "a known"} device${newPlace ? " from a new location" : ""} for ${customer}`
      : `${failures.length} failed logins for ${customer} (no success)`,
    subject_type: "customer",
    subject_id: customer,
    primary_ref: loginRef(pivot),
    event_time: pivot.timestamp,
    signals,
    mitigations,
    evidence: uniqueRefs([{ table: "customers", id: customer }, ...signals.flatMap((s) => s.evidence), ...mitigations.flatMap((m) => m.evidence)]),
    entities,
    products: new Set(risky.length > 0 ? risky.map((t) => ctx.accounts.get(t.account_id)?.product ?? "banking") : ["banking"]),
    floor: chain ? { min: ctx.policy.floors.atoChain, note: "New device (after failed logins or from a new location) followed by a sensitive change or transfer" } : undefined,
  };
}
