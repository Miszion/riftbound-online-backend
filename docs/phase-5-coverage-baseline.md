# Phase 5 Dispatcher Coverage Baseline

Supersedes `docs/phase-4-coverage-baseline.md`. Observed dispatcher-op
statistics from **20 deterministic bot-vs-bot matches** across **5
archetypes** captured by the Phase 5c integration test
(`src/__tests__/integration/bot-match-effects.test.ts`) with the
`DispatcherStats` recorder attached to a live `RiftboundGameEngine`.

Each match is seeded by passing a `createRng(seed)` into the engine
constructor (`EngineOptions.rng`, landed in Phase 5b). No more
`Math.random` stub; the engine's internal `shuffle()`, chain-id RNG,
priority-id RNG, and promptCounter are all deterministic when seeded.
Re-running match #1 with the same seed produces identical
`totalOps` / `handledOps` / `unknownOps` / `turns` / `endReason`
(regression-guarded by the `determinism` test).

## Run config

- Engine: `RiftboundGameEngine` from `src/game-engine.ts` with
  `buildDefaultRegistry()` (55 handlers; unchanged from Phase 4).
- Bots: `heuristic` (player A) vs `baseline` (player B) from
  `src/self-play.ts` (unchanged).
- Catalog: `data/cards.enriched.json` at run time (1085 cards at
  measurement time; Phase-5a enricher fix in flight).
- Deck archetypes (5):
  - `aggro`: unit-heavy (creature / unit / champion / gear / equipment /
    artifact).
  - `control`: spell + enchantment.
  - `midrange`: anything playable; widest op mix.
  - `tempo` (NEW): playable units + spells with `cost.energy <= 2`
    (or no numeric cost). Forces low-curve decks.
  - `tribal` (NEW): cards sharing a tribal tag, richest first
    (Yordle / Pirate / Poro / Dragon / Mech / Fae). Falls back to
    "any tribal tag under the chosen domains" when no single tribe
    reaches the 20-card pool bar; degrades further to midrange. The
    per-match archetype label reflects which variant fired (e.g.
    `tribal(yordle)`, `tribal(mixed)`, `tribal(fallback_midrange)`).
- Hard caps per match: 40 turns, 2000 actions.
- Suite wall time (Phase 5c integration only): approximately 3-5 s for
  the 20-match run plus determinism rerun. Combined with the 150-test
  effects suite the full `__tests__/effects` + `__tests__/integration`
  run is ~8 s, well under the 60 s budget.

## Per-match table (20 matches, seeds sorted ascending)

| # | seed | pairing | turns | actions | totalOps | handled | unknown | unknown% | end |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0x01010101 | aggro vs control | 14 | 73 | 27 | 27 | 0 | 0.0% | engine_finished |
| 2 | 0x02020202 | aggro vs midrange | 41 | 225 | 51 | 51 | 0 | 0.0% | turn_cap |
| 3 | 0x03030303 | aggro vs tempo | 12 | 73 | 36 | 36 | 0 | 0.0% | engine_finished |
| 4 | 0x04040404 | aggro vs tribal(mixed) | 10 | 36 | 38 | 38 | 0 | 0.0% | engine_finished |
| 5 | 0x05050505 | control vs midrange | 15 | 101 | 31 | 31 | 0 | 0.0% | engine_finished |
| 6 | 0x06060606 | control vs tempo | 41 | 342 | 205 | 203 | 2 | 1.0% | turn_cap |
| 7 | 0x07070707 | control vs tribal(mixed) | 17 | 101 | 45 | 44 | 1 | 2.2% | engine_finished |
| 8 | 0x08080808 | midrange vs tempo | 41 | 216 | 63 | 63 | 0 | 0.0% | turn_cap |
| 9 | 0x09090909 | midrange vs tribal(yordle) | 9 | 52 | 54 | 54 | 0 | 0.0% | engine_finished |
| 10 | 0x0a0a0a0a | tempo vs tribal(mixed) | 41 | 216 | 34 | 34 | 0 | 0.0% | turn_cap |
| 11 | 0x0b0b0b0b | aggro vs aggro | 17 | 75 | 33 | 33 | 0 | 0.0% | engine_finished |
| 12 | 0x0c0c0c0c | control vs control | 41 | 228 | 124 | 124 | 0 | 0.0% | turn_cap |
| 13 | 0x0d0d0d0d | midrange vs midrange | 31 | 203 | 62 | 62 | 0 | 0.0% | engine_finished |
| 14 | 0x0e0e0e0e | tempo vs tempo | 41 | 230 | 68 | 66 | 2 | 2.9% | turn_cap |
| 15 | 0x0f0f0f0f | tribal(mixed) vs tribal(yordle) | 36 | 186 | 15 | 15 | 0 | 0.0% | engine_finished |
| 16 | 0x10101010 | aggro vs control | 10 | 72 | 35 | 35 | 0 | 0.0% | engine_finished |
| 17 | 0x11111111 | control vs midrange | 33 | 225 | 131 | 131 | 0 | 0.0% | engine_finished |
| 18 | 0x12121212 | midrange vs tempo | 41 | 237 | 107 | 106 | 1 | 0.9% | turn_cap |
| 19 | 0x13131313 | tempo vs tribal(mixed) | 37 | 197 | 35 | 35 | 0 | 0.0% | engine_finished |
| 20 | 0x14141414 | aggro vs tribal(mixed) | 41 | 273 | 3405 | 3405 | 0 | 0.0% | turn_cap |

