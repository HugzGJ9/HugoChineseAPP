# src/ui — screens

<!-- Loaded only when a session works in src/ui. -->

## Design
- Reference: native iOS. Spec: `.claude/plans/2026-11-09-ios-design.md` (§1 principles, §2 tokens, §3 components,
  §5 do/don't). Read §5 before any style change.
- Tokens and shared classes in `src/styles.css`; components in `common.tsx`; reference screen: `Settings.tsx`.
- Screen CSS lives next to its screen. Always tokens, never raw hex; check light and dark.

## Map
| Screen | Files |
|---|---|
| Shell, routes (default `sheets`) | `App.tsx` |
| Sheets (home) | `Sheets.tsx`, `sheets/Menus.tsx`, `sheets/Practice.tsx`, `sheets/ScratchPad.tsx` |
| Hide/show list (shared) | `qm.tsx` |
| Quick | `Quick.tsx` |
| Review | `review/Session.tsx`, `CardView.tsx`, `GradeBar.tsx`, `VocabBack.tsx`, `OtherCard.tsx` (`Review.tsx` re-exports) |
| Word panel | `word/WordPanel.tsx`, `word/ExplainView.tsx`, `panel.tsx` |
| Status | `StatusPicker.tsx` |
| Writing | `WritePad.tsx` |
| Settings and setup | `Settings.tsx`, `Setup.tsx` (folder, sync, QR/key, link page), `Microsoft.tsx` |
| Other | `Today.tsx`, `Stats.tsx`, `Words.tsx`, `common.tsx` |

## Test hooks (e2e depends on them, don't rename)
`.sheets [role=tab]`, `button.status-chip`, `#sync`, `section.panel` — full list in the design spec §5.
TODO: move the full list here so ui-dev doesn't have to open the spec.

## Gotchas
- TODO: iPhone/Safari quirks found so far (one line each).
