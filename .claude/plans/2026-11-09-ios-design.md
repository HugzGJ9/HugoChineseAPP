# Native iOS design — spec (wave 1 foundation, 2026-11-09)

Hugo: "the design is still weak, needs to be high-end; iOS as the reference". The app should feel like one of Apple's own
apps (Settings, Notes, Music). This file is the reference for every screen. Foundation lives in `src/styles.css`
(sections 1–7), `src/ui/common.tsx`, `src/ui/App.tsx`, `src/ui/Settings.tsx` (the reference screen).

## 1. Principles
- Content first, chrome quiet. Grey grouped background, white cards, hairline separators, one accent colour.
- One accent: **Chinese red** `--accent` (#C8213A light, #FF453A dark). Use it for: active tab, back button, links,
  primary buttons, selected chips, slider fill, tinted glyphs. Never for large fills except the primary button.
- Status colours are semantic, not decorative: Mastered green, Studying blue, Not known orange, Not studied grey.
- Dark mode is first-class: always use tokens, never raw hex in screens. Check every change in both schemes.
- Motion is short and calm (0.2–0.4s, `--ease` / `--spring`), never blocks input, and disappears with reduced motion
  (handled globally in styles.css).
- Touch: every control ≥ 44px tall on coarse pointers (styles.css § touch); inputs ≥ 16px; no hover-only actions.
  Desktop keeps keyboard shortcuts and gets hover states via `@media (hover: hover)`.

## 2. Tokens (styles.css § 1)
| Role | Token | Light | Dark |
|---|---|---|---|
| Page background (grouped) | `--bg` | #F2F2F7 | #000 |
| Cards, rows, sheets | `--bg-elev` | #FFF | #1C1C1E |
| Fields inside cards | `--bg-elev-2` | #F2F2F7 | #2C2C2E |
| Fills (segmented track, search, chips) | `--fill` `--fill-2` `--fill-3` | grey 12/16/22 % | grey 24/32/38 % |
| Row pressed | `--press` | #E5E5EA | #2C2C2E |
| Text | `--label` `--label-2` `--label-3` `--placeholder` | #000 / #6C6C70 / #737378 / #A2A2A7 | #FFF / #A1A1A6 / #8D8D93 / #6C6C70 |
| Separators | `--separator` (hairline), `--separator-opaque` | | |
| Accent | `--accent` `--accent-tint` `--on-accent` | #C8213A | #FF453A |
| Destructive | `--red` | #D70015 | #FF453A |
| Status | `--green` `--blue` `--orange` `--gray` + `-tint` | AA-safe text versions | |
| Settings badges | `--badge-red/blue/orange/green/indigo/gray` | iOS system colours | |
| Bars | `--bar-bg` (translucent + blur), `--bar-solid` | | |
| Floating | `--material` (banners), `--hud` (toast, undo bar), `--scrim`, `--shadow-pop` | | |

Type (iOS dynamic type): `--fs-caption` 12 · `--fs-footnote` 13 · `--fs-subhead` 15 · `--fs-body` 17 · `--fs-title3` 20 ·
`--fs-title2` 22 · `--fs-title1` 28 · `--fs-large` 34. Fonts: `--font` (SF Pro Text → system → PingFang SC / Hiragino Sans GB /
Noto Sans SC), `--font-display` for titles and big numbers, `--hanzi`, `--kai` (practice grid), `--mono`.
Weights: 400 body, 500 controls, 600 emphasis and buttons, 700 large titles only.

Space: 4/8 grid. Page gutter 16px (+ safe area) on phones, 40px on desktop. Gap between groups 35px; header → card 7px;
card → footer 7px. Row padding 11px 16px (7px with a 30px badge). Radii: `--radius-s` 8, `--radius-m` 10 (fields,
segmented), `--radius-card` 12 (cards, groups, notices), `--radius-l` 14 (sheet top corners), capsules 999px.

Legacy tokens (`--paper --sheet --sheet-2 --ink --ink-2 --ink-3 --line --seal --jade --amber --blue-soft --hide …`) are
aliased onto these and keep old CSS working. **New code uses the new names only.**

## 3. Components (common.tsx) and classes (styles.css)
- `TopBar({ title, back?, backLabel?, children? })` — nav bar + large title (34/41 bold). At rest the bar is transparent;
  once the large title scrolls under it, the bar turns translucent (blur) with a hairline and shows the inline 17px title.
  `back` renders "‹ Settings" in accent (label derived from the href, or `backLabel`). `children` are trailing actions:
  keep them compact (icon buttons or a `LangSwitch`). No back + no actions → "bare": the large title sits at the top.
  Must be the first child of `.main`.
- `Section({ title?, footer?, id? })` → `.group` with `.group-h` (13px uppercase grey header), `.group-card` (white card,
  12px radius), `.group-f` (13px grey footer). Put explanations in the footer, not in the card.
- `Row({ label, detail?, value?, icon?+iconBg?, glyph?, trailing?, href?, external?, onClick?, tone?, center?, chevron? })`
  → `.cell`. Links get a chevron automatically. `icon` = white glyph on a 30px coloured badge (Settings style, use
  `--badge-*`); `glyph` = 24px accent glyph without badge (action rows). `tone: 'action'` (label colour + accent glyph),
  `'destructive'` (red; put it alone in its own group, `center`). Separators are inset hairlines, automatic.
- `SwitchRow({ label, detail?, checked, onChange })`, `Switch` (iOS 51×31, on = `--green-ui`). Any checkbox inside an
  existing `label.check` is also drawn as a trailing switch.
- `Cell({ children })` → `.cell.cell-pad`: free content inside a group (forms, notices, `.cell-actions` button rows).
- `Segmented({ options, value, onChange, label })` → `.seg` (buttons keep `aria-pressed`). `LangSwitch` uses it.
- `Icon({ name, filled? })` — SF-like line icons, 24 grid, 1.6 stroke, round caps. `filled` exists for tab icons
  (sheets, quick, settings). Names: sheets today quick words grammar stats settings sound close back chevron chevron-down
  updown undo sync pen shuffle check more search filter plus trash upload download folder cloud key globe info sparkles
  book clock lock doc external list check-circle x-circle bolt device wifi. Add new ones in the same style.
- Rows inside lists: `.cell-input` (bare right-aligned field; `.left` for text), `.cell-num` + `.cell-unit`, `.cell-select`
  (bare select + `updown` icon), `.cell-col`/`.cell-line`/`.cell-slider` (slider row), `.cell-details` (disclosure row:
  `<details class="cell-details"><summary class="cell tap">…chevron</summary><div class="cell cell-pad">…`),
  `.ok-value` (green check + text).
- Buttons `.btn`: neutral = grey fill + label text; `.primary` = filled accent (one per view); `.tinted` = accent tint;
  `.ghost`/`.plain` = accent text only; `.danger` = red text; `.small` = capsule 34px (44 on touch); `.block`.
  Press: opacity 0.6 + scale 0.98. Icon buttons `.icon-btn`: 44px circle, grey glyph (accent inside the nav bar).
- Chips `.chip`: capsule on `--fill`; pressed = accent tint + accent text; `.off` = struck through.
- Fields: borderless on `--fill`, 10px radius, 44px; `type=search` gets the magnifier; selects get the up/down chevron.
- Sheets: `.pp-panel` (panel.tsx `Shell`) and `.pop` menus get a grabber, 14px top radius, slide-up spring, scrim.
  Menus are a grouped card (`.pop-menu`) of `.pop-item` rows with inset separators and a trailing accent check;
  Close is a separate white rounded button below. On desktop: `.pop` is a centred card, `.pp-panel` a side panel.
- Feedback: `.notice` (12px radius tint, `.ok` green, `.bad` red, default orange), `.banners` (floating material card at
  the top, App.tsx; `.banner`, `.banner-icon`, `.banner-sub`), `.toast` (dark HUD capsule, top on phones),
  `.undo-bar` (HUD bar above the tab bar).

## 4. Shell (App.tsx)
- Phone: translucent tab bar (50px + home indicator, blur, hairline top). Icons 27px, label 10px medium; active = accent,
  filled icon; inactive = `--gray`. Press shrinks the icon slightly.
- Desktop ≥ 900px: iPadOS sidebar 248px: app icon + "Hugo 中文", rows 44px with accent glyphs; active row filled accent with
  white text. Content column max 760px (1100 for `.main.wide`).
- Review (`.shell.focus`) hides the tab bar; its header is a plain `.topbar` row.

## 5. Do / don't
- Do group related settings in `Section`s; one idea per row; values on the right in grey; explanations in footers.
- Do use `Row`/`Section` instead of new card markup; use tokens, never hex; use `--font-display` for numbers ≥ 28px.
- Do keep one primary button per view; secondary actions as neutral buttons or action rows.
- Don't put borders around cards or buttons (fills and hairlines only). Don't use red for anything that is not the
  accent, a destructive action or "Not known/wrong". Don't add shadows except `--shadow-pop` on floating things.
- Don't show long paragraphs inside cards; don't use uppercase except group headers.
- Don't break test hooks: `.sheets [role=tab]`, `button.status-chip`, `#sync`, `section.panel`, labels like
  "Claude API key", "Save key", "Remove key", the xlsx file input.

## 6. Screens (wave 2)
**Sheets (`Sheets.tsx`, `qm.tsx`, `sheets/*`)** — On phones show a large title "Sheets" (TopBar, LangSwitch hidden in the
"more" menu) instead of the hidden `.sh-h1`. Sticky header below the nav bar: sheet tabs as a scrollable segmented
control or capsules (selected = label-filled, as now), a search field, then the layer chips + filter + "⋯".
The word list becomes an inset grouped list: rows on `--bg-elev` inside a 12px card, inset hairline separators,
hanzi 22px `--hanzi`, pinyin tone-coloured 15px, meaning `--label-2` 15px. Status: a 3px coloured leading bar or a dot,
plus the status chip as a tinted capsule (`.status-chip.sp-*`, glyph + label, label hidden < 400px). The pen icon stays
a grey `.icon-btn`. The row id is `--fs-caption` `--label-3`. Hidden cells use `.bar` on `--fill-3`, rounded 6px.
Status menu = `.pop` sheet with a header (hanzi + pinyin) and a grouped list of the four statuses with coloured glyphs.

**Word panel (`word/*`, `panel.css`)** — Bottom sheet with grabber, `--bg` background so the content can be grouped:
header (hanzi 34px, pinyin, audio icon button, close "xmark" in a 30px `--fill` circle top-right), a `Segmented`
Explain / Practise, then sections as `Section`-like groups: Dictionary, Examples (each example a row: hanzi 17px +
translation in `--label-2`, tap to speak), "Explain more" as a `.btn.tinted` with the `sparkles` icon. Claude's text
in a white card. Status picker as a 4-segment control coloured by status when selected.

**Quick (`Quick.tsx`)** — Large title "Quick memory", LangSwitch trailing in the nav bar. Controls in a grouped card:
mode presets as `Segmented`, list/sheet/status as rows with `.cell-select`, Shuffle as an action row. List = inset
grouped list like Sheets. Cards view: one large white card (radius 20, `--shadow-card`), hanzi in `--kai` 72px, tap to
reveal with a 0.2s fade; swipe hint in `--label-3`.

**Review (`review/*`)** — Focus mode, no tab bar. Top: close (xmark) and undo icon buttons, thin accent progress bar,
count in `--fs-footnote`. Card centred on `--bg` inside a white rounded card. Grade bar: four tinted rounded buttons
(Again red tint, Hard orange, Good green, Easy blue) with the interval in `--fs-caption`; pressed scale 0.96. Answer
fields 52px, centred text. Verdict as tinted notice.

**Today, Stats, Words, Setup, Microsoft** — TopBar with `back="#/settings"`. Today: big number in `--font-display` 56px,
the three counts as a grouped card with vertical hairlines, Start as `.btn.primary.block`, shortcuts as a grouped list
with badge icons. Stats: charts in white cards, legends in footnotes, tables as grouped lists. Words: search field,
filters as `.cell-select` rows or capsules, results as an inset grouped list with `StatusPill`. Setup/Microsoft: convert
their `section.panel` blocks to `Section` + rows (keep `id="sync"` on the sync section and its texts and buttons).

## 7. Open items for the lead
- `index.html` `theme-color` is still red (#b8322a) / #161412: should become #F2F2F7 / #000 (and the manifest's theme and
  background colours to match) so Safari's chrome blends with the grouped background.
- `apple-mobile-web-app-status-bar-style` stays `default` (dark text on the light grouped background) — correct for light;
  in dark mode iOS adapts.
