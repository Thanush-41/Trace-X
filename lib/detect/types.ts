import type { DetectorId, Level } from "@/lib/policy";

export type SourceTable = "customers" | "accounts" | "transactions" | "login_events" | "loan_applications";
export type Ref = { table: SourceTable; id: string };

/** One scored indicator: a signal (adds risk) or a mitigation (subtracts risk). */
export type Rule = { code: string; label: string; weight: number; detail: string; evidence: Ref[] };

export type EntitySets = {
  customers: Set<string>;
  accounts: Set<string>;
  transactions: Set<string>;
  devices: Set<string>;
  applications: Set<string>;
};

export type Finding = {
  detector: DetectorId;
  category: string;
  title: string;
  subject_type: "transaction" | "device" | "customer" | "application_group" | "network";
  subject_id: string;
  primary_ref: Ref;
  event_time: string;
  signals: Rule[];
  mitigations: Rule[];
  evidence: Ref[];
  entities: EntitySets;
  products: Set<string>;
  /** Minimum score that mitigations cannot push below, with the reason. */
  floor?: { min: number; note: string };
  /** FD-06 only: fingerprints of the member findings. */
  members?: string[];
};

export type ScoredFinding = Finding & {
  raw_score: number;
  score: number;
  level: Level;
  floor_note: string | null;
  fingerprint: string;
  alert_id: string;
};

export const emptyEntities = (): EntitySets => ({
  customers: new Set(), accounts: new Set(), transactions: new Set(), devices: new Set(), applications: new Set(),
});

export function uniqueRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.table}:${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const fmtINR = (n: number) => `₹${inr.format(n)}`;
export const fmtMinutes = (ms: number) => (ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
