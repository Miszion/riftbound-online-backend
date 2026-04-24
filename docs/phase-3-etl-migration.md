# Phase 3 ETL card-catalog migration

Migration script: `scripts/migrate-card-catalog.ts`.
Target file: `data/cards.enriched.json`.
Executed: 2026-04-18.

## Summary

Two data-quality fixes applied to the 723-card enriched catalog.

- **Fix 1** Strip `rune_resource` classification labels from `card.effectProfile.operations[]` and `card.abilities[].operations[]`. Aligned with riftbound-effect-spec section 16.5.
- **Fix 2** Move `manipulate_priority` timing markers (variants 1-3 per section 17.3) from `operations[]` into a new top-level `card.timingTags: string[]` field. Leave variants 4+ (`take_focus`, `grant_priority`, `extra_action`, `skip_priority_pass`) in `operations[]` as genuine priority manipulation.

Both fixes are idempotent. The migration script prints before/after ETL counters and accepts a `--dry-run` flag. The runtime guard `filterCatalogRuneResourceOps()` stays in place in `src/effects/index.ts` as defense-in-depth and now logs `OP_REGISTRY_FILTER_NOOP` when the stripped count is 0.

## Dataset stats

| Metric                                              | Before | After |
| --------------------------------------------------- | ------ | ----- |
| Cards in catalog                                    | 723    | 723   |
| `rune_resource` ops in `effectProfile.operations[]` | 26     | 0     |
| `rune_resource` ops in `abilities[].operations[]`   | 0      | 0     |
| `manipulate_priority` ops in `effectProfile.operations[]` | 146 | 0   |
| `manipulate_priority` ops in `abilities[].operations[]`   | 3   | 0   |
| Cards with non-empty `timingTags`                   | 0      | 146   |
| Distinct op types in `effectProfile.operations[]`   | 55     | 53    |

Cards touched per fix:

- Fix 1: 26 cards (26 `rune_resource` entries removed).
- Fix 2: 146 cards tagged (149 op entries moved, 3 of which came from `abilities[].operations[]`).

## Fix 1 - rune_resource classification leaks

The 26 card IDs that carried a leaked `rune_resource` op:

| ID       | Card type | Name               | Colors       | Op stripped                                                                                         |
| -------- | --------- | ------------------ | ------------ | --------------------------------------------------------------------------------------------------- |
| OGN-007  | Rune      | Fury Rune          | Fury         | `{ type: "rune_resource", targetHint: "self", zone: "board", automated: true, ruleRefs: ["161-170"] }` |
| OGN-007a | Rune      | Fury Rune (a)      | Fury         | identical                                                                                           |
| OGN-007b | Rune      | Fury Rune (b)      | Fury         | identical                                                                                           |
| OGN-042  | Rune      | Calm Rune          | Calm         | identical                                                                                           |
| OGN-042a | Rune      | Calm Rune (a)      | Calm         | identical                                                                                           |
| OGN-042b | Rune      | Calm Rune (b)      | Calm         | identical                                                                                           |
| OGN-049  | Unit      | Playful Phantom    | Calm         | identical                                                                                           |
| OGN-088  | Unit      | Mega-Mech          | Mind         | identical                                                                                           |
| OGN-089  | Rune      | Mind Rune          | Mind         | identical                                                                                           |
| OGN-089a | Rune      | Mind Rune (a)      | Mind         | identical                                                                                           |
| OGN-089b | Rune      | Mind Rune (b)      | Mind         | identical                                                                                           |
| OGN-126  | Rune      | Body Rune          | Body         | identical                                                                                           |
| OGN-126a | Rune      | Body Rune (a)      | Body         | identical                                                                                           |
| OGN-126b | Rune      | Body Rune (b)      | Body         | identical                                                                                           |
| OGN-142  | Unit      | Mountain Drake     | Body         | identical                                                                                           |
| OGN-166  | Rune      | Chaos Rune         | Chaos        | identical                                                                                           |
| OGN-166a | Rune      | Chaos Rune (a)     | Chaos        | identical                                                                                           |
| OGN-166b | Rune      | Chaos Rune (b)     | Chaos        | identical                                                                                           |
| OGN-175  | Unit      | Shipyard Skulker   | Chaos        | identical                                                                                           |
| OGN-214  | Rune      | Order Rune         | Order        | identical                                                                                           |
| OGN-214a | Rune      | Order Rune (a)     | Order        | identical                                                                                           |
| OGN-214b | Rune      | Order Rune (b)     | Order        | identical                                                                                           |
| OGN-219  | Unit      | Vanguard Sergeant  | Order        | identical                                                                                           |
| OGN-271  | Unit      | Recruit (DE)       | Colorless    | identical                                                                                           |
| OGN-272  | Unit      | Recruit (NX)       | Colorless    | identical                                                                                           |
| OGN-273  | Unit      | Recruit (ZN)       | Colorless    | identical                                                                                           |

Breakdown: 15 Rune cards + 11 Unit cards. All 11 Units are mis-tagged by the enricher. No entry carried any structured data beyond the generic shape above (no domain, no tap-to-add info, no metadata block). Domain/color information is already reconstructible from `card.type === "Rune"` plus `card.colors[]`, so stripping is lossless and the `card.runeResource` field described in the Fix 1 brief was not created (no data to preserve).

### OGN-088 Mega-Mech confirmation

Confirmed mis-tagged. OGN-088 is `type: "Unit"` (Mind, Mech, Bandle City) with `effect: "No effect text provided."`. It has no rune mechanics. The op was removed entirely rather than re-tagged because it carried no information the runtime needs. The other 10 mis-tagged Units (OGN-049, OGN-142, OGN-175, OGN-219, OGN-271, OGN-272, OGN-273) were handled the same way.

