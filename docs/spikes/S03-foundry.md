# S03 — Remote Foundry v14/PF2e hooks, durable browser storage and GM-only journal import

- Issue: #13 (`S03`, parent #2 `F00`, roadmap #1). Blocks #21 `T16` (requires S03 **PASS**).
- Type: SPIKE, **human-required**. An agent prepared the harness below; it did not run anything against Foundry.
- Harness: [`spikes/s03-foundry/`](../../spikes/s03-foundry/) (throwaway; must not be imported by `src/` or `packages/`).

**Outcome: PENDING (human run required)**

Section 12 records an agent run on a local Foundry server (2026-11-08). The remote-host session has not happened, so sections 4 to 10 are still empty.

Outside section 12, nothing in this document is evidence yet. Every hook name, payload path and Foundry API used by the harness is a
**candidate, verify on v14/PF2e**. All result cells are intentionally empty.

## 1. Question

On the friend-hosted remote Foundry v14 server with PF2e:

1. Which hooks expose rolls/degrees of success, damage/healing, conditions, combat start/end/rounds, scene activation
   and item quantity changes, and with what payloads?
2. Can captured events survive a page refresh / tab kill in durable browser storage, and how many are lost?
3. Can a module installed from a GitHub release manifest import a local file as a GM-only journal (entry **and**
   pages), invisible from a player account?
4. Can one designated writer client be selected reliably so other clients ignore hooks?

## 2. Timebox

3 days of preparation + **one session with the host** (target ≤ 2 h). If the session ends with categories untested,
record them as `UNRESOLVED`; do not extend silently.

## 3. What the harness does

| Piece | File | Notes |
|---|---|---|
| Module manifest | `spikes/s03-foundry/module.json` | id `sargas-recap-spike`; `compatibility.minimum/verified = "14"` are **targets to verify**; `esmodules: ["scripts/main.js"]` |
| Entry | `src/main.ts` | `init`: world setting `designatedWriter`, settings menu (restricted, GM). `ready`: open IndexedDB, run recovery, register probes, expose `game.modules.get("sargas-recap-spike").api` |
| GM panel | `src/foundry/panel.ts` | Plain `ApplicationV2` (no Handlebars). Versions, capture status, buffered/flushed/persisted counts, designated-writer select, **Mark**, **Flush now**, **Export events (JSONL)**, loss table, hook fire counts, **Import test journal…** |
| Hook probe | `src/foundry/probe.ts`, `src/core/hook-catalog.ts` | Candidate hooks per category; stores anonymized summaries (ids hashed, free text replaced by `<str len=N>`, enum slugs + numbers kept, changed key paths, update option keys) |
| Store | `src/core/store.ts` | IndexedDB `sargas-recap-spike:<world hash>` (one database per world), store `events` keyed by `recordId`, `add` only (append-only), `durability: "strict"` |
| Flush policy | `src/core/flush-policy.ts` | see §6 |
| Loss ledger | `src/core/durability.ts` | synchronous `localStorage` "issued" counter per page load vs. records persisted; one key per page load (`sargas-recap-spike:issued:<world hash>:<session>`), so concurrent tabs never overwrite each other |
| Event ids / export | `src/core/ids.ts`, `src/core/export.ts` | `sargas-recap-spike/v1:<kind>:<source>:<discriminator>`; export deduplicates by `eventId` |
| Journal import | `src/core/journal.ts`, `src/foundry/actions.ts` | local JSON file → validated plain text → `JournalEntry` + text pages, ownership `{default: NONE, <gm>: OWNER}` on entry and every page; re-reads created docs and reports violations |
| Fixtures | `spikes/s03-foundry/fixtures/` | `test-journal.sample.json` (canary text), `test-journal.injection.json` (must be rejected), `payload-samples.PLACEHOLDER.jsonl` (synthetic placeholder only) |

Local checks (Windows, PowerShell or Git Bash):

```powershell
cd spikes\s03-foundry
npm ci
npm test          # Vitest + fake-indexeddb, no Foundry runtime
npm run lint      # ESLint + tsc --noEmit
npm run package   # dist\module\ + dist\sargas-recap-spike.zip + dist\module.json
```

