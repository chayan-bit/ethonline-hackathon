# P1 subscription plan

P1 subscription work is authorized to proceed in parallel with the P0 oracle repair.
This plan does not change the P0 release gate: P0 remains incomplete until a valid live Pyth grade and the remaining P0 acceptance evidence exist.
No P1 work may rewrite historical x402 grades, change reveal or quality semantics, add a reveal incentive, or treat oracle availability as a financial condition.

## Required P1 deliverables

The required P1 tranche is the prepaid subscription path described by `SUB-01` through `SUB-06` and verified by `AT-23` and `AT-24`.

1. **Vault accounting.** Create a bounded subscription with buyer, provider, settlement token, integer rate per second, start, maximum end, exact deposit, amount paid, cancellation state, and capped HBAR automation reserve.
The deposit must equal `rate_per_second × duration_seconds` in token atomic units.
The buyer grants only the exact deposit allowance, and renewal or top-up requires a new explicit authorization.

2. **Manual money paths.** Implement permissionless `checkpoint` and `claim` that pay only newly accrued value and are idempotent at the same timestamp.
Implement `cancel` and natural-expiry `close` so accrued value is settled and all unearned tokens plus unused automation reserve return atomically to the buyer.
Rounding must favor the buyer.
Transfer failure must revert accounting changes.

3. **Safety invariants.** Use reentrancy protection and checks-effects-interactions.
Handle HTS association and transfer response codes explicitly.
No owner rescue path may withdraw accounted subscriber balances.
Pausing new purchases, provider downtime, forecast accuracy, reveal state, grade state, HCS, or keeper health must not block checkpoint, claim, cancel, close, or refund paths.

4. **Subscriber authorization.** Add a replay-protected wallet-signed nonce for provider requests.
The gateway must check current on-chain entitlement before allowing a new subscription request.
Cancelled or expired subscriptions lose new-request entitlement, while already delivered response recovery remains available.

5. **Best-effort scheduling.** Add HIP-1215 scheduling only as an automation convenience.
Scheduling failure, capacity limits, missing gas, or a late scheduled call must not block manual checkpoint, claim, cancel, close, or refund.
A post-cancellation scheduled call is harmless and cannot create another funded schedule.
Reserve ownership and per-subscription schedule usage must remain auditable.

6. **Subscription signal identity.** Subscription commitments use an explicit subscription ID plus a unique request ID.
They must not fabricate an x402 payment reference.
Subscription samples are labeled separately from verified x402-paid cohorts, and sampled subscription outputs must never be presented as coverage of every delivered subscription output.

7. **Second provider or cohort.** Add a second provider, BTC/USD feed, or additional horizon behind explicit feed/schema/horizon configuration.
Keep each feed and horizon in a comparable cohort and do not reinterpret the existing ETH/USD x402 history.
Discovery and selection must preserve the same raw reveal and quality fields for the new provider or cohort.

8. **HCS-14 identity formatting.** Add the project UAID/HCS-14 representation to provider metadata and the registry binding where the selected implementation requires it.
Describe HCS-14 as a draft UAID format used by the project, not as Hedera-native identity issuance or a reputation registry.

## Minimum contract/runtime surface

The implementation should expose the smallest surface needed for the requirements and tests:

- `createSubscription` with fixed terms and exact deposit/reserve checks.
- `checkpoint` and `claim` with idempotent newly-earned accounting.
- `cancel` and `close` with atomic settlement and refund.
- Read functions for terms, accrued value, paid value, cancellation/expiry, entitlement, reserve, and schedule state.
- A permissionless scheduled-call entrypoint that is safe after cancellation and does not recursively fund itself after expiry.
- Events containing subscription ID, buyer, provider/payee, terms, deposit, paid amount, reserve changes, cancellation/close, and schedule outcomes.

The exact HTS token ID, decimals, reserve cap, epoch, and supported scheduler parameters must be explicit deployment configuration and documented before live testnet funding.
The configured test token is `SignalMarketTestToken` (`SMTT`) with 6 decimals.
It is project test credit, not Circle USDC or another production stablecoin.
Do not silently reuse HBAR x402 payment references for subscription samples.

## Ownership split

### Sol worker owns runtime and tests

Sol owns the subscription contract, its deployment/configuration adapter, gateway entitlement adapter, scheduler adapter, subscription persistence, and all P1 tests.
The proposed new-file boundary is:

- `contracts/SubscriptionVault.sol`;
- `src/protocol/subscription.ts`;
- `src/adapters/subscription-vault.ts` and `src/adapters/scheduler.ts`;
- `src/service/subscriptions.ts` and any subscription-only gateway entitlement helper;
- `scripts/subscription.ts` or an equivalent explicit CLI;
- `test/contracts/subscription-vault.test.ts`;
- `test/unit/subscription*.test.ts` and scheduler/entitlement tests.

