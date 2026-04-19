# Phase 4 enricher fix spec

Read-only investigation of the upstream bug that produced the 26 `rune_resource` leaks stripped by `scripts/migrate-card-catalog.ts` in Phase 3. This document specs the fix. It does not apply it.

Scope: explain why the enricher emits `rune_resource` into `effectProfile.operations[]`, what to change, where the classification should live, and how to prevent regression. Coordinates with the Phase 3 ETL report.

## 1. Root-cause analysis

### 1.1 Where the enricher lives

The enricher that produces `data/cards.enriched.json` is in-repo. It is the `generate:cards` pipeline declared in `package.json`:

```
"generate:cards": "ts-node scripts/data/transformChampionDump.ts"
```

- Authoritative enricher: `scripts/data/transformChampionDump.ts`. Reads `raw/champion-dump.json` (or fetches from `https://api.dotgg.gg/cgfw/getcards?game=riftbound`) and writes `data/cards.enriched.json` via `ENRICHED_OUTPUT` (line 9, write at line 1457).
- Shared logic: `src/card-catalog.ts`. The file duplicates the classification table and `buildEffectProfile()` from the script. It is imported by the runtime loader and by tests, and one helper (`parseTokenSpecs`) is imported back by the enricher script (line 5).

Both files carry the bug verbatim. Any fix must land in both, or we need to deduplicate and make the script import the table from `src/card-catalog.ts`.

### 1.2 The line responsible for emitting `rune_resource`

One classification entry fires for every card that triggers it. Exact locations:

- `scripts/data/transformChampionDump.ts` lines 470-478:

  ```
  {
    id: 'rune_type',
    label: 'Basic rune card',
    patterns: [
      /^No effect text provided\.?$/i
    ],
    operation: { type: 'rune_resource', targetHint: 'self', zone: 'board', automated: true },
    ruleRefs: ['161-170']
  },
  ```

- `src/card-catalog.ts` lines 889-898 (same definition, with an extra `description` field).

The rule fires inside `matchEffectClasses()` (script line 1244, src line 1148) and is mapped to an op by `buildEffectProfile()` (script line 1264, src line 1198) which does `classes.map(definition => ({ ...definition.operation, ruleRefs: definition.ruleRefs }))`. No filter on `card.type` exists anywhere in that path.

### 1.3 Why the 8 Unit cards got tagged

The raw input (`raw/champion-dump.json`) has `effect: ""` for every card with no printed effect text. This includes vanilla Runes (Body Rune OGN-126, Fury Rune OGN-007, etc.) AND vanilla Units (Mega-Mech OGN-088, Playful Phantom OGN-049, Recruit variants OGN-271/272/273, Mountain Drake OGN-142, Shipyard Skulker OGN-175, Vanguard Sergeant OGN-219).

The normalizer `ensureRulesCompliantEffect()` (script line 809, src line 1551) rewrites an empty string to the literal placeholder `"No effect text provided."` so the downstream pipeline has something to feed to regex matchers.

Then `matchEffectClasses()` runs the `rune_type` entry, whose only pattern is `/^No effect text provided\.?$/i`. The regex matches the placeholder exactly. There is no check on `card.type`, `card.tags`, `card.supertype`, `card.might`, or anything else that would distinguish a Rune from a vanilla Unit. The enricher attaches `{ type: 'rune_resource', targetHint: 'self', zone: 'board', automated: true }` to `effectProfile.operations[]` for every card whose printed effect text was empty in the raw source.

All 8 mis-tagged Units are confirmed: each has `effect: ""` in `raw/champion-dump.json` (verified for OGN-088, OGN-049, OGN-142, OGN-175, OGN-219, OGN-271, OGN-272, OGN-273). The regex matches after the normalizer runs. This is not a human-curated tag and not a lookup typo. It is a text classifier that reads the wrong signal.

