# Evidence and milestone status

Snapshot date: 6 September 2026.
Network: `hedera:testnet` only.
Public service: [temporary quick tunnel](https://valium-meant-atomic-articles.trycloudflare.com).
The tunnel is a short-lived process on the operator's Mac and has no uptime promise beyond the local server and tunnel process lifetime.

## Live deployment

The authoritative deployment record is [deployments/testnet.json](../deployments/testnet.json).

| Resource | Value |
| --- | --- |
| Agent Registry | `0x00000000000000000000000000000000009e74b9` |
| Signal Ledger | `0x2B90651860e98e3530bC2B67Aa919922EeD39E2B` / native `0.0.10387543` |
| Legacy Signal Ledger | `0x00000000000000000000000000000000009e753c` |
| HCS topic | `0.0.10384701` |
| Agent | `1`, `ETH Momentum` |
| Schema | `defi.return_forecast.v1` |
| Feed | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| Price | `100000` tinybars, or `0.001 HBAR` |
| Public base URL | `https://valium-meant-atomic-articles.trycloudflare.com` |

The public `/health` response reported `live: true`, configured contracts and oracle API, an enabled worker, and a non-stale indexer.
The public `/v1/agents` response reported three eligible paid samples, three reveals, `reveal_pct: 100`, one grade, `grade_coverage_pct: 33.3`, and two legacy `oracle_unavailable` samples.
The default selection result was `no_eligible_provider` with `insufficient_history` because the default minimum is five eligible samples.

The raw legacy public summary is [live-api-snapshot.json](evidence/live-api-snapshot.json).
It intentionally omits salts, forecast payloads, signatures, private keys, and full HCS message bodies.

## Two legacy paid records

Both records are x402 HBAR transfers from buyer `0.0.10384426` to payee `0.0.10384424` through facilitator fee payer `0.0.7162784`.
The public API reports both as `payment_status: verified`, `status: delivered`, and publicly revealed.

| Request | Payment | Commitment | Target | Reveal | HCS receipt | Current grade state |
| --- | --- | --- | ---: | ---: | --- | --- |
| `0x1381ef3f939efd9b5ccf2d0a7439b36ef585b4a76a6dcda9c2b79de7f649950a` | `0.0.7162784@1788652152.867721393` | `0.0.10384424@1788652158.134650253` | `1788652515` | `1788652523` | `0.0.10384424@1788652172.354415316` | `oracle_unavailable` |
| `0x63c07d42013194b7d974e4a48b058bd23c8f3da1fb615fc7dc39e25796ebd5fc` | `0.0.7162784@1788652616.723469092` | `0.0.10384424@1788652619.146305203` | `1788652979` | `1788653040` | `0.0.10384424@1788652630.285733214` | `oracle_unavailable` |

The earlier expiring sample is the `0x1381...9950a` request with target `1788652515`.
The later sample is the `0x63c0...d5fc` request with target `1788652979`.
The earlier sample's reveal transaction is `0.0.10384424@1788652518.690688933`.
The target timestamps and public reveal timestamps are evidence of elapsed time; a demo must not claim that six minutes elapsed instantly during recording.

The second payment is independently visible on [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784%401788652616.723469092).
The public service also exposes the records at `/v1/agents/1/signals` and `/v1/activity`.

## Current paid lifecycle

The public switch points agent `1` at the receipt-backed current ledger.
Request `0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc` paid exactly `100000` tinybars from buyer `0.0.10384426` to provider `0.0.10384424` through facilitator `0.0.7162784`.
The facilitator's separate network fee was `246502` tinybars.
The request committed at `1788668348`, targeted `1788668700`, revealed at `1788668709`, and graded at `1788668786`.
The prediction was `-3` bps, the actual return was `-17` bps, and the absolute error was `14` bps.
The public API reports `direction_correct: false`, which is correct under the five-basis-point neutral band because `-3` is neutral while `-17` is negative.

| Current lifecycle receipt | Value |
| --- | --- |
| Payment | [`0.0.7162784@1788668338.206961381`](https://hashscan.io/testnet/transaction/0.0.7162784%401788668338.206961381) |
| Commitment | [`0x0f7fdd8c28fb326bf2e8fb677bc74717f86bd95add9251f109f5d4e0fd3484fd`](https://hashscan.io/testnet/transaction/0x0f7fdd8c28fb326bf2e8fb677bc74717f86bd95add9251f109f5d4e0fd3484fd) |
| HCS audit | [`0.0.10384424@1788668357.252618357`](https://hashscan.io/testnet/transaction/0.0.10384424%401788668357.252618357) |
| Reveal | [`0x75864d79367acc3038da10803a47ed83b09ea2f7ab37b3908793b9d1b49e52de`](https://hashscan.io/testnet/transaction/0x75864d79367acc3038da10803a47ed83b09ea2f7ab37b3908793b9d1b49e52de) |
| Grade | [`0xfd1becd8e2d3dc15f6fb48fef1eaa67b71e89cf6f50f6e87c4437e1cb023dba`](https://hashscan.io/testnet/transaction/0xfd1becd8e2d3dc15f6fb48fef1eaa67b71e89cf6f50f6e87c4437e1cb023dba) |
| Public API | [Signal evidence](https://valium-meant-atomic-articles.trycloudflare.com/v1/signals/0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc) |

The current Pyth issue was `250578230439 × 10^-8` at `1788668348`, and the target was `250132753669 × 10^-8` at `1788668700`.

## Contract verification

[Sourcify registry job](https://sourcify.dev/server/v2/verify/c6a3ac43-83ea-40df-967d-ee365b3c3786) and [Sourcify ledger job](https://sourcify.dev/server/v2/verify/76a986fd-7f6a-4097-b481-d4f5ca3168b4) both completed with exact runtime matches.
The verification jobs report `creationMatch: null`.
This report therefore claims exact runtime matches only and does not claim creation bytecode matches.

## Oracle blocker

The current Pyth address is `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`.
Hermes historical price fetches succeed with the configured trial key.
The official testnet contract rejects the fetched PNAU proof with `InvalidWormholeVaa`.
An independent read-only simulation reproduced the same rejection, while the old feed data was stale by roughly 13 days and the upgraded column was blank at probe time.

The read-only result is preserved in [preflight.json](evidence/preflight.json) with `oracle_compatible: false` and intentional exit status 2.
Do not change the oracle, fake a grade, or reinterpret the chain evidence to make this gate pass.
Use the official Pyth upgrade guidance at [Preparing for the Pyth price feed upgrade](https://docs.pyth.network/price-feeds/core/upgrade/preparing) and [Upgrade contracts](https://docs.pyth.network/price-feeds/core/upgrade/contracts) when the integration is revisited.
The approved, project-operated coexistence plan is [docs/oracle-upgrade-plan.md](oracle-upgrade-plan.md).
The official legacy path remains blocked, but the approved project-operated verifier and coexisting ledger are now receipt-backed.
The public configuration switch is live, and the fresh paid current-cohort lifecycle is now receipt-backed and browser-verified.

The official legacy Pyth limitation remains historical evidence for the two old records; it does not invalidate the current-ledger grade.
P1 implementation is now authorized in parallel under [docs/p1-parallel-plan.md](p1-parallel-plan.md), but P1 completion and release remain separately gated.
Payment, commitment, reveal, HCS audit, discovery, and UI evidence now include one successful current-ledger lifecycle.

## Approved self-hosted oracle boundary

The operator approved and receipt-backed a bounded P0 self-deployment built from the pinned upstream `pyth-network/pyth-crosschain` source.
The upstream source pin is a reproducibility anchor; the resulting Hedera addresses are project-operated and self-deployed, not an official Pyth Hedera deployment or a Pyth endorsement.
The Pyth stack remains capped at `80 HBAR`, and the full recovery allocation remains capped at `100 HBAR` including the coexisting SignalLedger and one measured commit-reveal-grade lifecycle.
Future stable-governance retrieval remains unverified and must be stated as such even if current price proofs pass.

The receipt-backed Pyth proxy is `0x0B38666C2A6E89EB78c53c3098001E8c904a8b63` / native `0.0.10387542`.
The receipt-backed current SignalLedger is `0x2B90651860e98e3530bC2B67Aa919922EeD39E2B` / native `0.0.10387543`.
Recorded receipt fees total `1,199,317,485` tinybars (`11.99317485 HBAR`), the alias deployer reached nonce `6`, and the governance tracker remained at latest sequence `1030`.
Runtime hashes, proxy slots, guardians, source/build identity, zero-owner and immutable reads, one authentic ETH/USD feed proof, and exact one-bit `InvalidWormholeVaa()` rejection passed.
The deployment journal is the operator-local `data/pyth-pro-deployment.json`; the current attestation artifact is [deployments/oracle-attestation.json](../deployments/oracle-attestation.json).
The public configuration now uses the receipt-backed current ledger, while the two legacy records remain immutable historical evidence on the old ledger.

The current lifecycle request is `0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc` on the new ledger and is `SUCCESS`.
The read-only public API reports verified payment, commitment at `1788668348`, target `1788668700`, reveal at `1788668709`, and grade at `1788668786`.
The exact payment is `100000` tinybars from buyer `0.0.10384426` to provider `0.0.10384424`; the separate facilitator fee is `246502` tinybars from `0.0.7162784`.
The request predicted `-3` bps and graded to actual `-17` bps, absolute error `14` bps, and `direction_correct: false`.
The five-basis-point neutral band explains the direction result: `-3` is neutral while `-17` is negative.

| Current lifecycle evidence | Receipt or public evidence |
| --- | --- |
| Public request and grade payload | [Read-only signal API](https://valium-meant-atomic-articles.trycloudflare.com/v1/signals/0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc) |
| Payment | [`0.0.7162784@1788668338.206961381`](https://hashscan.io/testnet/transaction/0.0.7162784%401788668338.206961381), exact `100000` tinybars |
| Commitment | [`0x0f7fdd8c28fb326bf2e8fb677bc74717f86bd95add9251f109f5d4e0fd3484fd`](https://hashscan.io/testnet/transaction/0x0f7fdd8c28fb326bf2e8fb677bc74717f86bd95add9251f109f5d4e0fd3484fd) |
| Reveal | [`0x75864d79367acc3038da10803a47ed83b09ea2f7ab37b3908793b9d1b49e52de`](https://hashscan.io/testnet/transaction/0x75864d79367acc3038da10803a47ed83b09ea2f7ab37b3908793b9d1b49e52de), revealed `1788668709` |
| Grade | [`0xfd1becd8e2d3dc15f6fb48fef1eaa67b71e89cf6f50f6e87c4437e1cb023dba`](https://hashscan.io/testnet/transaction/0xfd1becd8e2d3dc15f6fb48fef1eaa67b71e89cf6f50f6e87c4437e1cb023dba), graded `1788668786` |
| Pyth inputs | Issue `250578230439 × 10^-8` at `1788668348`; target `250132753669 × 10^-8` at `1788668700` |

The post-grace public metrics now report `3` eligible paid samples, `3` reveals, `100%` reveal coverage, `1` grade, `33.3%` grade coverage, `0.0%` directional hit rate, `14.0` bps mean absolute error, and `2` legacy `oracle_unavailable` records.
Controlled deployment and lifecycle fees total `13.02856993 HBAR`, comprising `11.99317485 HBAR` for deployment, `1.03439508 HBAR` for commit/HCS/reveal/grade, and `0.001 HBAR` for the paid request; the separate facilitator network fee is `0.00246502 HBAR`.

The legacy cohort is the existing SignalLedger and its two paid ETH/USD forecasts.
Both are publicly revealed, giving `reveal_pct: 100`, while both remain `oracle_unavailable` with grade coverage `0`.
They remain tied to the legacy Pyth address, must remain visible as historical evidence, and must not be copied or regraded by the current verifier.
The current cohort is the separately receipt-verified SignalLedger configured with the self-hosted verifier.
Its health state must be reported separately from `readiness.oracle.legacy`; current compatibility does not rewrite legacy history.

## P1 evidence checklist

P1 now has a partial live evidence record, but completion still requires evidence for each boundary below:

The deployed testnet resources are SMTT `0.0.10387834`, SubscriptionVault `0.0.10387915` at `0x66d98EE5b9aaB0986aA52C99de491b04a31B24F5`, SubscriptionLedger `0.0.10387917` at `0x874e8C3015cf1268f2E3B25Ffb92788DcA1F85bD`, and subscription agent `2`.
Two subscriptions used operator `0.0.10384424` as subscriber and dedicated account `0.0.10384426` as the temporary provider payee.
The registry was restored after creation: agent `2` is active and its payee is again operator `0.0.10384424`.

Subscription `0x6fe2a3191e43cd2bd796e1c340058a1c4002d5529801296be3150f1202212b94` was manually cancelled in transaction `0.0.10384424@1788672896.591233918`.
Its `12000` SMTT deposit settled entirely to the provider, and its `50000000` tinybar reserve reconciled as `2187720` spent plus `47812280` refunded.
Subscription `0x44e960aa194bb1c26b040850d00277609b28b07071b0771569c46361240de58f` was manually closed by the distinct dedicated account in transaction `0.0.10384426@1788672903.596483436`.
Its `9000` SMTT deposit settled entirely to the provider, and its `100000000` tinybar reserve reconciled as `2553164` spent plus `97446836` refunded.
Both escrows finished with zero SMTT and zero HBAR reserve, and the final operator/dedicated-account token balances were `89979000` and `10021000` atomic units.

Automatic settlement is not live-proven.
Schedule `0.0.10388269` executed at consensus timestamp `1788672699.089861120`, but its EVM block timestamp was `1788672697`, two seconds before callback argument `1788672699`.
The deployed callback returned without paying or rescheduling, and the eventual `9000` SMTT checkpoint happened during manual close.
The source now has a bounded local timestamp-skew fix, stale-schedule recovery, and regression tests, but that fix is not deployed.
The planned subscription forecast missed its commit window, so no subscription forecast commitment, reveal, HCS audit, or grade was broadcast or proven live.

- Contract/runtime tests cover cancellation at start, midpoint, and end; repeated checkpoint/claim calls; late scheduled calls; exact accrued plus refunded value; provider caps; and reserve conservation.
- HTS association and transfer failures, scheduler failure/capacity, cancelled or paused entitlement, manual exits, rollback, and cross-subscriber reserve isolation are tested.
- Subscription responses carry an explicit subscription ID and request ID, use no fabricated x402 payment reference, and remain labeled as sampled outputs separate from the legacy x402 cohort.
- The configured test token is `SignalMarketTestToken` (`SMTT`) with 6 decimals.
  It is project test credit and must not be described as Circle USDC or another production stablecoin.
- Machine-readable discovery exposes token identity, rate/deposit/paid atomic values, separate initial/current/spent HBAR reserve values, schedule state, and independent reveal/quality fields.
- Public evidence preserves the legacy two-record reveal/grade boundary and shows any current-ledger records with their verifier provenance.

## Milestones

| Milestone | Status | Evidence boundary |
| --- | --- | --- |
| M0 dependency proof | Partial | Hedera, Blocky402, Hermes fetch, deployed contracts, and public endpoints are live; the official legacy path remains blocked, while the receipt-backed current verifier, public switch, and fresh lifecycle pass. |
| M1 deterministic protocol | Partial | Canonical schema/hash, registry and ledger tests, deployed addresses, and exact runtime verification exist; creation matches are unknown. |
| M2 paid vertical slice | Live verified | Three real payments, durable delivery, commitment records, bounded initial-read verification polling, and resume recovery without a second charge are evidenced. |
| M3 reveal and audit | Current lifecycle and aggregate verified | Both legacy records remain revealed and ungraded; the current request has verified payment, commitment, reveal, HCS, and grade evidence, and post-grace metrics report one current grade. |
| M4 discovery and end-to-end proof | Current flow browser-verified | Public API/UI, canonical safe-block indexer checks, selection reasons, evidence views, current grade, and post-grace aggregate metrics are live; legacy history remains separate. |
| P1 | Partial live evidence; not complete | SMTT, the vault, the vault-bound ledger, agent `2`, and two manually finalized subscription lifecycles are receipt-backed with conservation. Automatic scheduled settlement failed on timestamp skew, the local fix is undeployed, and no subscription forecast commitment/reveal/grade is live. |

## Test and coverage boundary

The current package scripts are `npm test`, `npm run test:contracts`, `npm run typecheck`, `npm run compile`, `npm run check`, and `npm run test:coverage`.
The latest completed green `npm run check` passed 109 unit tests and 31 contract tests after a successful TypeScript typecheck.
The unit suite includes real ABI indexer replay with pagination, duplicate-event idempotence, exact native payment verification, captured-watermark enforcement, process-lock ownership, malformed remote discovery metadata, and persisted buyer recovery checks.

`npm run test:coverage` now includes every protocol and service module and enforces at least 80% statement and line coverage.
The latest coverage run reported 94.48% statement and line coverage overall, above the enforced 80% floor.
The secret-free GitHub Actions workflow runs `npm ci`, compiles contracts before artifact-dependent tests, then runs the complete check and enforced coverage gate.
The published baseline and P0 interface follow-up runs both passed.

## Browser QA boundary

The observed browser evidence is recorded in [ui-validation.md](ui-validation.md).
Manual QA confirms the public UI at a 386px viewport, rejects the invalid nine-decimal HBAR input, and preserves the rapid minimum-history policy sequence `2 → 5 → 2`.
The two legacy history rows show `Revealed` and `Oracle unavailable`; the current-ledger row shows `Revealed` with its separate graded evidence.
The current request's detail view shows prediction `-3` bps, actual `-17` bps, and absolute error `14` bps.
After more than 16 seconds of auto-refresh, closing a detail dialog restores the current action button.
Browser acceptance for this flow is cleared.

## Remaining P0 acceptance boundary

The following items remain before the specification's P0 completion claim can be made.

See the complete [AT-01 through AT-22 acceptance matrix](acceptance.md) for exact test and live-evidence boundaries.

The canonical indexer watermark is now verified by the final test run: all four safe-block log sets matched Mirror before cursor advancement, including delayed-Mirror and hidden-reveal regressions.

| P0 boundary | Current evidence | Remaining acceptance work |
| --- | --- | --- |
| Live oracle grade | The receipt-backed self-hosted verifier accepts one authentic ETH/USD feed proof and rejects a one-bit corruption with `InvalidWormholeVaa()`; the current request is graded with `14` bps absolute error. | Preserve the two legacy records as reveal-only history and keep future governance retrieval labeled unverified. |
| Required API contract | The schema response exposes encoding and public policy, singleton P0 discovery and history are bounded and paginated, history includes cohort/evidence fields, health separates liveness/readiness, and errors include safe request/retry context. | Preserve the OpenAPI and HTTP regression test with the final release evidence. |
| Seller lifecycle and mapped acceptance | Registry authorization and mutation tests exist, the AT matrix is documented, initial registration uses `npm run deploy`, and `npm run seller` provides status, dry-run, gateway/payee/metadata update, and activation/deactivation operations. Distinct owner/payee behavior is tested through `HEDERA_PAYEE_ID`. | Live adversarial lifecycle mutations remain intentionally unclaimed; use the documented owner CLI only when an exact mutation is intended, and keep the provider inactive across the two-transaction payee/metadata rotation window. |
| Discovery and buyer journey | The P0 service intentionally has one provider; policy filtering, reveal thresholds, bounded exploration, pagination, recovery, stale/quality rejection fixtures, and public no-leak behavior are covered. | A live two-provider run remains P1 scope; AT-18 remains an explicit local deterministic fixture. |

These are hard P0 boundaries from `requirements-spec.md`.
Full A2A interoperability is optional extra credit because the current Agent Card is REST discovery metadata only.
Permanent hosting, event publication, and the video are submission/package work.
The required P1 scope is documented in [docs/p1-parallel-plan.md](p1-parallel-plan.md) and may proceed in parallel, but its release claim remains separate from the P0 oracle gate.
Full A2A interaction remains optional extra credit rather than a required P1 subscription dependency.

The package pins Hiero SDK `2.85.0` with patched gRPC, protobuf, WebSocket, and cryptography overrides.
The production npm audit is reported as zero findings after the overrides, with 11 low development findings remaining.

## Remaining submission gaps

The public repository is [chayan-bit/ethonline-hackathon](https://github.com/chayan-bit/ethonline-hackathon), and both published code CI runs passed.
The hackathon event submission and video have not been created.
The public service is temporary rather than a permanent deployment.
Full A2A RPC interoperability is not implemented; the current Agent Card is REST metadata.
The 14-day Hermes trial key needs renewal or a free-access replacement, and no paid plan has been purchased.
