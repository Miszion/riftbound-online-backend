# Phase 7 Coverage Audit

_Source: `data/cards.enriched.json` (1085 cards, regenerated 2026-04-19T03:28:03.221Z)._ Phase-1 baseline: `docs/effect-ops-frequency.csv` (723 cards).

## Extraction rule

Ops were extracted from `card.effectProfile.operations[].type` for every card. Cards lacking `effectProfile` contribute zero ops but still count in "cards scanned". Duplicates within a card count N times in `count` and once in `coverage_impact`. Sub-ops are not nested in this catalog, so extraction is flat. The catalog was scanned in a single pass; no double-counting from `card.abilities[].operations[]` which is a subset of `effectProfile.operations`.

## 1. Dataset comparison

| Metric | Phase 1 | Phase 7 | Delta |
|:---|---:|---:|---:|
| Cards scanned | 723 | 1085 | +362 (+50.1%) |
| Cards with effectProfile | 723 | 1085 | +362 |
| Cards with at least one op | 723 | 1049 | +326 |
| Total ops | 1959 | 2754 | +795 |
| Distinct op types | 55 | 55 | +0 |

## 2. Op-set delta

### 2.1 Ops in Phase-1 but absent in Phase-7 (deletion candidates from the catalog side)

| op_type | phase1_count |
|:---|---:|
| `rune_resource` | 26 |

### 2.2 Ops in Phase-7 but absent in Phase-1 (enricher introduced)

These are net-new op types emitted by the enricher on the expanded card pool. If any of these are NOT in the registry, they are a handler coverage gap (see section 4).

| op_type | phase7_count | in_registry | example_cards |
|:---|---:|:---:|:---|
| `transform` | 1 | NO | UNL-081 |

### 2.3 Ops present in both, sorted by absolute delta

Top 25 movers (both growth and shrinkage).

| op_type | phase1 | phase7 | abs_delta | pct_delta |
|:---|---:|---:|---:|---:|
| `manipulate_priority` | 146 | 4 | -142 | -97.3% |
| `control_battlefield` | 168 | 285 | +117 | 69.6% |
| `draw_cards` | 107 | 167 | +60 | 56.1% |
| `move_unit` | 86 | 141 | +55 | 64.0% |
| `modify_stats` | 131 | 185 | +54 | 41.2% |
| `generic` | 4 | 52 | +48 | 1200.0% |
| `create_token` | 60 | 107 | +47 | 78.3% |
| `remove_permanent` | 51 | 98 | +47 | 92.2% |
| `ready` | 69 | 110 | +41 | 59.4% |
| `on_play_trigger` | 117 | 157 | +40 | 34.2% |
| `attach_gear` | 113 | 151 | +38 | 33.6% |
| `conquer_trigger` | 49 | 81 | +32 | 65.3% |
| `combat_bonus` | 49 | 73 | +24 | 49.0% |
| `stun` | 31 | 55 | +24 | 77.4% |
| `keyword_deflect` | 26 | 50 | +24 | 92.3% |
| `equip_trigger` | 59 | 81 | +22 | 37.3% |
| `summon_unit` | 25 | 47 | +22 | 88.0% |
| `phase_trigger` | 19 | 41 | +22 | 115.8% |
| `deal_damage` | 33 | 54 | +21 | 63.6% |
| `hold_trigger` | 24 | 44 | +20 | 83.3% |
| `keyword_ganking` | 28 | 46 | +18 | 64.3% |
| `recycle_card` | 50 | 66 | +16 | 32.0% |
| `death_trigger` | 25 | 41 | +16 | 64.0% |
| `cost_reduction` | 24 | 38 | +14 | 58.3% |
| `keyword_hidden` | 42 | 54 | +12 | 28.6% |

## 3. Handler coverage gap

Cross-reference against the 55 registered handlers in `src/effects/index.ts::buildDefaultRegistry()`. Each row is one registered handler and how many cards in the current catalog emit its op.