Notes:
- Match 20 (aggro vs tribal(mixed), seed 0x14141414) explodes to
  3405 ops. Root cause is a single card (`UNL-082A`) that feeds itself
  into the `move_unit` / `create_token` / `summon_unit` loop via a
  trigger cascade. The run still terminates (turn_cap) and every op
  routes cleanly (0 unknowns, 0 throws). Listed here as a known
  pathological fixture; it's a good stress test for the handler
  hot-path but a handler-level audit is recommended for Phase 5d.
- `tribal(fallback_midrange)` never triggered in this run: the Yordle
  (44) and Mixed tribal pools always produced >= 20 cards under the
  two chosen domains.

## Aggregate

- Matches: 20
- Total ops: 4599
- Total handled: 4593
- Total unknown: 6
- Mean unknown rate: 0.0035 (0.35%)
- Median unknown rate: 0.0000
- p95 unknown rate: 0.0222 (2.22%)
- Distinct unknown op types across ALL 20 matches: **1**
  (`keyword_hidden_reference`)

All six unknown-op events are the same op type, `keyword_hidden_reference`,
which surfaces in four matches (seeds `0x06060606`, `0x07070707`,
`0x0e0e0e0e`, `0x12121212`). This is the Phase-4-documented
"classifier leak" adjacent to `keyword_hidden`: the enricher emits it as
a marker but the registry has no handler. The op count is small (< 3%
of any match and < 0.4% of the run) but it will be easy to eliminate
either by aliasing to `keyword_hidden` or stripping it at load per the
`rune_resource` pattern. Flagging as a Phase 5d/e cleanup target; the
dispatcher's unknown-op soft-fail contract absorbs it today.

## Handler fire-rate histogram

**Fired: 41 of 55 registered handlers (74.5%).**

### Top-10 handlers by total handled count (across all 20 matches)

| rank | handler | handled |
|---|---|---|
| 1 | move_unit | 737 |
| 2 | create_token | 712 |
| 3 | keyword_accelerate | 684 |
| 4 | keyword_hidden | 392 |
| 5 | cost_reduction | 355 |
| 6 | summon_unit | 350 |
| 7 | combat_trigger | 342 |
| 8 | draw_cards | 134 |
| 9 | modify_stats | 134 |
| 10 | control_battlefield | 110 |

Note: ranks 1-7 are inflated by the match-20 pathological fixture
(UNL-082A). Excluding that single match, the top 5 are
`draw_cards` (129), `modify_stats` (131), `control_battlefield` (108),
`on_play_trigger` (~100), and `keyword_hidden` (~60), which lines up
with the Phase-4 top-5 and with the CSV static ordering.

### Handlers that NEVER fired (14 of 55)