## 4. GM / host procedure

### 4.1 Publish the throwaway release (GM, not the agent)

1. `npm run package`. Optionally set `S03_RELEASE_TAG` (default `s03-spike-v<version>`) and `S03_REPO` first; the
   manifest's `manifest`/`download` URLs are written from them.
2. On GitHub, create a **pre-release** with that tag and upload exactly `dist/module.json` and
   `dist/sargas-recap-spike.zip`. Mark it as a throwaway spike in the release notes.
3. Check `https://github.com/sargas79/sargas-session-recap/releases/download/<tag>/module.json` downloads.

The repo was public when this harness was written; if it becomes private, release assets are no longer downloadable
by the Foundry server. In that case record it and have the host install the zip manually (record which path was used —
manifest install is part of the question).

### 4.2 Host installation

1. Host: *Setup → Add-on Modules → Install Module → Manifest URL* → paste the manifest URL → Install.
2. Use a **throwaway or backed-up world**. Enable the module in that world only (*Manage Modules*).
3. Record any compatibility warning text verbatim.

### 4.3 Versions to record (from the panel's "Versions" section and Setup screen)

| Item | Value |
|---|---|
| Date of run | |
| Foundry core version / generation / build | |
| PF2e system version | |
| Other active modules (ids + versions) | |
| Host OS / hosting (self-hosted, Forge, …) | |
| GM browser + version | |
| Player browser + version | |
| Install path used (manifest URL / manual zip) | |
| Compatibility warnings shown | |

### 4.4 Session script (≈ 2 h, GM + one player account, ideally two connected clients)

1. GM opens *Game Settings → Configure Settings → Sargas Recap S03 Spike → Open S03 spike panel* (or console:
   `game.modules.get("sargas-recap-spike").api.open()`).
2. Before measuring, reset: `await game.modules.get("sargas-recap-spike").api.clearStore()` (GM console). The reset
   applies to the current world only: it pauses capture, discards still-buffered writes, deletes this world's records
   and loss-ledger entries, and restarts the counters. Close other tabs of the same world first (their counters are
   per tab and would reappear as false losses).
3. Set the designated writer to the GM user. Run the hook categories (§5), then durability (§6), the designated-writer
   check (§7) and the import check (§8).
4. Export events (JSONL) from each client that wrote. Anonymize-check them (§9) before committing anything.

## 5. Hook categories

For each row trigger the action in the game, then check the panel's "Hook probe" counts and the exported JSONL.
"Invocations" counts each hook call once, before filtering; "Events emitted" counts captured events (a filtered call
emits 0, an item update that is both a condition and a quantity change emits 2). Invocations > 0 with 0 emitted means
the hook fires but the payload did not match the probe's filter.
Status: `supported` (fires on the writer client, payload sufficient, stable over ≥ 3 repetitions), `partial` (fires but
payload missing a needed field, or only on the initiating client), `unsupported` (does not fire / unusable).

| Category | Candidate hook(s) (verify on v14/PF2e) | Action to trigger | Fires on writer? | Fires on non-initiating clients? | Fields present (e.g. outcome, total, hp delta) | Status | Evidence (fixture file / screenshot) |
|---|---|---|---|---|---|---|---|
| Rolls / degrees of success | `createChatMessage` (`flags.pf2e.context.type/outcome`, `rolls[]`) | Strike, skill check, saving throw incl. a crit success and crit failure | | | | | |
| Damage / healing | `createChatMessage` (damage-roll card, `flags.pf2e.appliedDamage`), `updateActor` (`system.attributes.hp`) | Roll damage, apply damage from the card, apply healing, edit HP manually | | | | | |
| Conditions | `createItem`/`updateItem`/`deleteItem` (`type === "condition"`), `createActiveEffect`/`deleteActiveEffect` | Add frightened 2, decrement to 1, remove; add/remove a status via token HUD | | | | | |
| Combat start / end / rounds | `combatStart`, `combatRound`, `combatTurn`, `updateCombat`, `deleteCombat` | Create encounter, begin, next turn ×3, next round, end combat | | | | | |
| Scene activation | `updateScene` (`changed.active`), `canvasReady` (control) | Activate scene B, then scene A; GM views a scene without activating | | | | | |
| Item quantity | `updateItem` (`changed.system.quantity`) | Change consumable quantity, use a consumable, move an item between actors | | | | | |

