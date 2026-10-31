import { beforeAll, describe, expect, it } from "vitest";
import { all, resetWorkspace } from "@/lib/db/client";
import { loadSample } from "@/lib/ingest/samples";
import { runDetection } from "@/lib/detect/run";
import { getCase, listCases, recordDecision } from "@/lib/cases";
import { getCustomerProfile } from "@/lib/customers";
import { bundledGroundTruth, evaluateLatestRun } from "@/lib/evaluation";

describe("case workflow", () => {
  beforeAll(async () => {
    await resetWorkspace();
    await loadSample(2);
    await runDetection();
  });

  it("every case starts Open with evidence, customer and category", async () => {
    const cases = await listCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.status).toBe("OPEN");
      expect(c.alert_count).toBeGreaterThan(0);
      expect(c.category).toBeTruthy();
    }
    const detail = await getCase(cases[0].case_id);
    expect(detail!.alerts.length).toBe(cases[0].alert_count);
    expect(detail!.timeline.length).toBeGreaterThan(0);
  });

  it("a decision changes status but leaves the original alerts byte-identical", async () => {
    const [c] = await listCases({ level: "High" });
    const before = await all("SELECT a.* FROM alerts a JOIN case_alerts ca ON ca.alert_id = a.alert_id WHERE ca.case_id = ? ORDER BY a.alert_id", [c.case_id]);
    await recordDecision(c.case_id, { decision: "FALSE_POSITIVE", note: "Customer confirmed the transfer by phone", analyst: "Asha", revised_level: "Low" });
    const after = await all("SELECT a.* FROM alerts a JOIN case_alerts ca ON ca.alert_id = a.alert_id WHERE ca.case_id = ? ORDER BY a.alert_id", [c.case_id]);
    expect(after).toEqual(before);
    const detail = await getCase(c.case_id);
    expect(detail!.case.status).toBe("FALSE_POSITIVE");
    expect(detail!.case.level).toBe("High");
    expect(detail!.case.current_level).toBe("Low");

    await recordDecision(c.case_id, { decision: "REQUIRES_INVESTIGATION", analyst: "Ravi" });
    const again = await getCase(c.case_id);
    expect(again!.case.status).toBe("REQUIRES_INVESTIGATION");
    expect(again!.decisions.map((d) => d.decision)).toEqual(["REQUIRES_INVESTIGATION", "FALSE_POSITIVE"]);
  });

  it("requires a note for False positive and Dismissed, and a known case", async () => {
    const [c] = await listCases();
    await expect(recordDecision(c.case_id, { decision: "DISMISSED", analyst: "Asha" })).rejects.toThrow(/note/);
    await expect(recordDecision("CASE-nope", { decision: "ESCALATED", analyst: "Asha" })).rejects.toThrow(/not found/);
    await expect(recordDecision(c.case_id, { decision: "MAYBE", analyst: "Asha" })).rejects.toThrow();
  });

  it("decisions survive re-running detection", async () => {
    const decided = (await listCases()).filter((c) => c.status !== "OPEN").map((c) => [c.case_id, c.status]);
    const run = await runDetection();
    expect(run.new_cases).toBe(0);
    const after = (await listCases()).filter((c) => c.status !== "OPEN").map((c) => [c.case_id, c.status]);
    expect(after).toEqual(decided);
  });

  it("builds a customer view with linked devices", async () => {
    const truth = await bundledGroundTruth(2);
    const ring = truth!.items.find((i) => i.id === "S6-CROSS")!.entities.customer_ids!;
    const profile = await getCustomerProfile(ring[1]);
    expect(profile!.devices.some((d) => d.others.length >= 3)).toBe(true);
    expect(profile!.alerts.length).toBeGreaterThan(0);
  });

  it("evaluates the stored run against the bundled answer key", async () => {
    const result = await evaluateLatestRun((await bundledGroundTruth(2))!);
    expect(result!.recall).toBe(1);
    expect(result!.lookalike_false_positive_rate).toBe(0);
  });
});
