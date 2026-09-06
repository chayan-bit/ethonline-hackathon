# Public UI validation

Validation date: 6 September 2026.
Target: [temporary public quick tunnel](https://valium-meant-atomic-articles.trycloudflare.com).

The current public flow passed a fresh browser check after the canonical indexer restart.
The page reported fresh evidence, two eligible paid samples, two revealed samples, `100%` reveal coverage, and the expected default rejection at a five-sample minimum.

At the measured 386px mobile viewport, the document width matched the viewport and only the evidence table used horizontal scrolling.
The latest browser runtime did not honor requested 739px or 1280px viewport overrides, so this record does not claim current validation at those widths.

The maximum-price field rejected a value with nine HBAR decimal places through native form validation.
Rapid minimum-sample changes from `2` to `5` to `2` settled on the latest request and selected the provider under the final policy.
Raw public evidence expanded successfully.

Both real history rows displayed `Revealed` in the reveal-state column and `Oracle unavailable` in the separate quality column.
The signal evidence dialog displayed `State: Revealed` and `Grade: Oracle unavailable`, preserving the protocol distinction between disclosure and grading.
The second record displayed its public `-11 bps` prediction and working payment and commitment links.

After more than one 15-second auto-refresh cycle, closing the provider dialog restored focus to the current `Inspect provider` button.
Closing a signal evidence dialog after auto-refresh likewise restored focus to the current matching `Inspect` button rather than the removed opener or document body.

No new paid request was created during this validation.
The public URL remains a temporary tunnel, and P0 grading remains blocked by the recorded Pyth `InvalidWormholeVaa` incompatibility.