Hooks that do not exist on v14 or fire with different arguments: list them here with the console error/observed args.

| Hook | Observation | Replacement candidate |
|---|---|---|
| | | |

Discriminator check: for update-based events the harness uses `_stats.modifiedTime` as a cross-client discriminator
(`localDiscriminator: false`). `combatRound`/`combatTurn` use `<round>.<turn>@<combat _stats.modifiedTime>` so going back
a turn and forward again yields distinct events (round/turn alone would collide and be deduplicated away); include a
"previous turn, next turn" step and check that both forward transitions survive export. Record whether two clients' exports produce identical `eventId`s for the same change
(merge them with `mergeJsonl` or compare by eye): | Same eventId across clients? | |

## 6. Refresh / tab-kill durability

**Mechanism under test:** IndexedDB, append-only, `durability: "strict"` transactions.

**Flush policy** (`DEFAULT_FLUSH_POLICY`): flush when 10 events are buffered **or** 500 ms after the first unflushed
event (timer not reset by later events), **plus** immediate flush on `visibilitychange → hidden` and on `pagehide`.
Failed batches are re-queued at the front and retried on the next trigger. Worst-case in-memory residence is therefore
≈ 500 ms + one commit.

**Loss measurement:** each captured event first increments an `issued` counter written synchronously to
`localStorage`; after reload the panel compares it with the records IndexedDB holds for that page load
(`lost = issued − persisted`). `localStorage` itself may not survive a hard kill, so also count your own Mark clicks.

Protocol (GM client = designated writer; repeat each trial 3× on the GM browser, and once on a second browser if possible):

1. Reset the store (console `clearStore()`), reload, open the panel.
2. Click **Mark** N times as fast as possible (N = 25), then immediately:
   - T1 *soft refresh*: press F5 within 0.2 s of the last click.
   - T2 *close tab*: Ctrl+W within 0.2 s.
   - T3 *tab kill*: browser Task Manager (Shift+Esc in Chromium) → End process within 0.2 s.
   - T4 *browser crash/kill*: kill the browser process from the OS task manager.
   - T5 *idle refresh*: wait 2 s after the last click, then F5 (expected 0 loss: control).
3. Reload, open the panel, read the "Refresh / tab-kill loss" table (Issued / Persisted / Lost) and note your own N.

| Trial | Browser | Rep | Marks clicked (N) | Issued (ledger) | Persisted | Lost | Notes |
|---|---|---|---|---|---|---|---|
| T1 soft refresh | | 1 | | | | | |
| T1 soft refresh | | 2 | | | | | |
| T1 soft refresh | | 3 | | | | | |
| T2 close tab | | 1 | | | | | |
| T2 close tab | | 2 | | | | | |
| T2 close tab | | 3 | | | | | |
| T3 renderer kill | | 1 | | | | | |
| T3 renderer kill | | 2 | | | | | |
| T3 renderer kill | | 3 | | | | | |
| T4 browser kill | | 1 | | | | | |
| T5 idle refresh (control) | | 1 | | | | | |

Result: measured worst-case loss = ___ events / ___ ms window. Chosen mechanism + policy for T16: ___ .

## 7. Designated-writer reliability

| Check | Expected | Observed |
|---|---|---|
| GM sets writer = GM; player client's panel/console `api.stats().writes` | `false` on player, `true` on GM | |
| Roll on player client; player `api.stats().ignored` increases, GM `issued` increases | yes | |
| Switch writer to the player user (GM panel); next events persist only on the player client | yes, without reload | |
| Writer user disconnects; panel status | `offline`; nobody writes (gap is visible) | |
| Same user logged in from two tabs | both write (known limitation); export merge dedupes by eventId | |
| Writer setting survives world reload | yes | |
| Non-GM attempts to change writer via console `game.settings.set` | rejected by Foundry (world setting) | |

Verdict (reliable / partial / unreliable): ___

## 8. GM-only journal import, verified from a player account

