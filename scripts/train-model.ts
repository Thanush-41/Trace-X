/**
 * Trains the graph model offline and writes config/model.json plus docs/MODEL_CARD.md.
 *   npx tsx scripts/train-model.ts
 * Splits by dataset, never by row, so no customer appears in two splits:
 *   train seeds 1, 2, 3 · validation seed 101 (model selection and threshold) · sealed test seeds 201, 202 (reported once).
 */
process.env.TRACEX_DB_URL = ":memory:";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const { resetWorkspace } = await import("@/lib/db/client");
  const { loadSample } = await import("@/lib/ingest/samples");
  const { loadContext } = await import("@/lib/detect/context");
  const { scoreTransfers } = await import("@/lib/detect/anomaly");
  const { bundledGroundTruth } = await import("@/lib/evaluation");
  const { nodeFeatures, customerGraph, graphFeatures, NODE_FEATURES } = await import("@/lib/ml/features");
  const { customerLabels } = await import("@/lib/ml/labels");
  const { train, predict, metrics, atThreshold } = await import("@/lib/ml/mlp");

  type Split = { X: number[][]; G: number[][]; y: number[]; edges: number };
  async function dataset(seeds: number[]): Promise<Split> {
    const out: Split = { X: [], G: [], y: [], edges: 0 };
    for (const seed of seeds) {
      await resetWorkspace("train");
      await loadSample(seed);
      const ctx = await loadContext();
      ctx.anomaly = scoreTransfers(ctx);
      const { ids, X } = nodeFeatures(ctx);
      const { edges } = customerGraph(ctx, ids);
      const G = graphFeatures(ids.length, edges, X);
      const labels = customerLabels(ctx, (await bundledGroundTruth(seed))!);
      out.X.push(...X); out.G.push(...G); out.y.push(...ids.map((id) => labels.get(id)!)); out.edges += edges.length;
      console.log(`seed ${seed}: ${ids.length} customers, ${edges.length} graph edges, ${ids.filter((id) => labels.get(id)).length} fraud-linked`);
    }
    return out;
  }
  const tr = await dataset([1, 2, 3]);
  const va = await dataset([101]);
  const te = await dataset([201, 202]);

  const candidates = [
    { name: "Logistic regression, own features (no graph)", graph: false, hidden: 0, epochs: 400, lr: 0.03, l2: 1e-3 },
    { name: "Logistic regression on graph features (SGC)", graph: true, hidden: 0, epochs: 400, lr: 0.03, l2: 1e-3 },
    { name: "Graph neural network: SIGN propagation + MLP(16)", graph: true, hidden: 16, epochs: 300, lr: 0.01, l2: 1e-3 },
    { name: "Graph neural network: SIGN propagation + MLP(32)", graph: true, hidden: 32, epochs: 300, lr: 0.01, l2: 3e-3 },
  ];
  const results = candidates.map((c) => {
    const model = train(c.graph ? tr.G : tr.X, tr.y, { hidden: c.hidden, epochs: c.epochs, lr: c.lr, l2: c.l2, seed: 7 });
    const score = (s: Split) => (c.graph ? s.G : s.X).map((x) => predict(model, x));
    return { ...c, model, train: metrics(score(tr), tr.y), validation: metrics(score(va), va.y), vScores: score(va), tScores: score(te) };
  });
  for (const r of results) console.log(`${r.name}: train AP ${r.train.ap} · validation AUC ${r.validation.auc} AP ${r.validation.ap}`);
  const best = results.reduce((a, b) => ((b.validation.ap ?? 0) > (a.validation.ap ?? 0) ? b : a));

  // Threshold chosen on validation only: the lowest score that keeps precision at or above 0.8.
  const grid = [...new Set(best.vScores.map((s) => Math.round(s * 100) / 100))].sort((a, b) => a - b);
  const threshold = grid.find((t) => (atThreshold(best.vScores, va.y, t).precision ?? 0) >= 0.8) ?? 0.9;
  const test = { ...metrics(best.tScores, te.y), ...atThreshold(best.tScores, te.y, threshold) };
  const baseline = results[0];
  const baselineTest = metrics(baseline.tScores, te.y);
  console.log(`selected: ${best.name}; threshold ${threshold}; sealed test AUC ${test.auc} AP ${test.ap} precision ${test.precision} recall ${test.recall}`);

  // Ablation: the same architecture without the enriched fields (session telemetry and payee-name check).
  const ENRICHED = ["recent SIM swap", "remote-access tool seen", "emulator / rooted device seen", "VPN / proxy share", "max behaviour anomaly", "payee-name mismatch share"];
  const keep = NODE_FEATURES.map((f, j) => (ENRICHED.includes(f) ? -1 : j)).filter((j) => j >= 0);
  const strip = (s: Split) => (best.graph ? s.G : s.X).map((row) => {
    const d = NODE_FEATURES.length;
    const blocks = best.graph ? 3 : 1;
    return Array.from({ length: blocks }, (_, b) => keep.map((j) => row[b * d + j])).flat();
  });
  const ablModel = train(strip(tr), tr.y, { hidden: best.hidden, epochs: best.epochs, lr: best.lr, l2: best.l2, seed: 7 });
  const ablTest = metrics(strip(te).map((x) => predict(ablModel, x)), te.y);
  const ablVal = metrics(strip(va).map((x) => predict(ablModel, x)), va.y);
  console.log(`ablation without enriched fields: validation AP ${ablVal.ap}, test AUC ${ablTest.auc} AP ${ablTest.ap}`);

  const card = {
    name: best.name, version: new Date().toISOString().slice(0, 10), graph: best.graph, threshold,
    features: best.graph ? [...NODE_FEATURES, ...NODE_FEATURES.map((f) => `1-hop: ${f}`), ...NODE_FEATURES.map((f) => `2-hop: ${f}`)] : [...NODE_FEATURES],
    node_features: [...NODE_FEATURES],
    splits: { train: { seeds: [1, 2, 3], customers: tr.y.length, positives: tr.y.filter(Boolean).length }, validation: { seeds: [101], customers: va.y.length, positives: va.y.filter(Boolean).length }, test: { seeds: [201, 202], customers: te.y.length, positives: te.y.filter(Boolean).length } },
    candidates: results.map((r) => ({ name: r.name, train: r.train, validation: r.validation, test: metrics(r.tScores, te.y) })),
    test, baseline_test: baselineTest, ablation: { removed: ENRICHED, validation: ablVal, test: ablTest },
    model: best.model,
  };
  fs.writeFileSync(path.join("config", "model.json"), JSON.stringify(card));
  const md = [
    "# Graph model card", "",
    `Selected model: **${best.name}** (chosen by validation average precision).`, "",
    "Task: score each customer's probability of being part of a fraud scenario, from their own records and their neighbours in the customer graph (shared device, phone, email, national ID, payout or beneficiary account, invoice).", "",
    "## Data splits (by dataset, so no customer is in two splits)", "",
    "| Split | Seeds | Customers | Fraud-linked |", "|---|---|---|---|",
    ...(["train", "validation", "test"] as const).map((k) => `| ${k} | ${card.splits[k].seeds.join(", ")} | ${card.splits[k].customers} | ${card.splits[k].positives} |`), "",
    "## Results", "", "| Model | Train AP | Validation AUC | Validation AP | Sealed test AUC | Sealed test AP |", "|---|---|---|---|---|---|",
    ...card.candidates.map((c) => `| ${c.name} | ${c.train.ap} | ${c.validation.auc} | ${c.validation.ap} | ${c.test.auc} | ${c.test.ap} |`), "",
    `Operating threshold ${threshold} (set on validation for precision ≥ 0.8). On the sealed test seeds it flags ${test.flagged} customers with precision ${test.precision} and recall ${test.recall}.`, "",
    "## Value of the enriched data fields", "",
    `Same architecture retrained without ${ENRICHED.join(", ")}: sealed test AUC ${ablTest.auc} and AP ${ablTest.ap}, against ${test.auc} and ${test.ap} with them.`, "",
    "## Limits", "", "- Synthetic data: the scenarios are planted by our generator, so these numbers show the method works, not real-world accuracy.", "- Labels mark customers named in a planted scenario; mule accounts outside the customer base are not scored.", "- The model runs alongside the rules and the agent; it never closes or escalates a case on its own.", "",
  ].join("\n");
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync(path.join("docs", "MODEL_CARD.md"), md);
}
main();
