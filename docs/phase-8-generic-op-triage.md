# Phase 8c Triage: catch-all op spike

_Source: `data/cards.enriched.json` pre- and post-Phase-8c regeneration._

## Summary

In the Phase-one catalog, four cards carried the catch-all op. In the Phase-seven catalog (pre-8c), the count was fifty-two. The Phase-8c catalog (post-fix) has six cards with the catch-all op. Target for this phase: six cards.

The forty-eight new catch-all cards (delta between Phase one and Phase seven) split cleanly into two buckets. One classifier miss accounted for forty-six of the forty-eight cards, and that miss is fixed in this phase. Six cards remain as long-tail classifier misses scoped for Phase nine.

| Bucket                                            | Count | Action                                            |
|:--------------------------------------------------|------:|:--------------------------------------------------|
| Empty effect text ("No effect text provided.")    |    46 | Fixed in 8c: enricher emits zero ops for empty text |
| "Deal N to a unit" pattern (no "damage" word)     |    3  | Long-tail: fix in Phase 9 (`deal_damage` regex)   |
| Conditional combat buff / level-gated buff        |    2  | Long-tail: extend `combat_bonus` / `conditional_buff` |
| "Deals damage equal to..." (plural verb)          |    1  | Long-tail: fix damage regex to accept `deals`     |

## Root cause (Phase 5a fallout)

`docs/phase-7-coverage-audit.md` flagged the thirteen-x spike. The spike is entirely explained by Phase-5a.

In Phase one, the enricher matched the `rune_type` class on any card whose effect text was blank or the placeholder string "No effect text provided.". That class emitted a `rune_resource` op, which kept thirty-six blank-text Rune cards plus ten blank-text Unit cards out of the catch-all bucket.

Phase 5a (see the enricher-fix spec in `docs/`) removed the `rune_type` class because it was firing on Unit cards too and producing twenty-six mis-tagged `rune_resource` ops. The fix correctly deleted the classifier, but the blank-text cards then fell through to `matchEffectClasses` and received one catch-all op per card via the `GENERIC_EFFECT_CLASS` fallback. That is the entire forty-six-card contribution.

## Fix landed in Phase 8c

Added `isEmptyEffectText(text)` in both `scripts/data/transformChampionDump.ts` and `src/card-catalog.ts`. `buildEffectProfile` short-circuits for blank input and returns:

```
{ classes: [], primaryClass: null, operations: [], targeting: {...}, references: [], reliability: 'exact' }
```

This is the correct shape. A Rune with no printed effect text has no ops to dispatch, and a vanilla Unit like `OGN-271 Recruit (DE)` should be zero-op at the catalog level. `isRuneResource` (Phase 5a) already flags Rune cards at the record level for runtime systems that need it.

## Residual six cards (true classifier misses, scoped for Phase nine)

Pre-Phase-8c these were already in the Phase-one baseline of four plus two new non-empty-text misses. Top miss is the `deal_damage` regex (four of the six cards) followed by combat-buff variants (two cards).

| card_id   | type  | name                | effect_text_excerpt                                                                                              | recommended_op                      |
|:----------|:------|:--------------------|:-----------------------------------------------------------------------------------------------------------------|:------------------------------------|
| OGN-029   | Spell | Falling Star        | "Deal 3 to a unit."                                                                                              | `deal_damage`                       |
| OGN-248   | Spell | Icathian Rain       | "Deal 2 to a unit." repeated six times                                                                           | `deal_damage`                       |
| OGN-105   | Spell | Singularity         | "Deal 6 to each of up to two units."                                                                             | `deal_damage`                       |
| SFD-107   | Spell | Strike Down         | "...It deals damage equal to its Might to an enemy unit. Then detach an Equipment from it."                      | `deal_damage` + `attach_gear`       |
| UNL-154   | Unit  | Crimson Pigeons     | "I have +2 :rb_might: while I'm attacking with another unit."                                                    | `combat_bonus` (+conditional)       |
| UNL-098   | Unit  | Targonian Visionary | "[Level 11][>] I have +4 :rb_might:. (While you have 11+ XP, get the effect.)"                                   | `conditional_buff` / `stat_scaling` |

## Classifier-miss frequency (top three misses among the six residual cards)

| missed_op          | count | leverage                                                        |
|:-------------------|------:|:----------------------------------------------------------------|
| `deal_damage`      |     4 | Fix regex to accept "Deal N to" (no "damage" word) plus the plural verb "deals"; captures all four |
| `combat_bonus`     |     1 | Existing `/\+\d+.*:rb_might:.*while.*attacker/i` misses "while I'm attacking with another unit" phrasing |
| `conditional_buff` |     1 | Existing `/\bwhile\s+there\s+are?\s+\d+\b/i` misses `[Level N]` gating |

Top-one miss (`deal_damage`) covers four cards, below the ten-card threshold in the Phase 8c brief, so it is NOT fixed in this phase. It is scoped for Phase nine alongside the other two misses.

### Proposed Phase-nine regex patches (informational only)

```ts
// scripts/data/transformChampionDump.ts + src/card-catalog.ts EFFECT_CLASS_DEFINITIONS
// id: 'damage'
patterns: [
  /\bdeals?\b.*\bdamage\b/i,     // accept deal AND deals
  /\bdeals?\s+\d+\s+to\b/i,      // "Deal 3 to a unit"
  /\bstrike\b/i,
  /\bblast\b/i,
  /\bburn\b/i
]
```

```ts
// id: 'combat_bonus'
patterns: [
  /\[Assault\b/i,
  /\bASSAULT\b/i,
  /\+\d+.*:rb_might:.*while.*(attacker|attacking)/i,
  /\+\d+.*might.*while.*(attacker|attacking)/i
]
```

```ts
// id: 'conditional_buff' (or new id: 'level_gated_buff')
patterns: [
  /\bwhile\s+you\s+have\s+another\s+unit\b/i,
  /\bwhile\s+.*\s+is\s+in\s+combat\b/i,
  /\bwhile\s+I'?m\s+in\s+combat\b/i,
  /\bwhile\s+there\s+are?\s+\d+\b/i,
  /\[Level\s+\d+\]/i
]
```

## Cross-reference: Phase-one top-four vs Phase-8c residual top-four

Phase-one baseline card ids: OGN-029, OGN-248, OGN-105, SFD-107.

Phase-8c residual list (post-fix): OGN-029, OGN-248, OGN-105, SFD-107 (identical to the Phase-one baseline), plus two new entrants UNL-154 and UNL-098 from the UNL set that did not exist in the Phase-one dataset. The Phase-8c fix fully reverses the Phase-5a regression: the set of cards in the catch-all bucket is now a superset of the Phase-one baseline by exactly two cards, both of which are genuine new classifier misses on genuinely new content.

## Post-fix counts

| Metric                                            | Phase one | Phase seven | Phase 8c |
|:--------------------------------------------------|----------:|------------:|---------:|
| Cards with the catch-all op                       |         4 |          52 |        6 |
| Cards with `manipulate_priority` op               |       146 |           4 |        0 |
| Cards with non-empty `timingTags`                 |         0 |         207 |      207 |

## Recommendation

- Phase 8c lands the one high-leverage fix (empty-text short-circuit, forty-six cards).
- Phase nine picks up the three long-tail regex tweaks above (six cards total, all in `src/card-catalog.ts` and `scripts/data/transformChampionDump.ts` EFFECT_CLASS_DEFINITIONS).
- The catch-all handler registry entry is correct (defers to human intervention); the enricher just shouldn't be flagging empty-text cards as needing one.

## Machine-parseable target

post-triage generic op count: 6
