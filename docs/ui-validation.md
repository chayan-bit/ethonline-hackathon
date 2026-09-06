# Public UI validation

Validation date: 6 September 2026.
Target: [temporary public quick tunnel](https://valium-meant-atomic-articles.trycloudflare.com).

The current public flow passed a fresh browser check after the canonical indexer restart.
The page reported fresh evidence, three eligible paid samples, three revealed samples, `100%` reveal coverage, one grade, `33.3%` grade coverage, and the expected default rejection at a five-sample minimum.
The final browser policy check used minimum reveal `100%`, minimum samples `3`, and maximum price `0.001 HBAR`; it selected ETH Momentum despite `33.3%` grade coverage and `0.0%` directional hit rate.
The selected current request was `0x10d7ceb8b712edbe1738d0405e3b9b448610642353af3b4e672ca11b4a5158dc`.

At the measured 386px mobile viewport, the document width matched the viewport and only the evidence table used horizontal scrolling.
The latest browser runtime did not honor requested 739px or 1280px viewport overrides, so this record does not claim current validation at those widths.
The final mobile capture reported viewport width `386` and document `scrollWidth` `386`, with no horizontal overflow.

The maximum-price field rejected a value with nine HBAR decimal places through native form validation.
Rapid minimum-sample changes from `2` to `5` to `2` settled on the latest request and selected the provider under the final policy.
Raw public evidence expanded successfully.

The two legacy history rows displayed `Revealed` in the reveal-state column and `Oracle unavailable` in the separate quality column.
The current-ledger history row displayed `Revealed` with its separate grade evidence.
The current signal evidence dialog displayed prediction `-3` bps, actual `-17` bps, and absolute error `14` bps, preserving the protocol distinction between disclosure and grading.
The current record displayed working payment, commitment, reveal, and grade evidence links.

After more than one 15-second auto-refresh cycle, closing the provider dialog restored focus to the current `Inspect provider` button.
Closing a signal evidence dialog after auto-refresh likewise restored focus to the current matching `Inspect` button rather than the removed opener or document body.

No additional paid request was created during this browser validation.
The public URL remains a temporary tunnel, the current grade is verified on the receipt-backed ledger, and the two legacy records remain blocked by the recorded Pyth `InvalidWormholeVaa` incompatibility.
