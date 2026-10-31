# Known limitations

- **No authentication.** Anyone who can reach the app can import data, record decisions or reset the workspace. The analyst name on a decision is self-declared and remembered in the browser. A real deployment needs SSO, roles (analyst, lead, admin) and per-role permissions. Reset in particular should be restricted.
- **Synthetic data only.** The evaluation figures (17/17 planted fraud, 9/9 lookalikes on three seeds) measure behaviour on generated data whose patterns the rules were designed around. They are not validated real-world precision or recall. Weights in `config/policy.json` are reasoned starting values, not trained or calibrated.
- **Rules and statistics, not machine learning.** Detection uses configurable rules, robust per-account statistics (median/MAD, percentiles) and graph linking. No model is trained, and there is no LLM in the detection path.
- **Single workspace.** All imports go into one shared dataset. Detection always runs over everything currently loaded. There is no per-tenant or per-batch isolation.
- **Timestamps are treated as UTC** when the file gives no offset. `DD/MM/YYYY` is assumed for slash dates, so `MM/DD/YYYY` files would be misread or rejected.
- **Reference checks depend on import order.** A transaction whose accounts have not been imported yet is accepted with a warning. It links up once accounts are imported and detection re-runs, but the warning on the original batch stays.
- **Changing data creates new alerts.** An alert's identity comes from its evidence. If new records change what a finding is based on, the next run stores a new alert, and the earlier alert stays in history but drops out of the "latest run" views. Cases follow the same rule.
- **Scale.** The detection run loads the whole dataset into memory: about 70 ms for about 9.5k records. That is fine for demos and batches of tens of thousands of rows, not for streaming bank-scale volumes. Uploads are capped at 10 MB per file, and Vercel limits request bodies to 4.5 MB.
- **Insurance claims** are checked from the claim file alone. There is no document image analysis: the duplicate check relies on a supplied document hash or invoice number. Provider clustering needs `provider_id`.
- **Not built at Level 1:** case assignment and SLAs, policy editing in the UI, an interactive relationship graph, and an LLM case narrative.
- **Deployment:** Vercel needs a hosted libSQL database (Turso) via `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. The local SQLite file does not persist on serverless hosts.
