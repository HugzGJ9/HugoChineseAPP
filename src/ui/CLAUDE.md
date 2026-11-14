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
`.sheets [role=tab]`, `button.status-chip`, `#sync` (keep `id="sync"` on the sync section, its texts and buttons),
`section.panel`, the labels "Claude API key", "Save key", "Remove key", and the xlsx file input.

## Gotchas
- iPhone Home Screen app has its own storage, separate from Safari: keys and sign-ins must be entered there.
- No popups (they open outside the Home Screen app) and no iframes for sign-in (Safari blocks them).
- Buttons swapped in place inside a `<form>` (Quick: Show answer / Check / Next) need distinct `key`s, or React reuses the
  node and a `type=button` click submits the form.
- Add more one-liners at the end of sessions that hit a quirk.
