# Verifiable DeFi Signal Market implementation plan

Status: P0 implementation plan derived from `requirements-spec.md` and `final-system-design.md`.

Date: 6 September 2026.

## 1. Product requirements brief

Build one working Hedera testnet vertical slice in which a buyer agent discovers a provider, pays for one schema-valid ETH/USD forecast through x402 and Blocky402, verifies the pre-outcome commitment, and later obtains a permissionless reveal and Pyth-backed grade.

Payment buys delivery of a valid forecast and never buys correctness.

Reveal is voluntary and permissionless after expiry, and reveal percentage is a separate seller metric that affects discovery and buyer selection.

Quality is calculated independently from authenticated oracle evidence and cannot release, withhold, refund, slash, or transfer money.

The first usable submission is P0; subscription vault, scheduled checkpoints, a second provider, and broader identity or A2A work remain P1.

## 2. Locked acceptance boundary

P0 is complete only when all of the following are demonstrated on Hedera testnet with real external integrations.

- One provider serves `defi.return_forecast.v1` through a live x402 v2 endpoint using the Blocky402 facilitator.
- One buyer agent applies explicit spend and discovery policy, signs one exact payment, and completes a paid request.
- The buyer recovers the original response after a simulated lost HTTP response and verifies the canonical commitment against the ledger.
- Agent Registry and Signal Ledger contracts are deployed, verified, and exercised with authorization, timing, deduplication, and immutable evidence tests.
- Reveal is a separate operation from grade, and buyer, seller, or another holder can reveal after the target time without a reward or financial consequence.
- A valid reveal survives an oracle outage, and a later Pyth historical update finalizes at most one grade.
- The indexer rebuilds payment verification, reveal percentage, and quality metrics from public evidence, and its discovery API and buyer selector both enforce reveal thresholds.
- The browser screens expose selection reasons, pending and stale states, commitment and payment evidence, reveal state, and grade evidence without leaking an unrevealed payload.
- A real end-to-end evidence record includes transaction IDs, contract addresses, feed ID, selected dependency versions, commands, and remaining limitations.

P1 must be reported separately and must not be described as complete when any item above remains unverified.

## 3. Architecture and ownership

Use one TypeScript application initially, with modules for provider gateway, buyer agent, durable workflow store, worker, indexer, discovery API, and UI.

Use Solidity contracts for the Agent Registry and Signal Ledger, with the smallest interfaces that satisfy the required reads and writes.

Use SQLite for the single-instance demo's durable purchase, recovery, budget, worker, indexer cursor, and audit-job state.

Use the Hedera Mirror Node for transaction and event evidence, HCS receipts, and indexed-through timestamps.

Use Blocky402 for x402 verification and settlement, and use the Pyth contract plus Hermes historical updates for grading.

Keep the provider's forecast and salt in the private durable store until a valid public reveal, and keep HCS messages limited to non-secret audit fields.

### Component boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| Agent Registry | Owner, gateway, payee, active status, metadata hash, schema and payment capabilities | Rolling metrics or private signal data |
| Signal Ledger | Immutable commitment, reveal, grade or retryable oracle status, public evidence events | Payment verification by historical transfer lookup or any reward logic |
| Provider gateway | Quote binding, deterministic forecast, validation, settlement workflow, response recovery | Grading authority or arbitrary buyer key custody |
| Buyer agent | Discovery policy, exact signature checks, caps, kill switch, local commitment verification | Unbounded signing or silent policy relaxation |
| Worker | Restart-safe reveal and grade retries, HCS audit retries | Payment completion or financial entitlement |
| Indexer | Public evidence verification, cohort metrics, freshness, replay-safe projections | Seller-supplied metric values |
| Discovery API and UI | Filters, raw metrics, evidence links, buyer selection explanations | A hidden composite trust score |

## 4. P0 technical design

### 4.1 Integration spike before product code

Record the exact versions and successful commands for the Hedera SDK, Solidity toolchain, Blocky402 SDK or HTTP API, Pyth contract address, Hermes endpoint, and testnet network identifier.

Call Blocky402 `/supported` and verify the exact HBAR asset, `hedera:testnet` network, facilitator fee-payer behavior, verification response, settlement response, and transaction reference format.

Deploy a minimal contract to a disposable Hedera testnet account and verify event reads through the Mirror Node.

Resolve the actual Hedera testnet Pyth contract and ETH/USD feed ID from official sources, then run a historical update parse with a real verification fee.

Do not proceed to UI polish or claim integration completion while any of these probes use a mock or an invented identifier.

### 4.2 Canonical signal and commitment module

Create one JSON Schema and one shared TypeScript encoder for `defi.return_forecast.v1`.

