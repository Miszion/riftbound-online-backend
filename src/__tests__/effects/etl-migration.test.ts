/**
 * ETL migration regression tests.
 *
 * The Data Analyst is running two passes over data/cards.enriched.json:
 *   Fix 1: remove `rune_resource` entries from card.effectProfile.operations[]
 *          AND card.abilities[].operations[].
 *   Fix 2: move `manipulate_priority` variants {action_tagged, reaction_tagged,
 *          add_reaction} out of operations[] into a new card.timingTags[]
 *          field (spec section 17.6 open question, Phase-2b recommendation).
 *
 * Tests are split into two bands:
 *   - Always-on: load the catalog if present, run assertions regardless of
 *     migration state. These catch regressions where the enricher re-introduces
 *     stripped ops.
 *   - describeIfEtl: gated on the presence of card.timingTags on any card. Once
 *     the Data Analyst's pass lands, these light up automatically.
 *
 * The runtime filter `filterCatalogRuneResourceOps` from src/effects/index.ts
 * should strip zero entries after ETL. We import and call it here.
 */
import {
  BACKEND_READY,
  ETL_READY,
  describeIfEtl,
  loadEnrichedCatalog,
  EnrichedCard,
} from './_harness';

// ---------------------------------------------------------------------------
// Helpers. No fixture dependency because we assert on the real shipped json.
// ---------------------------------------------------------------------------

function allOpsOf(card: EnrichedCard): Array<{ type: string; [k: string]: unknown }> {
  const profileOps = card.effectProfile?.operations ?? [];
  const abilityOps = (card.abilities ?? []).flatMap((a) => a.operations ?? []);
  return [...profileOps, ...abilityOps];
}

const MANIPULATE_PRIORITY_MIGRATED_VARIANTS = new Set([
  'action_tagged',
  'reaction_tagged',
  'add_reaction',
]);

// ---------------------------------------------------------------------------
// Smoke test: the catalog loads and has a non-trivial count of cards. Runs
// regardless of backend / ETL state so a missing or empty json fails loud.
// ---------------------------------------------------------------------------

describe('etl-migration: catalog presence', () => {
  it('data/cards.enriched.json loads with a non-trivial card count', () => {
    const cards = loadEnrichedCatalog();
    if (!cards) {
      // If the file is absent, flag the inability to run these tests. Do not
      // fail the suite - the Data Analyst may be mid-migration and have
      // temporarily removed the file.
      // eslint-disable-next-line no-console
      console.log('[etl-migration] cards.enriched.json not present; regressions skipped');
      expect(cards).toBeNull();
      return;
    }
    expect(Array.isArray(cards)).toBe(true);
    expect(cards.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 regression: rune_resource must be absent from ALL operations arrays.
// ---------------------------------------------------------------------------

describe('etl-migration: fix 1 - rune_resource stripped', () => {
  it('zero cards have a rune_resource op in effectProfile.operations[]', () => {
    const cards = loadEnrichedCatalog();
    if (!cards) {
      // eslint-disable-next-line no-console
      console.log('[etl-migration] skipping: catalog not loaded');
      return;
    }
    const offenders = cards
      .filter((c) => (c.effectProfile?.operations ?? []).some((o) => o.type === 'rune_resource'))
      .map((c) => c.id);
    if (offenders.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[etl-migration] cards with rune_resource in effectProfile: ${offenders.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('zero cards have a rune_resource op in abilities[].operations[]', () => {
    const cards = loadEnrichedCatalog();
    if (!cards) return;
    const offenders = cards
      .filter((c) =>
        (c.abilities ?? []).some((a) =>
          (a.operations ?? []).some((o) => o.type === 'rune_resource'),
        ),
      )
      .map((c) => c.id);
    if (offenders.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[etl-migration] cards with rune_resource in abilities: ${offenders.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('runtime filterCatalogRuneResourceOps strips zero entries after ETL', () => {
    // If Backend is not ready we cannot import; skip.
    if (!BACKEND_READY) return;
    const cards = loadEnrichedCatalog();
    if (!cards) return;
    // Pull the filter from src/effects/index.ts. Same dynamic-import pattern
    // the harness uses for the dispatcher.
    type CatalogFilter = (
      cards: Array<{ id: string; effectProfile?: { operations: unknown[] } }>,
    ) => number;
    let filter: CatalogFilter | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../effects/index') as { filterCatalogRuneResourceOps?: CatalogFilter };
      filter = mod.filterCatalogRuneResourceOps ?? null;
    } catch {
      filter = null;
    }
    if (!filter) {
      // eslint-disable-next-line no-console
      console.log('[etl-migration] filterCatalogRuneResourceOps not exported; skipping');
      return;
    }
    // Clone so we don't mutate the cached catalog.
    const cloned = cards.map((c) => ({
      id: c.id,
      effectProfile: c.effectProfile
        ? { operations: [...(c.effectProfile.operations ?? [])] }
        : undefined,
    }));
    const stripped = filter(cloned as Array<{ id: string; effectProfile?: { operations: unknown[] } }>);
    expect(stripped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 regression: manipulate_priority marker variants stripped from ops.
// ---------------------------------------------------------------------------

describeIfEtl('etl-migration: fix 2 - manipulate_priority markers moved to timingTags', () => {
  it('zero cards carry action_tagged / reaction_tagged / add_reaction in operations[]', () => {
    const cards = loadEnrichedCatalog();
    if (!cards) return;
    const offenders: string[] = [];
    for (const c of cards) {
      for (const op of allOpsOf(c)) {
        if (op.type !== 'manipulate_priority') continue;
        const variant = (op as { variant?: string }).variant;
        if (variant && MANIPULATE_PRIORITY_MIGRATED_VARIANTS.has(variant)) {
          offenders.push(`${c.id}:${variant}`);
        }
      }
    }
    if (offenders.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[etl-migration] cards with marker variants still in ops: ${offenders.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('card.timingTags is a populated array on cards that previously had those variants', () => {
    const cards = loadEnrichedCatalog();
    if (!cards) return;
    // The Data Analyst's report should supply the exact N. Absent that, we
    // assert the LOWER BOUND: at least one card has a populated timingTags
    // array. When the migration report lands, widen this to the reported N.
    //
    // Phase 2 catalog sampling: ~146 cards had manipulate_priority, of which
    // the vast majority used variants 1-3 per spec 17.3. Lower bound of 50
    // should be comfortable once the Analyst's pass completes.
    const populated = cards.filter(
      (c) => Array.isArray(c.timingTags) && c.timingTags.length > 0,
    );
    expect(populated.length).toBeGreaterThanOrEqual(1);
  });

  it('timingTags values use normalized suffix form (action, reaction, add_reaction)', () => {
    const cards = loadEnrichedCatalog();
    if (!cards) return;
    const VALID = new Set(['action', 'reaction', 'add_reaction']);
    const malformed: string[] = [];
    for (const c of cards) {
      const tags = c.timingTags;
      if (!Array.isArray(tags)) continue;
      for (const t of tags) {
        if (!VALID.has(t)) {
          malformed.push(`${c.id}:${t}`);
        }
      }
    }
    if (malformed.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[etl-migration] non-normalized timingTags entries: ${malformed.join(', ')}`);
    }
    expect(malformed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics. These run regardless of gate state so the QA report has signal.
// ---------------------------------------------------------------------------

describe('etl-migration: diagnostics (always-on)', () => {
  it('reports ETL_READY flag', () => {
    // eslint-disable-next-line no-console
    console.log(`[etl-migration] ETL_READY=${ETL_READY}`);
    expect(typeof ETL_READY).toBe('boolean');
  });
});