1. GM: panel → **Import test journal…** → choose `fixtures/test-journal.sample.json`.
   Panel must show "created journal … with 2 page(s)" and "Ownership re-check: GM-only (entry and all pages)".
2. GM: open the entry's *Configure Ownership* and each page's ownership; record the values.
3. **Player account** (separate browser or private window): check the Journal sidebar, global search, and try
   `game.journal.getName("S03 GM-only import test (synthetic)")` in the console. The canary strings
   `S03-CANARY-PAGE-1/2` must not be visible anywhere.
4. GM: import `fixtures/test-journal.injection.json` — must be **rejected** with errors listed and no journal created.
5. Optional: GM grants the player OBSERVER on the entry only; check whether pages (explicit `default: NONE`) stay
   hidden. Record the result — it decides whether T19 sets page ownership explicitly or relies on INHERIT.

| Check | Expected | Observed |
|---|---|---|
| Entry ownership (GM view) | default None, GM Owner | |
| Page 1 / Page 2 ownership | default None, GM Owner | |
| Panel ownership re-check | no violations | |
| Player sidebar shows entry | no | |
| Player console `game.journal.getName(...)` | `undefined` | |
| Injection file | rejected, nothing created | |
| Entry OBSERVER + page NONE (optional) | | |

Evidence (screenshots, with player names cropped): ___

## 9. Anonymized payload samples

- Location: `spikes/s03-foundry/fixtures/`. Today it only contains synthetic placeholders.
- After the run, commit one JSONL per category named `<category>.foundry-<build>.pf2e-<version>.jsonl`, taken from the
  panel export. Before committing, check every line: no actor/user/scene names, no chat text, no world id; ids must
  appear only as `id:xxxxxxxx` hashes. Remove anything that still identifies players or the campaign.
- Delete `payload-samples.PLACEHOLDER.jsonl` once real samples exist.

## 10. Outcome

Fill in after the human run, then post `Outcome: …` as the last comment on #13 with links to this file and evidence.