Validate unknown fields, safe integer ranges, timestamps, feed allowlist, request ID, decimal `agent_id`, ASCII model version, and exact `non-exclusive` distribution at the gateway and buyer boundary.

Implement the Solidity hash as `keccak256(abi.encode(schemaId, requestId, agentId, priceFeedId, issuedAt, targetTime, predictedReturnBps, modelVersionHash, distributionCode, salt))` with explicit widths and signedness.

Add one golden vector with a negative return and assert byte-for-byte agreement between TypeScript and Solidity.

### 4.3 Registry and Signal Ledger

Agent Registry stores immutable identity anchors and owner-controlled mutable gateway, payee, metadata, capability, and active fields.

Signal Ledger stores request ID, agent ID, schema or policy version, commitment, commit time, target time, feed, payment mode, normalized payment reference, and immutable payment terms needed for indexing.

`commit` is restricted to the registered owner or authorized gateway and rejects inactive sellers, duplicate request IDs, duplicate normalized payment references, invalid timing, and unsupported schema or feed values.

`reveal` is callable by anyone at or after the stored target time, verifies payload consistency and commitment hash, records only the first valid reveal, and emits evidence without any transfer.

`grade` is permissionless for a valid reveal, authenticates both historical observations through the configured Pyth contract, handles retryable oracle failures without finalizing the sample, and finalizes at most one grade or deterministic oracle exclusion.

Keep reveal and grade state separate so a successful reveal cannot be rolled back by a later oracle error.

### 4.4 Paid vertical slice and recovery

Persist a quote before accepting payment, binding request body, buyer, provider, price, asset, network, payee, quote expiry, and idempotency key.

Run `verify payment -> generate and validate -> persist prepared response -> settle -> commit -> respond`.

Use the required deterministic momentum baseline for the first provider, based only on two pre-issuance observations, and record its truthful model version.

Persist the original forecast, salt, exact terms, expected native transaction ID, and workflow state before any operation that can be retried.

Reconcile unknown settlement outcomes through authoritative transaction status, and never create a replacement payment while the original may have succeeded.

Expose wallet-signed, expiring, single-use recovery challenges bound to domain, network, request ID, method, path, and body digest where applicable.

Return `paid_commit_failed` when settlement succeeded but commitment could not meet timing rules, and preserve the original evidence without backdating, replacement, or second charge.

### 4.5 Worker, HCS, and public evidence

The worker retries reveal and grade with bounded backoff and a capped operating wallet, but buyers and sellers can submit directly.

The audit job writes a deduplicated HCS receipt after commitment containing event version, request and agent IDs, payment mode and reference, ledger transaction ID, commitment hash, schema, and target time.

HCS or worker failure never changes payment or commitment state.

### 4.6 Indexer, metrics, and selection

Replay contract events, HCS messages, and Mirror Node transfers into idempotent projections with durable cursors and a consensus watermark.

Verify payer, asset, amount, expected payee, historical payee snapshot, request binding, unique reference, and transaction success before counting a commitment as a paid sample.

Compute the 30-day verified-paid cohort excluding the 300-second reporting grace period, and expose eligible, revealed, unrevealed, pending, graded, excluded, unavailable, and payment-pending counts.

Return `reveal_pct` as null with `insufficient_history` when there are no eligible samples, and compare exact counts or rational values rather than rounded display percentages.

Make discovery filter and sort by reveal percentage, sample count, schema, feed and target compatibility, active status, asset, price, and optional quality thresholds.

Make the buyer default policy require at least five eligible samples, reveal percentage at least 80%, fresh metrics, and the cheapest compatible seller, with higher reveal percentage and stable agent ID as tie-breakers.

Reject stale or unknown quality values by default, return machine-readable rejection reasons, and require an explicit bounded `allow_unproven` option for exploration.

### 4.7 Required application surface

Implement the schema, discovery, agent profile, signal request, challenge, purchase recovery, public evidence, seller history, and health endpoints named in the requirements before building alternate routes.

Expose separate liveness and readiness data, including indexer lag and worker state.

Keep private recovery and subscription access behind wallet-signed, expiring challenges, and apply bounded input sizes, HTTPS, write rate limits, and SSRF protection to seller metadata fetches.

## 5. Milestones and task checklist

### M0: dependency proof

- [ ] Inspect and pin upstream SDK/API versions.
- [ ] Confirm Blocky402 testnet support, exact asset, facilitator flow, and transaction reference.
- [ ] Confirm Hedera Solidity deployment and Mirror Node event reads.
- [ ] Confirm Hedera testnet Pyth contract, ETH/USD feed, historical window, and fee.
- [ ] Capture blockers and selected identifiers in the README or evidence notes.

