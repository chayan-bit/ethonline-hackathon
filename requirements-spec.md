# Requirements specification: Verifiable DeFi Signal Market

Version: 1.0 | Date: 5 September 2026 | Deployment: Hedera testnet only.
Audience: an AI implementation agent and the hackathon team.
Source: [final-system-design.md](./final-system-design.md), plus the owner's locked reveal-policy decision of 5 September 2026.
This document specifies observable behavior and acceptance criteria; it does not claim that any implementation or deployment already exists.

## 1. Authority and locked product decision

**Build a marketplace where an autonomous buyer discovers a seller, pays for a private DeFi forecast, verifies its commitment, and later uses public reveal coverage and forecast quality to choose sellers.**

The following requirements are locked and must not be redesigned by the implementation agent:

| ID | Requirement |
|---|---|
| DEC-01 | Payment purchases access to a schema-valid forecast; it does not purchase a correct outcome. |
| DEC-02 | No protocol bounty, reward, stake release, payment release, refund, slash, or other financial transfer may depend on revealing a forecast or grading its quality after expiry. |
| DEC-03 | Reveal is permissionless and voluntary after expiry: seller, buyer, or any party holding the correct payload and salt may reveal. |
| DEC-04 | Seller discovery metadata must contain a separate, verifiable `reveal_pct`, independent of accuracy and grading coverage. |
| DEC-05 | Both the discovery interface and buyer-agent selection must actually use reveal percentage; merely displaying it is insufficient. |
| DEC-06 | Forecast quality is calculated from authenticated oracle evidence and published independently of payment and reveal percentage. |
| DEC-07 | There is no protocol-defined aggregate trust score, human evaluator, DAO, seller stake, or accuracy-conditioned escrow. |

Discovery can affect future demand for a seller; that reputational effect is intentional.
DEC-02 removes direct protocol financial incentives, not the possible commercial benefit of a better public record.
Transaction gas and Pyth verification fees remain ordinary costs paid by the submitting party or the team's bounded operating wallet; they are not reveal rewards and must never be deducted from subscription balances.

Precedence: subsequent explicit owner instructions, then locked decisions above, then this specification, then the earlier design document.
Sections marked **implementation default** resolve details the earlier design left open; they are recommended starting values, not additional owner-approved product decisions.
Use these defaults to begin implementation and record changes with reasons rather than silently changing metric semantics.

## 2. Scope and delivery priorities

### P0: complete hackathon core

- One real forecast provider and one autonomous buyer agent.
- `defi.return_forecast.v1`, initially ETH/USD with an expiry at least five minutes after commitment.
- Agent Registry and Signal Ledger contracts on Hedera testnet.
- A live x402 v2 provider endpoint with exact Blocky402 settlement.
- Persistent paid-response recovery and buyer-side commitment verification.
- Permissionless reveal, independent oracle-backed grading, and separate reveal metadata.
- A replayable indexer, discovery API, seller profile, signal evidence page, and buyer activity view.
- HCS audit receipts containing no unrevealed forecast data.
- One real complete payment-to-grade demonstration, reproducible tests, setup instructions, transaction evidence, and submission materials.

### P1: implement after P0 passes end to end

- Prepaid Subscription Vault with bounded deposits, manual checkpoint, claim, and cancellation.
- Subscriber authentication and entitlement checks at the provider gateway.
- HIP-1215 scheduled checkpoints with manual fallback.
- A second provider, BTC/USD or additional horizons, and HCS-14 identity formatting.
- Actual A2A interaction beyond the discoverable Agent Card, if pursued for extra credit.

P1 is retained from the source design, not removed from the product.
Report P0 and P1 completion separately; the AI must not call the entire specification complete with P1 unfinished.
For a time-limited submission, P0 is the first usable deliverable.

### Explicit exclusions

No mainnet deployment, automatic trading, portfolio custody, model/IP ownership transfer, exclusive signal rights, protocol token, reveal bounty, slashing, trade-loss insurance, generalized evaluator marketplace, zkML, TEE, cross-chain payment, or custom royalty system.
No fabricated history or mock transactions presented as live evidence.
High forecast accuracy is not an acceptance requirement; correct delivery, verifiability, and honest measurement are.

## 3. Actors and user journeys

| Actor | Must be able to do |
|---|---|
| Seller owner | Register and update their agent, authorize/revoke a gateway, publish price and capabilities, inspect public history, deactivate new sales. |
| Buyer agent | Discover providers, explain its choice, enforce spend limits, purchase, recover a paid response, verify the commitment, retain reveal material, optionally reveal. |
| Human buyer/demo operator | Inspect spend policy, start/stop purchases, follow transaction progress, see selection reasons and failures. |
| Revealer/grader | Submit valid reveal data or oracle evidence without seller approval and without claiming a reward. |
| Indexer/operator | Rebuild public metrics from chain evidence, expose freshness and dependency status, retry audit and oracle work safely. |

**Primary journey:** discover → filter on reveal coverage and other buyer policies → obtain quote → validate and sign exact payment → verify/generate/settle/commit → receive and verify → wait for expiry → reveal → grade → refresh discovery.

**Selective non-reveal journey:** a paid commitment reaches expiry and its reporting grace period, remains unrevealed, and lowers reveal percentage without affecting payment or being counted as an inaccurate forecast.

