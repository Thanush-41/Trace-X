# Known limitations

- **Authentication is built in, not enterprise identity.** Pages and APIs require an HMAC-signed session; analyst and admin roles are enforced server-side, reset is admin-only, and decisions are attributed to the signed-in user. The two built-in accounts store only scrypt password hashes. Production use would need SSO, rate limiting on sign-in, account lifecycle and audit-log export.
- **One shared workspace.** Every account works on the same data, so two people loading different datasets at once see them merged, and an admin reset clears it for everyone. Detection stays correct on merged data, but a per-user or per-session workspace would be needed for concurrent independent evaluation.
- **Synthetic evaluation.** Recall (18/18), lookalike handling (10/10) and precision (91–96%) are measured on generated data, including an unseen holdout seed, not on real bank data. Rule weights are reasoned starting values. The Rules page suggests data-driven weight changes from analyst decisions, but only applies them if a person edits the policy.
- **The ML layer is unsupervised.** The Isolation Forest finds unusual transfers relative to the whole workspace; it is not trained on fraud labels, so it corroborates rules (top 0.2%) and widens coverage with Low model-only findings (top 0.5%) rather than deciding cases on its own. It needs at least 200 transfers.
- **No LLM.** The investigation brief is a deterministic template over stored evidence. An LLM summary could be added behind the same evidence-only contract.
- **Dates.** Slash dates are read day-first unless a column shows otherwise (any day above 12 decides it); each ambiguous column is reported. Times without an offset are read as the policy timezone (+05:30).
- **Currency** is converted to INR with a fixed table in `config/policy.json`, not live rates.
- **Reference checks depend on import order.** A transaction whose accounts are imported later is accepted with a warning and links up on the next detection run; the warning on the original batch stays.
- **Changing data creates new alerts.** An alert's identity comes from its evidence; if new records change a finding, the next run stores a new alert and the earlier one stays in history.
- **Scale.** Detection loads the workspace into memory: about 0.1 s locally and 2.5 s against the hosted database for about 10k records. Per-account baselines are capped at the last 200 transfers. Uploads are capped at 4.5 MB per request on Vercel.
- **Insurance claims** are checked from the claim file; there is no document image analysis, so duplicate detection relies on a supplied document hash or invoice number.
- **Not built:** case assignment and SLAs, policy editing in the UI, an interactive relationship graph.
