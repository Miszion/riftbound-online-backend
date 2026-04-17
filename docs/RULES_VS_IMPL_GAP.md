# Rules vs Implementation Gap Analysis

This audit walks the Riftbound TCG Core Rules v1.2 (as captured in `docs/RULES_SUMMARY.md`, `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md`, `docs/GAME_RULES_IMPLEMENTATION.md`, and `docs/RIFTBOUND_RULES_PARSED.json`) against the live backend implementation in `src/game-engine.ts`, `src/card-catalog.ts`, `src/champion-utils.ts`, and `src/game-state-serializer.ts`. The goal is to give product and engineering one table that shows, rule by rule, how closely the engine currently mirrors the rule book, where it diverges, and which gaps are load bearing for tournament play. All evidence cites absolute file paths with line numbers; where a rule is partially implemented or buggy, I quote the exact engine symbol so the fix can be scoped quickly. Rows are grouped by the ten categories requested: Turn Structure, Resources and Mana, Combat, Card Types, Keywords, Triggers, Zones, Win Conditions, Multiplayer and Priority, and Edge Cases. Two follow-up sections capture the ten highest-impact gaps and a list of rule book ambiguities the engine has silently resolved.

## Status Legend

- **OK** Implementation matches the rule book with no material deviation.
- **PARTIAL** Core behavior exists but important sub-cases, validations, or side effects are missing.
- **MISSING** No implementation found for the rule.
- **BUGGY** Implementation exists but produces incorrect behavior vs the written rule.

## Gap Table

### Turn Structure

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Setup and deck validation (103-118) | `docs/RULES_SUMMARY.md:6-24`, `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:9-14` | Engine validates main deck minimum, shuffles, initializes hands, runs initiative and mulligan flows | PARTIAL | `src/game-engine.ts:879` enforces `MIN_DECK_SIZE = 39` while the rule book specifies a 40-card floor (`src/game-engine.ts:567`). No domain identity check against Champion Legend is performed when loading a deck (no matches for `domain.*match` in `src/game-engine.ts`). |
| Initiative window (115) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:11`, `docs/RIFTBOUND_RULES_PARSED.json` `turn_structure.first_turn_process` | Replaces coin flip with "Doran's Blade/Shield/Ring" rock-paper-scissors; loser channels +1 rune on their first Channel Phase | OK | `src/game-engine.ts:546-548`, `src/game-engine.ts:998` sets `firstTurnRuneBoost = 1`, `src/game-engine.ts:1367-1370` applies the bonus exactly once. |
| Battlefield draft (103.4, 113) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:12` | Prompts each player to pick a battlefield; auto-selects when only one legal option | PARTIAL | Selections are applied in `src/game-engine.ts:1085-1104` but there is no uniqueness check across the two players even though rule 103.4 requires the two active battlefields to differ (no "unique battlefield" enforcement; grep for `uniqueBattlefield` returns nothing). |
| Mulligan window (117) | `docs/RULES_SUMMARY.md:20`, `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:14` | Allows up to two cards to be recycled and redrawn in parallel | OK | `src/game-engine.ts:1114-1153` builds the prompt with `maxReplacements: 2` and uses `.slice(0, 2)` to hard cap the swap. |
| Beginning Phase steps: Awaken, Begin, Channel, Draw (161-210, 735-742) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:18`, `docs/RULES_SUMMARY.md:87-91` | Engine awakens permanents, runs begin triggers, channels up to two runes (plus initiative loser bonus), draws one card | OK | `src/game-engine.ts:1350-1374` runs the four-step sequence, `readyChampions` and `readySummonedCreatures` live at `src/game-engine.ts:8342-8357`. |
| Main Phase 1 and Main Phase 2 (346-369) | `docs/RULES_SUMMARY.md:93-103` | Two main phases with priority windows and no hard action limit | OK | `src/game-engine.ts:1719-1733` advances from MAIN_1 to COMBAT to MAIN_2 to END; priority windows opened at `src/game-engine.ts:1704`, `src/game-engine.ts:1724`. |
| End step (318, 742) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:22` | Expires temporary effects, fires end triggers, rotates turn order | PARTIAL | `src/game-engine.ts:1726-1736` resolves end-of-turn effects and rotates. The legacy "discard down to 7" note in `docs/GAME_RULES_IMPLEMENTATION.md` is intentionally not enforced because the engine guide clarifies no hand cap exists (rule 107.6). This conflict should be reconciled in the docs; the engine itself has no hand-size discard logic (grep for `maxHandSize` / `hand.*limit` returns no matches). |
| Cleanup Phase (318, 742) | `docs/RULES_SUMMARY.md:104-108` | Cleanup resets turn counters and pendingMainPhaseEntry | PARTIAL | `src/game-engine.ts:1856-1864` handles turn rotation but does not explicitly fire "until end of turn" resets on gear or battlefield effects. `temporaryEffects` decrement is wired through `resolveEndOfTurnEffects` but gear attachments remain until destroyed. |
| Turn-order rotation | `docs/RIFTBOUND_RULES_PARSED.json` `turn_structure` | `endTurn` cycles `currentPlayerIndex` and increments `turnNumber` when it wraps to index 0 | OK | `src/game-engine.ts:1856-1864`. |

