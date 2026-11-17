# Sheets on iPhone: two-line rows and the keyboard bug — plan (2026-11-17)

Status: shipped (D3, D4 taken as defaults). From Hugo's iPhone screenshots of 2026-11-17 (HSK五级, FR, filter Studying, after mobile-ux PR #5).
Builders: read only your work package (§4) plus the decisions it names.

## 1. Evidence

| Id | Problem | Cause in the code |
|---|---|---|
| R1 | Meaning unreadable ("gr a…", "ma t…") | Phone row grid is `26px · 1fr · auto` (`qm.css` `.ql-row.x`). The trail column (Wrong tag ≈ 86 px + status chip 44 + pen 44 ≈ 174 px) runs the full row height, so `.ql-main` gets ≈ 118 px of a ≈ 350 px card. On `.ql-sub` the answer field takes a fixed 104 px + 8 gap, leaving the meaning a few px. |
| R2 | Rows are three lines tall | Hanzi placeholder 58 + gap 12 + pinyin 72 = 142 px > 118 px, so `.ql-top` (`flex-wrap: wrap`) wraps the pinyin onto its own line. |
| R3 | Id shows "1…" | `.ql-lead` is 26 px; HSK五级 ids have 4 digits. |
| R4 | Trail wastes space | Pen (Practise) is on every row although the word panel has "Practise this word" and Sheets has List \| Cards; the Wrong tag carries the word "Wrong"; trail sits centred on the row, beside line 2, while line 1 has free space on the right. |
| R5 | Placeholder cut ("汉字 or 1…") | 13 px placeholder in a 104 px field. |
| K1 | Tab bar floats above the keyboard, rows show beneath it | `.nav` is `position: fixed; bottom: 0` (`styles.css` §Tab bar). iOS ignores `interactive-widget=resizes-content`: the layout viewport keeps its height and iOS pans the visual viewport to the focused field, so the bar stays pinned to the layout-viewport bottom, now mid-screen. `useKeyboardInset` publishes `--kb` but nothing moves or hides `.nav`. |
| K2 | Return → next field can scroll under the keyboard / jump | `AnswerField` Return does `focus({ preventScroll: true })` + `scrollIntoView({ block: 'nearest' })`, which works on the layout viewport; iOS then pans the visual viewport too. `scroll-margin-bottom` adds `--nav-h` for a bar that should not be there while typing. |
| K3 | Same risk for `.undo-bar` | fixed at `bottom: calc(var(--nav-h) + 12px + …)`, i.e. also behind the keyboard or mid-screen. (`.toast` is at the top on phones — fine.) |

## 2. Decisions

**D1. Phone row = two lines; the trail moves to line 1.** Below 700 px, `.ql-main` dissolves (`display: contents`) and the
row becomes a grid with areas:
```
"top   trail"      hanzi · pinyin ............ [✗] [●]
"sub   sub"        meaning (2 lines max) ...... [answer field]
```
`grid-template-columns: minmax(0, 1fr) auto`. Budget at 390 pt: line 1 ≈ 240 px for hanzi + pinyin, line 2 ≈ 200 px for
the meaning (≈ 25 Latin chars per line, 2 lines) + 112 px field. Target row height ≤ 100 px (was ≈ 134 px) with 44 px touch targets on both lines.
Wide screens (≥ 700 px) keep today's one-line columns.

**D2. No id on phones.** `.ql-lead` hidden below 700 px; `--sep-left` back to 16 px. Wide screens keep the id (it matches
the Excel row). The word panel header shows the id so it stays findable on a phone.

**D3. No pen on phone rows.** Below 700 px the Practise button is not rendered in the row. Ways in that remain: tap the
hanzi → word panel → "Practise this word" (same deep link), the List | Cards switch, `W` on a keyboard. Wide screens
keep the pen. (Optional later: a swipe-left row action "Practise".)

**D4. Compact tags.** Status: the 28 px icon dot already used ≤ 400 px, now for all phones; its touch target stays 44 px
by padding with negative margin, so the visible trail is ≈ 64 px. Wrong: icon-only red ✗ badge on phones (no word),
same button, same `aria-label` ("Wrong: 少. Tap to clear"), so e2e selectors keep working. Wide screens unchanged.

**D5. Answer field.** 112 px wide on phones; placeholder "汉字·1–4" (fits at 13 px); typed text stays 16 px (no iOS zoom).

