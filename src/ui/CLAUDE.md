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
| Shell, routes (default `sheets`; Sheets/Grammar/Settings kept mounted, UI-3) | `App.tsx` |
| Sheets (home, the one list) | `Sheets.tsx`, `sheets/Menus.tsx`, `sheets/ScratchPad.tsx` (`ScratchPanel`) |
| Hide/show list (shared) | `qm.tsx` |
| Cards (`#/cards`, focus shell) | `cards/Cards.tsx` (`CardsPage`) |
| Review | `review/Session.tsx`, `CardView.tsx`, `GradeBar.tsx`, `VocabBack.tsx`, `OtherCard.tsx` (`Review.tsx` re-exports) |
| Word panel | `word/WordPanel.tsx`, `word/ExplainView.tsx` (`mine={false}`: dictionary only), `word/SentenceWord.tsx` (word tapped in a grammar sentence), `panel.tsx` (`Sheet`: every bottom sheet and menu) |
| Keyboard inset | `keyboard.ts` (`useKeyboardInset`: `--kb`, `--vvh`, `--vvt`; `useNoPan`/`focusNoPan`: iOS focus without a pan) |
| Grammar (`#/grammar`, `#/grammar/<id>`) | `grammar/GrammarPage.tsx`, `grammar/grammar.css` |
| Status | `StatusPicker.tsx` |
| Writing | `WritePad.tsx` |
| Settings and setup | `Settings.tsx` (`#/settings`: workbook, Audio), `SettingsAdvanced.tsx` (`#/settings/advanced`: Sync, data, Study, About), `Setup.tsx` (folder, sync, QR/key, link page), `Microsoft.tsx` |
| Other | `Today.tsx`, `Stats.tsx`, `Words.tsx`, `common.tsx` |

## Test hooks (e2e depends on them, don't rename)
`.sheets [role=tab]`, `button.status-chip`, `#sync` (keep `id="sync"` on the sync section, its texts and buttons),
and the xlsx file input. Sync, data, Study and About live on `#/settings/advanced` (e2e opens that route).

## Gotchas
- iPhone Home Screen app has its own storage, separate from Safari: keys and sign-ins must be entered there.
- No popups (they open outside the Home Screen app) and no iframes for sign-in (Safari blocks them).
- Buttons swapped in place inside a `<form>` (Cards: Show answer / Check / Next) need distinct `key`s, or React reuses the
  node and a `type=button` click submits the form.
- Sheet drag uses native touch listeners: iOS fires `pointercancel` as soon as it starts scrolling, so pointer events can't drag a sheet.
- Add more one-liners at the end of sessions that hit a quirk.
- "Try new animations" (`motion.ts`, `hz.motion`, device only; no switch any more, App.tsx sets it off once, pref `cleanup-2026-11`): new motion and the WenKai font are scoped under `html.motion`
  (CSS) or `motionOn()` (scripts); off = the app as before. Route transitions in `motion.css`, sheet exits (`.closing`) in
  `panel.css`. Font chunks: `scripts/copy-kai.mjs` → `public/kai/` (only `kai.css` is precached).
- `QmRow` is memoised (`sameRow`): row content that can change must be in `QmList.rowSig`; lead/trail/answer slots are render
  functions called inside the row, and row buttons read changing state through a ref (Sheets `live`), or a skipped row keeps
  a stale closure.
- Cards dock buttons prevent the `mousedown` default while the field has focus: losing it closes the iPhone keyboard and drops the screen.
- iOS pans the page to a field focused below the keyboard line: Cards stops it with `useNoPan` (field moved off-page for one frame while it takes focus) and sits on `top: var(--vvt); height: var(--vvh, 100dvh)`, never `top: 0` / `100vh`. Test with the stand-in keyboard in `e2e/layout.py` (`cards_no_pan`).
- Sheets, Grammar and Settings stay mounted, hidden, once visited (`<Activity>` in App.tsx): effects re-run each time the
  tab shows again (never scroll or reset there), portalled panels must close in a cleanup, and e2e must select
  `:visible` (`.main:visible`) because hidden screens stay in the DOM.
- With "Try new animations" on, any `startTransition` update starts a page-wide View Transition: grow lists with plain
  updates (Sheets `grow`). Per-row code must not read layout at mount (the old ios-haptics did: 3 s freezes).
- The sheet lock is `overflow: hidden` on `<html>` only: html and body are `height: 100%`, so locking body too resets
  the page scroll to 0.
- Screens use `useAppPick(...)` or a narrow `useApp` selector, never `useApp((s) => s)` (every sync or Excel tick re-rendered them).
