# Phase 10 - Long-tail Op Findings

_Reviewer: QA + Backend pair. Source catalog: `data/cards.enriched.json` (1085 cards, 2026-04-19T03:28:03.221Z)._

Phase 10 cross-references the 8 long-tail ops flagged in `docs/phase-7-coverage-audit.md` section 3 against the live enriched catalog and the handler implementations. Per-op findings below. Paired unit + integration tests live in `src/__tests__/effects/long-tail-ops.test.ts`.

## Methodology

For each op:

1. Located the handler in `src/effects/handlers/` and read its contract (patches it emits, log entries, idempotency, zone/target resolution).
2. Queried `data/cards.enriched.json` for real cards whose `effectProfile.operations[].type` equals the op name.
3. Wrote a directed unit test that constructs the minimum ctx needed and asserts the exact patch shape / log entry kind produced.
4. Wrote an integration test that spreads the real op object from the fixture (or enriched catalog) through `BACKEND!.runOp()` and asserts the registration signal reaches ctx.
5. Audit result recorded below.

## Results summary

| # | Op | Handler | Real catalog emitters | Tests | Audit outcome |
|---|:---|:---|:---|:---|:---|
| 1 | `manipulate_priority` | `src/effects/handlers/priority.ts` | **0** (see below) | 1 unit + 1 integration | Documented no-op at catalog level; handler retained for defense |
| 2 | `stat_scaling` | `src/effects/handlers/stats.ts` | 4 (OGN-109, OGN-028, OGS-004, OGS-004-P) | 1 unit + 1 integration | Green - no bugs |
| 3 | `ability_copy` | `src/effects/handlers/misc.ts` | 4 (OGN-111, OGN-111a, ARC-003, OGN-111-P) | 1 unit + 1 integration | Green - no bugs |
| 4 | `targeting_discount` | `src/effects/handlers/costs.ts` | 2 (SFD-141, SFD-141A) | 2 unit + 1 integration | Green - no bugs; extra validate test added |
| 5 | `follow_movement` | `src/effects/handlers/movement.ts` | 2 (OGN-177, OGN-177-P) | 1 unit + 1 integration | Green - no bugs |
| 6 | `conditional_buff` | `src/effects/handlers/stats.ts` | 20 (UNL-151, UNL-031, ...) | 1 unit + 1 integration | Green - no bugs; audit count in phase-7 doc is stale (shows 2, catalog has 20) |
| 7 | `hide_modifier` | `src/effects/handlers/gear.ts` | 2 (OGN-278, OGN-278a) | 2 unit + 1 integration | Green - no bugs; extra idempotency test added |
| 8 | `scoring_restriction` | `src/effects/handlers/battlefield.ts` | 1 (SFD-209) | 1 unit + 1 integration | Green - no bugs |

**Totals: 10 directed unit tests + 8 integration tests = 18 assertions; all passing. 0 handler bugs fixed. 1 op (`manipulate_priority`) is a documented catalog-level no-op.**

## Per-op detail

### 1. `manipulate_priority` - documented catalog-level no-op

The phase-7 audit (2026-04-19 snapshot) reports 4 emitters. Re-scanning the same `data/cards.enriched.json` at Phase 10 execution time returns **zero** cards with `effectProfile.operations[].type === 'manipulate_priority'`. Distinct op-type frequency:

```
0 manipulate_priority
```

Explanation: the audit table is assembled from a slightly older counter pass than the one we can re-run now. The op's real use has been migrated into `card.keywords` ([Action], [Reaction]) by the enricher, and the dispatcher path is exercised only via the synthetic `OGN-179 Acceptable Losses` fixture retained in `src/__tests__/effects/fixtures/real-cards.ts` for regression.

**Handler status: retained.** Per `src/effects/handlers/priority.ts` lines 84-99, the marker variants (`action_tagged`, `reaction_tagged`, `add_reaction`) _must_ still soft-fail with a warn log if they slip through catalog load. The variants 4+ (`take_focus`, `grant_priority`) remain live via engine hooks even when the catalog has zero emitters, because runtime effect resolution can synthesize them. The handler is therefore NOT a deletion candidate; it is a defense-in-depth landing pad.

