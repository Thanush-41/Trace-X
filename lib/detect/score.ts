import { levelFor, type Policy } from "@/lib/policy";
import { idFrom, sha256 } from "@/lib/util/hash";
import type { Finding, ScoredFinding } from "./types";

/**
 * score = clamp(Σ signals − Σ mitigations, 0, 100), then raised to the finding's floor if it has one.
 * The fingerprint identifies the same finding across runs: detector + policy version + evidence.
 */
export function scoreFinding(f: Finding, policy: Policy): ScoredFinding {
  const raw = f.signals.reduce((s, r) => s + r.weight, 0);
  const reduction = f.mitigations.reduce((s, r) => s + r.weight, 0);
  let score = Math.max(0, Math.min(100, raw - reduction));
  let floor_note: string | null = null;
  if (f.floor && score < f.floor.min) {
    floor_note = `Raised from ${score} to ${f.floor.min}: ${f.floor.note}`;
    score = f.floor.min;
  }
  const identity = f.members
    ? [...f.members].sort().join(",")
    : f.evidence.map((r) => `${r.table}:${r.id}`).sort().join(",");
  const fingerprint = sha256(`${f.detector}|${policy.version}|${f.subject_type}:${f.subject_id}|${identity}`);
  return { ...f, raw_score: raw, score, level: levelFor(score, policy), floor_note, fingerprint, alert_id: idFrom("ALT", fingerprint) };
}