| Acceptance criterion (#13) | Result | Evidence |
|---|---|---|
| Each hook category marked supported / partial / unsupported with evidence | | |
| Refresh durability measured | | |
| GM-only import verified from a player account view | | |
| Release/manifest installation validated with the host | | |
| Designated-writer selection reliable | | |

**Outcome: PENDING (human run required)** — replace with `PASS`, `FAIL` or `UNRESOLVED`. A `FAIL` defers F06 (#8)
without blocking the imported-audio recap path.

## 11. Known harness limitations / risks (agent notes, not results)

- Foundry APIs assumed from earlier generations and **not verified on v14**: `foundry.applications.api.ApplicationV2`
  with `DEFAULT_OPTIONS.actions`, `_renderHTML`/`_replaceHTML`/`_onRender`; `game.settings.registerMenu` accepting an
  ApplicationV2 class; `foundry.documents.JournalEntry` / `getDocumentClass`; `CONST.DOCUMENT_OWNERSHIP_LEVELS`,
  `CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML`; `document._stats.modifiedTime`; `game.release`. If the module fails to
  load, record the console error — that is a result too.
- Hook arguments and whether a hook fires on every client or only the initiating one are unknown; the per-client fire
  counts exist to answer that.
- The zip has `module.json` at its root; whether the v14 installer also needs a top-level folder is to be verified.
- `npm audit` reports moderate advisories in dev-only lint tooling (typescript-eslint's `minimatch`); none ship in the
  module bundle.

## 12. Agent run on a local Foundry server (2026-11-08)

Run by an agent at the GM's request, on the GM's PC. **This is not the remote-host session in section 4**: it is a local
server, reached over localhost, in a throwaway world, with game actions driven from the console API rather than by people
clicking through the sheets. Sections 4 to 10 stay empty until the host session.

| Item | Value |
|---|---|
| Foundry core | 14.370 (generation 14, build 370, Stable), Node server, `--noupnp` |
| PF2e system | 8.7.0 |
| Other active modules | `sargas-recap-spike@0.0.1` only |
| Clients | GM: Claude desktop built-in browser. Player: Chrome 157. Separate sessions |
| Install path | Manual copy of `dist/module` into `Data/modules`. **Manifest install not tested** |
| Compatibility | Module loaded on v14 with no probe errors (`probeErrors: {}`) |

### Hook categories (one client initiating, one observing)

| Category | Hook | Fires on initiator | Fires on the other client | Fields seen | Status (local) |
|---|---|---|---|---|---|
| Rolls / degrees | `createChatMessage` | yes | yes | `flags.pf2e.context.type`, `outcome`, `unadjustedOutcome`, `dc.value`, `rolls[].total`; critical success, failure and critical failure all seen | supported |
| Damage card | `createChatMessage` | yes | yes | `damage-roll`; a separate `damage-taken` message carries `flags.pf2e.appliedDamage` | partial (the roll card was built by script, not from a real Strike) |
| HP change | `updateActor` | yes | no (0 on the player for an NPC the player cannot see) | `hpChanged`, `hpAfter` | partial (healing and an owned actor not tested) |
| Conditions | `createItem`, `updateItem`, `deleteItem` | yes | yes | `type: condition`, `slug`, `conditionValue` | supported |
| Conditions | `createActiveEffect`, `deleteActiveEffect` | 0 fires | 0 fires | PF2e conditions arrive as items here | unused |
| Combat | `updateCombat`, `deleteCombat` | yes | yes | `changed.round`, `changed.turn`, `roundAfter`, `turnAfter` | supported |
| Combat | `combatStart`, `combatRound`, `combatTurn` | yes | **no (0 on the other client)** | `round`, `turn`, `direction` | initiator only |
| Scene | `updateScene` (`changed.active`) | yes | yes | `changedPaths` includes `active` | supported |
| Item quantity | `updateItem` (`changed.system.quantity`) | yes | yes | `quantityAfter`, `quantityChanged` | partial (moving an item between actors not tested) |

For T16: derive combat progress from `updateCombat`, because `combatStart`, `combatRound` and `combatTurn` only fire on the
client that made the change.

### Refresh durability

GM client, 25 Mark clicks, then a page reload in the same tick (all 25 were still buffered in memory, so this exercises the
`pagehide` flush).

| Trial | Rep | Issued | Persisted | Lost |
|---|---|---|---|---|
| T1 immediate reload | 1 | 25 | 25 | 0 |
| T1 immediate reload | 2 | 25 | 25 | 0 |
| T1 immediate reload | 3 | 25 | 25 | 0 |
| T5 idle 2 s, then reload (control) | 1 | 25 | 25 | 0 |

T2 (close tab within 0.2 s), T3 (renderer kill) and T4 (browser kill) were **not run**. Those are the cases most likely to lose data.

### Designated writer

| Check | Observed |
|---|---|
| Writer = GM; player `writes` | `false` on the player, `true` on the GM |
| Player rolls | Player `ignored` +1, GM `issued` +1 |
| Switch writer to the player, no reload | Player `writes: true`, `issued` +1; GM `writes: false`, `ignored` +1 |
| Writer disconnects | Panel shows `S03 Player (offline)`; nobody writes |
| Non-GM sets the writer from the console | Rejected: `lacks permission to update Setting` |
| Same user in two tabs; setting survives a world reload | Not tested |

### GM-only journal import

| Check | Expected | Observed |
|---|---|---|
| Entry and both pages | default None, GM Owner | `{default: 0, <gm>: 3}` on all three |
| Panel re-check | no violations | "GM-only (entry and all pages)" |
| Injection file | rejected, nothing created | Rejected with listed errors; journal count unchanged |
| Player: on-screen text | hidden | Canary and title not on screen; `visible: false`, permission 0 |
| Player console `game.journal.getName(...)` | `undefined` | **Returned the entry** |
| Player console `pages[i].text.content` | not available | **Contains `S03-CANARY-PAGE-1` and `-2`** |

**Finding: GM-only is display-only on this build.** The full text of a journal the player has no permission for reached the
player's browser, and could be read from the developer console. Nothing shows it in the UI, but T19 must not treat journal
ownership as confidentiality. The GM should decide whether that is acceptable for draft recaps.

### Not covered

The friend-hosted server, manifest install, a real Strike and healing through the sheets, moving items between actors, whether
two clients produce the same `eventId`, and durability trials T2 to T4.