### M1: deterministic protocol

- [ ] Implement schema, validator, encoder, and golden vector.
- [ ] Implement Registry contract and owner/gateway authorization.
- [ ] Implement Ledger commit, independent reveal, grade, and evidence events.
- [ ] Add timing, replay, duplicate, malformed payload, invalid proof, and no-fund-movement tests.
- [ ] Deploy to testnet and verify contract source and event visibility.

### M2: paid vertical slice

- [ ] Implement quote and purchase tables with unique request and settlement references.
- [ ] Implement exact buyer policy, caps, reservations, kill switch, and persisted wallet state.
- [ ] Implement provider generation, validation, durable prepared response, Blocky402 verification, settlement, and commitment.
- [ ] Implement restart-safe reconciliation and authenticated recovery.
- [ ] Complete one real paid request and preserve transaction evidence.

### M3: reveal, grade, and audit

- [ ] Implement restart-safe worker with bounded retries and no rewards.
- [ ] Implement permissionless reveal and direct grade tooling.
- [ ] Implement Pyth historical proof retrieval and deterministic arithmetic.
- [ ] Implement HCS receipts with durable idempotent jobs.
- [ ] Demonstrate reveal during oracle outage followed by later grade finalization.

### M4: discovery and end-to-end proof

- [ ] Implement replayable indexer and freshness watermark.
- [ ] Implement metric API, seller profile, signal evidence, and buyer activity endpoints.
- [ ] Implement discovery filters and buyer selection using the same reveal percentage field.
- [ ] Implement required UI states and prevent unrevealed payload leakage.
- [ ] Run AT-01 through AT-22, then record P0 status and evidence.

### P1: only after P0

- [ ] Implement Subscription Vault accounting, manual checkpoint, claim, cancellation, and refund first.
- [ ] Add subscriber signatures and entitlement checks.
- [ ] Add HIP-1215 scheduling with manual fallback and reserve accounting.
- [ ] Add second provider or horizon, HCS-14 formatting, and deeper A2A only if P0 remains stable.
- [ ] Run AT-23 and AT-24 and report P1 separately.

## 6. Concrete contradictions and blockers

### Must resolve before claiming P0 integration

1. `final-system-design.md` presents `revealAndGrade` as the core ledger operation, while the requirements mandate independent `reveal` and `grade` and require reveal to survive oracle failure.

   Resolution: implement separate operations and treat the combined operation as an optional client convenience only.

2. `final-system-design.md` suggests ETH/USD and BTC/USD across multiple horizons, while the requirements set P0 to one ETH/USD forecast and move broader coverage to P1.

   Resolution: implement one allowlisted ETH/USD feed and one short horizon in P0, with versioned configuration ready for later cohorts.

3. The design discusses subscription and scheduled payments as part of the architecture, while the requirements classify the vault as P1.

   Resolution: keep subscription interfaces out of the P0 acceptance claim and avoid letting subscription work delay the x402 path.

4. The requirements require a live Blocky402 flow, but no application or dependency implementation currently exists in this checkout.

   Blocker: verify current API and SDK behavior, fee payer requirements, asset support, transaction ID normalization, and testnet credentials before writing the gateway adapter.

5. Historical Pyth grading depends on a real Hedera testnet deployment, feed ID, Hermes response, and verification fee, none of which are present in the checkout.

   Blocker: perform the M0 Pyth probe and record the exact address, feed ID, window behavior, and fee before finalizing the Solidity oracle interface.

6. The requirements demand real paid and graded evidence, but the checkout currently contains only the two design documents.

   Blocker: create the minimal runnable project, deployment configuration, environment template, and evidence workflow before UI completion can be assessed.

### Known bounded risks to disclose

- Direct x402 settlement and on-chain commitment are not atomic, so `paid_commit_failed` must remain visible and recoverable as evidence.
- A buyer or provider can selectively disclose or self-purchase, so raw reveal and quality metrics are not a Sybil-resistant trust score.
- Signal payloads are non-exclusive after delivery.
- Indexer lag delays metrics; consensus watermark and `is_stale` must be visible.
- Pyth or HCS outages must remain retryable and must never move funds.

## 7. Definition of done and handoff

The implementation agent should work milestone by milestone, commit runnable tests with each milestone, and report exact commands and evidence rather than asserting completion from local mocks.

The final submission must include a public repository, dependency and environment instructions without secrets, verified contract addresses, live transaction links, architecture and payment-flow documentation, and a video under five minutes showing the real paid request plus discovery, commitment verification, reveal coverage, and grading.

Any changed default or unresolved external dependency must be recorded with its reason and impact on the P0 acceptance boundary.