Category assignment from the task's rubric:
- Not a regex matching on card text that matches the wrong cards (the regex does not read anything on the card except the normalized placeholder string).
- Not a typo'd lookup table.
- Not a classifier reading the wrong field exactly, but close: the classifier reads the post-normalization effect string instead of checking `card.type === 'Rune'`.
- Not an inheritance bug.
- Not a source data issue. The raw source is consistent: empty effect on every vanilla card, Rune and Unit alike. The enricher conflates "empty effect text" with "is a Rune resource." That is the bug.

### 1.4 Why the 15 genuine Rune cards also have the leak

Same regex, same map step, same op shape. The classifier correctly identifies them as vanilla Runes but then writes that classification into `effectProfile.operations[]`, which is the dispatcher's runtime op list per `riftbound-effect-spec.md` section 16.5. Spec section 16.5 (lines 1222-1224) already flagged this:

> `rune_resource` is not a dispatcher target. It is a data-layer tag... Recommendation: remove `rune_resource` from the dispatcher op table entirely; it's a classification label, not an op.

So the fix is two-pronged:

(a) Stop emitting `rune_resource` for non-Rune cards. The regex catches 11 vanilla Units today; the 8 listed in the Phase 3 report plus OGN-049, OGN-142, OGN-175 (all 11 are in the Phase 3 table row set; the phase-4 task counted 8 plus OGN-088 separately). The raw data has no way to distinguish these cards from vanilla Runes beyond `type`.

(b) Stop emitting `rune_resource` into `operations[]` for the 15 genuine Rune cards too. The spec says this is a classification tag, not a runtime op. The Rune's real abilities (`[E]: Add [1]`, `Recycle this: Add [C]`) are intrinsic activated abilities registered on every Rune instance at load time (spec 16.5, 16.6), and they dispatch as `gain_resource`. The current catalog does not print those abilities on the card record; they are implicit from `card.type === 'Rune'`.

## 2. Proposed fix

### 2.1 Code change

Target both files that carry the classification table. Preferred: have `scripts/data/transformChampionDump.ts` import `EFFECT_CLASS_DEFINITIONS` from `src/card-catalog.ts` so there is one source of truth; the current duplication is how the bug slipped past review.

Three-part change to the enricher:

1. Drop the `rune_type` entry from `EFFECT_CLASS_DEFINITIONS` entirely.
   - `scripts/data/transformChampionDump.ts` lines 470-478, delete.
   - `src/card-catalog.ts` lines 889-898, delete.
   - Nothing else reads the `rune_type` class id; `EffectClassId` union (src line 200) should also drop `'rune_type'`.

2. Compute rune-resource status from `card.type` directly during `reshapeDump()` (script line 1327). Pseudo-code inside the record builder at ~line 1346:

   ```
   const isRuneResource = normalize(record.type).toLowerCase() === 'rune';
   // ...
   return {
     id, slug, name,
     type,
     // ...
     isRuneResource,
     // ...
   };
   ```

   This field is set from the authoritative `type` field, not from text heuristics. It will be `true` for all 15 Rune-type cards and `false` for all 8 mis-tagged Units (and every other Unit, Spell, Gear, Battlefield, Legend).

3. Defensively assert, at the end of `buildEffectProfile()`, that `operations[]` contains no `rune_resource`. The runtime filter (`filterCatalogRuneResourceOps` in `src/effects/index.ts`) is doing this downstream; adding a throw at enricher-time turns a regressed classification entry into a build-time error instead of a silent catalog pollution.

No change to `src/effects/handlers/*`. No change to the dispatcher.

### 2.2 Raw source data change

None required. The raw source (`raw/champion-dump.json`) is consistent and correct: vanilla cards carry `effect: ""` regardless of card type. The bug is in the enricher's interpretation of that signal, not in the data.

The `ensureRulesCompliantEffect()` normalizer that rewrites empty to `"No effect text provided."` can stay. It is used for downstream rendering (it gives the UI a friendly placeholder) and the new `isRuneResource` flag does not depend on it.

### 2.3 Where `rune_resource` classification should land