**Oracle outage journey:** a valid reveal is recorded, reveal percentage includes it, grading stays pending/unavailable, and a later retry can grade it without paying the seller again.

## 4. Terms, configuration, and time

All protocol timestamps are integer Unix seconds in UTC.
Contract consensus time is authoritative for commitment, expiry eligibility, and reveal time; client clocks are advisory.
`expiry` means the committed `target_time`, not x402 quote expiry or subscription end time.

| Parameter | Implementation default | Rule |
|---|---|---|
| Network | `hedera:testnet` | Reject every other network in P0. |
| Settlement asset | HBAR, facilitator asset ID `0.0.0` | Prices use atomic units; display conversion must be explicit. |
| Schema | `defi.return_forecast.v1` | One immutable encoding and grading definition. |
| Feed allowlist | ETH/USD Pyth feed | Resolve the actual testnet-supported ID from official sources; never invent it. |
| Minimum / maximum target lead | 300 / 3,600 seconds after commitment | Pick a target with transaction-latency headroom; return the actual timestamp. |
| Issuance tolerance | 30 seconds | `abs(issued_at - committed_at) <= 30`. |
| Oracle window | 60 seconds | Issuance `[committed_at, committed_at + 60]`; outcome `[target_time, target_time + 60]`. |
| Maximum oracle confidence ratio | 100 bps | Check `confidence × 10,000 <= positive_price × 100`. |
| Neutral direction band | 5 bps inclusive | Returns from -5 to +5 bps are neutral. |
| Reveal reporting grace | 300 seconds after target | Delays inclusion in the denominator; does not prohibit immediate or late reveal. |
| Discovery history | Trailing 30 days by target time | Also expose lifetime counts. |
| Metrics freshness limit | 120 seconds | Automated selection refuses stale metrics by default. |
| Default buyer minimum history | 5 eligible paid commitments | Adjustable buyer policy; never a contract admission rule. |
| Default buyer minimum reveal | 80% | Compare exact fractions, not rounded display percentages. |
| Quote lifetime | At most 120 seconds | Also respect the signed Hedera transaction validity interval. |

Feed lists, oracle settings, encoding, and timing rules must be versioned and bound to commitments.
Changing a rule must not reinterpret previous commitments or grades.
P0 may use immutable constructor configuration and a deployment version instead of an upgrade framework.
Display actual commitment-to-target duration; do not label a 330-second interval as exactly 300 seconds.
When more horizons or feeds exist, keep quality statistics partitioned by comparable feed and horizon cohorts.

## 5. Functional requirements

### 5.1 Registry and seller metadata

**REG-01:** Register an immutable `agent_id` with owner, authorized gateway, payment recipient, active flag, metadata URI/hash, schema support, and payment modes.
Only the owner may change mutable registry fields or delegate/revoke the gateway.
Registration must prove control through a wallet transaction or a domain-bound signature.

**REG-02:** Metadata must describe name, capabilities, HTTPS service endpoint, Agent Card URL, schema version, supported feeds/target ranges, non-exclusive distribution, and current pricing.
Validate the fetched document against its on-chain hash and a bounded schema.
Record historical payee and quote terms so an owner changing today's payee cannot invalidate yesterday's payment evidence.

**REG-03:** `GET /v1/agents/{agent_id}` must return seller-supplied descriptive metadata and a separately sourced `metrics` object containing `reveal_pct`.
The indexer computes metrics; sellers cannot upload, overwrite, or reset them.
Registry edits, deactivation, gateway rotation, and model-version changes preserve the agent's previous history.

**REG-04:** Deactivation prevents new purchases and new commitments but must not block old-response recovery, reveal, grading, or subscription cancellation.
New identities can have no history; do not claim to prevent identity resets or Sybil sellers.

### 5.2 Canonical signal and commitment

**SIG-01:** Ship one JSON Schema and one shared canonical encoder, used by gateway, buyer, tests, and grading tooling.
Reject unknown fields, unsupported feeds/schema IDs, invalid timestamps, malformed identifiers, out-of-range integers, or unsupported distribution values before settlement.
JSON numbers must be safe integers; `agent_id` is a decimal string to preserve `uint256` precision.

| JSON field | Encoding / validation |
|---|---|
| `schema` | Exact ASCII string `defi.return_forecast.v1`; `schemaId = keccak256(UTF8(schema))`. |
| `request_id` | Cryptographically random `bytes32`, unique per intended purchase. |
| `agent_id` | Decimal string encoded as `uint256`. |
| `price_feed_id` | Allowlisted `bytes32`. |
| `issued_at` | `uint64`, seconds. |
| `target_time` | `uint64`, seconds. |
| `predicted_return_bps` | `int32`; implementation default accepted range -10,000 to +100,000. |
| `model_version` | 1-64 ASCII characters from letters, digits, `.`, `_`, `-`; encode `keccak256(UTF8(value))`. |
| `distribution` | Exact string `non-exclusive`, encoded as `uint8(1)`. |

**SIG-02:** The salt is a cryptographically random 32-byte value outside the signal JSON.
The exact commitment is:

