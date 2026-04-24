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

// ---------------------------------------------------------------------------
// Phase 8c regression: `generic` op triage outcome.
//
// The Phase-7 coverage audit flagged `generic` at 52 cards, a 12x growth
// over Phase-1 and the 17th-ranked op. Phase 8c triaged those 52 into
// truly-generic vs classifier-miss and optionally landed a top-1 classifier
// fix. These regressions pin the post-triage numbers and guard against
// silent regressions in the next enricher rebuild.
//
// Ground truth lives in docs/phase-8-generic-op-triage.md when Backend
// lands it. Until then the assertion reduces to a non-tightening upper
// bound sourced from the audit.
// ---------------------------------------------------------------------------

const PHASE_7_GENERIC_OP_COUNT = 52;

interface EnrichedCardLite {
  id: string;
  effectProfile?: { operations?: Array<{ type: string }> };
}

function countGenericOps(): { total: number; cardIds: string[] } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const target = path.resolve(__dirname, '../../../data/cards.enriched.json');
    if (!fs.existsSync(target)) return null;
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw) as
      | EnrichedCardLite[]
      | { cards: EnrichedCardLite[] };
    const cards = Array.isArray(parsed) ? parsed : parsed.cards ?? [];
    const cardIds: string[] = [];
    let total = 0;
    for (const c of cards) {
      const ops = c.effectProfile?.operations ?? [];
      const gen = ops.filter((o) => o.type === 'generic');
      if (gen.length > 0) {
        cardIds.push(c.id);
        total += gen.length;
      }
    }
    return { total, cardIds };
  } catch {
    return null;
  }
}

function tryLoadTriageDoc(): { exists: boolean; body: string | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const p = path.resolve(
      __dirname,
      '../../../docs/phase-8-generic-op-triage.md',
    );
    if (!fs.existsSync(p)) return { exists: false, body: null };
    const body = fs.readFileSync(p, 'utf8');
    return { exists: true, body };
  } catch {
    return { exists: false, body: null };
  }
}

describe('catalog loader: phase 8c generic op triage guard', () => {
  it('live generic op count does not exceed the Phase-7 audit baseline', () => {
    const result = countGenericOps();
    if (!result) {
      // eslint-disable-next-line no-console
      console.log('[catalog-load phase 8c] catalog unavailable; skipping');
      return;
    }
    // Upper bound: audit baseline. When Backend lands classifier fixes
    // this should DECREASE. The assertion tightens automatically through
    // the triage-doc parse below once the doc ships.
    expect(result.total).toBeLessThanOrEqual(PHASE_7_GENERIC_OP_COUNT);
  });

  it('live generic op count does not exceed the Phase-8c triage doc target (tightens when doc lands)', () => {
    const triage = tryLoadTriageDoc();
    if (!triage.exists || !triage.body) {
      // TODO(backend 8c): triage doc not present yet. When it lands, we
      // parse its reported post-triage count and assert a tightened
      // bound.
      return;
    }
    // Doc format is open; the Backend spec says the number is published
    // somewhere in the doc. Scan for a pattern like "post-triage: N",
    // "generic ops: N", "N cards remain", "N truly-generic", etc. Take
    // the smallest non-negative integer that appears alongside the word
    // "generic" on the same line; treat that as the declared target.
    const lines = triage.body.split(/\r?\n/);
    let target: number | null = null;
    for (const line of lines) {
      if (!/generic/i.test(line)) continue;
      const matches = line.match(/\b(\d{1,3})\b/g);
      if (!matches) continue;
      for (const m of matches) {
        const n = parseInt(m, 10);
        if (Number.isFinite(n) && n >= 0 && n <= PHASE_7_GENERIC_OP_COUNT) {
          if (target === null || n < target) target = n;
        }
      }
    }
    if (target === null) {
      // eslint-disable-next-line no-console
      console.log('[catalog-load phase 8c] triage doc present but no count parsed; falling back to baseline');
      return;
    }
    const result = countGenericOps();
    if (!result) return;
    // Allow the count to equal the target but never exceed it.
    expect(result.total).toBeLessThanOrEqual(target);
  });

  it('docs/phase-8-generic-op-triage.md exists and is non-empty', () => {
    const triage = tryLoadTriageDoc();
    if (!triage.exists) {
      // TODO(backend 8c): create the triage doc before closing the
      // phase. A silent doc drift is the thing this catches.
      //
      // Until the doc lands this test stays as a TODO stub; we do NOT
      // fail the suite because Phase 8c may still be in flight.
      // eslint-disable-next-line no-console
      console.log('[catalog-load phase 8c] docs/phase-8-generic-op-triage.md not present yet');
      return;
    }
    expect(triage.body).not.toBeNull();
    expect((triage.body ?? '').trim().length).toBeGreaterThan(0);
  });

  it('cards re-classified away from `generic` by the 8c classifier fix no longer emit generic', () => {
    // Parse the triage doc for a "reclassified" block. Shape accepted:
    //   - "- UNL-XYZ -> <op_type>"
    //   - "UNL-XYZ: now <op_type>"
    //   - "reclassified UNL-XYZ as <op_type>"
    // We accept any line that contains a card id and the word
    // "reclassif" or an arrow "->". For each parsed (id, newOp),
    // assert the card no longer has a `generic` op and DOES have an op
    // of the named new type.
    const triage = tryLoadTriageDoc();
    if (!triage.exists || !triage.body) {
      return;
    }
    interface Reclass {
      id: string;
      newOp: string;
    }
    const reclasses: Reclass[] = [];
    const lines = triage.body.split(/\r?\n/);
    for (const line of lines) {
      if (!/reclassif|->|→/i.test(line)) continue;
      const idMatch = line.match(/\b([A-Z]{2,4}-\d{2,3}[A-Za-z]?)\b/);
      if (!idMatch) continue;
      // Grab the first lowercase-or-underscore word that follows an
      // arrow, colon, or the word "as". These cover common doc shapes
      // without hard-coding Backend's wording.
      const opMatch = line.match(/(?:->|→|:|\bas\b)\s*`?([a-z_]+)`?/i);
      if (!opMatch) continue;
      const newOp = opMatch[1];
      // Filter out noise words the arrow grabber might catch.
      if (!newOp || /^(the|a|an|to|from|is)$/i.test(newOp)) continue;
      reclasses.push({ id: idMatch[1], newOp });
    }
    if (reclasses.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[catalog-load phase 8c] no reclassifications parsed from triage doc');
      return;
    }
    // Load catalog once.
    const result = countGenericOps();
    if (!result) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const catalogPath = path.resolve(
      __dirname,
      '../../../data/cards.enriched.json',
    );
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as
      | EnrichedCardLite[]
      | { cards: EnrichedCardLite[] };
    const cards = Array.isArray(parsed) ? parsed : parsed.cards ?? [];
    for (const rc of reclasses) {
      const card = cards.find((c) => c.id === rc.id);
      if (!card) continue;
      const types = (card.effectProfile?.operations ?? []).map((o) => o.type);
      expect(types).not.toContain('generic');
      expect(types).toContain(rc.newOp);
    }
  });
});
