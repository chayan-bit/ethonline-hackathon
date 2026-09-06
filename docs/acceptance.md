# P0 acceptance matrix

This matrix maps AT-01 through AT-22 from [requirements-spec.md](../requirements-spec.md) to the current evidence boundary.
`PASS` means the required result is supported by live evidence and/or the current browser/API check.
`LOCAL-ONLY` means the behavior passes deterministic unit or contract tests, but no equivalent live acceptance evidence is claimed.
`BLOCKED` means the scenario is partially evidenced but an external dependency prevents the required result.
`MISSING` means the required behavior is absent or the current interface does not expose the required contract.

| ID | Status | Current evidence | Exact remaining boundary |
| --- | --- | --- | --- |
| AT-01 | LOCAL-ONLY | `test/contracts/registry-ledger.test.ts:134` covers register, delegate, update, deactivate, and owner authorization; `npm run deploy` registers the configured provider and `npm run seller` provides status, dry-run, gateway/payee/metadata update, and activation controls. | No live adversarial owner lifecycle replay is claimed. |
| AT-02 | LOCAL-ONLY | `test/contracts/registry-ledger.test.ts:169` and `test/unit/protocol.test.ts:14` cover the negative-return canonical hash and field/salt mismatch behavior. | No separate live submission evidence is required for this deterministic vector, but it remains local test evidence. |
| AT-03 | PASS | The two public records in [live-api-snapshot.json](evidence/live-api-snapshot.json) show verified `0.001 HBAR` payments, delivered responses, commitments, and public request IDs. | Keep the linked transaction and buyer verification evidence with the final submission. |
| AT-04 | LOCAL-ONLY | `test/unit/workflow.test.ts:50` verifies generation failure never settles. | No live failure injection is claimed. |
| AT-05 | LOCAL-ONLY | `test/unit/workflow.test.ts:32`, `:59`, and `:102` cover durable settlement, concurrent retry, restart reconciliation, and unknown commit outcomes. | No live lost-settlement-response replay is claimed. |
| AT-06 | PASS | `test/unit/verification.test.ts:8`, `:24`, and `:35` cover bounded read retry and resumed-response validation; the second public record was resumed without a new charge. | Preserve the authenticated recovery evidence with the final run. |
| AT-07 | LOCAL-ONLY | `test/unit/payments.test.ts:11`, `:20`, `:31`, `:37` and `test/unit/auth.test.ts:34` cover exact transfer inspection, extra recipients, transaction aliases, Mirror evidence, and budget reservations. | No live adversarial signature or concurrent-cap exercise is claimed. |
| AT-08 | LOCAL-ONLY | `test/contracts/registry-ledger.test.ts:181`, `:197`, and `:294` cover timing, wrong payload/salt, duplicate IDs, and duplicate payment references. | No live invalid-operation replay is claimed. |
| AT-09 | LOCAL-ONLY | `test/contracts/registry-ledger.test.ts:181` and `:209` cover permissionless reveal, one valid reveal, no transfer, and independent grade state. | No live buyer-submitted reveal transaction is claimed. |
| AT-10 | BLOCKED | The two live records are publicly revealed while both grades are `oracle_unavailable`; `test/contracts/registry-ledger.test.ts:234` proves reveal retention under an invalid oracle proof. | The configured Pyth testnet proof path must be made compatible and a later valid grade must finalize once. See [preflight.json](evidence/preflight.json). |
| AT-11 | LOCAL-ONLY | `test/contracts/registry-ledger.test.ts:218` and `:234` cover authenticated windows, invalid proof handling, and later grading after invalid oracle input. | No live attacker-submitted invalid proof or fee exercise is claimed. |
| AT-12 | LOCAL-ONLY | `test/contracts/registry-ledger.test.ts:279` covers excessive confidence exclusion without suppressing reveal or moving funds. | No live high-confidence exclusion is claimed. |
| AT-13 | LOCAL-ONLY | `test/contracts/registry-ledger.test.ts:247` and `:262`, plus `test/unit/protocol.test.ts:38` and `:45`, cover exponent normalization, signed arithmetic, and safe rejection. | No live oracle-grade arithmetic run is claimed while Pyth is blocked. |
| AT-14 | LOCAL-ONLY | `test/unit/metrics.test.ts:16` covers ten eligible samples, 80% reveal coverage, 60% grade coverage, and separate excluded/unavailable counts. | The required fixture is local evidence, as permitted for AT-14. |
| AT-15 | LOCAL-ONLY | `test/unit/metrics.test.ts:26` covers future, within-grace, and late reveals without denominator distortion. | The required fixture is local evidence, as permitted for AT-15. |
| AT-16 | LOCAL-ONLY | `test/unit/metrics.test.ts:33` and `test/unit/http.test.ts:51` cover null unknown history, stale watermark behavior, and refusal of unproven default selection. | The live provider has two samples, so the current public service is not itself a zero-history demonstration. |
| AT-17 | LOCAL-ONLY | `test/unit/indexer.test.ts:70`, `:94`, and `:110` cover duplicate replay, delayed Mirror logs, canonical safe-block completeness, and hidden reveals; payment tests cover historical payment attribution. | No live payee-rotation and outage-replay exercise is claimed. |
| AT-18 | LOCAL-ONLY | `test/unit/metrics.test.ts:40` covers a cheaper low-reveal provider being rejected under the threshold policy. | The current service exposes one provider, so no live two-provider discovery run is claimed. |
| AT-19 | PASS | `test/unit/metrics.test.ts:40` covers default refusal and explicit exploration; public `/v1/agents` returns `no_eligible_provider` with `insufficient_history`, while `/v1/agents?allow_unproven=true` returns `selected_agent_id: "1"`. | Keep both live policy responses linked in the final evidence. |
| AT-20 | LOCAL-ONLY | `test/unit/worker.test.ts:37` and `:55` cover HCS/oracle retry behavior, disabled worker behavior, and no financial reward; both live HCS receipts are present in [live-api-snapshot.json](evidence/live-api-snapshot.json). | No live HCS outage or permanently unrevealed forecast exercise is claimed. |
| AT-21 | LOCAL-ONLY | `test/unit/workflow.test.ts:77`, `:89`, and `:102` cover paid-commit failure boundaries, pending receipts, no replacement payment, and retryable unknown outcomes. | No live `paid_commit_failed` transaction is claimed. |
| AT-22 | PASS | `test/unit/http.test.ts:51`, `:77`, and `:98` cover 402 shape, file probing, challenge replay, unauthorized recovery, and private response non-leakage; the current browser flow is accepted at 386px and public HCS/API evidence contains no unrevealed payload. The service has no seller-metadata fetch path, so unsafe remote metadata URLs are not dereferenced. | Preserve the browser and public evidence links; no additional SSRF behavior is present to test. |

