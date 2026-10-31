/**
 * Agent accuracy on sealed seeds 201 and 202 against their answer keys.
 *   OPENAI_API_KEY=... npx tsx scripts/eval-agent.ts
 * Compares the deterministic tool agent with the LLM multi-agent team. No feedback is recorded, so nothing is learned
 * from these seeds. Writes docs/AGENT_EVAL.md.
 */
process.env.TRACEX_DB_URL = ":memory:";
import fs from "node:fs";

async function main() {
  const { resetWorkspace } = await import("@/lib/db/client");
  const { loadSample } = await import("@/lib/ingest/samples");
  const { runDetection } = await import("@/lib/detect/run");
  const { listCases, getCase } = await import("@/lib/cases");
  const { runAgent } = await import("@/lib/agent/store");
  const { bundledGroundTruth } = await import("@/lib/evaluation");
  const { truthCategory } = await import("@/lib/agent/replay");
  const { llmEnabled, llmModel } = await import("@/lib/agent/llm");
  const modes = llmEnabled() ? (["deterministic", "auto"] as const) : (["deterministic"] as const);
  const rows: { seed: number; case_id: string; truth: string; [k: string]: unknown }[] = [];
  for (const seed of [201, 202]) {
    await resetWorkspace("eval");
    await loadSample(seed);
    await runDetection();
    const truth = (await bundledGroundTruth(seed))!;
    for (const c of await listCases({})) {
      const data = (await getCase(c.case_id))!;
      const real = truthCategory(truth.items as never, data.alerts) ?? "Not fraud";
      const row: (typeof rows)[number] = { seed, case_id: c.case_id, truth: real };
      for (const mode of modes) {
        const r = await runAgent(c.case_id, "eval", { mode });
        const a = r.assessment;
        const said = a.likely_benign ? "Not fraud" : a.predicted_category;
        row[mode] = { said, correct: said === real, grounding: a.verification.grounding, mode: a.mode, fallback: !!a.fallback_reason };
      }
      rows.push(row);
      console.log(seed, c.case_id, real, modes.map((m) => `${m}:${(row[m] as { said: string }).said}`).join(" "));
    }
  }
  const summary = modes.map((m) => {
    const rs = rows.map((r) => r[m] as { correct: boolean; grounding: number; fallback: boolean });
    return { mode: m === "auto" ? `LLM multi-agent (${llmModel()})` : "Deterministic tool agent", n: rs.length, correct: rs.filter((x) => x.correct).length, accuracy: Math.round((rs.filter((x) => x.correct).length / rs.length) * 1000) / 10, grounding: Math.round((rs.reduce((s, x) => s + x.grounding, 0) / rs.length) * 100) / 100, fallbacks: rs.filter((x) => x.fallback).length };
  });
  console.table(summary);
  const md = ["# Agent evaluation on sealed seeds", "", "Cases from seeds 201 and 202 (never used for training, tuning or lessons), judged against their answer keys. \"Not fraud\" means the key lists no fraud scenario for the case.", "",
    "| Agent | Cases | Correct | Accuracy | Mean citation grounding | Fallbacks |", "|---|---|---|---|---|---|",
    ...summary.map((s) => `| ${s.mode} | ${s.n} | ${s.correct} | ${s.accuracy}% | ${s.grounding} | ${s.fallbacks} |`), "",
    "| Seed | Case | Answer key | " + modes.map((m) => (m === "auto" ? "LLM agents" : "Deterministic")).join(" | ") + " |", "|---|---|---|" + modes.map(() => "---|").join(""),
    ...rows.map((r) => `| ${r.seed} | ${r.case_id} | ${r.truth} | ${modes.map((m) => { const x = r[m] as { said: string; correct: boolean }; return `${x.said} ${x.correct ? "✓" : "✗"}`; }).join(" | ")} |`), ""].join("\n");
  fs.writeFileSync("docs/AGENT_EVAL.md", md);
  fs.writeFileSync("config/agent-eval.json", JSON.stringify({ generated: new Date().toISOString().slice(0, 10), seeds: [201, 202], summary }));
}
main();
