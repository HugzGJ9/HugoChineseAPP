# src/ui — screens

<!-- Loaded only when a session works in src/ui. -->

## Design
- Reference: native iOS. Spec: `.claude/plans/2026-11-09-ios-design.md` (§1 principles, §2 tokens, §3 components,
  §5 do/don't). Read §5 before any style change.
- Tokens and shared classes in `src/styles.css`; components in `common.tsx`; reference screen: `Settings.tsx`.
- Screen CSS lives next to its screen. Always tokens, never raw hex; check light and dark.
- Colour roles: docs/decisions.md UI-1 (ink controls, red = wrong only, Excel status colours, tone hues); the
  ios-design §5 red rule is superseded. `colours.test.ts` guards contrast and tone/status distance.

## Map
| Screen | Files |
|---|---|
| Shell, routes (default `sheets`) | `App.tsx` |
| Sheets (home, the one list) | `Sheets.tsx`, `sheets/Menus.tsx`, `sheets/ScratchPad.tsx` (`ScratchPanel`) |
| Hide/show list (shared) | `qm.tsx` |
| Cards (`#/cards`, focus shell) | `cards/Cards.tsx` (`CardsPage`) |
| Review | `review/Session.tsx`, `CardView.tsx`, `GradeBar.tsx`, `VocabBack.tsx`, `OtherCard.tsx` (`Review.tsx` re-exports) |
| Word panel | `word/WordPanel.tsx`, `word/ExplainView.tsx` (`mine={false}`: dictionary only), `word/SentenceWord.tsx` (word tapped in a grammar sentence), `panel.tsx` (`Sheet`: every bottom sheet and menu) |
| Keyboard inset | `keyboard.ts` (`useKeyboardInset`, sets `--kb`) |
| Grammar (`#/grammar`, `#/grammar/<id>`) | `grammar/GrammarPage.tsx`, `grammar/grammar.css` |
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
- Buttons swapped in place inside a `<form>` (Cards: Show answer / Check / Next) need distinct `key`s, or React reuses the
  node and a `type=button` click submits the form.
- Sheet drag uses native touch listeners: iOS fires `pointercancel` as soon as it starts scrolling, so pointer events can't drag a sheet.
- Add more one-liners at the end of sessions that hit a quirk.
- "Try new animations" (`motion.ts`, `hz.motion`, device only): new motion and the WenKai font are scoped under `html.motion`
  (CSS) or `motionOn()` (scripts); off = the app as before. Route transitions in `motion.css`, sheet exits (`.closing`) in
  `panel.css`. Font chunks: `scripts/copy-kai.mjs` → `public/kai/` (only `kai.css` is precached).
- `QmRow` is memoised (`sameRow`): row content that can change must be in `QmList.rowSig`, and row buttons read changing
  state through a ref (Sheets `live`), or a skipped row keeps a stale closure.
- Cards dock buttons prevent the `mousedown` default while the field has focus: losing it closes the iPhone keyboard and drops the screen.
- iOS pans the page under the keyboard (`visualViewport.offsetTop`): a fixed full-screen view uses `top: var(--vvt)` and `bottom: var(--kb)` (keyboard.ts), never `top: 0`.