## Required interface gaps separate from AT status

These are concrete P0 contract gaps identified by comparing the current source to the required interfaces in `requirements-spec.md`.

| Required behavior | Current source boundary | Status |
| --- | --- | --- |
| Schema response includes encoder definition/version and public policy constants | `/v1/schema/defi.return_forecast.v1` preserves the JSON Schema and adds canonical ABI field order/types, encoding version, schema ID, distribution code, and policy constants. | IMPLEMENTED and covered by the HTTP contract test. |
| Paginated discovery | `/v1/agents` applies bounded `offset` and `limit` fields to the configured P0 provider set and returns stable pagination metadata; a second provider remains P1. | IMPLEMENTED for the intentional singleton P0 registry boundary. |
| History includes explicit cohort membership and evidence links | Agent history and signal detail add cohort membership plus payment, commitment, and available HCS evidence links without exposing private payloads. | IMPLEMENTED and covered by the HTTP/no-leak tests. |
| Separate liveness and readiness | `/health` retains compatibility fields and adds separate `liveness` and dependency-level `readiness` state. | IMPLEMENTED and covered by the HTTP contract test. |
| Request ID and safe retry guidance in errors | Error envelopes include a validated request ID when available and bounded guidance that distinguishes correction, new quote, same-request retry, and no replacement payment. | IMPLEMENTED and covered by the HTTP contract test. |
| Seller register/delegate/update/deactivate operator path | `npm run deploy` owns initial registration; `npm run seller` provides read-only status, dry-run, gateway/payee/metadata update, and active-state mutation using the existing owner-signed contract adapter. `HEDERA_PAYEE_ID` supports a recipient distinct from the owner. | IMPLEMENTED as a documented CLI with a documented inactive rotation window; no live mutation is claimed. |

The canonical safe-block indexer requirement is now covered by the final test evidence: all four canonical log sets must match Mirror before the cursor advances, including delayed-Mirror and hidden-reveal regressions.
The live Pyth grade remains the external blocker that prevents a P0 completion claim even after these local and interface gaps are addressed.