```text
keccak256(abi.encode(
  bytes32 schemaId, bytes32 requestId, uint256 agentId,
  bytes32 priceFeedId, uint64 issuedAt, uint64 targetTime,
  int32 predictedReturnBps, bytes32 modelVersionHash,
  uint8 distributionCode, bytes32 salt
))
```

Use standard ABI encoding, not packed encoding, JSON stringification, or an implementation-specific field order.
Restricting model-version text to ASCII removes Unicode-normalization ambiguity in v1.
Publish at least one golden vector shared between TypeScript and Solidity tests, including a negative return.

**SIG-03:** Only the registered owner or authorized gateway can commit for an active seller.
The ledger stores request ID, agent ID, schema/config version, commitment hash, commit time, target time, feed, payment mode, and immutable payment reference/terms needed by the indexer.
The revealed payload must match both the hash and those stored public fields.
Timing checks relying on hidden fields such as `issued_at` must also run during reveal; the gateway checks them before charging.

**SIG-04:** A request ID and normalized x402 settlement reference can each back at most one paid commitment in this ledger.
The transaction reference must be bound to the request, buyer, seller, expected asset/amount, and payee snapshot through an auditable purchase receipt.
Publish these receipt fields with the commitment event or bind a publicly retrievable immutable receipt by its hash in the ledger.
Normalize the reference as network plus native transaction ID before deduplication; textual aliases must not create multiple paid samples.
Contract acceptance alone does not prove that payment occurred.

**SIG-05:** Publish commitment events with evidence identifiers, never the private prediction or salt.
Buyer response includes signal, salt, commitment hash, chain/network, ledger address, request ID, settlement receipt, and commitment transaction ID.
The buyer recomputes the hash and reads the ledger before reporting the forecast as verified or usable.

**SIG-06:** The live provider must generate a forecast using inputs available before commitment and record a truthful model version.
Implementation default: a deterministic momentum baseline using two pre-issuance market-price observations, returning their observed percentage change in basis points as its forecast.
Document the lookback, data source, validation, and output bounds; fail before settlement when required inputs are unavailable.
Do not use future observations, fixture outputs disguised as live inference, or an LLM solely to reformat a numeric result.
The buyer may be a deterministic tool-using agent with an explicit discovery and spending policy; conversational intelligence and automated trading are not required.

### 5.3 Payment gateway and durable recovery

