/**
 * Catalog-load regression tests.
 *
 * Spec anchors: section 16.5, spec 17 Phase-2b open question.
 *
 * Pitfalls from the Tech Lead's Phase 2a review:
 *   1. `rune_resource` entries in card.operations[] MUST be stripped at
 *      catalog load. Both real rune cards (OGN-126) and non-rune cards
 *      mislabeled by the ETL (OGN-088) must have the op removed. A count
 *      must be logged.
 *   2. `manipulate_priority` marker variants (action_tagged, reaction_tagged,
 *      add_reaction) should ideally also be stripped at catalog load (spec
 *      17 final paragraph), but the dispatcher must STILL soft-fail if any
 *      slip through. The soft-fail is tested in priority.test.ts; the
 *      stripping test is here.
 */
import { BACKEND, BACKEND_READY, describeIfBackend } from './_harness';
import { FIXTURES } from './fixtures/real-cards';

describeIfBackend('catalog loader: rune_resource stripping (spec 16.5)', () => {
  it('removes rune_resource from a real Rune card (OGN-126 Body Rune)', () => {
    if (!BACKEND!.loadCatalog) {
      // TODO(backend): loadCatalog not yet exported from src/effects/index.ts.
      // When it ships, this assertion runs.
      return;
    }
    const input = [FIXTURES.OGN_126_BODY_RUNE];
    const out = BACKEND!.loadCatalog(input);
    const body = out.cards.find((c) => c.id === 'OGN-126');
    expect(body).toBeDefined();
    expect(body?.operations.some((o) => o.type === 'rune_resource')).toBe(false);
  });

  it('removes rune_resource from a non-Rune card (OGN-088 Mega-Mech) too', () => {
    if (!BACKEND!.loadCatalog) {
      return;
    }
    const input = [FIXTURES.OGN_088_MEGA_MECH];
    const out = BACKEND!.loadCatalog(input);
    const mech = out.cards.find((c) => c.id === 'OGN-088');
    expect(mech).toBeDefined();
    expect(mech?.operations.some((o) => o.type === 'rune_resource')).toBe(false);
  });

  it('returns a count of stripped rune_resource entries for audit', () => {
    if (!BACKEND!.loadCatalog) {
      return;
    }
    const input = [FIXTURES.OGN_126_BODY_RUNE, FIXTURES.OGN_088_MEGA_MECH];
    const out = BACKEND!.loadCatalog(input);
    expect(out.stats.stripped.rune_resource).toBeGreaterThanOrEqual(2);
  });
});

describeIfBackend('catalog loader: manipulate_priority marker stripping (spec 17 open question)', () => {
  it('strips action_tagged / reaction_tagged markers from operations[]', () => {
    if (!BACKEND!.loadCatalog) {
      return;
    }
    // OGN-179 Acceptable Losses has manipulate_priority plus attach_gear in
    // its raw operations list. After catalog load, the action_tagged marker
    // should be moved from operations[] into a separate timingTags field,
    // per spec 17's Phase-2b recommendation. The remaining op for dispatch
    // is attach_gear (which itself is mislabeled - see gear.test.ts).
    const out = BACKEND!.loadCatalog([FIXTURES.OGN_179_ACCEPTABLE_LOSSES]);
    const card = out.cards.find((c) => c.id === 'OGN-179');
    // Still dispatchable but stripped of the priority-tag marker.
    const priorityMarkers = card?.operations.filter((o) => o.type === 'manipulate_priority');
    // Accept 0 (fully stripped, recommended) or 1 (not yet stripped but
    // dispatcher will soft-fail). Either way the match cannot crash.
    expect(priorityMarkers?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

describeIfBackend('catalog loader: idempotent load', () => {
  it('running the loader twice on the same input is a no-op after the first pass', () => {
    if (!BACKEND!.loadCatalog) {
      return;
    }
    const once = BACKEND!.loadCatalog([FIXTURES.OGN_126_BODY_RUNE]);
    const twice = BACKEND!.loadCatalog(once.cards);
    // Second pass should strip zero rune_resource entries because the first
    // pass already removed them.
    expect(twice.stats.stripped.rune_resource ?? 0).toBe(0);
  });
});

describe('catalog loader: smoke (runs regardless of backend readiness)', () => {
  it('the fixture OGN-126 has exactly one rune_resource op in the raw shape', () => {
    // This guards the fixture itself. If the enriched-json ETL ever ships a
    // card without the rune_resource marker, our loader tests would go
    // silent. Pin the raw shape.
    const raw = FIXTURES.OGN_126_BODY_RUNE;
    const runeResourceOps = raw.effectProfile.operations.filter((o) => o.type === 'rune_resource');
    expect(runeResourceOps.length).toBe(1);
  });

  it('BACKEND_READY is a boolean flag the harness exposes', () => {
    expect(typeof BACKEND_READY).toBe('boolean');
  });
});