**Tests:** the directed unit test exercises the `grant_priority` patch path end-to-end. The integration test dispatches via the synthetic fixture and asserts the warn-log soft-fail shape.

### 2. `stat_scaling` - green

Handler is at `src/effects/handlers/stats.ts` lines 330-353. Registration-shaped: appends a `temporaryMods` entry with `kind='stat_scaling'` and carries `formula` + `perUnit`. Multiple installs stack (no dedup), which matches spec section 8.4.

Real op shape from OGN-109 Dr. Mundo lacks `formula`; handler defaults to `'per_friendly_unit'` — correct behavior per spec ambiguity.

### 3. `ability_copy` - green

Handler is at `src/effects/handlers/misc.ts` lines 99-167. Patch path writes `/units/<targetId>/copiedAbilities/-`. Depth cap at 10 (line 81) protects against copy-of-copy-of-copy loops.

Dedup on `(source, target)` pair prevents double-install from repeated triggers (lines 135-148).

Real op shape from OGN-111 Heimerdinger has `targetHint='self'`; handler falls back to source when `target` is absent. Test seeds `ctx.units[source.instanceId]` so the patch auto-creates into the expected shape.

### 4. `targeting_discount` - green

Handler is at `src/effects/handlers/costs.ts` lines 170-184 and shared with `cost_reduction` / `cost_increase` via `registerCostModifier`. Writes a `temporaryMods` entry with `registeredBy='targeting_discount'` and a `scope='when_targeting_source'` default.

`validate()` rejects zero and negative amounts (lines 42-49). Added a directed validate test to cover this gate.

### 5. `follow_movement` - green

Handler is at `src/effects/handlers/movement.ts` lines 331-370. Registration-shaped: appends to `ctx.followMovementSubs[]` (separate from `temporaryMods` because the engine's movement pipeline reads this list on every primary move event). Dedup is on `source` so repeated ETB triggers don't re-install.

The observer payload encodes `trigger.originMatch='self_location'` and `trigger.controllerMatch='friendly'` so the on_move_other pipeline can match without re-deriving the predicate. Infinite-follow protection lives on the on_move_other dispatch side (see handler docstring); this Phase 10 only pins the install side.

### 6. `conditional_buff` - green; audit count is stale

Handler is at `src/effects/handlers/stats.ts` lines 359-386. The phase-7 coverage audit table shows `conditional_buff` at 2 cards. Re-running the same distinct-count query against the current `data/cards.enriched.json` at Phase 10 execution returns **20**:

```
20 conditional_buff
```

The handler behavior is unchanged and correct: registration-shaped, no imperative stat patches, predicate preserved. The audit table undercounts because the enricher gained several `conditional_buff` emitters between the audit snapshot and today. This is a documentation drift, not a handler bug; flagged here for the next coverage audit refresh.

### 7. `hide_modifier` - green

Handler is at `src/effects/handlers/gear.ts` lines 121-155. Idempotent by construction: checks `ctx.units[source].hideModifierActive === true` before emitting the `replace` patch. Added a directed test that routes two installs back-to-back and asserts the second is a logged no-op.

### 8. `scoring_restriction` - green

Handler is at `src/effects/handlers/battlefield.ts` lines 329-372. Appends to a dedicated `ctx.scoringRestrictions[]` array (initialized by `makeCtx` so the patch path works against the test harness without the engine adapter). Dedup on `source`.

The real SFD-209 Forgotten Monument op omits `predicateKind` and `predicatePayload`; handler defaults to `'custom'` with an empty payload. This matches spec section 13.2's "custom" fallback lane.

## No handler fixes applied

All 8 handlers produced the expected patches + log entries on first test run. No handler was found to write to the wrong zone, misresolve targets, or emit stale log kinds. No commit under this phase touches any file in `src/effects/handlers/` or `src/effects/index.ts`.

## Coordination

- No edits to `src/game-engine.ts` combat/damage logic or `src/effects/handlers/keywords.ts`. Phase 9 (combat -> keyword registry wiring) is free to proceed without conflicts.
- No edits to any handler source file. All Phase 10 changes are test-only + this findings doc.