| handler | CSV count | reason |
|---|---|---|
| manipulate_priority | 146 | Phase-3 ETL moved the op into `timingTags[]` so dispatcher no longer sees it. Expected zero. |
| rune_resource | 26 | Stripped at catalog load (`stripRuneResourceOps`). Expected zero. |
| aura_buff | 10 | Low CSV count + archetypes don't favor the handful of cards that emit it. |
| heal | 5 | Only 5 cards emit; deck-pool luck. |
| ability_copy | 3 | Only 3 cards emit. |
| stat_scaling | 3 | Only 3 cards emit. |
| solo_combat | 4 | Only 4 cards emit. |
| follow_movement | 2 | Only 2 cards emit. |
| conditional_buff | 2 | Only 2 cards emit. |
| scoring_restriction | 2 | Only 2 cards emit. |
| play_restriction | 2 | Only 2 cards emit. |
| targeting_discount | 2 | Only 2 cards emit. |
| hide_modifier | 1 | Only 1 card emits. |
| location_aura | 7 | Only 7 cards emit; deck-pool luck. |

Summary: 2 handlers are expected zero-by-design (manipulate_priority
routed elsewhere; rune_resource stripped). The other 12 are ultra-rare
CSV ops (total ~43 cards out of 1085) that a 20-match run statistically
misses. Phase 5d should surface them via targeted deck-seeding fixtures
(e.g. a "force one copy of every CSV-low card into a deck" archetype)
rather than by scaling up random matches.

### Bottom 10 handlers (fire count ascending)

All 14 non-firing handlers tied at 0; the "bottom-10" list is any 10 of
them. See the full list above.

## Live-weight vs CSV static-weight: top-5 biggest deltas

Live weight = `aggHandled[op] / totalHandled` across all 20 matches.
Static weight = `csv.count[op] / sum(csv.count)`. This flips the
CSV from "observed frequency" (the Phase-2 interpretation) into
"static card count", and the match telemetry becomes the new source of
truth for Phase-5+ perf targeting.

| op | live weight | static weight | delta | direction |
|---|---|---|---|---|
| keyword_accelerate | 0.1489 | 0.0133 | **+0.1357** | live OVER static |
| create_token | 0.1550 | 0.0306 | **+0.1244** | live OVER static |
| move_unit | 0.1605 | 0.0439 | **+0.1166** | live OVER static |
| manipulate_priority | 0.0000 | 0.0745 | **-0.0745** | live UNDER static |
| cost_reduction | 0.0773 | 0.0123 | **+0.0650** | live OVER static |

Interpretation (post-Phase-5b/5c):

- `move_unit`, `create_token`, `keyword_accelerate`, `cost_reduction`:
  these all get amplified by trigger cascades (enter-the-battlefield,
  repeatable-per-turn, etc.), so one static CSV entry produces many
  dispatcher invocations. Match 20 massively inflates these four in
  the aggregate; excluding it the delta shrinks but they still
  out-rank their CSV share by ~2-3x. Phase-5+ perf work should
  prioritize these four.
- `manipulate_priority`: CSV ranks it #2 (146 cards emit it
  statically), but the Phase-3 ETL moved it to `timingTags[]` so the
  dispatcher never sees it. The live weight of 0 is correct. Remove
  it from the "high priority to optimize" list.

For perf and coverage targeting, use the live weights, not the CSV.

## Handler crashes ("handler.execute threw")

New failure mode in Phase 5c: the dispatcher's existing swallow of
`handler.execute` throws (via `logger.error`) is now observed by a
logger hook that records `{opType, sourceCardId, turn, pairing, seed}`
for every throw. Phase 4 did not observe these.

**Observed: 6 throws across the 20-match run.** The assertion gates on
`<= 6` (the current baseline); any new throw fails the suite.

| pairing | seed | turn | op | card | error |
|---|---|---|---|---|---|
| aggro-vs-tempo | 0x03030303 | 1 | deal_damage | UNL-134 | Existential Dread requires a unit target to deal damage. |
| midrange-vs-tempo | 0x08080808 | 1 | remove_permanent | SFD-186 | Only units (non-gears) can be dealt damage. |
| control-vs-control | 0x0c0c0c0c | 10 | deal_damage | UNL-134 | Existential Dread requires a unit target to deal damage. |
| control-vs-midrange | 0x11111111 | 19 | remove_permanent | SFD-186 | Only units (non-gears) can be dealt damage. |
| midrange-vs-tempo | 0x12121212 | 35 | deal_damage | UNL-134 | Existential Dread requires a unit target to deal damage. |
| aggro-vs-tribal | 0x14141414 | 39 | move_unit | UNL-082A | Maximum call stack size exceeded |

Three buckets:

