# ETHOnline demo recording plan — 3:30

This version uses existing public evidence. It does **not** create another paid request, wait for a forecast to expire, or expose secrets.

## Before recording

1. Start the service with `npm start` and confirm the public tunnel loads.
2. In the UI, set **Minimum samples** to `3`, **Minimum reveal** to `100`, and **Maximum price** to `0.001`. If the indexer is fresh, the provider is selected; if it is stale, keep the rejection visible and use the fail-closed line below.
3. Open these tabs in advance: marketplace, the current signal detail, and its grade transaction on HashScan.
4. Close notifications and any tabs that show personal data. Never open `.env`, wallet keys, signed payloads, or `data/`.
5. Record at 1080p or higher in a quiet room. Use your own voice; ETHGlobal rejects AI voiceovers, sped-up video, videos under 720p, and videos outside 2–4 minutes.

macOS: press `Shift–Command–5`, choose **Record Entire Screen**, select your microphone under **Options**, then record. Trim dead time in QuickTime without changing playback speed.

## Shot-by-shot script

### 0:00–0:20 — Hook

**Show:** Marketplace hero and live metrics.

**Say:**

> AI agents can buy a market prediction in milliseconds, but how do they know it existed before the outcome—or that the seller did not hide the bad calls? Signal Market is a pay-per-forecast marketplace where every payment, commitment, reveal, and grade is independently inspectable on Hedera.

### 0:20–0:55 — Product and buyer policy

**Show:** The four metrics, then apply the prepared policy: 100% reveal, 3 samples, 0.001 HBAR.

**Say:**

> The buyer—not the seller—sets the trust policy. This provider has three real paid forecasts, all three publicly revealed, and one oracle-backed grade. Payment buys access to a schema-valid forecast; it never buys correctness, and no score controls the seller's payment.

If the UI reports stale metrics, add: **“The current Mirror snapshot is stale, so the buyer refuses to select even though the historical evidence remains inspectable. That is deliberate fail-closed behavior.”** Otherwise add: **“The current evidence is fresh, so this policy selects the provider.”**

### 0:55–1:30 — Hedera payment flow

**Show:** Inspect provider, then Network Activity. Open one payment link in HashScan.

**Say:**

> The service returns an x402 quote bound to the request. The agent verifies the Hedera network, HBAR asset, exact amount, payee, facilitator, and spending limit before signing. Blocky402 settles 0.001 HBAR. The service durably stores the response, commits its hash to SignalLedger, and returns the forecast and salt so the buyer can recompute it locally.

### 1:30–2:15 — Inspect a complete signal

**Show:** Return to Discover, open the current graded row, and scroll through payment, commitment, prediction, actual return, and grade. Open the commitment or grade transaction.

**Say:**

> This is a completed live request. It predicted minus 3 basis points. After expiry, the payload was revealed and an authenticated Pyth price recorded an actual return of minus 17 basis points—an absolute error of 14. These are separate on-chain states: an oracle failure can leave a forecast ungraded, but it cannot erase a valid payment or reveal.

### 2:15–2:45 — Honest history

**Show:** The three history rows and the oracle notice.

**Say:**

> The two earlier records are still revealed, but remain visibly marked oracle unavailable because their legacy Pyth contract rejected the upgraded proof format. We do not rewrite history or turn missing data into zero. The current ledger uses a receipt-verified, project-operated verifier built from pinned Pyth source.

### 2:45–3:15 — Why Hedera / protocol view

**Show:** The Protocol tab; briefly move through the four stages.

**Say:**

> Hedera is the trust layer, not decoration: HBAR settles the x402 payment, AgentRegistry publishes identity and metadata, SignalLedger anchors commitments and evidence, HCS carries audit receipts, and Mirror Node lets the indexer reconstruct public metrics. HCS-14 metadata also makes the service discoverable to other agents.

### 3:15–3:30 — Close

**Show:** Return to the hero and live metrics.

**Say:**

> Signal Market lets models stay private while their behavior becomes accountable. Forecasts stay private. Evidence does not.

## Upload checklist

- Duration is between 2:00 and 4:00; target 3:20–3:40.
- Resolution is 1080p or higher; normal playback speed.
- Voice is clear, with no music-only section or synthetic narration.
- The live paid request, Hedera transaction, and working UI are visible.
- No keys, account secrets, or unrevealed payloads appear in any frame.
- Title: `Signal Market — Proof before trust for agent-bought forecasts`.
- Description links the public GitHub repository and states `Built for ETHOnline 2026 · Hedera AI & Agentic Payments`.
