# Verifiable DeFi Signal Market

This repository contains a Hedera testnet-only vertical slice for buying a schema-valid ETH/USD return forecast, verifying its commitment, and publishing independent reveal and grade evidence.

Payment purchases access to a valid forecast and never purchases correctness.
Reveal is permissionless after expiry, and reveal coverage is an independent discovery metric.
Forecast quality is computed separately from payment and reveal coverage.

## Current status

The public demo currently runs at [the temporary quick tunnel](https://valium-meant-atomic-articles.trycloudflare.com).
The tunnel is temporary, runs from the operator's Mac, and exists only while the local server and tunnel process remain alive.

The live service is configured for `hedera:testnet`, with registry `0x00000000000000000000000000000000009e74b9`, ledger `0x00000000000000000000000000000000009e753c`, and HCS topic `0.0.10384701`.

Two real x402 payments of `0.001 HBAR` are indexed and publicly revealed.
The current public metrics are two eligible paid samples, two revealed samples, `reveal_pct: 100`, zero grades, and two `oracle_unavailable` samples.
The default buyer policy still rejects this provider because it requires five eligible samples.
Use `--allow-unproven` only when an operator intentionally enables a bounded exploratory purchase.

Discovery metrics use a trailing 30-day cohort by target time and a default five-minute, or 300-second, reveal reporting grace period.
The grace period delays denominator inclusion after target time but does not prohibit an earlier or later public reveal.
With no eligible history, `reveal_pct` is `null`.

Pyth historical fetches work through Hermes, but the official Hedera testnet Pyth contract currently rejects the fetched proof with `InvalidWormholeVaa`.
The preflight records this as `oracle_compatible: false` and exits with status 2 intentionally.
P0 can be evidenced through the reveal boundary but cannot be claimed complete until the grade gate passes, and P1 has not started.

See [the status report](docs/status-report.md), [the live API snapshot](docs/evidence/live-api-snapshot.json), [the UI validation](docs/ui-validation.md), and [the short demo script](docs/demo-script.md) for the evidence boundary.

## Scope and safety

This is a testnet demonstration.
It does not support mainnet deployment, automatic trading, portfolio custody, exclusive signal rights, reveal rewards, slashing, accuracy-conditioned escrow, or financial advice.

The service accepts only `hedera:testnet`, HBAR asset `0.0.0`, and the allowlisted ETH/USD Pyth feed.
The forecast distribution is explicitly non-exclusive.

Never place credentials in source, logs, HCS messages, public API responses, or screenshots.
Private keys belong only in the ignored `.env` file or the ignored `data/` state created by setup.
Keep `.env` mode `0600`, and never print or read private key contents while troubleshooting.

## Setup

Use Node.js `>=22.13.0` and the repository lockfile.
Use a Nix-managed Node runtime for a one-off session, for example `nix-shell -p nodejs_22 --run 'node --version'`.
Do not install Node, npm packages, or command-line tools globally with `npm -g`, Homebrew, or `pip --user`.

```sh
npm ci
cp .env.example .env
chmod 600 .env
npm run compile
npm run check
npm run test:coverage
```

Fill `.env` manually from the testnet operator and buyer accounts.
At minimum, set `HEDERA_NETWORK=hedera:testnet`, ECDSA testnet `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY`, ECDSA testnet `HEDERA_BUYER_ID` and `HEDERA_BUYER_KEY`, `REGISTRY_ADDRESS`, `LEDGER_ADDRESS`, `HCS_TOPIC_ID`, and `PYTH_API_KEY`.
`HEDERA_PAYEE_ID` defaults to the operator account and may be set separately when the payment recipient differs from the registry owner.
The current `.env` also names the public base URL and must match the URL stored in registry metadata.

The account setup script uses the existing funded faucet operator to create bounded operator and buyer accounts, then persists the generated keys locally before funding.
The completed setup is already present in this checkout.
Do not run `scripts/setup-accounts.ts` again unless the operator explicitly intends to create replacement accounts and has reconciled `data/account-setup.json` first.

When the temporary public URL changes, update `PUBLIC_BASE_URL`, run `npm run deploy -- --update-metadata`, and restart the server.
The deployment script updates registry metadata only when the flag is present.

## Run the service and buyer

Start the local service on `127.0.0.1:3000`:

```sh
npm start
```

Useful read-only checks are:

```sh
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/v1/agents
curl -fsS http://127.0.0.1:3000/v1/agents/1/signals
```

The buyer defaults to at least five eligible paid samples and at least 80% exact reveal coverage.
With no history, `reveal_pct` is `null` and the API reports `history_status: insufficient_history`.
The buyer does not treat no history as a zero or invent history.

The buyer commands are:

```sh
npm run buyer -- --allow-unproven       # explicit exploratory purchase; may charge 0.001 HBAR
npm run buyer -- --resume 0xREQUEST_ID  # recover the original paid response; never pays again
npm run buyer -- --kill                 # enable the persistent kill switch
npm run buyer -- --enable               # clear the kill switch
npm run buyer -- --status               # show kill-switch and budget state
```

Do not run the exploratory command during evidence review unless the operator explicitly wants another paid request.
The buyer validates the exact network, asset, amount, payee, fee payer, quote, request binding, and commitment before reporting a verified response.

The initial seller registration is performed by `npm run deploy`.
Existing registry state can be inspected and owner-only lifecycle changes can be validated without mutation:

```sh
npm run seller -- --status
npm run seller -- --active false --dry-run
```

After checking the dry-run, the operator can use exactly one of `--active true|false`, `--gateway 0.0.ACCOUNT|none`, `--payee 0.0.ACCOUNT`, or `--metadata`.
These commands submit owner-authorized registry transactions, so do not run a mutating form during evidence review unless that exact lifecycle change is intended.
Payee rotation spans separate registry transactions: deactivate sales, set the new `HEDERA_PAYEE_ID`, run the payee update and metadata update, restart the service, verify `--status`, then reactivate.
Keeping the provider inactive during that window prevents quotes while the registry payee and metadata hash are temporarily out of sync.

## Payment and evidence flow

The service implements this durable sequence:

```text
POST /v1/signals without payment
  -> 402 x402 v2 requirements and bound quote
buyer validates quote and signs one exact HBAR transfer
  -> POST /v1/signals with PAYMENT-SIGNATURE and wallet proof
service verifies payment
  -> generates and validates the forecast
  -> persists the response, salt, and commitment before settlement
  -> settles through the Blocky402 facilitator
  -> commits the hash to Signal Ledger
  -> returns the paid response
buyer recomputes the hash and polls the ledger when the first public read lags
worker submits HCS audit evidence after commitment
after target time, worker or any holder may reveal
grade is a separate permissionless operation and may remain unavailable
```

Payment, commitment, reveal, and grade are separate states.
A successful payment never authorizes a replacement payment, and an oracle outage never changes payment or reveal state.
The buyer uses bounded verification polling for initial RPC lag, and `--resume` recovers the original request without a second charge.
If a paid commitment misses its timing window, the service retains `paid_commit_failed` evidence instead of backdating or silently replacing it.

## Architecture and module map

```text
Hedera testnet
  AgentRegistry       identity, gateway, payee, metadata hash, active flag
  SignalLedger        commitment, reveal, grade status, public evidence events
  HCS topic           non-secret commitment audit receipts
  Mirror Node         transaction, event, and consensus evidence

TypeScript service
  src/server.ts       wiring, process lock, indexer and worker loop
  src/service/app.ts  HTTP routes, auth boundary, static UI
  src/service/gateway.ts  quote, x402 verification, durable purchase state
  src/service/indexer.ts  Mirror logs, payment reconciliation, projections
  src/service/worker.ts   restart-safe recovery, HCS, reveal and grade retries
  src/protocol/signal.ts  schema, timing policy, canonical commitment hash
  src/protocol/discovery.ts  exact buyer policy and provider selection
  src/protocol/metrics.ts   trailing cohort and reveal/quality metrics
  src/adapters/           Hedera, Mirror, Blocky402, Hermes, and identity adapters
  web/                     public discovery, activity, and protocol views
  data/                    ignored SQLite state with mode 0600 files
```

The provider gateway owns quote binding and delivery.
The buyer owns discovery policy, spend caps, kill switch, exact signing checks, and local commitment verification.
The worker retries evidence work but has no financial entitlement logic.
The indexer computes metrics from public evidence rather than accepting seller-supplied values.

The Agent Card is currently REST metadata for discovery.
It is not a claim of full A2A RPC interoperability.

## Public API

The minimal current endpoint contract is in [docs/openapi.yaml](docs/openapi.yaml).
The public endpoints include `/health`, the schema, the Agent Card, metadata, discovery, agent history, signal evidence, and buyer activity.
`POST /v1/auth/challenges`, `POST /v1/signals`, and `GET /v1/purchases/{request_id}` are the authenticated purchase and recovery paths.

The server limits request bodies to 128 KiB, applies a per-IP request limit, rejects unsafe payment headers, and returns machine-readable error codes.
Private purchase recovery requires a short-lived wallet proof bound to buyer, request, method, path, and body digest.

## Milestone checklist

| Milestone | Status | Evidence or remaining gate |
| --- | --- | --- |
| M0 dependency proof | Partial | Hedera, Blocky402, Hermes fetch, contracts, and public deployment are present; official Pyth proof compatibility is blocked by `InvalidWormholeVaa`. |
| M1 deterministic protocol | Partial | Registry and ledger are deployed; Sourcify reports exact runtime matches; creation matches are still null. |
| M2 paid vertical slice | Live verified | Two real `0.001 HBAR` x402 payments, durable commitment records, buyer verification, and resume recovery are evidenced. |
| M3 reveal, grade, and audit | Reveal live; grade blocked | Both samples are revealed and HCS receipts exist; oracle grading remains unavailable until the Pyth compatibility gate is resolved. |
| M4 discovery and end-to-end proof | Partial | Public UI/API, canonical safe-block indexer checks, exact reveal policy, evidence records, and temporary service are live; browser acceptance for the current flow is cleared, while grading and final P0 acceptance mapping remain. |
| P1 extensions | Not started | Subscription vault, scheduled checkpoints, second provider or horizon, and deeper A2A work remain out of scope until P0 passes. |

Run `npm run compile`, `npm run check`, `npm run test:coverage`, and `npm run preflight` before treating a checkout as a release candidate.
The preflight exit status 2 is intentional while the oracle compatibility result is false.
The latest completed green run passed 46 unit tests and 13 contract tests.
The latest coverage run reported 94.57% statement and line coverage overall, 93.78% for service modules, and 82.55% for the indexer, above the enforced 80% floor.

The exact remaining P0 acceptance boundary is mapped in [the status report](docs/status-report.md).

## Evidence and known limitations

Deployment addresses are recorded in [deployments/testnet.json](deployments/testnet.json).
Sourcify verification jobs are recorded in [docs/evidence/verification-jobs.json](docs/evidence/verification-jobs.json).
The read-only Pyth preflight is recorded in [docs/evidence/preflight.json](docs/evidence/preflight.json).
The current public API summary and two paid records are recorded in [docs/evidence/live-api-snapshot.json](docs/evidence/live-api-snapshot.json).

The public tunnel is a temporary quick tunnel from the operator machine and can disappear without notice.
The indexer can lag Mirror Node consensus, so the API exposes `indexed_through`, `lag_seconds`, and `is_stale`.
The two current paid samples share one paying wallet and are not a Sybil-resistant trust score.
Both samples are publicly revealed but have no grade because the Pyth proof is rejected by the configured testnet contract.
The current package uses SDK `2.85.0` with pinned patched transitive dependencies for gRPC, protobuf, WebSocket, and cryptography.
Production dependency audit is reported as zero findings after those overrides, while 11 low development findings remain.
The temporary Hermes trial key must be renewed within 14 days; no paid Pyth plan has been purchased.

The source is published at [chayan-bit/ethonline-hackathon](https://github.com/chayan-bit/ethonline-hackathon).
Both the [baseline CI run](https://github.com/chayan-bit/ethonline-hackathon/actions/runs/34001749831) and the [P0 interface follow-up run](https://github.com/chayan-bit/ethonline-hackathon/actions/runs/34002452903) passed.
The hackathon event submission and video have not been created.