Option chosen: **drop `rune_resource` from `effectProfile.operations[]` entirely, add a top-level `card.isRuneResource: boolean` derived from `card.type === 'Rune'`.**

Justification:

- The Phase 3 remediation confirmed that `rune_resource` ops carried no structured data beyond `{ targetHint, zone, automated, ruleRefs }` (see phase-3-etl-migration.md line 66). Stripping was lossless. A boolean is sufficient to reconstruct the tag.
- `card.type === 'Rune'` is already the source of truth. Rune-ness does not need a second home, but a boolean is cheap, makes the catalog self-describing, and keeps callers that want to filter runes from having to know the string value.
- Alternative A, "drop it entirely and rely on `card.type === 'Rune'`": workable but leaves catalog consumers duplicating the string comparison. The Phase 3 doc line 66 treats reconstruction from `card.type + card.colors` as the working assumption, and that remains fine if the team would rather not add the boolean. Pick one and document.
- Alternative B, keep on a new `card.effectProfile.classifications[]` sibling to `operations[]`: more flexible for future classification tags (e.g. a future `tribal_synergy` classification). Reasonable long-term shape, but overkill right now. `rune_resource` is the only classification label we know needs to be hoisted. `manipulate_priority` was already hoisted into `card.timingTags` (phase-3-etl-migration.md fix 2). The pattern of lifting classifications to top-level fields is already established; match it rather than introduce a third container.
- Alternative C, keep it as `card.runeAffinity: Domain[]`: conflates two things. Runes have a single domain (Fury, Calm, Mind, Body, Chaos, Order, or Colorless for the "universal" recruit runes). Use `card.colors[]` for domain; keep the boolean for "this card is a Rune resource."

Concrete examples:

- OGN-126 Body Rune: `{ type: "Rune", colors: ["Body"], isRuneResource: true, effectProfile.operations: [] }`.
- OGN-126a, OGN-126b: same as OGN-126. The `a`/`b` variants are art-variant reprints; they share the rune-resource tag.
- OGN-088 Mega-Mech: `{ type: "Unit", colors: ["Mind"], isRuneResource: false, effectProfile.operations: [] }`.
- OGN-271 Recruit (DE), OGN-272 Recruit (NX), OGN-273 Recruit (ZN): `{ type: "Unit", colors: ["Colorless"], isRuneResource: false, effectProfile.operations: [] }`.
- OGN-001 Blazing Scorcher (control, for shape comparison): `{ type: "Unit", isRuneResource: false, effectProfile.operations: [{type: 'keyword_accelerate'}, {type: 'ready'}] }`.

### 2.4 Shape migration

`EnrichedCardRecord` in `src/card-catalog.ts` (the interface used by the runtime loader) gains a required `isRuneResource: boolean`. `StoredCardRecord` (the parse-tolerant form) gets `isRuneResource?: boolean` and the normalizer defaults to `false` when absent. This mirrors the `timingTags` migration shape from Phase 3 (phase-3-etl-migration.md line 151).

`EffectOperationType` can drop the `'rune_resource'` entry (src/card-catalog.ts line 127) once all stored payloads are re-enriched. Until then, keep the `@deprecated` entry so stale catalogs still parse.

## 3. Regression prevention

### 3.1 Enricher-side test (add to the enricher repo/script before shipping a rebuild)

A single assertion pass over the freshly-built catalog, run at the end of `scripts/data/transformChampionDump.ts` before the write to `ENRICHED_OUTPUT`:

```
// 1. No `rune_resource` op anywhere.
for (const card of cards) {
  const ops = [
    ...(card.effectProfile?.operations ?? []),
    ...(card.abilities ?? []).flatMap(a => a.operations ?? [])
  ];
  assert(!ops.some(op => op.type === 'rune_resource'),
    `${card.id} has rune_resource in operations[]`);
}

// 2. Every Rune has isRuneResource: true.
for (const card of cards.filter(c => c.type === 'Rune')) {
  assert(card.isRuneResource === true,
    `${card.id} is type=Rune but isRuneResource !== true`);
}

// 3. No non-Rune card carries rune-specific fields.
for (const card of cards.filter(c => c.type !== 'Rune')) {
  assert(card.isRuneResource === false,
    `${card.id} is type=${card.type} but has isRuneResource=true`);
  // Also: no card should carry a bare rune_resource op (redundant with check 1,
  // but kept as a named regression guard against future regex classifiers).
}
```

