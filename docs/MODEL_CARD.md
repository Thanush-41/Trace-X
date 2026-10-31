# Graph model card

Selected model: **Graph neural network: SIGN propagation + MLP(32)** (chosen by validation average precision).

Task: score each customer's probability of being part of a fraud scenario, from their own records and their neighbours in the customer graph (shared device, phone, email, national ID, payout or beneficiary account, invoice).

## Data splits (by dataset, so no customer is in two splits)

| Split | Seeds | Customers | Fraud-linked |
|---|---|---|---|
| train | 1, 2, 3 | 999 | 51 |
| validation | 101 | 333 | 17 |
| test | 201, 202 | 666 | 34 |

## Results

| Model | Train AP | Validation AUC | Validation AP | Sealed test AUC | Sealed test AP |
|---|---|---|---|---|---|
| Logistic regression, own features (no graph) | 0.999 | 0.973 | 0.809 | 0.991 | 0.886 |
| Logistic regression on graph features (SGC) | 1 | 0.994 | 0.81 | 0.997 | 0.857 |
| Graph neural network: SIGN propagation + MLP(16) | 1 | 0.996 | 0.893 | 0.997 | 0.862 |
| Graph neural network: SIGN propagation + MLP(32) | 1 | 0.999 | 0.98 | 0.997 | 0.879 |

Operating threshold 0.29 (set on validation for precision ≥ 0.8). On the sealed test seeds it flags 36 customers with precision 0.944 and recall 1.

## Value of the enriched data fields

Same architecture retrained without recent SIM swap, remote-access tool seen, emulator / rooted device seen, VPN / proxy share, max behaviour anomaly, payee-name mismatch share: sealed test AUC 0.997 and AP 0.862, against 0.997 and 0.879 with them.

## Limits

- Synthetic data: the scenarios are planted by our generator, so these numbers show the method works, not real-world accuracy.
- Labels mark customers named in a planted scenario; mule accounts outside the customer base are not scored.
- The model runs alongside the rules and the agent; it never closes or escalates a case on its own.
