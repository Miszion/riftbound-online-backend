/**
 * Phase 9 classifier regression tests.
 *
 * Context: docs/phase-8-generic-op-triage.md enumerates six residual cards
 * that fall through the enricher classifiers and land on the `generic`
 * catch-all op. Phase 9 patches the deal_damage, combat_bonus, and
 * conditional_buff regex families in both
 *   - scripts/data/transformChampionDump.ts (EFFECT_CLASS_DEFINITIONS)
 *   - src/card-catalog.ts (EFFECT_CLASS_DEFINITIONS)
 * to classify these six cards correctly. After regeneration of
 * data/cards.enriched.json, each of the six target cards should produce its
 * expected op family instead of `generic`.
 *
 * This test file locks in that expectation. Pre-regen runs fail loudly on
 * the specific per-card assertions; post-regen runs pass. The generic-ceiling
 * test gates future enrichment changes so the catch-all count cannot silently
 * climb back up.
 *
 * Op names were confirmed against src/effects/handlers/:
 *   - combat.ts line 115:  op: 'deal_damage'
 *   - stats.ts  line 185:  op: 'combat_bonus'
 *   - stats.ts  line 360:  op: 'conditional_buff'
 * and src/effects/index.ts buildDefaultRegistry registers all three.
 */
import { loadEnrichedCatalog, EnrichedCard } from './_harness';

// ---------------------------------------------------------------------------
// Target cards from docs/phase-8-generic-op-triage.md residual table.
// ---------------------------------------------------------------------------

const DEAL_DAMAGE_CARDS = ['OGN-029', 'OGN-248', 'OGN-105', 'SFD-107'];
const COMBAT_BONUS_CARDS = ['UNL-154'];
const CONDITIONAL_BUFF_CARDS = ['UNL-098'];

// Phase 9 target after Backend regex patch + catalog regen: zero cards
// remain on the `generic` catch-all. A small +2 buffer guards against a
// single classifier drift without letting the ceiling quietly regrow.
const GENERIC_OP_CEILING = 2;

// ---------------------------------------------------------------------------
// Helpers. Collect ops from both effectProfile.operations and abilities[].
// Phase 9 enrichment may attach the classifier result to either path; we
// accept a match on either.
// ---------------------------------------------------------------------------

function allOpsOf(card: EnrichedCard): Array<{ type: string; [k: string]: unknown }> {
  const profileOps = card.effectProfile?.operations ?? [];
  const abilityOps = (card.abilities ?? []).flatMap((a) => a.operations ?? []);
  return [...profileOps, ...abilityOps];
}

function findCard(cards: EnrichedCard[], id: string): EnrichedCard | undefined {
  return cards.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Per-card assertions: each target card carries at least one op of the
// expected family once the enricher regen lands. If the catalog is missing
// we flag and skip (mirrors the etl-migration.test.ts convention).
// ---------------------------------------------------------------------------

describe('classifier-regressions: deal_damage variants (4 cards)', () => {
  for (const cardId of DEAL_DAMAGE_CARDS) {
    it(`${cardId} has at least one deal_damage op`, () => {
      const cards = loadEnrichedCatalog();
      if (!cards) {
        // eslint-disable-next-line no-console
        console.log('[classifier-regressions] catalog not loaded; skipping');
        return;
      }
      const card = findCard(cards, cardId);
      expect(card).toBeDefined();
      if (!card) return;
      const ops = allOpsOf(card);
      const types = ops.map((o) => o.type);
      const hasDamage = types.includes('deal_damage');
      if (!hasDamage) {
        // eslint-disable-next-line no-console
        console.error(
          `[classifier-regressions] ${cardId} ops: [${types.join(', ')}]`
        );
      }
      expect(hasDamage).toBe(true);
    });
  }
});

describe('classifier-regressions: combat_bonus (1 card)', () => {
  for (const cardId of COMBAT_BONUS_CARDS) {
    it(`${cardId} has at least one combat_bonus op`, () => {
      const cards = loadEnrichedCatalog();
      if (!cards) return;
      const card = findCard(cards, cardId);
      expect(card).toBeDefined();
      if (!card) return;
      const ops = allOpsOf(card);
      const types = ops.map((o) => o.type);
      const hasBonus = types.includes('combat_bonus');
      if (!hasBonus) {
        // eslint-disable-next-line no-console
        console.error(
          `[classifier-regressions] ${cardId} ops: [${types.join(', ')}]`
        );
      }
      expect(hasBonus).toBe(true);
    });
  }
});

describe('classifier-regressions: conditional_buff [Level N] (1 card)', () => {
  for (const cardId of CONDITIONAL_BUFF_CARDS) {
    it(`${cardId} has at least one conditional_buff op`, () => {
      const cards = loadEnrichedCatalog();
      if (!cards) return;
      const card = findCard(cards, cardId);
      expect(card).toBeDefined();
      if (!card) return;
      const ops = allOpsOf(card);
      const types = ops.map((o) => o.type);
      const hasBuff = types.includes('conditional_buff');
      if (!hasBuff) {
        // eslint-disable-next-line no-console
        console.error(
          `[classifier-regressions] ${cardId} ops: [${types.join(', ')}]`
        );
      }
      expect(hasBuff).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Fence test: the generic catch-all must not climb back up. Post-Phase-9 the
// expected steady-state count is 0 (all six residual cards reclassified).
// We allow a +2 flex buffer so a single transient classifier drift does not
// tank CI, but anything over that is a hard failure.
// ---------------------------------------------------------------------------

describe('classifier-regressions: generic op ceiling (fence)', () => {
  it(`catalog has <= ${GENERIC_OP_CEILING} cards whose effect is purely generic/noop`, () => {
    const cards = loadEnrichedCatalog();
    if (!cards) {
      // eslint-disable-next-line no-console
      console.log('[classifier-regressions] catalog not loaded; skipping ceiling check');
      return;
    }
    const offenders: string[] = [];
    for (const c of cards) {
      const ops = allOpsOf(c);
      if (ops.length === 0) continue;
      const nonGeneric = ops.filter(
        (o) => o.type !== 'generic' && o.type !== 'noop'
      );
      if (nonGeneric.length === 0) {
        offenders.push(c.id);
      }
    }
    if (offenders.length > GENERIC_OP_CEILING) {
      // eslint-disable-next-line no-console
      console.error(
        `[classifier-regressions] generic-only cards (${offenders.length}): ${offenders.join(', ')}`
      );
    }
    expect(offenders.length).toBeLessThanOrEqual(GENERIC_OP_CEILING);
  });
});