For the required provider/identity extension, Sol owns the isolated feed/provider configuration, provider fixture, UAID formatter, metadata/registry binding, and tests in new or clearly scoped files such as `src/protocol/hcs14.ts`, `src/protocol/provider-cohorts.ts`, `test/unit/hcs14.test.ts`, and `test/unit/provider-cohort.test.ts`.
Any edit to shared metadata or registry code must preserve the deployed P0 metadata hash and be separately tested.

Sol may add the minimum deployment/configuration fields needed for this surface and must preserve immutable x402, reveal, grade, and historical payment behavior.

Sol must not modify the P0 oracle ownership boundary in this tranche:
`src/adapters/pyth.ts`, `scripts/preflight.ts`, `docs/evidence/preflight.json`, and the core reveal/grade semantics in `contracts/SignalLedger.sol` remain outside P1 subscription changes.
A subscription-specific worker or scheduler adapter should be a new module rather than a rewrite of the oracle worker.

### Luna owns documentation and API contract

Luna owns:

- this plan and the P1 section of [docs/status-report.md](status-report.md);
- P1 additions to [docs/acceptance.md](acceptance.md), including AT-23 and AT-24 evidence status;
- [docs/openapi.yaml](openapi.yaml) for subscription creation, entitlement, checkpoint/claim status, cancel/close, and error envelopes once the runtime shapes are fixed;
- README setup, payment/subscription flow, testnet safety, and release-gate language;
- demo/status documentation for P1, without claiming live subscription funding before evidence exists.

Luna does not edit contracts, runtime, configuration, tests, Pyth/preflight files, or shared oracle/indexer implementation.

### Core P0 boundary

The P0 owner retains Pyth, preflight, and any minimal shared ledger/indexer/worker changes needed for the live grade and canonical evidence.
P1 subscription work must not change the P0 acceptance matrix's x402 cohort, reveal percentage, quality denominator, historical grades, or no-financial-incentive rule.

## Acceptance split

`AT-23` must cover cancellation at start, midpoint, and end; repeated checkpoint/claim calls; late scheduled calls; exact accrued plus refunded value equal to the deposit; provider payment never exceeding accrued value; and reserve conservation.

`AT-24` must cover HTS association failure, token transfer failure, scheduler failure/capacity, cancelled or paused purchase behavior, manual exits without a scheduler/backend, rollback correctness, and proof that one subscription cannot spend another subscriber's reserve or deposit.

Additional required checks cover exact allowance, rate/duration/deposit mismatch, replayed subscriber nonce, expired/cancelled entitlement, no owner rescue, reentrancy, and separate subscription sample labeling.

