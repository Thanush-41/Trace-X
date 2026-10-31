import raw from "@/config/policy.json";

export type RuleDef = { weight: number; label: string; perExtra?: number; max?: number };
export type DetectorPolicy<P> = {
  params: P;
  signals: Record<string, RuleDef>;
  mitigations: Record<string, RuleDef>;
};

export type Policy = typeof raw & {
  fd01: DetectorPolicy<typeof raw.fd01.params>;
  fd02: DetectorPolicy<typeof raw.fd02.params>;
  fd03: DetectorPolicy<typeof raw.fd03.params>;
  fd04: DetectorPolicy<typeof raw.fd04.params>;
  fd05: DetectorPolicy<typeof raw.fd05.params>;
};

export const policy = raw as Policy;

export const DETECTORS = {
  "FD-01": "Suspicious transfer",
  "FD-02": "Coordinated device use",
  "FD-03": "Account takeover",
  "FD-04": "Identity / synthetic profile",
  "FD-05": "Loan application fraud",
  "FD-06": "Cross-system organised fraud",
} as const;

export type DetectorId = keyof typeof DETECTORS;
export type Level = "High" | "Medium" | "Low";

export function levelFor(score: number, p: Policy = policy): Level {
  if (score >= p.levels.high) return "High";
  if (score >= p.levels.medium) return "Medium";
  return "Low";
}