### Resources and Mana

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Energy vs Power vs Universal Power (158-161) | `docs/RULES_SUMMARY.md:73-82` | `ResourcePool` tracks energy, per-domain power, and universal power | OK | `src/game-engine.ts:196-200` defines the pool; universal power is allocated at `src/game-engine.ts:1566` and cost-matching in `src/champion-utils.ts:106-129` falls back to universal when a domain rune is absent. |
| Channel Phase rune count (161-170) | `docs/RULES_SUMMARY.md:88-89` | Channels exactly two runes per turn; adds one on the initiative loser's first turn | OK | `src/game-engine.ts:565-569` constants, `src/game-engine.ts:1367-1370`, `src/game-engine.ts:1391` `channelRunes`. |
| Resource persistence across turns | `docs/RULES_SUMMARY.md:162-164` | Energy and power carry forward because untapping at Awaken does not reset the resource pool | OK | `src/game-engine.ts:8342-8357` only flips `summoned` / `isTapped`, leaving `resources` untouched. |
| Recycle (403) | `docs/RULES_SUMMARY.md:156-159` | Recycles cards back to the main deck with a reshuffle | OK | `src/game-engine.ts:6802-6819` `recycleCards` / `recycleRune`. |
| Deflect cost inflation | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:49` (taxonomy), keyword guide | Adds +1 (or card-specific) energy cost when targeting a unit with Deflect | OK | `src/game-engine.ts:2384-2393`. |
| Accelerate alternate cost | Card text, `src/game-engine.ts:7088-7102` | Pays the accelerate cost, bypasses summoning sickness | OK | `src/game-engine.ts:7088-7102`. |
| Domain identity enforcement (133, 110) | `docs/RULES_SUMMARY.md:13-14`, `docs/RULES_SUMMARY.md:43-51` | None found | MISSING | No code in `src/game-engine.ts` validates that deck entries share the Champion Legend's domain(s); grep for `domain.*match`, `enforceDomainIdentity`, `champion.*domain` returns nothing. |

### Combat

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Showdown trigger (437) | `docs/RULES_SUMMARY.md:116-124`, `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:20` | Combat is opened when a unit moves to a contested battlefield | OK | `src/game-engine.ts:1702-1707` opens the showdown priority window when COMBAT begins. |
| Priority windows and reaction chains (739, 737, 745) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:21` | Maintains a reaction chain with LIFO resolution and priority passes | OK | `src/game-engine.ts:3197-3210` chain items, `src/game-engine.ts:8284-8340` combat priority, `src/game-engine.ts:3282-3419` chain resolution. |
| Declare attackers and blockers | `docs/RULES_SUMMARY.md:125-129` | Attack is modeled as "move to battlefield"; blocking is implicit via presence of defending units | PARTIAL | `src/game-engine.ts:2962-2967` only moves a unit, `resolveCombat` at `src/game-engine.ts:2972-3008` takes a single boolean `blocked` flag and no block assignments. The full showdown chain of "attacker declares, defender declares blocks, assign damage" is not modeled as a first-class flow; `declareBlockers` has no matches. |
| Damage assignment between units (443) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:71` | Damage is restricted to units only via `ensureDamageableTarget` | OK | `src/game-engine.ts:7040-7048`. Combat outcome uses aggregate might comparison at `src/game-engine.ts:8195-8282` rather than per-unit damage rolls. |
| Combat resolution by might totals | Rule book implies per-unit damage; engine uses summed might groups | Implemented | BUGGY | `src/game-engine.ts:8195-8282` sorts groups by `totalMight` and destroys every losing unit regardless of individual damage dealt. This diverges from the written rules, which require damage to be assigned unit-to-unit up to `power` and leaves attackers with excess power alive. Tank, Deflect, and blocker selection never factor into survival because the loop kills all non-winning units. |
| Summoning sickness | `docs/RULES_SUMMARY.md:207-210` | Units gain `summoned = true` on play, cleared at Awaken | OK | `src/game-engine.ts:5290` sets, `src/game-engine.ts:8342-8347` clears. Accelerate bypasses it at `src/game-engine.ts:7102`. |
| Facedown zone contents (hidden cards) | `docs/RULES_SUMMARY.md:31` | Each battlefield tracks `hiddenCards` and hides card payloads from opponents | OK | `src/game-engine.ts:2555-2690` for hide/activate flow, `src/game-state-serializer.ts:184-199` hides the card body from non-owners. |
| Focus (aggressive player) | `docs/RULES_SUMMARY.md:121-123` | `focusPlayerId` is tracked on `gameState` | OK | `src/game-engine.ts:415`, rotations at `src/game-engine.ts:8298-8338`. |
| Stalemate when might is tied | Not explicit in rule book; engine destroys every participating unit | Implemented | PARTIAL | `src/game-engine.ts:8248-8260` zeroes the battlefield and wipes all units on a tie. This is plausible but rule-text ambiguous; see Ambiguities section. |

### Card Types

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Unit cards | `docs/RULES_SUMMARY.md:55-56` | Played to `board.creatures`, track power / toughness | OK | `src/game-engine.ts:5110-5300` play flow (unit path), `src/game-engine.ts:2972` combat. |
| Spell cards | `docs/RULES_SUMMARY.md:57` | Executed through `executeEffectOperations` and go to graveyard when resolved | OK | `src/game-engine.ts:3594-3710` resolveSpell path. |
| Gear (attachment) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:51` | Gear goes through `attach_gear` effect operation | PARTIAL | `src/game-engine.ts:6370` includes gear equip totals but there is no dedicated `player.board.gear` array; gear attaches via ad-hoc attachment state on the target unit. Detaching when the unit dies is implicit (no explicit detach logic observed). |
| Runes | `docs/RULES_SUMMARY.md:57` | Channeled, never "played" from hand, tracked in `channeledRunes` | OK | `src/game-engine.ts:171`, `src/game-engine.ts:1391-1405`. |
| Battlefields | `docs/RULES_SUMMARY.md:57-58` | Drafted during setup, controller-aware, fire setup and control triggers | OK | `src/game-engine.ts:1085-1111`, control handlers at `src/game-engine.ts:7380-7430`. |
| Champion Legend (103, 132.6) | `docs/RULES_SUMMARY.md:47`, `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:49` | Sits in Legend Zone, supports manually activated abilities (`:rb_exhaust::`, `:rb_energy_X::`) | OK | `src/champion-utils.ts:26-44`, `src/game-engine.ts:181-194` champion state. |
| Chosen Champion Unit | `docs/RULES_SUMMARY.md:11-14` | Stored on `PlayerState.championLeader`, deploys from Champion Zone | PARTIAL | `src/game-engine.ts:185-186` tracks deployment, but no check validates that the chosen champion unit shares the Champion Legend's name family (rule 103.1 requires matching name). |
| Token units | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:48` | Tokens are created via `create_token` operation | OK | `src/game-engine.ts:5110-5116` creates synthetic instance ids; tokens do not enter deck or hand. |
| Card text overrides rules (Golden Rule) | `docs/RULES_SUMMARY.md:179` | Effect operations are fed from card text first | OK | `src/game-engine.ts:3690-4870` `executeEffectOperations`. |

### Keywords

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Tank (must-target) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md` taxonomy, card text | Forces opponents to target Tank units first in the same zone | OK | `src/game-engine.ts:2108-2140` `checkTankTargetingViolation`. |
| Deflect (cost tax) | Card text | Adds cost when targeting a unit with Deflect | OK | `src/game-engine.ts:2384-2393`. |
| Legion (tribal might) | Card text | Adds +1 might per same-tribe ally on the same battlefield | OK | `src/game-engine.ts:8049-8060`. |
| Ganking (inter-battlefield move) | `docs/RIFTBOUND_RULES_PARSED.json` keywords | Only Ganking units may move between battlefields mid-turn | OK | `src/game-engine.ts:2488-2500`. |
| Assault (attack bonus) | Card text | Bonus might added while attacking | OK | `src/game-engine.ts:6960-6964`, bonus aggregated at `src/game-engine.ts:8213-8216`. |
| Hidden (facedown units/spells) | Card text | Players can hide up to `maxHiddenCards` cards; activation gated by not same-turn-as-hide | OK | `src/game-engine.ts:2555-2690`. |
| Reaction timing | `docs/RULES_SUMMARY.md:110-114` | Spells tagged `reaction` may be cast during reaction windows or in response to chain | OK | `src/game-engine.ts:1870-1905`. |
| Deathknell (on-death triggers) | Card text | Text scan matches `deathknell` and `when I die` to wire death triggers | OK | `src/game-engine.ts:386`, `src/game-engine.ts:5422-5574`. |
| Shielding (damage prevention) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:49` taxonomy | Taxonomy lists `shield` but there is no `preventDamage` / `shieldCharges` state | MISSING | No matches for `preventDamage`, `shieldCharges`, or `damagePrevention` in `src/game-engine.ts`; `shielding` class is recognized by the classifier only. |
| Transform | Taxonomy | No runtime path swaps a unit's stats or identity | MISSING | No `transform` handler in `src/game-engine.ts`; the taxonomy class never resolves to a concrete operation. |
| Shroud / Untargetable (general keyword category) | Card text | No central targeting-restriction check outside Tank and Deflect | PARTIAL | Only Tank-style enforcement exists; "cannot be targeted" text is not parsed into a dedicated gate. |

### Triggers

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Play effects (on-enter) | `docs/RULES_SUMMARY.md:167-170` | `triggerUnits(units, 'play')` fires after play | OK | `src/game-engine.ts:5286-5300` and `triggerUnits` definition above line 4868. |
| Triggered abilities on game events | `docs/RULES_SUMMARY.md:171-173` | `SUPPORTED_KEYWORD_TRIGGERS` map and text inference | OK | `src/game-engine.ts:4868-4884`. |
| Conquer / Hold / Conquer-open / Conquer-after-attack | Rule book, derived from 437-450 | Engine emits four distinct trigger kinds tied to battlefield control state | OK | `src/game-engine.ts:7417-7429`, hold-bonus loop at `src/game-engine.ts:7432-7462`. |
| Combat-win trigger | Rule book combat section | Fires on units that survive a showdown | OK | `src/game-engine.ts:8241`, `src/game-engine.ts:8277`. |
| Static / continuous abilities | `docs/RULES_SUMMARY.md:171-173` | `calculateStatModifiers` aggregates auras, tribal synergy, location effects | OK | `src/game-engine.ts:7996-8080`. |
| Temporary effects expiration (742) | `docs/RULES_SUMMARY.md:104-108` | `resolveEndOfTurnEffects` decrements and removes expired entries | OK | `src/game-engine.ts:1726-1732`, handler defined around `resolveEndOfTurnEffects`. |
| "At start of turn" triggers | Engine guide phase 5 | Fired during Begin sequence and beginning-phase effects | PARTIAL | `updateTurnSequenceStep('begin', ...)` fires but there is no generic `start_of_turn` dispatcher that scans every permanent; triggers only fire through keyword/text inference, which can miss unusual phrasings. |
| "At end of turn" triggers | Engine guide phase 9 | Driven by priority-window opening at end step | PARTIAL | `src/game-engine.ts:1727-1732` opens a reaction window but does not explicitly iterate all permanents for "at end of turn" triggers unless the text parser flagged them. |

### Zones

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Hand (secret info) | `docs/RULES_SUMMARY.md:34-38` | `hand: Card[]` per player, serializer hides non-owner hand contents | OK | `src/game-engine.ts:172`, `src/game-state-serializer.ts:184-199`. |
| Main Deck and Rune Deck | `docs/RULES_SUMMARY.md:36-38` | Separate arrays, shuffled on load | OK | `src/game-engine.ts:169-171`, `src/game-engine.ts:913-917`. |
| Trash (graveyard) | `docs/RULES_SUMMARY.md:38` | `graveyard` array per player; effect parser accepts both "graveyard" and "trash" tokens | OK | `src/game-engine.ts:173`, `src/game-engine.ts:4263-4314`. |
| Banishment (permanent removal) | `docs/RULES_SUMMARY.md:39` | No dedicated zone; nothing routes cards to a banishment array | MISSING | Grep for `banish` / `Banish` in `src/game-engine.ts` returns no state changes; removal paths send cards to `graveyard` even when rules call for banishment. |
| Exile (temporary removal) | `docs/RULES_SUMMARY.md:41` | `exile: Card[]` declared but never pushed or read | MISSING | `src/game-engine.ts:174`, `src/game-engine.ts:755-756`, `src/game-engine.ts:835`. No `.exile.push(` / `.exile.splice(` occurrences. |
| Legend Zone | `docs/RULES_SUMMARY.md:32` | `championLegend` held off-board and cannot be removed | OK | `src/game-engine.ts:181-184`. |
| Champion Zone | `docs/RULES_SUMMARY.md:33` | `championLeader` tracked with `championLeaderDeployed` flag | PARTIAL | `src/game-engine.ts:185-186`; once deployed to the board, the engine does not guarantee the champion returns to the Champion Zone on a bounce effect. |
| Battlefields (board zones) | `docs/RULES_SUMMARY.md:30` | Both players share the drafted battlefields list on `gameState.battlefields` | OK | `src/game-engine.ts:1100-1111`. |
| Facedown Zone per battlefield | `docs/RULES_SUMMARY.md:31` | `battlefield.hiddenCards` list, owner-only visibility | OK | `src/game-engine.ts:536`, `src/game-state-serializer.ts:184-199`. |
| Base (per-player board) | `docs/RULES_SUMMARY.md:30` | `PlayerBoard` with creatures/artifacts/enchantments | OK | `src/game-engine.ts:175` and `PlayerBoard` definition. |

### Win Conditions

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Reach 8 Victory Points | `docs/RULES_SUMMARY.md:137-141` | `VICTORY_SCORE = 8`; `awardVictoryPoints` ends game when reached | OK | `src/game-engine.ts:566`, `src/game-engine.ts:3011-3049`. |
| Burn Out (empty deck) | `docs/RULES_SUMMARY.md:151-154` | Draw from empty deck calls `burnOut` which ends the game | OK | `src/game-engine.ts:3103-3160`. |
| Concede | `docs/RULES_SUMMARY.md:144-147` | `concedeMatch` sets winner and reason | OK | `src/game-engine.ts:2825-2842`. |
| Timeout | `docs/RULES_SUMMARY.md:144-147` | `MatchResult.reason` includes `timeout`; no internal timer fires it | PARTIAL | `src/game-engine.ts:507` types `timeout` as a valid reason, but nothing inside `game-engine.ts` triggers a timeout (no `setTimeout`, no clock). It must be invoked from the match service layer. |
| Objective-based points | `docs/RULES_SUMMARY.md:140` | `awardVictoryPoints(player, n, 'objective', ...)` fires when objectives resolve | OK | `src/game-engine.ts:4102`, `src/game-engine.ts:4109`, `src/game-engine.ts:4181`, `src/game-engine.ts:7615`. |
| Hold points (controlling a battlefield at turn start) | Rule book combat section | Fires when controller still holds the battlefield exclusively | OK | `src/game-engine.ts:7432-7462` `checkBattlefieldHoldBonuses`. |
| Support-based Victory | Engine guide taxonomy, card text | `support` is a typed ScoreReason but no engine call sites fire it | MISSING | `awardVictoryPoints\(.*['"]support` returns zero matches in `src/game-engine.ts`; only `combat`, `hold`, `objective`, `decking`, `concede`, `timeout` are actually awarded. |
| Alternative win conditions | `docs/RULES_SUMMARY.md:142` | None wired | MISSING | No card-specific alt-win path exists; if a card says "you win the game," it would fall through to `generic` in the effect taxonomy. |

### Multiplayer and Priority

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Open State vs Closed State (330-333) | `docs/RULES_SUMMARY.md:110-114` | Tracks `reactionChain` null vs populated as equivalent states | OK | `src/game-engine.ts:418-419`, `src/game-engine.ts:1921-1935`. |
| Priority passes and window rotation | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:21` | `priorityWindow` + `focusPlayerId` rotate between players; two consecutive passes close combat | OK | `src/game-engine.ts:8284-8340`. |
| Chain resolution order (LIFO) | `docs/RULES_SUMMARY.md:110-114` | Chain items pop in reverse insertion | OK | `src/game-engine.ts:3197-3210`, `src/game-engine.ts:3282-3419`. |
| Two-player only | `docs/RULES_SUMMARY.md` (implied by 1v1) | `getOtherPlayer` assumes exactly two players | OK | Implicit throughout; e.g. `src/game-engine.ts:3154-3158` references a single `opponent`. Multiplayer (3+) is not supported. |
| Prompt-driven human choices | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:57-67` | Battlefield, mulligan, action, target, reaction, discard prompts emitted through `gameState.prompts` | OK | `src/game-engine.ts:1114-1122` (mulligan), `src/game-engine.ts:1163-1217` (discard), `src/game-engine.ts:2626-2690` (hidden activation). |
| Turn player priority during own Main Phase | Rule book main phase | Current player always receives priority at the top of each main phase | OK | `src/game-engine.ts:1704-1733`. |

### Edge Cases

| Rule | Location in Rule Book | Engine Implementation | Status | Evidence |
|------|----------------------|----------------------|--------|----------|
| Cannot beats Can (Silver/Golden Rule) | `docs/RULES_SUMMARY.md:178-181` | No global resolution layer; only Tank and Deflect have explicit prohibitions | PARTIAL | Prohibition-style effects like "can't be targeted" would need centralized handling; today only a subset of restrictions are enforced (`src/game-engine.ts:2108-2140`). |
| Damage is unit-only (443) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:71` | Enforced via `ensureDamageableTarget` | OK | `src/game-engine.ts:7040-7048`. |
| No maximum hand size (107.6) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:72` | No cleanup discard to hand limit | OK | No `maxHandSize` enforcement in `src/game-engine.ts`. Note that `docs/GAME_RULES_IMPLEMENTATION.md:106` still lists "Discard down to hand limit (typically 7)"; the engine aligns with the newer guide, not the legacy doc. |
| Unique battlefield requirement (103.4) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:12` | Engine does not enforce uniqueness between players during draft | PARTIAL | `src/game-engine.ts:1085-1104`. |
| Copy rule: up to 3 of the same card | `docs/RULES_SUMMARY.md:13` | No per-card deck validation | MISSING | No deck linting checks count limits (grep for `quantity` / `max 3` returns only card entry parsing). |
| Champion Legend name match | `docs/RULES_SUMMARY.md:11-14` | No runtime validation that the chosen Champion matches the Legend's name family | MISSING | No `champion.*match` / `championLegend.*name` logic in `src/game-engine.ts`. |
| Priority auto-pass when prompts exist | Rule book implies priority blocks on required prompts | Engine checks `hasBlockingEndStepActivity` and `hasBlockingBeginPhaseActivity` | OK | `src/game-engine.ts:1745-1767`. |
| Snapshot / replay support | Not in rule book but mentioned in engine guide | `recordSnapshot` is called at major transitions | OK | `src/game-engine.ts:1103, 1149, 1159`, etc. |
| Reaction chain interaction with combat | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:21` | Combat uses its own priority stage distinct from the general reaction chain | OK | `src/game-engine.ts:8312-8340`. |
| Gear attachment rules (durability, detach on death) | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:51` | Attachment via `attach_gear` operation, no explicit "falls off when unit dies" hook | PARTIAL | `destroyUnit` at `src/game-engine.ts:8250-8276` routes the unit to graveyard without explicitly unattaching gear. |
| Spell targeting legality | `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:57-64` | `analyzeSpellTargeting` infers target scope, friendly/enemy allowance, selection requirement | OK | `src/card-catalog.ts:1958-2091`, `src/game-state-serializer.ts:95-123`. |

## Top Gaps

1. **Combat resolution does not match rule text.** `src/game-engine.ts:8195-8282` compares summed might and wipes the losing side rather than running unit-by-unit damage per rule 443. This skips partial survivors, overkill, and per-unit Tank/Deflect interactions; it is the single largest deviation.
2. **Showdown flow is over-simplified.** There is no first-class `declareBlockers` phase. `resolveCombat` at `src/game-engine.ts:2972-3008` treats "blocked" as a boolean input and lets the caller decide, which leaves rule-book showdown order and reaction windows partially observable but not authoritatively modeled.
3. **Exile zone is declared but never used.** `player.exile` (`src/game-engine.ts:174`) has no push/read sites anywhere; any "exile" card text falls through to graveyard, losing rules-accurate semantics for temporary removal.
4. **Banishment zone is not implemented.** Rule book distinguishes Trash and Banishment (`docs/RULES_SUMMARY.md:38-39`), but every destroy path in the engine routes to `graveyard`, so banished cards can be resurrected by graveyard-based effects.
5. **Support victory points never award.** `support` is listed in `ScoreReason` (`src/game-engine.ts:261`) and described in docs, but `awardVictoryPoints(...'support')` has zero call sites. Cards that grant support points silently do nothing.
6. **Domain identity is not validated at deck load.** The Champion Legend's domains are never cross-checked with main-deck entries (`src/game-engine.ts:879-920`). Illegal decks pass through.
7. **`MIN_DECK_SIZE` is off by one.** Rule book and `docs/RULES_SUMMARY.md:8` say 40; the engine enforces 39 (`src/game-engine.ts:567`). Single-card discrepancy but user-visible on validation.
8. **Battlefield uniqueness across players is unchecked.** Rule 103.4 / engine guide requires the two active battlefields to differ; `src/game-engine.ts:1085-1104` applies selections in order with no cross-player dedupe.
9. **Shielding and Transform taxonomy classes have no runtime operation.** The classifier can tag a card as `shielding` or `transform` (`docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:47-50`), but `src/game-engine.ts` has no shield-charge or transform handler. Those effects silently no-op.
10. **Deck size, 3-copy limit, and Champion-name match are not deck-linted.** None of the construction rules from `docs/RULES_SUMMARY.md:7-14` are enforced at match init beyond minimum card count; illegal decks (4+ copies, mismatched champion names) can start a match.

## Notable Rule Book Ambiguities

- **Stalemate handling in showdown.** The rule book does not explicitly prescribe what happens when both sides field equal might at a contested battlefield. The engine destroys all participating units (`src/game-engine.ts:8248-8260`), which the rule-text does not disprove but also does not confirm.
- **Cleanup discard limit.** `docs/GAME_RULES_IMPLEMENTATION.md:106` still documents a "discard down to 7" step, while `docs/RIFTBOUND_GAME_ENGINE_GUIDE.md:72` states rule 107.6 sets no hand cap. The engine follows the engine-guide interpretation; product should reconcile the two docs.
- **Hidden card timing vs combat.** Rule text is silent on whether a Hidden card can be activated mid-showdown by the defender before blockers are declared. The engine allows it as long as the owner holds combat priority (`src/game-engine.ts:2626-2690`).
- **Gear detaching when host unit leaves play.** The rules imply gear remains attached to a specific unit, but never spell out what happens on exile, bounce, or destruction. The engine leaves gear attached state implicit and does not move the gear to a fallback zone.
- **Universal Power allocation order.** Rule book allows universal power to substitute for any domain but is silent on ordering when multiple alignments satisfy a cost. The engine greedily prefers domain-tagged runes first, then untyped, then any available (`src/champion-utils.ts:106-129`).
- **Champion Legend return to Legend Zone after trigger.** If an effect attempts to "destroy" a Champion Legend, rule text says it cannot leave the Legend Zone, but does not clarify whether the triggering source fizzles. The engine treats the legend as non-movable and silently no-ops removal attempts.
- **Initiative replacement.** The rule book's `turn_structure.first_turn_process` only speaks of a coin flip; the engine implements a Blade/Shield/Ring rock-paper-scissors (`src/game-engine.ts:546-548`). This is not strictly rules-compliant but is game-design intentional.
- **Timeout handling.** `timeout` is declared as a valid end reason (`src/game-engine.ts:507`) but no internal clock fires it; the rule book does not define a specific timeout policy either, so this is deliberately deferred to the match-service layer.