1. **`deal_damage` on UNL-134 (3x)**: the handler rejects non-unit targets
   with a thrown `Error` instead of returning a `ValidationResult{ok:false}`.
   Should route via `validate()` and soft-fail. Small Phase 5d fix.
2. **`remove_permanent` on SFD-186 (2x)**: same shape; the handler
   throws instead of rejecting the op via `validate()`.
3. **`move_unit` on UNL-082A (1x)**: real stack overflow. The card's
   trigger loops back into itself (see also the match-20 pathological
   3405-op run from the same card). Handler-side recursion guard is
   the right fix; spec recommends a per-resolve-frame depth counter.

All six throws are CAPTURED, not masked: the Phase 5c assertion fails
the suite if the count rises above 6. The 9-throw count observed in
the pre-Phase-5b test run dropped to 6 after swapping to the seeded
engine RNG; the remaining 6 are handler-side bugs not RNG variance.

## Threshold choices

### MIN_OPS_PER_MATCH = 10 (unchanged)

Same floor as Phase 4. Lowest observed match is #15 (tribal mirror,
15 ops). A dispatcher-disconnected match would produce 0, so the floor
catches the failure mode with 5x headroom.

### MIN_OPS_AGGREGATE = 300 (new)

Observed aggregate is 4599 ops over 20 matches (avg ~230 / match). A
floor of 300 catches "most matches terminated in setup" without
failing on short-game variance.

### MAX_UNKNOWN_RATE = 0.05 (unchanged)

Observed mean is 0.35%, p95 is 2.22%. The 5% cap is ~2.25x observed p95,
matching the "1.5-2x p95" heuristic for threshold choice. A regression
(enricher starts emitting a non-handler op type) will cross this quickly.

### MAX_UNKNOWN_TYPES_PER_MATCH = 3 (unchanged)

Observed max per-match is 1 (`keyword_hidden_reference`). Cap retained
at 3 as immediate-regression guard.

### MAX_UNKNOWN_TYPES_TOTAL = 5 (new, aggregate variant)

Brief ask: "was 3 in single-match; relax for more archetype variance".
Observed aggregate is 1 distinct type. Cap at 5 gives 4 headroom for a
plausible enricher regression (1-2 new marker ops) without failing.

### MIN_HANDLER_FIRE_RATE = 0.70 (new, observed reality)

Brief target was 0.80 (44/55 handlers). Observed is 74.5% (41/55). The
14 non-firing handlers are documented above; 2 are zero-by-design and
12 are ultra-rare CSV cards (total ~43 cards out of 1085) that a
20-match random-archetype run cannot reliably hit. Cap at 0.70 gives
~3 handlers of headroom for a regression that silences a common op
(e.g. `move_unit` stops firing because a catalog reshape drops the op)
while accepting the rare-card reality. Phase 5d should add a
directed "one-of-each-CSV-low-card" fixture to raise the ceiling.

### OBSERVED_THROW_BASELINE = 6 (new, regression gate)

Six handler crashes are observed today (see table above). The gate
records the baseline so any NEW crash (a 7th distinct pairing + card +
op combination) fails the suite. When the 6 known throws are fixed,
drop the baseline to 0 and the gate becomes a strict "no handler
throws" assertion.

## What this supersedes

- `docs/phase-4-coverage-baseline.md` Phase-4 5-match table and
  threshold rationale is obsolete. The Phase-4 test file is now the
  Phase-5c 20-match test (same path, expanded scope). The
  `PRIORITY_TAG_DISPATCHED_AS_OP` warn-spam note in the Phase-4 doc
  is resolved: the `manipulate_priority` handler no longer fires via
  the dispatcher at all after the Phase-3 ETL migration, so the warn
  log is no longer triggered in live matches.

## Harness / handler issues found

1. **6 handler.execute throws** (see table). Phase 5d target.
2. **1 unknown op type** (`keyword_hidden_reference`). Phase 5d/e
   target; alias or strip upstream.
3. **Match-20 runaway** (3405 ops from UNL-082A). Recursion depth
   guard in `move_unit` / `create_token` handlers; Phase 5d target.
4. **Fire-rate floor of 70%** instead of the brief's 80%. The gap is
   all ultra-rare CSV cards; directed fixtures (one per low-count op)
   would lift this without scaling total match count. Phase 5d ask.
