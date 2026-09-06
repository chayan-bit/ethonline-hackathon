# Under-five-minute demo script

Use the existing public records for the reveal and oracle states.
Do not run another paid request while reviewing evidence.
If an operator chooses to create a fresh live record, `npm run buyer -- --allow-unproven` is the explicit exploratory command and can charge `0.001 HBAR`.

The earlier expiring sample is request `0x1381ef3f939efd9b5ccf2d0a7439b36ef585b4a76a6dcda9c2b79de7f649950a` with target `1788652515`.
The later sample is request `0x63c07d42013194b7d974e4a48b058bd23c8f3da1fb615fc7dc39e25796ebd5fc` with target `1788652979`.
These timestamps are already in the public evidence and must not be presented as if the recording waited six minutes instantly.

## 0:00 to 0:30: open the service

Open [the temporary public service](https://valium-meant-atomic-articles.trycloudflare.com) and show the marketplace page.
Say that it is Hedera testnet only and that the tunnel exists only while the local server and tunnel process on the operator's Mac remain alive.

## 0:30 to 1:15: show policy-driven discovery

Open the discovery view and show the provider's three eligible paid samples, `100%` reveal coverage, one grade, and `33.3%` grade coverage.
Point out that the default buyer still rejects the provider because the minimum history is five samples.
Enable the explicit exploratory option in the UI and show the selection reason change.
Explain that `allow_unproven` is a bounded policy override, not a claim of provider history.

## 1:15 to 2:30: show the paid records

Open the activity or history view and inspect the two legacy requests plus the current-ledger request.
Show the payment and commitment transaction links for each record.
Use the second payment's [HashScan record](https://hashscan.io/testnet/transaction/0.0.7162784%401788652616.723469092) to show the successful `0.001 HBAR` transfer from the buyer to the payee and the separate facilitator network fee.
Show that the public record contains commitment and payment evidence without relying on a private key or wallet secret.

## 2:30 to 3:20: show independent reveal and grade states

Open both signal evidence dialogs.
Show that all three records are publicly revealed and that reveal coverage is `100%`.
Show that the two legacy grades are `oracle_unavailable` and the current record has actual return `-17` bps with `14` bps absolute error.
Explain that reveal remains valid when the legacy oracle is unavailable and that the current grade is tied to the new verifier and ledger.

## 3:20 to 4:05: show public API evidence

Open these read-only endpoints in a second tab:

```text
/health
/v1/agents
/v1/agents/1/signals
/v1/activity
```

Point out `indexed_through`, `is_stale`, `reveal_pct`, `history_status`, and `oracle_unavailable_count`.
Do not open or record private `.env` contents, wallet keys, signed payment payloads, or unrevealed response storage.

## 4:05 to 4:45: state the honest boundary

Say that the three payments, commitments, reveals, HCS receipts, discovery policy, current grade, and browser-verified public UI are live evidence.
Say that Pyth historical proofs still fail on the official legacy testnet contract with `InvalidWormholeVaa`, while the receipt-backed project-operated verifier accepts one authentic proof and rejects a one-bit corruption.
Show the current request `0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc` as a completed paid lifecycle with verified payment, reveal, HCS, and grade evidence.
Show the post-grace aggregate as three eligible samples, `100%` reveal coverage, one grade, `33.3%` grade coverage, `0.0%` directional hit rate, and `14.0` bps mean absolute error.
Explain that the two legacy records remain `oracle_unavailable` historical evidence and are not regraded by the current verifier.
P1 has deployed SMTT, vault, ledger, agent, and two manually finalized subscription records with conservation.
Do not present the scheduled path as working: its live callback returned early on a two-second EVM timestamp skew, the local fix is not deployed, and the subscription forecast commitment/reveal/grade path was never broadcast.
Say that the Agent Card is REST metadata and not full A2A RPC interoperability.
End with the Sourcify exact runtime matches and the remaining creation-match, oracle, final-acceptance, and permanent-hosting limitations.
