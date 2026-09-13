# Public UI validation

Validation date: 13 September 2026.
Target: [stable GitHub Pages demo](https://chayan-bit.github.io/ethonline-hackathon/).

The final interface uses a light evidence-ledger system: editorial typography, a horizontal product header, one proof ribbon for the verified lifecycle, a dense buyer-policy workbench, a ledger-style history table, and a connected protocol sequence. The system uses restrained entrance and dialog transitions and provides a `prefers-reduced-motion` fallback.

## Browser acceptance

- Desktop passed at `1440 × 900`: the hero, proof ribbon, live statistics, provider workbench, activity timeline, protocol view, and evidence dialogs render with no document-level horizontal overflow.
- Mobile passed at `390 × 844`: the document width remains `390px`; the evidence table alone scrolls horizontally by design.
- The provider, all three public history rows, and the current grade load without an operator service. Setting the minimum sample count to `3` selects the provider in the snapshot.
- View changes return to the top of the document with smooth motion, or immediate motion when the operating system requests reduced animation.
- Native focus outlines, skip navigation, labeled controls, status regions, dialog focus restoration, and minimum touch targets remain present.
- The browser loaded the intended IBM Plex family and reported the light color scheme.
- The console showed no application errors during Discover, Network activity, or Protocol checks.

## Evidence and interaction checks

The public flow reports three eligible paid forecasts, three reveals, `100%` reveal coverage, and one current-ledger grade. The graded record shows prediction `-3` bps, actual return `-17` bps, and absolute error `14` bps. The two legacy rows remain `Revealed` with the separate quality state `Oracle unavailable`.

The maximum-price field uses native HBAR precision validation. Rapid policy refreshes keep only the latest response, and closing a refreshed detail dialog restores focus to its matching action. No paid request was created during this validation.

The hosted demo is a read-only snapshot, so it stays available independently of the operator service. The current grade is receipt-backed, while the two legacy records remain blocked by the recorded Pyth `InvalidWormholeVaa` incompatibility.
