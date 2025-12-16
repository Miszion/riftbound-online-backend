# Riftbound Engine Automation Guide

This document consolidates the automation expectations captured from `RIFTBOUND_RULES_FLAT.txt`, `RIFTBOUND_RULES_PARSED.json`, and the current champion dump. Use it as the canonical reference when wiring the backend driven game loop.

## Phase & Priority Responsibilities

The backend drives every deterministic portion of the turn structure while surfacing human choices as prompts. Rule references\* are provided for traceability.

One-time pre-game responsibilities:

1. **Setup & Deck Validation** (`103-118`): validate Champion Legend identity, rune/battlefield quotas, and enforce unique battlefield requirement before shuffling decks.
2. **Coin-Flip Window** (`115`): randomly determine who goes first. Record results because the player who goes second channels three runes during their first Channel Phase instead of the usual two (see `docs/RIFTBOUND_RULES_PARSED.json -> turn_structure.first_turn_process`).
3. **Battlefield Draft** (`103.4`, `113`): after decks are loaded, surface a battlefield selection prompt per player. Each user chooses one card from their legal battlefield pool; if only one option exists the engine auto-selects. Only the first two selections become active for the match.
4. **Mulligan Window** (`117`): after drawing four cards per player automatically, emit mulligan prompts that allow each player to select up to two cards. The engine handles recycling (rule `403`) and redraws.

Per-turn loop (repeats until a player wins):

5. **Beginning Phase** (`161-210`, `735-742`): awaken/untap permanents, channel two runes (three for the player who lost the coin flip on their very first Channel Phase), refresh temporary effects, score "Temporary" triggers, and advance to Main 1. These steps never require user confirmation.
6. **Main Phases** (`346-369`): maintain a priority window for the turn player. Human actions (play, activate, move, pass) resolve through prompts, while cost payments, targeting legality, and trigger fan-out are enforced server-side. There are two main phases each turn—Main 1 precedes combat and Main 2 follows combat.
7. **Combat Phase** (`437-450`, `735-741`): combat is only staged when a player moves a unit to a contested battlefield (rule `184` and `437`). The engine emits prompts for attackers/blockers, opens reaction windows before each showdown, and assigns damage strictly between units (rule `443`).
8. **Reaction Windows** (`739`, `737`, `745`): every Action that resolves during a Closed State automatically triggers a reaction prompt for the opponent. The backend tracks who currently has priority and when a window closes.
9. **End & Cleanup** (`318`, `742`): execute end-of-turn triggers, expire temporary buffs, and rotate turn order. The engine snapshots the state for replay persistence.

\*Rule numbers reference the parsed JSON file to keep numbering stable across docs.

## Effect Taxonomy Overview

Running the classifier across `champion-dump.json` produced the following deterministic classes. Each class drives a default operation that the engine can use for automation and prompt generation.

| Class ID | Description | Default Operation | Rule Refs |
| --- | --- | --- | --- |
| `card_draw` | Adds cards to hand or manipulates top of deck | `draw_cards` (self, deck) | `409-410`, `743` |
| `card_discard` | Forces player to discard | `discard_cards` (enemy, hand) | `346`, `407` |
| `resource_gain` | Generates energy/power/runes | `gain_resource` (self) | `161-170` |
| `buff` | Grants positive stat/counter mods | `modify_stats` (ally) | `430-450` |
| `debuff` | Applies negative stat mods | `modify_stats` (enemy) | `430-450` |
| `damage` | Deals damage to units only | `deal_damage` (enemy) | `437`, `500-520` |
| `heal` | Restores health/removes damage | `heal` (ally) | `520-530` |
| `summon` | Plays or creates non-token units | `summon_unit` (ally) | `340-360` |
| `token` | Creates unit tokens/copies | `create_token` (ally) | `340-360` |
| `movement` | Moves or swaps cards/battlefields | `move_unit` (ally) | `430`, `737` |
| `battlefield_control` | Captures / contests battlefields | `control_battlefield` | `106`, `437` |
| `removal` | Destroys, kills, or banishes | `remove_permanent` (enemy) | `500-520`, `716` |
| `recycle` | Recycles/shuffles cards | `recycle_card` (self) | `403`, `409` |
| `search` | Tutors or looks through a deck | `search_deck` (self) | `346`, `409` |
| `rune` | Channels or manipulates runes | `channel_rune` (self) | `161-170`, `132.5` |
| `legend` | Interacts with Champion Legends / Leaders | `interact_legend` | `103-107`, `132.6` |
| `priority` | Alters timing, priority, or reaction access | `manipulate_priority` | `117`, `346`, `739` |
| `shielding` | Prevents or redirects damage | `shield` (ally) | `735-742` |
| `attachment` | Equips or attaches gear | `attach_gear` (ally) | `716`, `744` |
| `transform` | Transforms a unit / swaps forms | `transform` (any) | `430-450` |
| `mulligan` | Adjusts mulligan/starting hand rules | `adjust_mulligan` | `117` |
| `generic` | Fallback when no heuristics match | `generic` | `000-055` |

The classifier also infers target hints (`friendly`, `enemy`, `battlefield`) and priority hints (`main`, `reaction`, `combat`, `setup`) for every card. Refer to `data/effect-taxonomy.json` (generated via `npm run generate:taxonomy`) for an up-to-date snapshot.

## Prompt Expectations

All human decisions are surfaced as prompts via GraphQL subscriptions:

- **Battlefield Prompt**: emitted during setup with each player's legal battlefield options. If only one card is legal the engine auto-resolves, otherwise the selection is persisted before mulligans start.
- **Mulligan Prompt**: includes cards drawn, maximum mulligans allowed, deadline.
- **Action Prompt**: enumerates allowed Game Actions (play, activate, move, pass) given the effect profile and current resources.
- **Target Prompt**: for effects marked `targeting.requiresSelection`, includes filtered legal targets per `TargetHint`.
- **Reaction Prompt**: emitted whenever `priority` class is detected or when keywords grant Reaction timing. Contains countdown timers for priority passes.

Every prompt resolution is persisted alongside the full game state so replays can deterministically rebuild the match timeline.

## Rule Clarifications

- **Damage is unit-only**: Combat step `443` (see `docs/RIFTBOUND_RULES_PARSED.json:225-256`) requires attacking and defending units to assign lethal damage before anything else. The engine now rejects attempts to damage players, battlefields, or gear.
- **No maximum hand size**: Section `107.6` (`docs/RIFTBOUND_RULES_FLAT.txt`) describes hand privacy/count transparency but never establishes a cap. Cleanup therefore no longer discards down—players can hold any number of cards unless a specific effect says otherwise.

---

*This guide will evolve as additional rulings or card batches are ingested. Always cross-reference with the parsed rules JSON when introducing new mechanics.*
