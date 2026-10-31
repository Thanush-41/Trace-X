import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resetWorkspace } from "@/lib/db/client";
import { loadSample } from "@/lib/ingest/samples";
import { detect, type DetectionOutput } from "@/lib/detect/run";
import { evaluate, groundTruthSchema, type EvalAlert } from "@/lib/detect/evaluate";
import type { ScoredFinding } from "@/lib/detect/types";

export const toEval = (f: ScoredFinding): EvalAlert => ({
  alert_id: f.alert_id, detector: f.detector, level: f.level, score: f.score, title: f.title,
  entities: {
    customer_ids: [...f.entities.customers], account_ids: [...f.entities.accounts], transaction_ids: [...f.entities.transactions],
    device_ids: [...f.entities.devices], application_ids: [...f.entities.applications],
  },
});

const truthFor = (seed: number) =>
  groundTruthSchema.parse(JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "samples", `seed-${seed}`, "ground_truth.json"), "utf8")));

describe.each([1, 2, 3])("seed %i", (seed) => {
  let out: DetectionOutput;
  beforeAll(async () => {
    await resetWorkspace();
    await loadSample(seed);
    out = await detect();
  });

  it("detects every planted fraud scenario and keeps every lookalike low", () => {
    const result = evaluate(truthFor(seed), out.findings.map(toEval));
    const failures = result.items.filter((i) => !i.pass).map((i) => `${i.id} (${i.detector}, expected ${i.expectation}): ${JSON.stringify(i.matched)}`);
    expect(failures).toEqual([]);
  });

  it("explains every alert with signals that add up to its raw score", () => {
    for (const f of out.findings) {
      expect(f.signals.length).toBeGreaterThan(0);
      expect(f.raw_score).toBe(f.signals.reduce((s, r) => s + r.weight, 0));
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(100);
      for (const r of [...f.signals, ...f.mitigations]) expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  it("puts the loan ring and the takeover that pays its mule in one cross-system case", () => {
    const truth = truthFor(seed);
    const cross = truth.items.find((i) => i.id === "S6-CROSS")!;
    const ids = cross.entities.customer_ids!;
    const c = out.cases.find((k) => k.alerts.some((a) => a.detector === "FD-06") && ids.every((id) => k.alerts.some((a) => a.entities.customers.has(id))));
    expect(c, "cross-system case").toBeDefined();
    expect(new Set(c!.alerts.map((a) => a.detector))).toEqual(new Set(["FD-01", "FD-02", "FD-03", "FD-04", "FD-05", "FD-06"]));
    expect(c!.level).toBe("High");
  });

  it("reports precision on actionable alerts", () => {
    const r = evaluate(truthFor(seed), out.findings.map(toEval));
    console.log(`seed ${seed}: ${r.fraud_detected}/${r.fraud_total} fraud detected, ${r.lookalikes_clean}/${r.lookalikes_total} lookalikes clean, ` +
      `${r.actionable_alerts_on_planted}/${r.actionable_alerts} actionable alerts on planted entities (precision ${(r.precision * 100).toFixed(0)}%), ` +
      `${out.findings.length} findings, ${out.cases.length} cases`);
    expect(r.recall).toBe(1);
  });
});