Build fails on any violation. `assert` throws non-zero exit; the `sync:cards` npm script halts before `upload:cards` runs, so a regressed catalog cannot reach the upload step.

### 3.2 Runtime validation on load

Current state: `filterCatalogRuneResourceOps()` in `src/effects/index.ts` (line 179) scans each loaded card, removes `rune_resource` entries from `effectProfile.operations[]`, returns the stripped count, and logs `OP_REGISTRY_FILTER_NOOP` when the count is zero (per phase-3-etl-migration.md line 101).

Recommendation: **keep the runtime filter as defense-in-depth; do not retire it.** Two reasons:

1. The backend loads catalogs from S3/disk that may be older than the current deploy (e.g. rollback scenarios). A shipped server must tolerate a pre-fix catalog without faulting on an unknown op.
2. Other codepaths (bot decks, replay hydration, fixture tests) construct partial card records. The filter is the last line of defense.

Add one extension: the filter should also assert `card.isRuneResource === true` for cards whose `type === 'Rune'`, and log a warning if not. That way if a future enricher regression zeroes the boolean we get a boot-time warning.

Retirement path: once the enricher has emitted a clean catalog for two full releases and both the CI check in 3.1 and the runtime filter have logged zero removals across production, the dispatcher's `'rune_resource'` union entry (src/card-catalog.ts line 127, effects/index.ts filter) can be removed in a follow-up PR. That is out of scope for Phase 4.

## 4. Open questions

- **Where does the enricher run in production?** The `sync:cards` npm script chains `generate:cards` through `upload:cards`. Need confirmation on whether production catalogs are built by CI on each deploy or by a human running `npm run sync:cards` locally. If the latter, the enricher-side assertions in 3.1 only help if the operator remembers to run the full chain. Recommend wiring `sync:cards` into CI before removing `filterCatalogRuneResourceOps`.
- **Single-source-of-truth for classifications.** `scripts/data/transformChampionDump.ts` duplicates `EFFECT_CLASS_DEFINITIONS` and `buildEffectProfile()` from `src/card-catalog.ts`. Any fix applied to one file without the other will silently regress. The spec proposes landing the fix in both; the bigger cleanup (make the script import from the src module) is worth scheduling but is out of scope for the patch itself. Flag for the user.
- **Are OGN-271/272/273 (colorless Recruit units) intended to be Rune-adjacent?** They are colorless Units with no effect text, used (per in-game function) as the payout for the "recruit a Unit" rune-channel mechanics. We are confident they are NOT Runes (raw `type === "Unit"`, `type` is the canonical source), but worth a sanity check with a game designer if one is reachable, because their existence as colorless zero-effect Units is unusual. Their names (Recruit DE / NX / ZN) suggest deck-slot filler tokens.
- **Raw source documentation.** `raw/champion-dump.json` is a scraped artifact from `https://api.dotgg.gg/cgfw/getcards?game=riftbound` (script line 11). There is no schema doc in-repo. If the upstream scraper ever starts returning `effect: null` instead of `effect: ""`, the `ensureRulesCompliantEffect()` normalizer will still handle it (line 811: `(effect || '').trim()`). If it starts returning the literal string `"No effect text provided."` pre-normalized, nothing breaks because the old `rune_type` regex is gone. Worth a one-page `docs/raw-source-schema.md` as a follow-up.
- **The spec union entry.** `EffectOperationType` still lists `'rune_resource'` as `@deprecated` (src/card-catalog.ts line 127). After the enricher fix, should Phase 5 remove it, or wait until at least one release has shipped with a clean catalog? Recommend waiting.