The first P1 evidence target is local contract/runtime tests and a machine-readable API contract.
Live testnet subscription funding, scheduler execution, and public claims require a separate operator decision after the tests pass; this plan authorizes no new paid x402 action.
That later decision produced the partial live record summarized in [status-report.md](status-report.md#p1-evidence-checklist); it did not prove automatic settlement or a subscription forecast lifecycle.

## Live evidence checklist

This checklist records the minimum evidence needed before changing AT-23 or AT-24 from local evidence to live acceptance.
It does not authorize testnet funding or a new subscription run.

| Requirement | Local evidence already present | Live evidence still required |
| --- | --- | --- |
| SUB-01 terms and exact funding | `test/contracts/subscription-vault.test.ts:264` covers allowance, deposit, duration, and reserve rejection; two live subscriptions have exact funded terms and conservation. | Preserve the receipt and balance evidence in the final package. |
| SUB-02 earned value and idempotence | `test/contracts/subscription-vault.test.ts:124` covers repeated checkpoint and accrued payment. | Same-time checkpoint/claim receipt pair and on-chain paid/provider balance evidence. |
| SUB-03 cancel and close | `test/contracts/subscription-vault.test.ts:124` and `:167` cover mid-term/start cancellation and natural close; the live run manually cancelled one subscription and permissionlessly closed another with exact conservation. | Live start cancellation and automatic final checkpoint remain unproven. |
| SUB-04 scheduling | Local tests cover callback fields, bounded clock skew, unauthorized early calls, stale recovery, post-cancel safety, and end callback plus close. | The live callback returned early on timestamp skew. The tested fix is undeployed, so recurring automatic settlement remains unproven. |
| SUB-05 entitlement and authorization | `test/contracts/subscription-ledger.test.ts:140` and `test/unit/subscription-service.test.ts:108` cover entitlement loss; `test/unit/subscription-http.test.ts:35` covers wallet auth and recovery. | Public API subscriber signature, replay rejection, post-cancel new-request rejection, and delivered-response recovery. |
| SUB-06 identity and cohort labeling | `test/contracts/subscription-ledger.test.ts:163` and `:267`, `test/unit/subscription-service.test.ts:91`, and `test/unit/subscription-worker.test.ts:46` cover explicit IDs, no x402 reference, sampling, and separate cohort fields. | Public indexed evidence proving `subscription_id`, unique request ID, `payment_mode: subscription`, sampled labeling, and separation from x402 history. |

### Deployment and identity

- Record successful Mirror receipts and source/runtime verification for the SMTT token, `SubscriptionVault`, `SubscriptionLedger`, and subscription-agent registration.
- Verify the token is `SignalMarketTestToken` (`SMTT`), has 6 decimals, exact configured token ID, finite supply, no mutable admin/freeze/KYC/wipe/pause keys, and no custom fees.
- Verify the vault and ledger bind the registry, HTS/HSS system addresses, token, current Pyth verifier, schema, ETH/USD feed, 900-second horizon, and the documented confidence and neutral-band settings.
- Verify the subscription agent ID is distinct from x402 agent `1`, active, bound to the intended payee and metadata hash/URI, and advertises subscription payment mode without changing the x402 provider identity.

### One successful manual lifecycle

- Record the buyer allowance receipt and creation receipt for exact terms: rate, duration, `deposit = rate × duration`, start/end, schedule interval/gas, and capped HBAR reserve.
- Read the escrow terms, token balances, allowance, reserve, schedule address, and next scheduled timestamp after creation.
- Execute buyer cancellation before the signal target and before reveal, then read `cancelled_at`, `closed`, entitlement, paid value, token balances, reserve, spent reserve, refunded reserve, and cleared schedule state.
- Reveal and grade the already committed request after cancellation, then verify the commitment retains the explicit subscription ID and subscriber while no payment reference exists.
- Verify the public API accepts an authorized subscriber request, rejects an unauthorized or replayed signature, exposes recovery for the delivered response, and labels the result `payment_mode: subscription`, `sampled: true`, with separate reveal/quality fields and no fabricated x402 payment reference.

### Token and HBAR conservation

- Capture pre-creation and post-close token balances for buyer, provider, and escrow, and assert `deposit = provider_paid + buyer_refund + escrow_token_balance` with escrow balance zero after close.
- Capture reserve initial, automation spent, current reserve, and refunded reserve, and assert `reserve_initial = spent + current_reserve + refunded_reserve` without counting ordinary operator or buyer transaction fees as subscriber reserve.
- Verify provider payment never exceeds on-chain accrued value and that repeated checkpoint or claim at the same timestamp pays zero additional tokens.

### Recurring scheduler and manual close

- Run a separate long-enough subscription with at least two schedule intervals before end; the current `p1-evidence.ts` duration is 120 seconds with a 300-second interval and cannot demonstrate this.
- Verify a successful `ScheduleAttempt` creates the expected callback, a scheduled callback pays only newly accrued value, and the callback recreates the next schedule before natural end.
- Execute at least two recurring callbacks and verify each receipt, checkpoint amount, next schedule, reserve debit, and per-subscription reserve isolation.
- At natural end, verify the final scheduled callback checkpoints without closing, then call permissionless `close` and verify exact token settlement, full remaining reserve refund, zero schedule state, and no further payment.
- Execute a scheduled callback after cancellation and verify it is harmless, cannot reopen entitlement, cannot pay again, and cannot create a funded schedule.

### Cohort and second-provider evidence

- Query `GET /v1/agents?payment_mode=subscription`, the subscription agent metadata, and subscription history after indexer convergence; verify the subscription cohort is separate from x402 history and reports its own sampled commitment, reveal, and quality fields.
- Verify the new request uses a unique request ID plus subscription ID, while x402 history remains unchanged and no subscription output is counted as coverage of every delivered output.
- Verify a second provider or explicitly distinct feed/schema/horizon is registered with a distinct identity and comparable cohort configuration; the one-agent `p1-evidence.ts` runner does not establish this requirement.

### What remains local-only

The contract tests remain the evidence for injected HTS association/transfer failures, scheduler failure or capacity, paused purchase rollback, fee-on-transfer rollback, reentrancy, no-owner-rescue, exact allowance and term rejection, and cross-subscriber isolation.
The current live runner does not safely induce those failures on testnet, so it must not be reported as proving them.
The live runner created two subscriptions, observed one scheduled transaction that became a contract no-op, then manually cancelled and closed the escrows with exact conservation.
The forecast commit window was missed, so no subscription commitment, HCS audit, reveal, grade, or later checkpoint was broadcast.
Recurring scheduler execution, same-time live checkpoint idempotence, public subscription API evidence, and the remaining adversarial cases remain unproven.

## Optional extra credit

Actual A2A interaction beyond the discoverable REST Agent Card is optional extra credit, not a required subscription P1 deliverable.
It must not be used to imply compatibility with an unverified A2A version or path.
Permanent hosting, event publication, repository packaging, and video submission remain release/package work rather than subscription runtime scope.

The release order is therefore:

```text
P0 live oracle repair and final P0 acceptance  ──┐
                                                  ├─ release gate: both remain explicit
P1 subscription + second provider/cohort + HCS14 ─┘
optional extra-credit A2A interaction             → after required P1 is stable
```
