# Durable decisions

<!-- The decisions every future change must respect, pulled out of the plans so nobody reads 900-line plans to find
     them. One entry = 2–4 lines: the rule, why, source. Global ids (AREA-n) so "see D2" is never ambiguous.
     Fill each TODO from the source section, in your own short words. -->

## Storage
- **STORE-1. Dexie stays at v1 while only kv content is added.** Why: TODO. Source: roadmap D2, word-status D3,
  connected-saving D11.

## Events, marks and the engine
- **ENG-1. Event month provenance: `ReviewEvent.mo`.** TODO. Source: roadmap D1.
- **ENG-2. Marks are their own append-only stream, replayed with reviews.** TODO. Source: word-status D1, D4.
- **ENG-3. Status (`WordStatus`) is separate from FSRS; review never sets it.** TODO. Source: sheets D1.
- **ENG-4. Status changes are marks with `st:*` kinds, no format change.** TODO. Source: sheets D2.
- **ENG-5. ts-fsrs is pinned; forward compatibility rules.** TODO. Source: roadmap D8.

## Sync
- **SYNC-1. Each device writes only its own monthly files; per-file error isolation.** TODO. Source: roadmap D5, word-status D2.
- **SYNC-2. Shared prefs travel in `settings.json` as additive `prefs`.** TODO. Source: word-status D7.
- **SYNC-3. Same files and bytes on GitHub and the OneDrive app folder.** TODO. Source: connected-saving D9.
- **SYNC-4. Multi-tab and dirty-stamp rules.** TODO. Source: roadmap D3, D4.

## Import and Excel
- **XL-1. Bad-import guard holds suspicious imports.** TODO. Source: roadmap D6.
- **XL-2. Renames keep history through `VocabFile.aliases`.** TODO. Source: roadmap D7.
- **XL-3. "Newer wins" between Hugo's change and the Excel colour (`colourSince`, per-row times).** TODO.
  Source: sheets D3, connected-saving D3–D4.
- **XL-4. Where statuses are written: real workbook with Microsoft, copy without.** TODO. Source: sheets D5,
  connected-saving D5, D10, D13.
- **XL-5. Write-back = stateless projection + write intents; If-Match; never clobber Excel.** TODO.
  Source: connected-saving D6–D7.

## Microsoft
- **MS-1. Small PKCE client by redirect, no MSAL, no popups.** TODO. Source: connected-saving D8.
- **MS-2. Content identity = quickXorHash.** TODO. Source: connected-saving D2.

## Explain
- **EXP-1. Claude key on this device only; never synced or backed up.** TODO. Source: word-explain D5.
- **EXP-2. Explanation cache synced, additive, Dexie unchanged.** TODO. Source: word-explain D6.
