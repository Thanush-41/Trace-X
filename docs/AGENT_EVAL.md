# Agent evaluation on sealed seeds

Cases from seeds 201 and 202 (never used for training, tuning or lessons), judged against their answer keys. "Not fraud" means the key lists no fraud scenario for the case.

| Agent | Cases | Correct | Accuracy | Mean citation grounding | Fallbacks |
|---|---|---|---|---|---|
| Deterministic tool agent | 19 | 18 | 94.7% | 1 | 0 |
| LLM multi-agent (gpt-4o-mini) | 19 | 18 | 94.7% | 0.99 | 0 |

| Seed | Case | Answer key | Deterministic | LLM agents |
|---|---|---|---|---|
| 201 | CASE-af0cc220af | Account takeover | Account takeover ✓ | Account takeover ✓ |
| 201 | CASE-7db904f641 | Cross-system fraud | Cross-system fraud ✓ | Cross-system fraud ✓ |
| 201 | CASE-e518aa8826 | Account takeover | Account takeover ✓ | Account takeover ✓ |
| 201 | CASE-bc5053d8ca | Identity fraud | Identity fraud ✓ | Identity fraud ✓ |
| 201 | CASE-cb7f566f76 | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 201 | CASE-83611a9577 | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 201 | CASE-b30a2a043e | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 201 | CASE-7a855d2031 | Insurance fraud | Insurance fraud ✓ | Insurance fraud ✓ |
| 201 | CASE-4b772cb5a6 | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 202 | CASE-d23e722b89 | Account takeover | Account takeover ✓ | Account takeover ✓ |
| 202 | CASE-62f90fb3b8 | Cross-system fraud | Cross-system fraud ✓ | Cross-system fraud ✓ |
| 202 | CASE-06626214d4 | Identity fraud | Identity fraud ✓ | Identity fraud ✓ |
| 202 | CASE-f344f0d299 | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 202 | CASE-622b88ae8c | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 202 | CASE-696916ad06 | Account takeover | Account takeover ✓ | Account takeover ✓ |
| 202 | CASE-852848aca1 | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 202 | CASE-9861eef6cc | Suspicious transfers | Suspicious transfers ✓ | Suspicious transfers ✓ |
| 202 | CASE-d7135fe2ed | Insurance fraud | Insurance fraud ✓ | Insurance fraud ✓ |
| 202 | CASE-75897950d4 | Not fraud | Suspicious transfers ✗ | Suspicious transfers ✗ |