**D6. Hide the tab bar while typing (phones).** CSS first, so it happens before the keyboard animation:
`@media (max-width: 899px) { html:has(input:focus, textarea:focus, [contenteditable]:focus) .nav { display: none; } }`
plus a JS fallback: `useKeyboardInset` toggles `html.kb-open` when `--kb > 80`, and `.kb-open .nav { display: none; }`.
This matches iOS apps, where the tab bar is hidden behind the keyboard. Page bottom padding drops the `--nav-h` share
while hidden. `.undo-bar` sits at `bottom: calc(var(--kb) + 12px)` while `kb-open`.

**D7. Return → next field scrolls against the visual viewport.** New helper in `keyboard.ts`:
`revealAboveKeyboard(el, margin = 16)`: if `el`'s bottom > `vv.offsetTop + vv.height - margin` or its top < the sticky
header bottom, `window.scrollBy` by the difference. `AnswerField` uses it after `focus({ preventScroll: true })`, inside
a `requestAnimationFrame`. Drop `--nav-h` from `.ql-ans input` `scroll-margin-bottom`.

## 3. Questions for Hugo

- D3: OK to drop the pen on phone rows (Practise via the word panel and the Cards switch)? Default: yes.
- D4: Wrong as an icon-only badge on phones? Default: yes.

## 4. Work packages

### Batch A — keyboard (ship first, small, independent)

#### WPA — Tab bar and scrolling with the keyboard (ui-dev)
- Owns: `src/styles.css` (`.nav`, `.undo-bar`, page bottom padding only), `src/ui/keyboard.ts`, `src/ui/qm.css`
  (`.ql-ans input` scroll margins only), `src/ui/Sheets.tsx` (`AnswerField` Return handler only).
- Interfaces:
  ```ts
  // keyboard.ts
  export function useKeyboardInset(): number;            // unchanged, also toggles html.kb-open (kb > 80)
  export function revealAboveKeyboard(el: HTMLElement, margin?: number): void;
  ```
- Steps: D6, D7.
- Done when: in `e2e/layout.py` at 390×844, focusing a row's answer field makes `.nav` not visible; with `kb-open` and
  `--kb` forced to 300 px, Return over five rows leaves each focused field inside `innerHeight - 300`; `.undo-bar` box
  sits above the forced keyboard; desktop sidebar untouched. Hugo checks on the iPhone (not automatable: real keyboard).

### Batch B — the two-line row

#### WPB — Phone row layout (ui-dev, parallel to WPA; touches different rules)
- Owns: `src/ui/qm.css` (phone rules), `src/ui/qm.tsx` (only if a wrapper class is needed), `src/ui/status.css`
  (`.sc-pill` phone size), `src/ui/sheets/sheets.css` (`.hs-wrong` phone variant), `src/ui/Sheets.tsx` (trail: pen
  hidden below 700 px via a `hs-wide-only` class or `useMedia`; placeholder text), `src/ui/word/WordPanel.tsx` (id in the
  header, D2).
- Steps: D1–D5. Prefer CSS (`display: none` below 700 px) over conditional rendering, so the DOM stays the same at every
  width.
- Tests: extend `e2e/layout.py` at 390×844, light and dark, HSK五级 with all three layers shown and a Wrong word:
  `.ql-lead` hidden; the trail's top within line 1 (|trail.top − hz.top| < 8 px); meaning cell ≥ 180 px wide; row height
  ≤ 100 px; answer field ≥ 112 px; no text overflowing its cell; at 1280×860 the id, pen and "Wrong" word still show.
- `e2e/cards.py` (iPhone 13 run) clicks the row button "Practise 少": switch that run to the word panel's
  "Practise this word"; the desktop run keeps the pen.
- Done when: the checks above pass; `npx tsc --noEmit -p .`, `npm test`, `npm run build`, `e2e/explain.py`,
  `e2e/cards.py`, `e2e/layout.py` pass; screenshots at iPhone 13 (List, filter Studying, all layers / Recall preset).

**Gate:** lead merges A and B, runs the checks, qa, PR to `main`; Hugo checks on the iPhone: type down five rows with
Return (tab bar gone, field always above the keyboard), meanings readable, status and Wrong still tappable.

## 5. Order

WPA ∥ WPB → lead merge → qa → PR → Hugo's iPhone check. Update INDEX.md in the same commit as this plan.
