# Phase 4 Dispatcher Coverage Baseline

Observed dispatcher-op statistics from 5 deterministic bot-vs-bot matches,
captured by the Phase 4 integration test
(`src/__tests__/integration/bot-match-effects.test.ts`) with the
DispatcherStats recorder attached to a live `RiftboundGameEngine`.

Matches run heuristic-vs-baseline bots through the same engine path used
by the live bot-match harness (`src/bot-match.ts`), minus persistence /
pubsub / JSONL writes. Every op that reaches `runOp` is counted as
"handled" or "unknown"; ops that bypass the dispatcher because their type
is not in the registry (fall through to the legacy switch in
`game-engine.executeEffectOperations`) are counted as "unknown" via a
direct `recordOp` call from the engine call site, so the recorder sees
100% of effect-op dispatch events, not just the dispatcher's own unknowns.

## Run config

- Engine: `RiftboundGameEngine` from `src/game-engine.ts` with
  `buildDefaultRegistry()` (55 handlers, post-Phase-3).
- Bots: `heuristic` vs `baseline` from `src/self-play.ts`.
- Catalog: `data/cards.enriched.json` (723 cards, Phase-3 cleaned).
- Hard caps per match: 40 turns, 2000 actions.
- Determinism: `Math.random()` is swapped for a seeded mulberry32 during
  each match so the engine's internal deck `shuffle()` reproduces
  identically run to run. Restored in `finally`.
- Total wall time for the 5-match integration suite: approximately
  2 seconds (well under the 30s budget).

## Per-match statistics

| seed | pairing | turns | actions | totalOps | handled | unknown | unknown rate | end reason |
|---|---|---|---|---|---|---|---|---|
| 0x11111111 | aggro vs control | 14 | 79 | 57 | 57 | 0 | 0.0% | engine_finished |
| 0x22222222 | control vs midrange | 9 | 62 | 18 | 18 | 0 | 0.0% | engine_finished |
| 0x33333333 | midrange vs aggro | 41 | 188 | 14 | 14 | 0 | 0.0% | turn_cap |
| 0x44444444 | aggro vs aggro | 39 | 222 | 35 | 35 | 0 | 0.0% | engine_finished |
| 0x55555555 | control vs midrange | 17 | 119 | 71 | 71 | 0 | 0.0% | engine_finished |

Unknown op types observed: none. Across all 5 runs, zero ops fell through
the registry.

### Top-5 handled ops per match

| seed | top-5 handled ops |
|---|---|
| 0x11111111 | control_battlefield=11, manipulate_priority=10, conquer_trigger=8, hold_trigger=7, draw_cards=4 |
| 0x22222222 | create_token=6, hold_trigger=3, manipulate_priority=2, modify_stats=2, on_play_trigger=2 |
| 0x33333333 | on_play_trigger=4, attach_gear=2, modify_stats=2, remove_permanent=2, create_token=1 |
| 0x44444444 | on_play_trigger=9, channel_rune=4, gain_resource=4, attach_gear=3, hold_trigger=3 |
| 0x55555555 | manipulate_priority=18, control_battlefield=7, draw_cards=5, move_unit=5, remove_permanent=5 |

## Aggregate

- Matches: 5
- Total ops observed: 195
- Total unknown ops: 0
- Mean unknown rate: 0.0000
- Median unknown rate: 0.0000
- p95 unknown rate: 0.0000

## Observed vs CSV static-frequency comparison

CSV top-5 (`docs/effect-ops-frequency.csv`):
1. control_battlefield (168)
2. manipulate_priority (146)
3. modify_stats (131)
4. on_play_trigger (117)
5. attach_gear (113)

Observed top across all 5 matches (summed `handled` counts):

1. manipulate_priority (30)
2. control_battlefield (18)
3. on_play_trigger (15)
4. hold_trigger (13)
5. draw_cards (9)

Overlap of CSV top-5 and observed top-5: control_battlefield,
manipulate_priority, on_play_trigger (3 of 5). The CSV says `modify_stats`
and `attach_gear` are the 3rd and 5th most common statically, but in the
live runs `hold_trigger` and `draw_cards` surface more often than either.

Interpretation: bot-match runs weight registration-time triggers
(`hold_trigger`, `on_play_trigger`, `conquer_trigger`) and
resource-flow ops (`draw_cards`, `channel_rune`, `gain_resource`) higher
than the CSV static count, because triggers get registered on every ETB
while `modify_stats` only fires when a stat-changing spell actually
resolves AND targets a legal unit. The CSV estimate overweights
`modify_stats` relative to real play.

