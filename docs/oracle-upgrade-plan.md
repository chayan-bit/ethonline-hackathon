# Pyth Pro compatibility recovery plan

Status: receipt-backed verifier, coexisting-ledger deployment, public switch, and one fresh paid lifecycle complete; legacy history remains separate and future governance retrieval remains unverified.
The operator has approved a project-operated self-deployment from the pinned upstream Pyth source, capped at `100 HBAR` total recovery spend.
The approval did not claim Pyth endorsement; the public switch and one measured paid lifecycle are now separately receipt-backed.

## Decision boundary

The legacy `SignalLedger` stores its Pyth address immutably through the constructor.
The two existing public samples therefore remain immutable history tied to the legacy Pyth address and remain `oracle_unavailable`.
They must not be copied to a new ledger, regraded with a different verifier, or presented as successful grades.

The compatible path is a coexisting Pyth Pro-compatible verifier plus a coexisting `SignalLedger` deployment whose constructor points to that verifier.
The existing registry, ledger, deployment evidence, payment records, reveals, and HCS receipts remain historical evidence.
The public service now routes new requests to the current ledger after the read-only replay check, while the legacy ledger remains indexed as separate history.

This plan preserves the locked financial rule: oracle availability affects grade state only.
It never releases, withholds, refunds, slashes, or transfers buyer or seller funds.

## Evidence anchors

| Evidence                  | Exact path or anchor                                                             | What it establishes                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core recovery facts       | [docs/evidence/pyth-pro-recovery.md](evidence/pyth-pro-recovery.md)              | Source pin, six-step local stack, trust configuration, authentic/corrupted proof behavior, gas estimate, and stop gates.                                                      |
| Legacy blocker            | [docs/evidence/preflight.json](evidence/preflight.json)                          | Current official testnet address, authenticated Hermes result, `InvalidWormholeVaa`, legacy receiver guardian set, and the read-only blocker.                                 |
| Local validation record   | [docs/evidence/pyth-pro-recovery.md](evidence/pyth-pro-recovery.md)              | Exact artifact names, constructor/setup calls, receiver rotation, initializer arguments, proof simulation, runtime hashes, and inspection reads used by the local validation. |
| Upstream source           | `pyth-network/pyth-crosschain` commit `859113ec53e59a3abaeeb3333ae71ef1fa09615e` | Reproducible source pin, linked from the recovery evidence.                                                                                                                   |
| Current consumer          | [contracts/SignalLedger.sol](../contracts/SignalLedger.sol)                      | Immutable Pyth constructor dependency and separate reveal/grade state that the coexistence plan must preserve.                                                                |
| Current deployment record | [deployments/testnet.json](../deployments/testnet.json)                          | Existing registry, ledger, HCS topic, and deployment transaction anchors.                                                                                                     |

The local source tree used by the validation script is `/tmp/pyth-crosschain-solcore-20260906`.
It is a local build input, not a repository artifact or a provenance claim by Pyth.
Signed guardian-rotation payloads and signer addresses stay out of logs, evidence, and this repository.

## Prepared executor

[`scripts/deploy-pyth-pro.ts`](../scripts/deploy-pyth-pro.ts) is the reviewable, resumable executor for the canonical stack and coexisting ledger.
Its default mode is read-only and prints the exact source pin, artifact hashes, guardian-set digests, transaction caps, and maintenance limitation without creating a transaction.
`npm run deploy:pyth-pro -- --verify-anchor` additionally reads the finalized Solana sequence tracker, fetches the matching standard governance VAA, and verifies that VAA through the official legacy Hedera receiver.
The last read-only verification derived latest sequence `1030` from tracker value `1031`, authenticated guardian set `7` with `13` signatures, and reproduced VAA SHA-256 `bc08560393514d0db515f87c3cd5a10416f12cc067ba927455652923f9907df4`.