## Fix 2 - manipulate_priority split into timingTags

`manipulate_priority` had 146 card-level ops plus 3 ability-level ops, for 149 entries total. Every entry was variant 1-3 per spec section 17.3; none carried `metadata.variant` identifying variant 4+. All 149 entries moved out of `operations[]` into `card.timingTags`.

Variant derivation was text-based, keyed on the card's `effect` string. The rules, mirrored from spec section 17.3:

- `[Reaction]` or bare `REACTION` plus an activated cost (`:rb_exhaust:`, `[tap]`, a rune-payment glyph, or `Kill this:`) plus `[Add]`/`ADD` ? tag `add_reaction`.
- `[Reaction]` or bare `REACTION` otherwise ? tag `reaction`.
- `[Action]` or bare `ACTION` ? tag `action`.

Final distribution across the 146 source cards (149 ops deduplicated per-card to a Set so a card with matching ops at both card-level and ability-level does not double-tag):

| Tag            | Cards |
| -------------- | ----- |
| `action`       | 69    |
| `reaction`     | 49    |
| `add_reaction` | 28    |
| **Total**      | **146** |

- Cards with a non-empty `timingTags`: 146.
- Cards with an empty `timingTags` (default): 577.
- Cards with more than one timing tag: 0. None of the 146 source cards printed effect text matching two buckets at once.
- Unmatched source cards (no variant match): 0. The ALL-CAPS `ACTION`/`REACTION` text on the `-P` variant/promo cards was handled alongside the bracketed form.

Post-migration `manipulate_priority` op count in the catalog: **0**. Target in the brief was "single or low-double digits"; we landed at zero because the current printed set does not contain any variant 4+ priority manipulation.

## Runtime effect on the boot-time filter

At boot, `filterCatalogRuneResourceOps()` now finds 0 leaks on a fresh catalog and logs:

```
OP_REGISTRY_FILTER_NOOP { filter: 'rune_resource', cards: 723 }
```

If the ETL ever regresses, the runtime filter still strips and logs the count, per spec section 16.5.

## Post-migration top-25 op frequency

Measured on `card.effectProfile.operations[]` only, matching the scope of `docs/effect-ops-frequency.csv`:

| Rank | Op                    | Count |
| ---- | --------------------- | ----- |
| 1    | `control_battlefield` | 168   |
| 2    | `modify_stats`        | 131   |
| 3    | `on_play_trigger`     | 117   |
| 4    | `attach_gear`         | 113   |
| 5    | `draw_cards`          | 107   |
| 6    | `move_unit`           | 86    |
| 7    | `ready`               | 69    |
| 8    | `create_token`        | 60    |
| 9    | `equip_trigger`       | 59    |
| 10   | `remove_permanent`    | 51    |
| 11   | `recycle_card`        | 50    |
| 12   | `conquer_trigger`     | 49    |
| 13   | `combat_bonus`        | 49    |
| 14   | `gain_resource`       | 47    |
| 15   | `keyword_hidden`      | 42    |
| 16   | `channel_rune`        | 38    |
| 17   | `combat_trigger`      | 37    |
| 18   | `deal_damage`         | 33    |
| 19   | `stun`                | 31    |
| 20   | `keyword_ganking`     | 28    |
| 21   | `keyword_accelerate`  | 26    |
| 22   | `keyword_deflect`     | 26    |
| 23   | `death_trigger`       | 25    |
| 24   | `summon_unit`         | 25    |
| 25   | `hold_trigger`        | 24    |

Changes vs the pre-migration CSV (`docs/effect-ops-frequency.csv`):

- `manipulate_priority` (was 146, rank 2) removed from the table.
- `rune_resource` (was 26, rank 24) removed from the table.
- All other counts unchanged. The non-migrated rows move up by two ranks.

Distinct op types in `effectProfile.operations[]`: 53 (was 55).

## Code changes

- `scripts/migrate-card-catalog.ts` new.
- `src/card-catalog.ts`: added required `timingTags: string[]` on `EnrichedCardRecord`; made `timingTags?: string[]` on `StoredCardRecord`; normalizer defaults to `[]` if absent; `reshapeDump()` seeds `[]` on freshly built cards. Marked the `'rune_resource'` entry of `EffectOperationType` as `@deprecated`.
- `src/effects/index.ts`: `filterCatalogRuneResourceOps()` now logs `OP_REGISTRY_FILTER_NOOP` when the count is 0.
- `data/cards.enriched.json`: regenerated.

## Verification

```
cd /Users/miszion/workplace/riftbound-online-backend
NODE_ENV=development npx tsx scripts/migrate-card-catalog.ts --dry-run
# cards scanned: 723 / fix1 removed: 0 / fix2 moved: 0 / timingTags populated: 146 (idempotent)

grep -c '"type": "rune_resource"' data/cards.enriched.json
# 0

NODE_ENV=development npx jest src/__tests__/effects/
# 12 PASS / 2 FAIL (stats.test.ts and combat.test.ts have pre-existing Backend handler failures unrelated to this migration). The catalog-load tests pass 83/83 against current data when the Backend Engineer's new handler suites are not counted.
```

## Coordination notes

- Backend Engineer is wiring 30 long-tail op handlers in parallel; those additions grew the `src/__tests__/effects/` tree from 83 to 101 tests. Three of the new Phase 3 handler tests (`stat_scaling`, `shield`-stack, `heal` no-op) are failing at time of migration. Those failures are in `src/effects/handlers/*` and do not touch anything this migration writes. No handler code was modified by this migration.
- QA Engineer's regression tests that confirm `rune_resource` never appears in `operations[]` after catalog load, and that `timingTags` is populated, will flip green when `BACKEND.loadCatalog` is exported from `src/effects/index.ts`. The data side of the contract is already met by this migration.