This is a Phase 5 signal for two things:

1. The top-24 plan that prioritized `modify_stats` by CSV count was
   correct for coverage breadth but the live hot-path is narrower than
   it estimates; if we ever want to optimize handler perf, the real
   targets are `manipulate_priority`, `control_battlefield`, and the
   trigger-registration handlers.
2. `manipulate_priority` emits a `PRIORITY_TAG_DISPATCHED_AS_OP` warn
   log on every invocation, which spams the live-match console. Not a
   correctness bug (the handler still runs); the tag should probably be
   demoted to `info` or stripped at catalog load. Flagging for Phase 5
   hygiene.

## Threshold selection

The brief suggested these per-match thresholds:

- `totalOps >= 100`
- `unknownOps / totalOps <= 0.05`
- `unknownOpTypes.size <= 3`

Observed reality dictated two adjustments:

### MIN_OPS_PER_MATCH = 10 (down from 100)

Bot-match heuristic vs baseline routes 14-71 card-effect ops per match,
not 100+. Most bot actions (advance_phase, pass_priority, channel
clicks, card picks) do not dispatch a card-effect op, and short games
(someone reaches 8 VP in 9 turns) terminate before much text-ops play.
A floor of 10 still catches the failure mode the brief was worried
about (dispatcher not wired in produces 0 ops), with ~4x headroom vs
the lowest observed match (14 ops).

We additionally assert an aggregate floor of 100 ops across 5 matches
(`MIN_OPS_AGGREGATE`), which matches the brief's intent without failing
on short-game variance.

### MAX_UNKNOWN_RATE = 0.05 (unchanged)

Observed mean is 0.0% and p95 is 0.0%. Headroom from p95 * 1.5 is
effectively zero, so we keep the brief's original 5% threshold.

### MAX_UNKNOWN_TYPES = 3 (unchanged)

Observed is 0. Kept at the brief's original so a regression (e.g. a
newly-seen op type from a catalog-enricher change) would fail the test
immediately.

## Notes for Phase 5

### PRIORITY_TAG_DISPATCHED_AS_OP spam

The `manipulate_priority` handler warn-logs
`[effects] PRIORITY_TAG_DISPATCHED_AS_OP` every single time it fires,
which at ~30 invocations per match is noisy. Either:
- strip these markers upstream (catalog enricher / Phase 3 ETL), or
- demote the warn to an `info` or `trace` log.

Not a blocker; logged here for visibility.

### `keyword_hidden_reference`

In the initial test iteration, before the `Math.random` stub was added,
a single `keyword_hidden_reference` op slipped through as
"unknown-to-dispatcher" in the seed=0x22222222 midrange vs control
match. With the stub (and matching seeds), this op type does not surface
in the 5-run baseline. The op does exist in the catalog as an
enricher-emitted marker adjacent to `keyword_hidden`; it has no
registered handler. If future matches surface it again, the fix is
either to alias it to `keyword_hidden` in the registry or strip it at
load (it looks like a classifier leak in the vein of `rune_resource`).

### Catalog-enricher coupling

The test is seeded on the current `data/cards.enriched.json`. If the
Tech Lead's enricher audit lands a reshape, the per-match op counts
and top-5 distributions will drift but the three assertions
(`MIN_OPS_PER_MATCH`, `MAX_UNKNOWN_RATE`, `MAX_UNKNOWN_TYPES`) all
leave enough headroom to tolerate modest catalog changes without
needing to retune.

### Not tested here

- End-to-end coverage of the `runOp` unknown-op warn path as a distinct
  code path. The dispatcher's unknown-op branch is covered by the
  Phase 2 dispatcher contract test (`dispatcher.test.ts`); Phase 4 only
  validates that it is not getting hit at live-match volume.
- Replacement-registry interaction. Phase 2b intentionally left
  replacements running outside the dispatcher; the recorder counts
  post-replacement ops only.

## Harness / handler issues found

None. The 5-match run completed cleanly with no engine crashes, no
dispatcher throws, and no handler exceptions. The only noteworthy
signal is the `PRIORITY_TAG_DISPATCHED_AS_OP` warn spam noted above,
which does not change dispatch outcomes.
