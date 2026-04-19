# Effect Op Frequency Audit

_Source: `data/cards.enriched.json` (723 cards, enriched 2026-01-16)._

## Extraction rule

Ops were extracted from `card.effectProfile.operations[].type` for every card. Every card in the dataset has this array populated (no zero-op cards). Ops are flat objects with fields `{type, targetHint, zone, automated, ruleRefs, magnitudeHint?, metadata?}`; there are no nested sub-ops. `card.abilities[].operations[]` exists on 232 unit/legend cards but is always a subset of `effectProfile.operations`, so using `effectProfile.operations` is the complete, non-double-counting source. A card with the same op type listed twice in its operations array counts twice in `count`; it counts once in `coverage_impact`.

## Dataset stats

- Total cards scanned: 723
- Cards with at least one op: 723 (100%)
- Total ops counted: 1959
- Distinct op types: 55

## Top 20 ops

| Rank | op_type | count | coverage (cards) | coverage % of cards w/ ops |
|---:|:---|---:|---:|---:|
| 1 | `control_battlefield` | 168 | 168 | 23.2% |
| 2 | `manipulate_priority` | 146 | 146 | 20.2% |
| 3 | `modify_stats` | 131 | 128 | 17.7% |
| 4 | `on_play_trigger` | 117 | 117 | 16.2% |
| 5 | `attach_gear` | 113 | 113 | 15.6% |
| 6 | `draw_cards` | 107 | 107 | 14.8% |
| 7 | `move_unit` | 86 | 86 | 11.9% |
| 8 | `ready` | 69 | 69 | 9.5% |
| 9 | `create_token` | 60 | 60 | 8.3% |
| 10 | `equip_trigger` | 59 | 59 | 8.2% |
| 11 | `remove_permanent` | 51 | 51 | 7.1% |
| 12 | `recycle_card` | 50 | 50 | 6.9% |
| 13 | `conquer_trigger` | 49 | 49 | 6.8% |
| 14 | `combat_bonus` | 49 | 48 | 6.6% |
| 15 | `gain_resource` | 47 | 47 | 6.5% |
| 16 | `keyword_hidden` | 42 | 42 | 5.8% |
| 17 | `channel_rune` | 38 | 38 | 5.3% |
| 18 | `combat_trigger` | 37 | 37 | 5.1% |
| 19 | `deal_damage` | 33 | 33 | 4.6% |
| 20 | `stun` | 31 | 31 | 4.3% |

## Pareto

- Top 24 ops cover 81.1% of total op occurrences (first crossing 80%).
- Top 37 ops cover 95.0% of total op occurrences (first crossing 95%).
- The remaining 18 op types account for the last ~5% of occurrences.

## Breakdown by card type

| Card type | Count of cards | Top 5 ops |
|:---|---:|:---|
| Unit | 359 | `on_play_trigger` (114), `control_battlefield` (93), `modify_stats` (71), `ready` (57), `move_unit` (52) |
| Spell | 144 | `manipulate_priority` (102), `control_battlefield` (38), `draw_cards` (31), `modify_stats` (29), `remove_permanent` (22) |
| Gear | 79 | `attach_gear` (33), `equip_trigger` (31), `manipulate_priority` (20), `draw_cards` (13), `remove_permanent` (11) |
| Legend | 77 | `modify_stats` (18), `control_battlefield` (17), `manipulate_priority` (12), `gain_resource` (12), `channel_rune` (12) |
| Battlefield | 43 | `control_battlefield` (17), `conquer_trigger` (13), `hold_trigger` (10), `draw_cards` (7), `create_token` (4) |
| Rune | 18 | `rune_resource` (18) |
| Token | 3 | `modify_stats` (2), `gain_resource` (1), `remove_permanent` (1), `channel_rune` (1), `manipulate_priority` (1) |

## Long-tail callouts (ops on exactly 1 card)

| op_type | count | card |
|:---|---:|:---|
| `hide_modifier` | 1 | OGN-278 |

## Open questions / ambiguities

Possible semantic overlaps (same verb stem across multiple op types):

- `trigger`: `on_play_trigger`, `equip_trigger`, `conquer_trigger`, `combat_trigger`, `death_trigger`, `hold_trigger`, `phase_trigger`
- `cards`: `draw_cards`, `discard_cards`
- `unit`: `move_unit`, `summon_unit`
- `resource`: `gain_resource`, `rune_resource`
- `buff`: `aura_buff`, `conditional_buff`
- `restriction`: `scoring_restriction`, `play_restriction`

Ops whose semantics are not obvious from the name alone (flagged for design review before registry implementation):

- `manipulate_priority` (146 cards)
- `control_battlefield` (168 cards)
- `combat_bonus` (48 cards)
- `equip_trigger` (59 cards)
- `on_play_trigger` (117 cards)
- `conquer_trigger` (49 cards)
- `recycle_card` (50 cards)

The following ops look like trigger markers (they classify *when* an effect fires, not *what* it does); the dispatcher may want to route them to a subscription layer rather than a handler:

- `on_play_trigger` (117 cards)
- `equip_trigger` (59 cards)
- `conquer_trigger` (49 cards)
- `combat_trigger` (37 cards)
- `death_trigger` (25 cards)
- `hold_trigger` (24 cards)
- `phase_trigger` (19 cards)