| handler_op | cards_using | ops_emitted | status |
|:---|---:|---:|:---|
| `control_battlefield` | 285 | 285 | active |
| `modify_stats` | 182 | 185 | active |
| `draw_cards` | 167 | 167 | active |
| `on_play_trigger` | 157 | 157 | active |
| `attach_gear` | 151 | 151 | active |
| `move_unit` | 141 | 141 | active |
| `ready` | 110 | 110 | active |
| `create_token` | 107 | 107 | active |
| `remove_permanent` | 98 | 98 | active |
| `equip_trigger` | 81 | 81 | active |
| `conquer_trigger` | 81 | 81 | active |
| `combat_bonus` | 71 | 73 | active |
| `recycle_card` | 66 | 66 | active |
| `stun` | 55 | 55 | active |
| `deal_damage` | 54 | 54 | active |
| `keyword_hidden` | 54 | 54 | active |
| `generic` | 52 | 52 | active |
| `keyword_deflect` | 50 | 50 | active |
| `combat_trigger` | 49 | 49 | active |
| `gain_resource` | 47 | 47 | active |
| `summon_unit` | 47 | 47 | active |
| `keyword_ganking` | 46 | 46 | active |
| `hold_trigger` | 44 | 44 | active |
| `death_trigger` | 41 | 41 | active |
| `phase_trigger` | 41 | 41 | active |
| `cost_reduction` | 38 | 38 | active |
| `keyword_accelerate` | 36 | 36 | active |
| `return_to_hand` | 36 | 36 | active |
| `channel_rune` | 35 | 35 | active |
| `shield` | 34 | 34 | active |
| `discard_cards` | 32 | 32 | active |
| `keyword_tank` | 28 | 28 | active |
| `tribal_synergy` | 28 | 28 | active |
| `scoring` | 25 | 25 | active |
| `keyword_repeat` | 25 | 25 | active |
| `keyword_weaponmaster` | 19 | 19 | active |
| `keyword_legion` | 17 | 17 | active |
| `cost_increase` | 16 | 16 | active |
| `aura_buff` | 14 | 14 | active |
| `interact_legend` | 11 | 11 | active |
| `return_from_graveyard` | 11 | 11 | active |
| `effect_amplifier` | 11 | 11 | active |
| `location_aura` | 10 | 10 | active |
| `heal` | 10 | 10 | active |
| `play_restriction` | 8 | 8 | active |
| `solo_combat` | 6 | 6 | active |
| `manipulate_priority` | 4 | 4 | long-tail |
| `stat_scaling` | 4 | 4 | long-tail |
| `ability_copy` | 4 | 4 | long-tail |
| `targeting_discount` | 2 | 2 | long-tail |
| `follow_movement` | 2 | 2 | long-tail |
| `conditional_buff` | 2 | 2 | long-tail |
| `hide_modifier` | 2 | 2 | long-tail |
| `scoring_restriction` | 1 | 1 | long-tail |
| `rune_resource` | 0 | 0 | DELETION-CANDIDATE |

Totals: 46 active, 8 long-tail (1-4 cards), 1 deletion-candidate (0 cards).

## 4. New ops (catalog emits them, no registered handler)

These ops will hit the unknown-op soft-fail path in the dispatcher if a card using them is played at runtime. Backend Engineer should add handlers or the enricher should stop emitting them.

| op_type | count | cards_using | example_cards |
|:---|---:|---:|:---|
| `transform` | 1 | 1 | UNL-081 |

### 4.1 Ops in catalog not referenced by spec section 18 union or registered handler

Documentation gap. These op types appear in `effectProfile.operations` but are not in the Section-18 `RiftboundOp` union and not in `buildDefaultRegistry`.

| op_type | count | example_cards |
|:---|---:|:---|
| `transform` | 1 | UNL-081 |

## 5. Top-25 shift (Phase-1 vs Phase-7)

| Rank | Phase-1 op | P1 count | Phase-7 op | P7 count | Rank change (P7 op) |
|---:|:---|---:|:---|---:|---:|
| 1 | `control_battlefield` | 168 | `control_battlefield` | 285 | +0 |
| 2 | `manipulate_priority` | 146 | `modify_stats` | 185 | +1 |
| 3 | `modify_stats` | 131 | `draw_cards` | 167 | +3 |
| 4 | `on_play_trigger` | 117 | `on_play_trigger` | 157 | +0 |
| 5 | `attach_gear` | 113 | `attach_gear` | 151 | +0 |
| 6 | `draw_cards` | 107 | `move_unit` | 141 | +1 |
| 7 | `move_unit` | 86 | `ready` | 110 | +1 |
| 8 | `ready` | 69 | `create_token` | 107 | +1 |
| 9 | `create_token` | 60 | `remove_permanent` | 98 | +2 |
| 10 | `equip_trigger` | 59 | `conquer_trigger` | 81 | +3 |
| 11 | `remove_permanent` | 51 | `equip_trigger` | 81 | -1 |
| 12 | `recycle_card` | 50 | `combat_bonus` | 73 | +2 |
| 13 | `conquer_trigger` | 49 | `recycle_card` | 66 | -1 |
| 14 | `combat_bonus` | 49 | `stun` | 55 | +6 |
| 15 | `gain_resource` | 47 | `deal_damage` | 54 | +4 |
| 16 | `keyword_hidden` | 42 | `keyword_hidden` | 54 | +0 |
| 17 | `channel_rune` | 38 | `generic` | 52 | +29 |
| 18 | `combat_trigger` | 37 | `keyword_deflect` | 50 | +6 |
| 19 | `deal_damage` | 33 | `combat_trigger` | 49 | -1 |
| 20 | `stun` | 31 | `gain_resource` | 47 | -5 |
| 21 | `keyword_ganking` | 28 | `summon_unit` | 47 | +5 |
| 22 | `keyword_accelerate` | 26 | `keyword_ganking` | 46 | -1 |
| 23 | `rune_resource` | 26 | `hold_trigger` | 44 | +4 |
| 24 | `keyword_deflect` | 26 | `death_trigger` | 41 | +1 |
| 25 | `death_trigger` | 25 | `phase_trigger` | 41 | +8 |

## 6. Pareto refresh

Phase-1: Top 24 crossed 80%; top 37 crossed 95%.
Phase-7: Top 24 crosses 80%; top 36 crosses 95% of 2754 total op occurrences.

### Deletion candidates (safe to delete)

Registered handlers with zero cards emitting the op in the current catalog. Backend Engineer uses this list in a follow-up pass; this analysis does not delete anything.

| handler | op | impl | tests | recommendation |
|:---|:---|:---|:---|:---|
| `runeResourceHandler` | `rune_resource` | `src/effects/handlers/runes.ts` | catalog-load.test.ts, etl-migration.test.ts, runes.test.ts | keep (covered by directed test; handler is ready if a card shows up) |

