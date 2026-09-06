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
| Signal Ledger | `0x00000000000000000000000000000000009e753c` |
| HCS topic | `0.0.10384701` |
| Agent | `1`, `ETH Momentum` |
| Schema | `defi.return_forecast.v1` |
| Feed | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| Price | `100000` tinybars, or `0.001 HBAR` |
| Public base URL | `https://valium-meant-atomic-articles.trycloudflare.com` |

The public `/health` response reported `live: true`, configured contracts and oracle API, an enabled worker, and a non-stale indexer with 10 seconds of lag at capture.
The public `/v1/agents` response reported two verified paid samples, two reveals, `reveal_pct: 100`, zero grades, and two `oracle_unavailable` samples.
The default selection result was `no_eligible_provider` with `insufficient_history` because the default minimum is five eligible samples.

The raw public summary is [live-api-snapshot.json](evidence/live-api-snapshot.json).
It intentionally omits salts, forecast payloads, signatures, private keys, and full HCS message bodies.

## Two real paid records

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

Because Pyth compatibility is a P0 gate, P0 cannot be claimed complete and P1 is not started.
Payment, commitment, reveal, HCS audit, discovery, and UI evidence remain valid independent of this grade blocker.

## Milestones

| Milestone | Status | Evidence boundary |
| --- | --- | --- |
| M0 dependency proof | Partial | Hedera, Blocky402, Hermes fetch, deployed contracts, and public endpoints are live; Pyth contract compatibility remains blocked. |
| M1 deterministic protocol | Partial | Canonical schema/hash, registry and ledger tests, deployed addresses, and exact runtime verification exist; creation matches are unknown. |
| M2 paid vertical slice | Live verified | Two real payments, durable delivery, commitment records, bounded initial-read verification polling, and resume recovery without a second charge are evidenced. |
| M3 reveal and audit | Reveal and HCS verified; grade blocked | Both records were revealed and HCS receipts were submitted; Pyth grading is unavailable. |
| M4 discovery and end-to-end proof | Partial | Public API/UI, canonical safe-block indexer checks, selection reasons, and evidence views are live; browser acceptance for the current flow is cleared, while grading and final P0 acceptance mapping remain. |
| P1 | Not started | Subscription vault, scheduled checkpoints, second provider or horizon, and deeper A2A remain deferred. |

## Test and coverage boundary

The current package scripts are `npm test`, `npm run test:contracts`, `npm run typecheck`, `npm run compile`, `npm run check`, and `npm run test:coverage`.
The latest completed green `npm run check` passed 43 unit tests and 13 contract tests after a successful TypeScript typecheck.
The unit suite includes real ABI indexer replay with pagination, duplicate-event idempotence, exact native payment verification, captured-watermark enforcement, process-lock ownership, malformed remote discovery metadata, and persisted buyer recovery checks.

`npm run test:coverage` now includes every protocol and service module and enforces at least 80% statement and line coverage.
The latest coverage run reported 93.27% statement and line coverage overall, 92.07% for service modules, and 82.55% for the indexer, above the enforced 80% floor.
The proposed secret-free GitHub Actions workflow runs `npm ci`, compiles contracts before artifact-dependent tests, then runs the complete check and enforced coverage gate.

## Browser QA boundary

The observed browser evidence is recorded in [ui-validation.md](ui-validation.md).
Manual QA confirms the public UI at a 386px viewport, rejects the invalid nine-decimal HBAR input, and preserves the rapid minimum-history policy sequence `2 → 5 → 2`.
Both history rows show `Revealed` and `Oracle unavailable`; both detail dialogs show `State: Revealed` and `Grade: Oracle unavailable`.
After more than 16 seconds of auto-refresh, closing a detail dialog restores the current action button.
Browser acceptance for this flow is cleared.

## Remaining P0 acceptance boundary

The following items remain before the specification's P0 completion claim can be made.

See the complete [AT-01 through AT-22 acceptance matrix](acceptance.md) for exact test and live-evidence boundaries.

The canonical indexer watermark is now verified by the final test run: all four safe-block log sets matched Mirror before cursor advancement, including delayed-Mirror and hidden-reveal regressions.

| P0 boundary | Current evidence | Remaining acceptance work |
| --- | --- | --- |
| Live oracle grade | Hermes fetches succeed, but the configured Hedera testnet Pyth contract rejects the proof with `InvalidWormholeVaa`. | Resolve the supported Pyth proof path and demonstrate one valid later grade after a reveal survived oracle unavailability. |
| Required API contract | Public routes, OpenAPI, buyer recovery, and metrics are present. | Reconcile the final API against the spec's encoder/version and policy constants in the schema response, paginated discovery, explicit cohort/evidence links in history, separate liveness/readiness health, and request-scoped retry guidance in errors. |
| Seller lifecycle and mapped acceptance | Registry authorization and mutation tests exist. | Provide end-to-end evidence or a documented operator CLI for register, delegate, update, and deactivate, then map AT-01 through AT-22 to runnable tests, live evidence, or observed UI behavior. |
| Discovery and buyer journey | Single-provider policy filtering, reveal thresholds, bounded exploration, and current browser flow are evidenced. | Complete the final acceptance run for stale metrics, multi-provider selection reasons, pagination, recovery, and public no-leak behavior after the canonical indexer changes. |

These are hard P0 boundaries from `requirements-spec.md`.
Full A2A interoperability remains a deferred P1 or extra-credit capability because the current Agent Card is REST discovery metadata only.
Permanent hosting, public repository creation, event publication, and the video are submission/package work.
Subscription vault, scheduled checkpoints, and related financial automation are P1 and remain gated on P0.

The package pins Hiero SDK `2.85.0` with patched gRPC, protobuf, WebSocket, and cryptography overrides.
The production npm audit is reported as zero findings after the overrides, with 11 low development findings remaining.

## Remaining submission gaps

The public repository has not been created.
The hackathon event submission and video have not been created.
The public service is temporary rather than a permanent deployment.
Full A2A RPC interoperability is not implemented; the current Agent Card is REST metadata.
The 14-day Hermes trial key needs renewal or a free-access replacement, and no paid plan has been purchased.