Execution requires both `--execute` and the exact `--approval canonical-self-deployed-pyth-pro` argument.
It creates a distinct zero-balance ECDSA-alias deployer account, while the existing numeric operator sponsors bounded outer Hedera fees and gas without changing its key or registry authority.
Contract creation uses HIP-1086 jumbo `EthereumTransaction` envelopes with raw EIP-1559 transactions signed by that alias deployer, eliminating the paid FileCreate and FileAppend path.
The six P0 CREATE operations use alias nonces `0` through `5`, with the new SignalLedger at nonce `5`; the guardian rotation uses the numeric operator and does not consume an alias nonce.
Any later P1 deployment must query and verify the alias account's live nonce, expected to be `6` after complete P0 execution, before deriving its own addresses.
Every outer transaction is frozen and signed, fee-estimated through the live Mirror endpoint, and atomically journaled with its transaction ID, signed bytes hash, allocation, and identity fingerprints before broadcast.
A retry first queries the original receipt and replays the exact signed transaction while it is valid; any unresolved expired transaction stops the deployment so an unknown fee or alias nonce can never be omitted by replanning.
The executor stores both each receipt's native contract ID and the canonical EVM CREATE address, then verifies their Mirror mapping and the alias account's on-chain Ethereum nonce before continuing.
It verifies cumulative transaction fees, the pinned SignalLedger build information and source hash, compiler-template runtime hashes with compiler-declared immutable ranges masked, every immutable ledger getter, the Pyth implementation self reference against its canonical EVM address, both ERC-1967 implementation slots, receiver and guardian configuration, Pyth sources and replay floor, zero owner, version, valid period, update fee, and authentic-versus-corrupted price proof behavior.
It records hashes of the receiver setup calldata and Pyth initializer calldata without logging raw private keys.
It writes the candidate addresses only to its ignored recovery state and does not switch public configuration or start a paid request.
After the Pyth proxy reaches consensus, it refetches the finalized governance tracker and emits a compatible attestation only when the sequence still equals the initializer anchor and the exact custom `InvalidWormholeVaa()` error rejects the corrupted proof.
The service reports the active oracle as `compatible` only when `ORACLE_ATTESTATION_PATH` points to that reviewed attestation and every bound address and hash validates; `ORACLE_GRADING_STATUS=compatible` alone is rejected.

The approved deployment reached consensus on 2026-09-06.
The Pyth proxy is `0x0B38666C2A6E89EB78c53c3098001E8c904a8b63` / native `0.0.10387542`, and the coexisting SignalLedger is `0x2B90651860e98e3530bC2B67Aa919922EeD39E2B` / native `0.0.10387543`.
The operator receipt journal records total fees of `1,199,317,485` tinybars (`11.99317485 HBAR`), alias nonce `6`, unchanged tracker latest sequence `1030`, passing runtime/proxy/guardian/source/zero-owner/immutable checks, one authentic ETH/USD feed proof, and exact one-bit `InvalidWormholeVaa()` rejection.
See [the receipt-backed evidence](evidence/pyth-pro-recovery.md) and [the current attestation artifact](../deployments/oracle-attestation.json).
The current request `0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc` completed on the coexisting ledger with exact payment, reveal, and grade evidence.
Its prediction was `-3` bps, actual return was `-17` bps, and absolute error was `14` bps.
The public post-grace aggregate reports three eligible samples and one current grade; the two legacy samples remain `oracle_unavailable`.

## Candidate compatible stack

The validated six-transaction shape is:

1. `ReceiverSetup`.
2. `ReceiverImplementationHalf`, enforcing the Pyth Pro half-plus-one threshold.
3. `WormholeReceiver` configured for Hedera Wormhole chain ID `50048`, the upstream production router set, and the upstream receiver-governance source.
4. The upstream production guardian-set rotation, resulting in guardian-set index `1` with five members and a three-signature threshold.
5. `PythUpgradable`.
6. `ERC1967Proxy` initialized with the receiver, the single production Pro emitter on emitter chain `26`, the stable Pyth governance emitter, the stable emitter's latest verified sequence, a `60` second valid period, and update fee `0`.

