# Hedera Pyth Pro recovery gate

## Decision boundary

The legacy SignalLedger and its two revealed samples remain immutable history tied to the legacy Hedera Pyth address.

They cannot be graded with post-upgrade Hermes proofs because the configured Pyth contract rejects those proofs before the price window is evaluated.

The recovery path may use a new coexisting ledger that receives a newly deployed Pyth Pro-compatible contract address through its constructor.

The receipt-backed candidate now proves current price-proof compatibility.
Its future stable-governance path is unverified because the pinned Pyth implementation uses the same Wormhole receiver for prices and governance, while the currently available stable-governance VAA is signed by the legacy guardian set and the candidate receiver trusts the Pro set.

The operator has approved the bounded self-deployment decision, subject to the trust configuration, future-governance maintenance limitation, and the 80 HBAR Pyth-stack budget.
The verifier and coexisting ledger are now receipt-backed on Hedera testnet.
This does not claim an official Pyth deployment or endorsement.
The public configuration switch and one paid current-cohort lifecycle are complete, while future-governance retrieval remains unverified and the two legacy records remain ungraded.

## Source pin

Build from official `pyth-network/pyth-crosschain` commit [`859113ec53e59a3abaeeb3333ae71ef1fa09615e`](https://github.com/pyth-network/pyth-crosschain/commit/859113ec53e59a3abaeeb3333ae71ef1fa09615e), fetched on 2026-09-06.

Use Solidity 0.8.29, EVM target `paris`, optimizer enabled, and 200 optimizer runs, exactly as pinned by the upstream Foundry configuration.

The compiled PythUpgradable runtime is 24,067 bytes, which is 509 bytes below the EIP-170 limit.

The compiled runtime hashes are `0xe86e3296c090557bd046e9e43846238894e412f63bf91788e01181b529d7938f` for ReceiverSetup, `0x672c872ab76094a205608519efb1f34a50662ced3410fdcfd45965bf41f6bef1` for ReceiverImplementationHalf, `0xdc3e90fa531e085a7df6e3fce1322f2ae67b47716d606097959e5d80afa764c6` for WormholeReceiver, `0x7190f97e629ac8b731b8475c7819d77423b53215deaca6ed07fb89e414da135a` for PythUpgradable, and `0x7e693eea60500e1d5c5984a4cc54ec0b371d9ad29e8bb09c543cb7be447963df` for ERC1967Proxy.

## Canonical deployment sequence

1. Deploy `ReceiverSetup`.
2. Deploy `ReceiverImplementationHalf`, which enforces the Pyth Pro half-plus-one threshold.
3. Deploy `WormholeReceiver` with Hedera Wormhole chain ID 50048, the upstream production router set, and the upstream receiver-governance source.
4. Submit the upstream production guardian-set rotation from `ProCompatibleProductionGuardianSetVaas.json` and verify guardian-set index 1 with five members.
5. Deploy `PythUpgradable`.
6. Deploy an `ERC1967Proxy` initialized with the receiver, the single production Pro emitter, the stable Pyth governance source, the stable emitter's latest verified sequence, a 60-second valid period, and zero update fee.

The upstream generic deployment script and the current official Hedera Pyth contract both use sequence 0, but that value is unsafe for a new deployment because it permits replay of already-published signed governance messages.

The canonical Solana sequence-tracker account decoded to `1031` at 2026-09-06T01:51:01Z and stores the next sequence to publish, so the latest published stable-governance sequence was `1030`.
Wormholescan independently exposed VAA `1030`.

The deployment must refetch the tracker immediately before encoding the initializer and use `tracker - 1`, which rejects all prior signed messages.
This replay protection does not preserve future governance by itself.

The production rotation file used in validation has SHA-256 `a1738888354baa38eba722860ce822d7c572176236a1a264d2f7debc568bf5ae`.

The ordered production guardian-set digests are `0xc2f3213b1e9476bc75f697c08b0567c08b1ded0c8167baaba9be0410aeb67294` for set 0 and `0x0a807d95db2b67804c532c618f9c002ab25b032b4b63fb07928f3928b8f8193b` for rotated set 1, using `keccak256` over the five concatenated 20-byte addresses in order.

The signed rotation and signer addresses must stay out of logs and repository evidence.

## Trust properties

The receiver accepts three signatures from the current five-member Pyth production router set.

The Pyth proxy accepts price roots only from the single production Pro emitter on emitter chain 26.

Receiver rotations remain controlled by the upstream signed receiver-governance lineage.

Pyth state names the stable Pyth governance emitter, but the candidate has no currently evidenced path for authenticating that emitter's future VAAs.

Upstream PR [#3973](https://github.com/pyth-network/pyth-crosschain/pull/3973) makes this transition explicit: after a Pro cutover, a legacy-guardian-signed governance VAA is rejected and the same payload must be signed by the Pro receiver keys.
The public sequence-`1030` governance VAA uses legacy guardian set `7` with `13` signatures, while the candidate trusts Pro guardian set `1` with a three-of-five threshold.
The pinned repository provides no public retrieval path for the required Pro-signed stable-governance VAA, and Hermes' quorum ingestion rejects non-Pythnet, non-accumulator sources.

The Pyth proxy owner is the zero address after initialization, so the deployer has no owner upgrade path.

The deployed address will be project-operated and is not an address endorsed in Pyth's official Hedera registry.

Every consumer must therefore verify the source commit, runtime hashes, proxy implementations, and on-chain configuration rather than relying on an official-address designation.

## Local validation

The six-step stack was deployed to a clean Anvil chain from the pinned upstream artifacts.

The resulting Pyth contract reported version 1.4.6, zero owner, Hedera receiver chain ID 50048, guardian-set index 1 with five members, the production Pro emitter, and the stable governance emitter.

An authenticated Hermes historical update at Unix time 1788652441 passed `parsePriceFeedUpdatesUnique` for ETH/USD and returned exactly one feed with the requested ID.

A copy with one signature byte changed was rejected.

The same authentic update fails against the current official Hedera receiver with `guardian set has expired`.

## Receipt-backed Hedera deployment

The bounded deployment reached consensus on 2026-09-06.
The Pyth proxy is EVM address `0x0B38666C2A6E89EB78c53c3098001E8c904a8b63` and native contract `0.0.10387542`.
The coexisting SignalLedger is EVM address `0x2B90651860e98e3530bC2B67Aa919922EeD39E2B` and native contract `0.0.10387543`.
The alias deployer reached nonce `6` after the six Ethereum transactions, and the governance tracker remained at next sequence `1031` / latest published sequence `1030`.

The recorded receipt fees sum to `1,199,317,485` tinybars, or `11.99317485 HBAR`.
The public transaction IDs and native entities are:

| Step | Transaction | Native entity | Receipt fee |
| --- | --- | --- | ---: |
| Alias deployer | `0.0.10384424@1788667622.425037789` | `0.0.10387477` | `61,625,685` tinybars |
| ReceiverSetup | `0.0.10384424@1788667626.710777000` | `0.0.10387479` | `29,798,055` tinybars |
| ReceiverImplementationHalf | `0.0.10384424@1788667682.498165678` | `0.0.10387492` | `212,327,115` tinybars |
| WormholeReceiver | `0.0.10384424@1788667962.757290461` | `0.0.10387538` | `34,362,930` tinybars |
| Guardian rotation | `0.0.10384424@1788667969.516671461` | `0.0.10387538` | `30,038,925` tinybars |
| PythUpgradable | `0.0.10384424@1788667969.426493189` | `0.0.10387540` | `554,426,355` tinybars |
| ERC1967Proxy | `0.0.10384424@1788667979.888443868` | `0.0.10387542` | `39,406,815` tinybars |
| SignalLedger | `0.0.10384424@1788667985.228083231` | `0.0.10387543` | `237,331,605` tinybars |

Receipt inspection passed the pinned source and manifest checks, runtime hashes, ERC-1967 proxy implementation slots, guardian-set index and members, receiver configuration, zero-owner checks, immutable consumer addresses, and the source/build identity checks.
An authentic ETH/USD historical proof for one feed passed, and a one-bit corrupted proof was rejected with the exact `InvalidWormholeVaa()` error.
The receipt journal is the operator-local `data/pyth-pro-deployment.json`; it contains the public receipt and hash fields used for this record and must not be replaced with key-bearing material.
The current attestation artifact is [deployments/oracle-attestation.json](../../deployments/oracle-attestation.json).

The two legacy forecasts remain on the old ledger, publicly revealed, and `oracle_unavailable` with grade coverage `0`.
The public switch is live on the new ledger, and request `0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc` completed a fresh paid current-cohort lifecycle.
The read-only public API reports payment verified, commitment at `1788668348`, target `1788668700`, reveal at `1788668709`, and grade at `1788668786`.
The payment is exactly `100000` tinybars from buyer `0.0.10384426` to provider `0.0.10384424`; the facilitator paid a separate `246502` tinybar network fee.
The grade reports prediction `-3` bps, actual `-17` bps, `14` bps absolute error, and `direction_correct: false`.
The false direction result is correct under the five-basis-point neutral band because `-3` is neutral while `-17` is negative.

| Current lifecycle evidence | Receipt or public evidence |
| --- | --- |
| Public request and grade payload | [Read-only signal API](https://valium-meant-atomic-articles.trycloudflare.com/v1/signals/0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc) |
| Payment | [`0.0.7162784@1788668338.206961381`](https://hashscan.io/testnet/transaction/0.0.7162784%401788668338.206961381), exact `100000` tinybars |
| Commitment | [`0x0f7fdd8c28fb326bf2e8fb677bc74717f86bd95add9251f109f5d4e0fd3484fd`](https://hashscan.io/testnet/transaction/0x0f7fdd8c28fb326bf2e8fb677bc74717f86bd95add9251f109f5d4e0fd3484fd) |
| HCS audit | [`0.0.10384424@1788668357.252618357`](https://hashscan.io/testnet/transaction/0.0.10384424%401788668357.252618357) |
| Reveal | [`0x75864d79367acc3038da10803a47ed83b09ea2f7ab37b3908793b9d1b49e52de`](https://hashscan.io/testnet/transaction/0x75864d79367acc3038da10803a47ed83b09ea2f7ab37b3908793b9d1b49e52de), revealed `1788668709` |
| Grade | [`0xfd1becd8e2d3dc15f6fb48fef1eaa67b71e89cf6f50f6e87c4437e1cb023dba`](https://hashscan.io/testnet/transaction/0xfd1becd8e2d3dc15f6fb48fef1eaa67b71e89cf6f50f6e87c4437e1cb023dba), graded `1788668786` |
| Pyth inputs | Issue `250578230439 × 10^-8` at `1788668348`; target `250132753669 × 10^-8` at `1788668700` |

The public API now reports this request as `cohort_membership: eligible` and the post-grace metrics report `3` eligible paid samples, `3` reveals, `100%` reveal coverage, `1` grade, `33.3%` grade coverage, `0.0%` directional hit rate, `14.0` bps mean absolute error, and `2` legacy `oracle_unavailable` records.
Controlled deployment and lifecycle fees total `13.02856993 HBAR`, comprising `11.99317485 HBAR` for deployment, `1.03439508 HBAR` for commit/HCS/reveal/grade, and `0.001 HBAR` for the paid request.
The separate facilitator network fee was `0.00246502 HBAR` and is not included in that controlled total.
The authoritative source paths are the operator-local receipt journal [data/pyth-pro-deployment.json](../../data/pyth-pro-deployment.json), the attestation artifact [deployments/oracle-attestation.json](../../deployments/oracle-attestation.json), the cohort registry [deployments/testnet.json](../../deployments/testnet.json), and the legacy blocker [preflight.json](preflight.json).

## Cost and stop gates

The canonical executor uses HIP-1086 jumbo `EthereumTransaction` envelopes for each CREATE rather than Hedera File Service uploads.

Hedera testnet reported services version `0.76.3`, above the required `0.76.1` jumbo implementation.

The live Mirror `FeeEstimateQuery` accepted the signed 24,497-byte raw EIP-1559 deployment for the largest contract.

A distinct zero-balance ECDSA-alias account supplies the Ethereum sender and CREATE nonce, while the existing numeric operator pays bounded outer transaction fees and gas allowances.

The journal binds both identities, the old registry address, each canonical CREATE address, and each receipt's native contract ID.

The verifier CREATEs consume alias nonces `0` through `4`, and the new SignalLedger consumes alias nonce `5`.

The guardian rotation is a native contract execution by the existing numeric operator and does not consume an alias nonce.

The bounded P0 allocations total `79 HBAR` through the Pyth proxy and `95.8 HBAR` through the new SignalLedger, while actual receipt fees remain the authoritative cumulative spend under the `100 HBAR` cap.

The local deployment consumed 8,554,935 gas across the six transactions.

At the Hedera testnet gas price observed on 2026-09-06 of 1,110,000,000,000 weibars per gas, the gas component is approximately 9.50 HBAR.

The pre-broadcast budgets conservatively reserve the observed contract-creation cost and gas while avoiding the unbudgeted FileCreate and FileAppend fees.

Use an 80 HBAR hard cap for the Pyth stack and recompute the exchange rate, gas price, and transaction fees immediately before broadcast.

A new SignalLedger consumed 2,378,199 gas locally and a comparable live deployment previously cost 14.88 HBAR including Hedera's creation fee.

At the current gas price, commit and reveal add approximately 0.72 HBAR, the configured x402 payment is 0.001 HBAR, and grade must receive its own measured bound after the final ledger build.

Use a 100 HBAR total recovery cap covering the Pyth stack, one new SignalLedger, and one paid commit-reveal-grade lifecycle.

These were the pre-broadcast stop gates; the recorded deployment passed them.
Any future deployment or replacement must stop if a receipt fails, the cumulative estimate exceeds the cap, a runtime hash differs, either proxy implementation slot differs from the receipt-verified implementation, the receiver is not set 1 with the expected ordered digest, the Pyth owner is nonzero, the initialized governance sequence is below the immediately preceding stable-emitter high-water mark, or an authentic historical proof fails.

Capture the receiver setup calldata hash and Pyth initializer calldata hash once receipt-derived addresses are known.

Only after both ledgers pass read-only grade simulation should a new paid lifecycle be authorized.

The old two samples remain `oracle_unavailable` and must not be copied, regraded, or presented as successful evidence on the new ledger.
