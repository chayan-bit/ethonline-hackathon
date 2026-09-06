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

Open the discovery view and show the provider's two eligible paid samples and `100%` reveal coverage.
Point out that the default buyer still rejects the provider because the minimum history is five samples.
Enable the explicit exploratory option in the UI and show the selection reason change.
Explain that `allow_unproven` is a bounded policy override, not a claim of provider history.

## 1:15 to 2:30: show the paid records

Open the activity or history view and inspect the two existing requests.
Show the payment and commitment transaction links for each record.
Use the second payment's [HashScan record](https://hashscan.io/testnet/transaction/0.0.7162784%401788652616.723469092) to show the successful `0.001 HBAR` transfer from the buyer to the payee and the separate facilitator network fee.
Show that the public record contains commitment and payment evidence without relying on a private key or wallet secret.

## 2:30 to 3:20: show independent reveal and grade states

Open both signal evidence dialogs.
Show that each record is publicly revealed and that reveal coverage is `100%`.
Show that both grades are `oracle_unavailable` and that grade coverage is `0%`.
Explain that reveal remains valid when the oracle is unavailable and that the grade operation is separate and retryable.

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

Say that the two payments, commitments, reveals, HCS receipts, discovery policy, and current browser-verified public UI are live evidence.
Say that Pyth historical proofs currently fail on the official testnet contract with `InvalidWormholeVaa`, so P0 grading is blocked and P1 has not started.
Say that the Agent Card is REST metadata and not full A2A RPC interoperability.
End with the Sourcify exact runtime matches and the remaining creation-match, oracle, final-acceptance, and permanent-hosting limitations.