This stack authenticates current Pro price proofs, but future stable-governance execution is not yet proven.
The pinned `PythUpgradable` uses one Wormhole receiver for both price and governance VAAs.
Upstream PR [#3973](https://github.com/pyth-network/pyth-crosschain/pull/3973) explicitly tests that, after a Pro cutover, a governance VAA signed by the legacy guardian set is rejected and the equivalent payload must be signed by the Pro receiver keys.
The public stable-governance VAA at sequence `1030` is signed by legacy guardian set `7` with `13` signatures, so it cannot authenticate against the candidate's Pro guardian set `1` with a three-of-five threshold.
The pinned repository exposes no official public source for stable-governance VAAs re-signed by the Pro router set, and Hermes' quorum listener accepts only chain-`26` accumulator-emitter VAAs.
This is an explicit maintenance limitation for the immutable, versioned candidate: current authenticated price proofs work, while operational future governance upgrades remain unverified and must not be claimed.

The pinned build settings are Solidity `0.8.29`, EVM target `paris`, optimizer enabled, and `200` optimizer runs.
The validated PythUpgradable runtime is `24,067` bytes, below the EIP-170 limit by `509` bytes.
The local stack used `8,554,935` gas in total.
At the observed Hedera testnet price of `1,110,000,000,000` weibars per gas, its gas component is approximately `9.50 HBAR`.
Recent Hedera receipts show an additional fixed network charge of approximately `12.38 HBAR` for each top-level contract creation.
The six-transaction stack contains five top-level contract creations and one guardian-rotation call.
Five creations therefore bring the current Pyth-stack estimate to approximately `71.9 HBAR`; the proposed Pyth-stack hard cap is `80 HBAR`.
A new SignalLedger was estimated at approximately `15.1 HBAR`, and commit plus reveal were estimated at approximately `0.72 HBAR` at the observed gas price; the measured current lifecycle is recorded in [the receipt-backed evidence](evidence/pyth-pro-recovery.md).
The configured x402 sample price is `0.001 HBAR`.
Use a `100 HBAR` total recovery cap for the Pyth stack, one new SignalLedger, and one commit-reveal-grade lifecycle.
Recompute the estimate immediately before any broadcast.
The observed operator balance is `159.29 HBAR` in free Hedera testnet HBAR; this is testnet-only context, not mainnet funds or an approval to spend it.

The current legacy anchors are Pyth proxy `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`, implementation `0x35a58beee77a2ad547fcded7e8cb1c6e19746b13`, and receiver `0xb27e5ca259702f209a29225d0eDdC131039C9933`.
Candidate EVM addresses are deterministically derived from the dedicated alias deployer and its CREATE nonces, then accepted only after the receipt's native contract ID maps back to that exact EVM address.

The compiled runtime hashes are:

- ReceiverSetup: `0xe86e3296c090557bd046e9e43846238894e412f63bf91788e01181b529d7938f`.
- ReceiverImplementationHalf: `0x672c872ab76094a205608519efb1f34a50662ced3410fdcfd45965bf41f6bef1`.
- WormholeReceiver: `0xdc3e90fa531e085a7df6e3fce1322f2ae67b47716d606097959e5d80afa764c6`.
- PythUpgradable: `0x7190f97e629ac8b731b8475c7819d77423b53215deaca6ed07fb89e414da135a`.
- ERC1967Proxy: `0x7e693eea60500e1d5c5984a4cc54ec0b371d9ad29e8bb09c543cb7be447963df`.

The ordered guardian-set digests are `0xc2f3213b1e9476bc75f697c08b0567c08b1ded0c8167baaba9be0410aeb67294` for production set 0 and `0x0a807d95db2b67804c532c618f9c002ab25b032b4b63fb07928f3928b8f8193b` for rotated production set 1.

These digests must be matched against the upstream public anchors, and no project or operator key may appear in either set.

The local validation observed Pyth version `1.4.6`, zero proxy owner, receiver chain ID `50048`, guardian-set index `1`, five guardian members, the production Pro emitter, and the stable governance emitter.
The authentic 5 September historical ETH/USD update passed `parsePriceFeedUpdatesUnique` and returned exactly one requested feed.
A copy with one signature byte changed was rejected.
The same authentic proof fails against the current official Hedera receiver because its legacy guardian set has expired.

These reads do not establish a functioning future governance path.
The governance emitter stored in Pyth state is checked only after the configured Wormhole receiver authenticates the VAA signatures, and the candidate Pro receiver rejects the currently available legacy-signed governance VAA.

These facts establish a candidate project-operated verifier, not an official Pyth Hedera deployment.
The resulting address would not be present in Pyth's official Hedera registry and must be labeled self-deployed and source-verified.

## Trust and release gates

Before any testnet broadcast, the operator and reviewer must approve all of the following:

- the exact upstream commit, compiler settings, optimizer settings, artifact bytecode, and runtime hashes;
- every six transaction receipt, cumulative gas, and cap calculation;
- receiver chain ID `50048`, guardian-set index `1`, five-member production router set, and half-plus-one verification behavior;
- the single production Pro emitter on chain `26`, stable governance emitter, freshly verified high-water governance sequence, valid period `60`, and update fee `0`;
- explicit acceptance that operational future governance upgrades remain unverified until an official Pro-signed stable-governance VAA retrieval path is available;
- proxy owner equal to the zero address after initialization and no deployer upgrade path;
- authentic historical ETH/USD proof acceptance and one-bit mutation rejection on the deployed candidate;
- the new ledger constructor pointing to the candidate verifier;
- a read-only grade simulation on the new ledger before any new request or payment;
- a replay showing the two existing legacy samples remain unchanged and ungraded;
- an explicit decision for indexing old and new ledgers without mixing their verifier provenance.

Sequence `0` is rejected for the candidate because it would permit replay of already-published signed governance messages even though it matches the generic upstream script and legacy Hedera watermark.
The canonical Solana Wormhole sequence-tracker account stores the next sequence to publish.
It decoded to `1031` at `2026-09-06T01:51:01Z`, so the latest published sequence was `1030`; Wormholescan independently exposed VAA `1030`.
The deployer must refetch the tracker immediately before encoding the initializer and use `tracker - 1` as the high-water mark.
Every later governance message remains signature checked and target-chain scoped.

The high-water mark prevents replay but does not solve the guardian-set mismatch.
Until the official Pro-signed governance relay is proven, the candidate must be described as price-proof compatible with future governance unavailable, rather than governance preserving.

These were the pre-broadcast stop gates; the recorded deployment passed them.
Any future replacement must stop if a receipt fails, a runtime hash differs, either proxy implementation slot differs from the receipt-verified implementation, guardian configuration is not index `1` with the expected ordered digest, the proxy owner is nonzero, the initialized governance sequence is below the immediately preceding stable-emitter high-water mark, the Pyth stack estimate exceeds `80 HBAR`, the total recovery estimate exceeds `100 HBAR`, or the authentic proof fails.
Capture and retain the receiver setup calldata hash and Pyth initializer calldata hash after receipt-derived addresses are known.
Do not replace a failed proof with a fabricated proof, a mocked grade, or a silent legacy-history rewrite.

## Future rollout sequence

Steps 1 through 8 below are now receipt-backed for the measured current lifecycle; future official governance retrieval remains pending:

1. **Complete.** Reproduce the local validation from the pinned source and preserve the exact output outside secrets and signed payloads.
2. **Complete.** Deploy the six candidate verifier transactions to Hedera testnet under the `80 HBAR` Pyth-stack cap.
3. **Complete.** Inspect runtime hashes and all on-chain trust/configuration reads.
4. **Complete.** Run authentic and corrupted ETH/USD proof simulations against the candidate verifier.
5. **Complete.** Deploy a coexisting `SignalLedger` configured with the candidate verifier, preserving the current registry and old ledger as historical records.
6. **Complete.** Run read-only commit/reveal/grade simulations on the new ledger without charging a buyer or publishing a new paid sample.
7. **Complete.** Extend indexer configuration and evidence projections after proving that legacy samples remain tied to the legacy verifier and the current request is tied to the candidate verifier.
8. **Complete for this lifecycle.** Switch the public service and authorize the measured paid lifecycle only after the attestation and current-ledger checks passed; preserve the full recovery below `100 HBAR`.
9. Verify any future official Pro-signed stable-governance retrieval path before claiming or attempting an operational governance upgrade.

The existing two samples remain visible as historical `oracle_unavailable` records throughout this sequence.
No historical grade is retroactively filled by the new verifier.

## Ownership and non-goals

The P0 core owner controls `src/adapters/pyth.ts`, `scripts/preflight.ts`, the legacy evidence, shared ledger/indexer/worker changes, and any future consumer switch.
This plan does not edit those files.

The potential new ledger and verifier are coexisting infrastructure, not an upgrade of the official Pyth testnet address.
The plan does not claim Pyth endorsement, official registry inclusion, mainnet readiness, security audit completion, or a permissionless bridge for old samples.
It does not authorize additional paid requests or production publishing beyond the recorded measured lifecycle without a separate release decision.