**PAY-01:** Implement the sequence `verify payment → generate and validate → durably persist prepared response → settle → commit → respond`.
Reuse the supported x402/Hedera SDK and facilitator integration; do not invent an escrow or implement Hedera signing from scratch.
Use the facilitator's current `/supported` capabilities and required fee-payer identity.
Check response bodies for verification and settlement success, not just HTTP 200.
The precise facilitator behavior is documented in [Blocky402 API reference](https://blocky402.com/docs/api-reference/).

**PAY-02:** Bind each quote to one request body, buyer, provider, price, asset, payee, network, expiry, and idempotency key.
Persist these terms before accepting payment.
Generation or schema-validation failure must occur before settlement and produce no seller payment.
If the remaining target lead is insufficient before settlement, expire the quote and require a fresh unsigned request.

**PAY-03:** A transaction timeout has an unknown outcome until reconciled.
Persist the expected native transaction ID before broadcast, query authoritative transaction status, and do not create a replacement payment while the old payment may have succeeded.
Retries must retrieve the original result or resume the original workflow without recomputing a different prediction, salt, quote, or payment.
Concurrent identical requests must have one durable purchase record and at most one successful transfer.

**PAY-04:** If payment succeeds but commitment is delayed, return an authenticated pending status and retry the original commitment while its timing constraints remain valid.
If those constraints expire, record `paid_commit_failed`, retain the original receipt/payload, and display that it is not a verified forecast.
Never backdate, silently replace the prediction, request a second charge, or promise an automatic refund.
This non-atomic failure is a documented delivery risk of the chosen direct-payment design and must be visible in the demo activity view.

**PAY-05:** Paid-response recovery requires proof of buyer ownership; a public transaction ID alone must never grant access.
Use wallet-signed, expiring, single-use challenges bound to domain, network, request ID, method, path, and body digest where applicable.
Keep unrevealed payloads out of public API responses, logs, traces, analytics, HCS, and static assets.
Recovery must survive process restart; an in-memory cache alone does not satisfy this requirement.

**PAY-06:** Before each signature, the buyer validates exact asset, amount, payee, network, quote validity, and allowed facilitator transaction structure.
Reject extra transfers, allowances, unrelated operations, and changed terms on retry.
Do not blindly sign arbitrary serialized transactions from a provider.

**PAY-07:** Buyer policy includes per-request, per-provider UTC-day, and global UTC-day spend caps; token/network allowlists; and an immediate kill switch.
Reserve budget atomically for in-flight payments and retain the reservation while outcome is unknown.
Count successful recovered payments once and persist budget state across restarts.
Use a dedicated low-balance test wallet, with credentials confined to the trusted buyer process.

### 5.4 Reveal independently from grade

**REV-01:** Provide `reveal(requestId, signal, salt)` independently of oracle submission.
It is callable when `block.timestamp >= targetTime` by anyone with matching data.
Before target time, reject the reveal even if the hash is correct.

**REV-02:** Validate hash, schema, stored-field consistency, and issuance timing before recording a reveal.
An invalid attempt reverts without changing the request, seller counts, payment, or reputation.
The first valid reveal stores its consensus timestamp and emits enough public data to reproduce the commitment.
Subsequent reveals must not duplicate events or counts; the API may return the existing result while the contract returns an explicit already-revealed error.

**REV-03:** A valid reveal increases the appropriate reveal numerator whether submitted by buyer, seller, or keeper.
The metric measures availability of a seller's committed forecasts, not who submitted the transaction.
No submission bounty, gas reimbursement reward, score-dependent payout, or non-reveal financial penalty exists.

**REV-04:** Reveal remains possible after the reporting grace period and after extended outages.
Late reveals update eventual reveal percentage; preserve original timestamps so delay remains auditable.
Leaving a reporting cohort does not erase historical commitment or reveal records.

**REV-05:** A convenience `revealAndGrade` endpoint is optional; independent reveal and grade operations are mandatory.
An oracle error must not erase an already successful reveal.
For a combined transaction that reverts on oracle failure, the client must fall back to submitting reveal alone.

### 5.5 Oracle grading

**GRD-01:** Provide a permissionless `grade(requestId, issueUpdate, targetUpdate)` operation for a validly revealed signal.
Read prediction data from the recorded reveal or require it again and verify against the stored commitment.
Finalize at most one grade per request.
The ledger never pays the seller, revealer, or grader as a result of grading.

**GRD-02:** Authenticate both historical observations through the configured Pyth contract using `parsePriceFeedUpdatesUnique`, the committed feed, and fixed issuance/target windows.
This API requires the first authenticated observation in the requested range and a verification fee; callers cannot substitute a current spot price or choose a later favorable observation.
See [Pyth historical unique-update API](https://api-reference.pyth.network/price-feeds/evm/parsePriceFeedUpdatesUnique).

**GRD-03:** Normalize differing price exponents with checked integer arithmetic before comparing prices.
Reject unsupported arithmetic ranges; require positive prices and the configured confidence bound on both observations.
Use signed division truncated toward zero for `actual_return_bps` and document that rule in tests.

```text
actual_return_bps = truncTowardZero((p1 - p0) * 10_000 / p0)
absolute_error_bps = abs(predicted_return_bps - actual_return_bps)
direction(x) = -1 if x < -5; 0 if -5 <= x <= 5; +1 if x > 5
direction_correct = direction(predicted_return_bps) == direction(actual_return_bps)
```

**GRD-04:** Malformed proofs, insufficient verification fees, wrong feeds/windows, and temporary missing oracle data must not permanently finalize a sample as excluded.
An attacker must not be able to censor a future valid grade by submitting bad data first.
The off-chain worker may show retryable `oracle_unavailable` with a reason and last-attempt time; that status is not proof that a valid observation can never exist.

**GRD-05:** A terminal `oracle_excluded` state is permitted only when authenticated unique observations establish deterministic invalid price/confidence conditions under the fixed policy.
Exclude these samples from accuracy calculations, retain them in reveal coverage and eligible sample counts, and emit the authenticated exclusion reason.
Unauthenticated fetch failures remain retryable and must not masquerade as terminal chain evidence.

**GRD-06:** Grade events include request, policy version, both price observations/exponents/confidences/publish times, actual return, absolute error, and directional result.
Store or emit sufficient evidence for an independent indexer to reproduce the calculation.
Poor forecasts produce ordinary grades with no fund movement.

### 5.6 Evaluator and audit worker

**OPS-01:** A small restart-safe worker may reveal cached signals after expiry and attempt grading with bounded retries and backoff.
It receives no reward and has a dedicated capped operating balance.
The user can disable it; buyers and sellers retain independent reveal/grade access.
Do not make worker execution a prerequisite for payment completion or subscription withdrawal.

**OPS-02:** Emit an HCS receipt after commitment with version, event type, request/agent IDs, payment mode/reference, ledger transaction ID, commitment hash, schema, and target time.
HCS failure must not undo or repeat settlement; retry a durable audit job and deduplicate indexed receipts by logical event ID.
Contract state is the grading authority, while HCS supplies a redundant audit trail.

## 6. State model

Keep payment, reveal, and grade status separate; a single `completed` flag cannot represent this product.

| Dimension | States and transitions |
|---|---|
| Purchase | `quoted → prepared → settlement_pending → paid → commit_pending → delivered`; pre-payment failures terminate without charge; unrecoverable post-payment commit failure becomes `paid_commit_failed`. |
| Commitment | Absent → immutable committed record; indexed payment verification is independently `pending`, `verified`, or `invalid`. |
| Reveal | `unrevealed → revealed`; `not_due`, `within_grace`, and `overdue` are derived time labels, not terminal states. |
| Grade | `not_revealed → pending → graded` or authenticated `oracle_excluded`; off-chain `oracle_unavailable` is retryable. |
| Audit | `pending → published`; transient errors retry without affecting other dimensions. |

Events from every stage must be deduplicated and reconciled after restart.
Use a transactional database for purchase recovery, budget reservations, worker jobs, and indexer cursors; a single service and SQLite are acceptable for a single-instance demo.
Separate modules and responsibilities do not require separate microservices.
Public metrics must be rebuildable from verified chain events plus published purchase evidence, independent of the provider's private database.

## 7. Reveal percentage and quality metrics

### 7.1 Exact primary cohort

The primary discovery cohort is **verified x402-paid commitments**, partitioned by seller and schema, with optional feed/horizon filters.
Subscription and unpaid commitments must be labeled and reported separately; do not mix unmetered subscription requests into paid sample counts.
Also expose all-commitment counts for transparency, including unverifiable payment references.

For one query evaluated at consensus-data watermark `T`, define:

```text
W = 30 days
G = 300 seconds
E = commitments with verified payment and target_time in [T-W, T-G]
R = members of E with a valid reveal recorded at or before T
Q = members of E with a valid finalized grade at or before T
X = members of E with authenticated terminal oracle exclusion

reveal_pct = null if |E| == 0 else 100 * |R| / |E|
grade_coverage_pct = null if |E| == 0 else 100 * |Q| / |E|
directional_hit_rate_pct = null if |Q| == 0 else 100 * correct_direction_count / |Q|
mean_absolute_error_bps = null if |Q| == 0 else sum(absolute_error_bps) / |Q|
```

**MET-01:** Apply the same cohort to numerator and denominator.
Future commitments and commitments within grace do not dilute the percentage; show them as pending counts.
Early eligible reveals must not inflate the numerator before their commitments enter the denominator.
Reveal at the exact target time is valid; eligibility at exactly `target_time + G` is included.

**MET-02:** Do not remove unrevealed, bad-quality, or oracle-excluded commitments from `E`.
Do not score an unrevealed sample as directionally wrong, zero error, or oracle excluded.
Label quality as conditional on graded samples and show reveal and grade coverage beside it to expose selective disclosure.

**MET-03:** No history produces `null` and an explicit `insufficient_history` label, never 0% or 100%.
Return numerator/denominator counts and precision alongside rounded percentages.
Perform policy comparisons using counts or exact rational arithmetic; display at two decimals only.

**MET-04:** Late valid reveals count as revealed once indexed; no deadline closes the reveal operation.
Store `revealed_at` and show whether a reveal arrived after grace.
The primary field is eventual reveal percentage, not a promise of on-time service.

**MET-05:** Verify successful payment, payer, asset, expected amount, historical payee, unique reference, and request binding against Mirror Node transaction evidence and the public purchase receipt.
Indexing delays are `payment_verification_pending`, not invalid payment.
Never count HCS messages or seller declarations as payment proof on their own.
Verified transfer proves payment movement, not independent demand or correct service delivery.

**MET-06:** Replay, pagination, duplicate events, and restart must preserve counts exactly.
Use an indexed-through consensus timestamp for `T`; expose wall-clock `computed_at` and lag separately.
An outage must not age commitments into the denominator using wall time while their reveal events remain unindexed.

**MET-07:** Preserve settled-but-uncommitted delivery failures as a separate operational count where independently observable.
Disclose that commitment-based reveal percentage cannot measure undisclosed payments or uncommitted forecasts.
Self-payments and Sybil purchases remain possible; volume and unique-wallet counts are untrusted demand signals.

### 7.2 Seller metadata response requirements

The following fields are mandatory in the computed `metrics` object:

| Group | Fields |
|---|---|
| Definition | `metric_version`, `schema`, `payment_mode`, `feed_filter`, `horizon_filter`, `window_start`, `window_end`, `reveal_grace_seconds`. |
| Freshness | `computed_at`, `indexed_through`, `lag_seconds`, `is_stale`. |
| Coverage | `eligible_paid_count`, `revealed_count`, `unrevealed_count`, `pending_expiry_or_grace_count`, `reveal_pct`. |
| Quality | `graded_count`, `grade_coverage_pct`, `directional_hit_rate_pct`, `mean_absolute_error_bps`. |
| Missing evidence | `oracle_excluded_count`, `oracle_unavailable_count`, `grade_pending_count`, `payment_verification_pending_count`, `invalid_payment_reference_count`. |
| Context | `history_status`, lifetime count equivalents, `unique_paying_wallets`, paginated evidence URL. |

Unavailable API values are `null` with a reason; numeric zero is reserved for observed zero.
Reveal timestamps remain available per signal even after a record leaves the rolling window.

### 7.3 Discovery must use the metric

**DIS-01:** Support filtering by schema, active status, feed/target compatibility, payment asset, maximum price, minimum eligible samples, minimum reveal percentage, and optional grade/quality thresholds.
Support explicit sort by reveal percentage, price, or available quality metrics, always with sample counts visible.

**DIS-02:** Default buyer policy uses at least five eligible samples and reveal percentage at least 80%, rejects stale data, then chooses the cheapest compatible provider; tie-break on higher reveal percentage and then stable agent ID.
If the buyer supplies quality thresholds, apply them before selection and reject unknown quality values rather than treating them as favorable.
Return machine-readable rejection reasons and explain the selected provider's actual values.

**DIS-03:** When no seller qualifies, do not silently relax coverage or spend policy.
Return `no_eligible_provider` with reasons.
A separate, explicit `allow_unproven` buyer option may permit a capped exploratory purchase from a seller with insufficient history.
Label this mode in the UI and keep every financial limit enforced.
For the first demo purchase, use that visible exploration option or previously accumulated real testnet samples.

**DIS-04:** Discovery UI default ordering places providers satisfying the current buyer filters first and shows the active criteria.
Changing a reveal threshold must change both the displayed eligible set and the autonomous buyer's next selection.
Ranking and thresholds are buyer/UI policy, not contract truth or a hidden composite reputation score.

## 8. Required interfaces

Names below specify the required surface; SDK wire formats must follow the pinned upstream versions.
Document implemented request/response schemas in OpenAPI or an equivalent generated, machine-readable contract.

| Interface | Required behavior |
|---|---|
| Agent Card URL | Public capabilities, schema and payment modes, service URL, and metrics URL; verify the chosen A2A version/path before claiming compatibility. |
| `GET /v1/schema/defi.return_forecast.v1` | JSON Schema, encoder definition/version, and public policy constants. |
| `GET /v1/agents` | Filtered, paginated discovery with computed metrics and selection reasons. |
| `GET /v1/agents/{id}` | Registry-backed description, payee/pricing, metrics, evidence links. |
| `POST /v1/signals` | Body includes request ID, agent, feed, target, and schema; unpaid request returns x402 requirements; paid retry executes/retrieves the bound purchase. |
| `POST /v1/auth/challenges` | Expiring, request-scoped wallet challenge for private retrieval or subscription access. |
| `GET /v1/purchases/{request_id}` | Buyer-authenticated pending/failure status or original paid response; never creates a new payment. |
| `GET /v1/signals/{request_id}` | Public commitment/payment/reveal/grade evidence; includes payload only after valid public reveal. |
| `GET /v1/agents/{id}/signals` | Paginated sample history with explicit states, cohort membership, and evidence links. |
| Buyer CLI or API | Accepts task and explicit policy, discovers, selects, signs, purchases, verifies, persists evidence, and reports reasons. |
| Ledger SDK | `commit`, `reveal`, `grade`, and read functions; wallets submit directly without needing a privileged evaluator API. |
| Health endpoint | Separate process liveness and dependency/readiness states, including indexer lag and worker status. |

Use stable error codes such as `invalid_signal`, `policy_rejected`, `quote_expired`, `payment_pending`, `paid_commit_failed`, `not_expired`, `hash_mismatch`, `already_revealed`, `oracle_unavailable`, and `no_eligible_provider`.
Errors include request ID and safe retry guidance, without keys, signatures, or unrevealed payloads.
Use HTTPS for hosted access, bounded input sizes, authentication on private endpoints, and rate limits on writes and challenge issuance.
If the discovery service fetches seller-supplied URLs, block local/private/link-local destinations and unsafe redirects to prevent SSRF.

## 9. Required product screens

| Screen | Acceptance behavior |
|---|---|
| Discovery | Seller cards/table with price, reveal percentage and counts, grade coverage, MAE, hit rate, history/freshness badges, visible filters, and selection reasons. |
| Seller profile | Registry identity, capabilities, non-exclusive terms, separate reveal/quality history, pending/excluded samples, payment modes, and linked raw evidence. |
| Signal detail | Timeline from payment to commitment, expiry countdown, reveal state/time, grade or retryable oracle status, and external transaction/HCS links. |
| Buyer activity | Active budget and kill switch, provider-selection reasoning, exact signed charge, pending reconciliation, successful recovery, and commitment verification result. |
| Seller setup | Wallet-authorized registration/update/deactivation flow; may be a documented CLI for P0 rather than a separate dashboard. |

Unpurchased or unrevealed signal pages must not leak predictions.
Use accessible labels, keyboard-operable controls, readable mobile layouts, and distinct loading, empty, stale, pending, and error states.
Never use a green success indicator for a payment whose settlement outcome is unknown or whose commitment was not verified.

## 10. P1 subscription requirements

**SUB-01:** Subscription creation fixes buyer, provider/payee, token, start, maximum end, integer rate per second, deposit, and capped HBAR automation reserve.
Define deposit as `rate_per_second × duration_seconds` in token atomic units for v1; reject inconsistent funding.
The buyer grants at most the exact needed token allowance and the vault transfers the deposit in once.
No renewal or top-up occurs without a new explicit buyer authorization.

**SUB-02:** Earned service value is `min(deposit, rate_per_second × (min(now, cancelled_at_if_any, end) - start))`, clamped to zero before start.
`checkpoint` and `claim` transfer only earned value not already paid.
Repeated calls at the same time pay nothing extra; integer rounding must never increase the buyer's charge.

**SUB-03:** Buyer cancellation settles newly accrued value, marks cancellation, and returns all unearned tokens plus unused automation reserve atomically.
Seller downtime, poor accuracy, reveal state, grades, HCS, and keeper health do not affect this operation.
At natural expiry, the buyer can recover unused automation reserve through an explicit close/cancel path.
Transfer failures revert the transaction and preserve correct accounting; use reentrancy protection and checks-effects-interactions with atomic rollback.

**SUB-04:** Scheduled checkpoints are best-effort automation using the supported Hedera scheduling interface.
Scheduling failure must not prevent funding an otherwise valid manually operable subscription or block cancellation, claim, or checkpoint.
A call after cancellation is harmless and must not create another funded schedule.
Reserve ownership and per-subscription usage must remain auditable; scheduling must never draw another buyer's reserve or service deposit.

**SUB-05:** Gateway access requires a replay-protected subscriber signature and current on-chain entitlement.
Cancelled/expired subscriptions lose new-request entitlement; already delivered response recovery remains possible.
Paused new purchases cannot block withdrawals or cancellation, and no admin rescue path may withdraw accounted balances.
Handle HTS association and token transfer response codes explicitly.

**SUB-06:** Subscription signal commitments use an explicit subscription ID plus unique request ID, not a fabricated x402 payment reference.
Report their reveal/quality history separately and label sampling: v1 does not require every unmetered subscription request to be committed or graded.
Do not represent sampled subscription coverage as coverage of all delivered subscription outputs.

## 11. Verification and acceptance tests

Every requirement must map to a runnable test, observable UI behavior, or documented live evidence.
Use unit tests for deterministic logic, integration tests for workflow boundaries, and browser/agent E2E tests for the real user journey.
Target at least 80% coverage for application and contract logic, plus invariant/fuzz checks for money and commitment rules; coverage alone does not prove correctness.

| ID | Scenario | Required result |
|---|---|---|
| AT-01 | Register, delegate, update, deactivate; repeat with unauthorized wallet. | Authorized mutations work; unauthorized mutations fail; old history and reveal access persist. |
| AT-02 | Encode one negative-return golden signal in buyer, gateway, Solidity. | Identical hash; changing any field or salt produces a mismatch. |
| AT-03 | Real buyer pays a live provider on testnet. | One successful Blocky402 transfer, one commitment, authenticated delivery, buyer verifies hash and stored fields. |
| AT-04 | Generation fails or schema is malformed. | No settlement attempt and no seller charge. |
| AT-05 | Lose settlement HTTP response, retry concurrently, restart gateway. | Reconcile original transaction; at most one payment, one prepared forecast, one commitment. |
| AT-06 | Lose final paid HTTP response and retrieve by receipt. | Buyer recovers identical response; unrelated wallet and public transaction-ID-only access are rejected. |
| AT-07 | Alter payee/asset/network/amount, add an extra transfer, or exceed caps concurrently. | Buyer refuses the unsafe signature; reserved and final budgets remain correct across restart. |
| AT-08 | Commit/reveal at timing boundaries, wrong salt, wrong feed, duplicate IDs/reference. | Invalid operations change no evidence or funds; earliest valid reveal is exactly target time. |
| AT-09 | Buyer reveals seller's prediction; seller retries. | Exactly one valid reveal counts for that seller; no reward or fund change. |
| AT-10 | Reveal succeeds while Hermes/Pyth is unavailable. | Reveal remains recorded and counted; grade is retryable; later valid proofs finalize once. |
| AT-11 | Attacker submits invalid proof, wrong window, or insufficient oracle fee first. | Cannot finalize exclusion, suppress a later grade, or change reveal coverage. |
| AT-12 | Valid unique observations have excessive confidence width. | Authenticated exclusion, no quality sample, reveal still counted, no payment change. |
| AT-13 | Oracle exponents differ; returns are negative/neutral; exercise overflow boundaries. | Deterministic documented arithmetic or safe rejection, never a fabricated grade. |
| AT-14 | Ten eligible paid commitments, eight revealed, six graded, one excluded, one oracle-unavailable. | Reveal 80%; grade coverage 60%; quality denominator six; excluded and unavailable shown separately. |
| AT-15 | Add five future/within-grace commitments to AT-14, then reveal one overdue sample. | Pending samples do not dilute coverage; late reveal changes coverage to 90%. |
| AT-16 | Zero eligible history or zero graded history. | Undefined metrics are null and labeled; buyer does not interpret unknown as a passing value. |
| AT-17 | Reindex duplicate HCS/events, rotate payee, replay after outage. | Same counts; historical payment attribution preserved; lag shown; no unfair wall-clock aging. |
| AT-18 | Two otherwise eligible providers have reveal 90% and 60%; threshold is 80%. | Low-reveal seller is rejected even if cheaper; UI and agent explain the same decision. |
| AT-19 | All providers unproven or metrics stale. | Default agent refuses; explicit bounded exploration allows only the configured unproven case. |
| AT-20 | HCS publish fails; keeper is disabled; a forecast is inaccurate or never revealed. | Payment remains unchanged; HCS retries without duplicate charge; no grading-dependent transfers. |
| AT-21 | Settlement succeeds, but commitment can never meet timing bounds. | Visible `paid_commit_failed`, no backdating/replacement/second charge; risk accurately reported. |
| AT-22 | Inspect public API, browser assets, logs, audit messages, challenge replay and unsafe metadata URLs. | No pre-expiry secret leakage, unauthorized recovery, signature replay, or private-network URL fetch. |
| AT-23 | P1 cancel at start, mid-term, end; repeat checkpoints and late scheduled calls. | Paid + refunded service tokens equal deposit, provider never exceeds accrued amount, reserve conserved. |
| AT-24 | P1 transfer/association/scheduling failure and purchase pause. | Correct rollback; manual financial exits work without scheduler/backend; no cross-subscriber spending. |

AT-14/15 may use clearly labeled local fixtures; the submission's real paid lifecycle must not use mocked settlement or oracle verification.
For every valid or invalid reveal/grade test, assert that protocol buyer/seller balances do not change except the submitting account's ordinary network/oracle costs.
Test endpoint behavior through the real buyer interface as well as direct contract calls.

## 12. Implementation order and definition of done

### Milestone 0: prove integrations before building UI

Inspect supported upstream examples, SDK versions, facilitator capabilities, Hedera testnet connectivity, and historical Pyth parsing on the intended contract.
Record chosen versions, actual network IDs, feed IDs, contract addresses, and working setup commands.
Do not invent identifiers or substitute mocks while claiming the external dependency works.
Choose the smallest compatible stack; TypeScript for gateway/buyer/UI and Solidity for contracts are implementation defaults, not a demand for multiple services.

### Milestone 1: deterministic protocol

Implement shared schema, encoder, immutable ledger timing rules, registry, independent reveal, and grade arithmetic.
Complete golden vectors, authorization tests, malicious reveal/proof tests, and relevant invariants.

### Milestone 2: paid vertical slice

Implement durable quotes/response storage, exact buyer policy, facilitator settlement, commitment, and authenticated recovery.
Demonstrate one live paid request with transaction evidence and exercise a real HTTP recovery path.

### Milestone 3: expiry and evidence

Add the worker, historical oracle verification, permissionless reveal/grade tooling, and HCS audit jobs.
Demonstrate a live grade and prove that valid reveal is retained during oracle failure.

### Milestone 4: discover using reveal history

Build the indexer, metric API, discovery/profile/evidence/activity UI, and autonomous selection.
Prove AT-14 through AT-19 and the full UI journey.
P0 is complete only when all P0 tests pass and the real lifecycle evidence is present.

### Milestone 5: subscriptions

Implement the vault and manual exit paths first, then entitlement checks, then scheduling.
Run the financial invariants and failure tests before demonstrating automation.
Never trade away cancellation correctness to finish scheduled execution.

### Milestone 6: submission package

Provide a public repository, environment-variable template without secrets, pinned dependencies, exact setup/deploy/test commands, contract addresses and verification links, architecture/payment-flow README, and evidence report.
Include a video no longer than five minutes showing a real paid request executing, along with discovery, commitment verification, reveal coverage, and grading.
A previously created real expiring sample can demonstrate grading within the video; identify it rather than pretending the full waiting period occurred instantly.
Document the honest limits: selective disclosure, Sybil/self-payment, non-exclusive payloads, no delivery/payment atomicity, oracle outages, and commitment-based coverage.
Record any pre-existing material and confirm the applicable event participation rules before implementation/submission.

For each milestone, report changed artifacts, commands run, test outcomes, live transaction references where applicable, and remaining blockers.
Keep local tests, live integration evidence, P0 completion, and P1 completion distinct.

## 13. Competition and source checks

The current Hedera AI & Agentic Payments track requires a live x402 service settled through Blocky402, a consuming platform/agent completing a real paid request, a public repository with setup/architecture/payment-flow documentation, and a video of five minutes or less.
Scheduled payments, HCS audit trails, agent discovery, identity, and other integrations are additional opportunities rather than reasons to delay the payment loop.
Source checked 5 September 2026: [ETHOnline 2026 prize page](https://ethglobal.com/events/ethonline2026/prizes).
Recheck event rules and deadlines before building/submitting; this specification does not certify eligibility or promise a prize.

- Product source: [final-system-design.md](./final-system-design.md).
- Payment integration: [Blocky402 API](https://blocky402.com/docs/api-reference/) and [supported networks/assets](https://blocky402.com/docs/networks/), checked 5 September 2026.
- Historical grading: [Pyth unique historical update API](https://api-reference.pyth.network/price-feeds/evm/parsePriceFeedUpdatesUnique), checked 5 September 2026.
- Before P1, verify the scheduling API and deployed-network support against the official HIP-1215 and Hedera documentation linked in the source design.
- Before publishing Agent Card or HCS-14 compatibility claims, verify the applicable standard version; a project-specific card is not proof of full A2A interoperability.

## 14. Copy-paste implementation handoff

> Read `requirements-spec.md` and `final-system-design.md` in this folder.
> Implement this specification in milestone order, delivering and verifying P0 before starting P1.
> The reveal policy is locked: no financial reward, payout release, refund, or slash depends on revealing or grading; keep reveal percentage separate from quality and actually use it in seller discovery and buyer selection.
> Implement reveal independently from oracle grading so oracle failures cannot suppress valid reveals.
> Treat defaults as starting choices, preserve the stated semantics, and record any necessary changes with reasons.
> Reuse maintained Hedera/x402/Pyth integrations, pin versions, and prove live testnet behavior before claiming integration completion.
> Use durable payment recovery, exact spend limits, replay protection, and the listed acceptance tests.
> Produce a runnable implementation, test results, deployment/evidence instructions, and a concise milestone status; do not stop after a plan or replace the core integrations with mocks.
> Keep P0 and P1 status explicit and report any live dependency that remains unverified.
