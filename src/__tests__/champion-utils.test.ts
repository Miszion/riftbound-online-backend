/**
 * Champion Utils - Comprehensive Unit Tests
 *
 * Covers: hasManualActivation, parseChampionAbilityCost,
 *         canSatisfyChampionCost, summarizeChampionCost
 */
import {
  hasManualActivation,
  parseChampionAbilityCost,
  canSatisfyChampionCost,
  summarizeChampionCost,
  ChampionAbilityCost,
  DomainKey,
} from '../champion-utils';
import { RuneCard, Domain } from '../game-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRune(
  domain: Domain | null | undefined,
  powerValue = 1,
  isTapped = false,
  id = Math.random().toString(36).slice(2)
): RuneCard {
  return {
    id,
    name: `Rune-${id}`,
    domain: domain ?? undefined,
    energyValue: 1,
    powerValue,
    slug: `rune-${id}`,
    assets: null,
    isTapped,
    cardSnapshot: null,
  };
}

function makeCost(overrides: Partial<ChampionAbilityCost> = {}): ChampionAbilityCost {
  return {
    energy: 0,
    runes: {},
    requiresExhaust: false,
    rawText: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hasManualActivation
// ---------------------------------------------------------------------------

describe('hasManualActivation', () => {
  describe('returns false for absent / empty input', () => {
    it('returns false for undefined', () => {
      expect(hasManualActivation(undefined)).toBe(false);
    });

    it('returns false for null', () => {
      expect(hasManualActivation(null)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(hasManualActivation('')).toBe(false);
    });
  });

  describe('exhaust-activated abilities', () => {
    it('detects :rb_exhaust:: (double-colon) as activated', () => {
      expect(hasManualActivation(':rb_exhaust:: Draw a card.')).toBe(true);
    });

    it('detects :rb_exhaust: : with a space before colon', () => {
      expect(hasManualActivation(':rb_exhaust: : Do something.')).toBe(true);
    });

    it('detects [tap]: syntax', () => {
      expect(hasManualActivation('[tap]: Deal 1 damage.')).toBe(true);
    });

    it('detects [tap] : with a space', () => {
      expect(hasManualActivation('[tap] : Heal 2.')).toBe(true);
    });

    it('is case-insensitive for :RB_EXHAUST::', () => {
      expect(hasManualActivation(':RB_EXHAUST:: Uppercase.')).toBe(true);
    });

    it('is case-insensitive for [TAP]:', () => {
      expect(hasManualActivation('[TAP]: Uppercase tap.')).toBe(true);
    });

    it('returns false for :rb_exhaust: without following colon', () => {
      // Just the token with no activation colon - this is a rune token inside text
      expect(hasManualActivation('Requires :rb_exhaust: to activate maybe')).toBe(false);
    });
  });

  describe('energy-activated abilities', () => {
    it('detects :rb_energy_3:: as activated', () => {
      expect(hasManualActivation(':rb_energy_3:: Draw 2 cards.')).toBe(true);
    });

    it('detects :rb_energy_1:: as activated', () => {
      expect(hasManualActivation(':rb_energy_1:: Gain 1 life.')).toBe(true);
    });

    it('detects :rb_energy_10:: (multi-digit) as activated', () => {
      expect(hasManualActivation(':rb_energy_10:: Massive effect.')).toBe(true);
    });

    it('detects [2]: bracket-energy syntax', () => {
      expect(hasManualActivation('[2]: Do the thing.')).toBe(true);
    });

    it('detects [0]: zero-energy activation', () => {
      expect(hasManualActivation('[0]: Free activation.')).toBe(true);
    });

    it('is case-insensitive for energy tokens', () => {
      expect(hasManualActivation(':RB_ENERGY_2:: Caps test.')).toBe(true);
    });
  });

  describe('passive / triggered abilities (not activatable)', () => {
    it('returns false for "When..." triggered abilities', () => {
      expect(hasManualActivation('When this creature enters the battlefield, draw a card.')).toBe(false);
    });

    it('returns false for "At the start of your turn" phase triggers', () => {
      expect(hasManualActivation('At the start of your turn, gain 1 energy.')).toBe(false);
    });

    it('returns false for "At the end of your turn" phase triggers', () => {
      expect(hasManualActivation('At the end of your turn, deal 1 damage to each opponent.')).toBe(false);
    });

    it('returns false for "While..." conditional static abilities', () => {
      expect(hasManualActivation('While you control a fury creature, this gets +1/+1.')).toBe(false);
    });

    it('returns false for static buffs', () => {
      expect(hasManualActivation('Your creatures have +1/+1.')).toBe(false);
    });

    it('returns false for plain text with no activation syntax', () => {
      expect(hasManualActivation('This creature cannot be blocked by creatures with power 2 or less.')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// parseChampionAbilityCost
// ---------------------------------------------------------------------------

describe('parseChampionAbilityCost', () => {
  describe('null / undefined / empty input', () => {
    it('returns zero cost for undefined', () => {
      const cost = parseChampionAbilityCost(undefined);
      expect(cost.energy).toBe(0);
      expect(cost.runes).toEqual({});
      expect(cost.requiresExhaust).toBe(false);
      expect(cost.rawText).toBe('');
    });

    it('returns zero cost for null', () => {
      const cost = parseChampionAbilityCost(null);
      expect(cost.energy).toBe(0);
      expect(cost.runes).toEqual({});
      expect(cost.requiresExhaust).toBe(false);
      expect(cost.rawText).toBe('');
    });

    it('returns zero cost for empty string', () => {
      const cost = parseChampionAbilityCost('');
      expect(cost.energy).toBe(0);
      expect(cost.runes).toEqual({});
      expect(cost.requiresExhaust).toBe(false);
      expect(cost.rawText).toBe('');
    });
  });

  describe('energy parsing', () => {
    it('parses a single energy token', () => {
      const cost = parseChampionAbilityCost(':rb_energy_3:: Draw a card.');
      expect(cost.energy).toBe(3);
    });

    it('parses energy value of 1', () => {
      expect(parseChampionAbilityCost(':rb_energy_1::').energy).toBe(1);
    });

    it('sums multiple energy tokens', () => {
      const cost = parseChampionAbilityCost(':rb_energy_2: :rb_energy_1:: Effect.');
      expect(cost.energy).toBe(3);
    });

    it('parses two-digit energy token', () => {
      expect(parseChampionAbilityCost(':rb_energy_10::').energy).toBe(10);
    });

    it('returns 0 energy when no energy token present', () => {
      expect(parseChampionAbilityCost(':rb_rune_fury::').energy).toBe(0);
    });
  });

  describe('rune parsing', () => {
    it('parses a single fury rune', () => {
      const cost = parseChampionAbilityCost(':rb_rune_fury::');
      expect(cost.runes).toEqual({ fury: 1 });
    });

    it('parses a single calm rune', () => {
      expect(parseChampionAbilityCost(':rb_rune_calm::').runes).toEqual({ calm: 1 });
    });

    it('parses a single mind rune', () => {
      expect(parseChampionAbilityCost(':rb_rune_mind::').runes).toEqual({ mind: 1 });
    });

    it('parses a single body rune', () => {
      expect(parseChampionAbilityCost(':rb_rune_body::').runes).toEqual({ body: 1 });
    });

    it('parses a single chaos rune', () => {
      expect(parseChampionAbilityCost(':rb_rune_chaos::').runes).toEqual({ chaos: 1 });
    });

    it('parses a single order rune', () => {
      expect(parseChampionAbilityCost(':rb_rune_order::').runes).toEqual({ order: 1 });
    });

    it('parses a single rainbow rune', () => {
      expect(parseChampionAbilityCost(':rb_rune_rainbow::').runes).toEqual({ rainbow: 1 });
    });

    it('counts two of the same domain rune', () => {
      const cost = parseChampionAbilityCost(':rb_rune_fury: :rb_rune_fury::');
      expect(cost.runes).toEqual({ fury: 2 });
    });

    it('counts three of the same domain rune', () => {
      const cost = parseChampionAbilityCost(':rb_rune_mind: :rb_rune_mind: :rb_rune_mind::');
      expect(cost.runes).toEqual({ mind: 3 });
    });

    it('parses multiple different domain runes', () => {
      const cost = parseChampionAbilityCost(':rb_rune_calm: :rb_rune_mind::');
      expect(cost.runes).toEqual({ calm: 1, mind: 1 });
    });

    it('returns empty runes when no rune tokens present', () => {
      expect(parseChampionAbilityCost(':rb_energy_2::').runes).toEqual({});
    });
  });

  describe('exhaust parsing', () => {
    it('detects :rb_exhaust: token', () => {
      expect(parseChampionAbilityCost(':rb_exhaust::').requiresExhaust).toBe(true);
    });

    it('requiresExhaust is false when token absent', () => {
      expect(parseChampionAbilityCost(':rb_energy_2::').requiresExhaust).toBe(false);
    });

    it('is case-insensitive for exhaust token', () => {
      expect(parseChampionAbilityCost(':RB_EXHAUST::').requiresExhaust).toBe(true);
    });
  });

  describe('rawText', () => {
    it('preserves the full input string as rawText', () => {
      const text = ':rb_energy_2: :rb_rune_fury: :rb_exhaust:: Deal 3 damage.';
      expect(parseChampionAbilityCost(text).rawText).toBe(text);
    });
  });

  describe('complex combined cost', () => {
    it('parses energy + rune + exhaust together', () => {
      const cost = parseChampionAbilityCost(':rb_energy_2: :rb_rune_fury: :rb_exhaust:: Deal 3 damage.');
      expect(cost.energy).toBe(2);
      expect(cost.runes).toEqual({ fury: 1 });
      expect(cost.requiresExhaust).toBe(true);
    });

    it('parses multi-energy + multi-rune', () => {
      const cost = parseChampionAbilityCost(':rb_energy_3: :rb_rune_calm: :rb_rune_calm: :rb_rune_mind::');
      expect(cost.energy).toBe(3);
      expect(cost.runes).toEqual({ calm: 2, mind: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
// canSatisfyChampionCost
// ---------------------------------------------------------------------------

describe('canSatisfyChampionCost', () => {
  describe('zero cost', () => {
    it('returns true with zero cost and no runes', () => {
      expect(canSatisfyChampionCost([], makeCost())).toBe(true);
    });

    it('returns true with zero cost and available runes', () => {
      const runes = [makeRune(Domain.FURY), makeRune(Domain.CALM)];
      expect(canSatisfyChampionCost(runes, makeCost())).toBe(true);
    });
  });

  describe('energy cost', () => {
    it('returns true when exactly enough untapped runes for energy', () => {
      const runes = [makeRune(Domain.FURY)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 1 }))).toBe(true);
    });

    it('returns true when more runes than energy required', () => {
      const runes = [makeRune(Domain.FURY), makeRune(Domain.CALM), makeRune(Domain.MIND)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 2 }))).toBe(true);
    });

    it('returns false when not enough untapped runes for energy', () => {
      const runes = [makeRune(Domain.FURY)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 2 }))).toBe(false);
    });

    it('returns false when all runes are tapped', () => {
      const runes = [makeRune(Domain.FURY, 1, true), makeRune(Domain.CALM, 1, true)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 1 }))).toBe(false);
    });

    it('returns false with no runes and energy > 0', () => {
      expect(canSatisfyChampionCost([], makeCost({ energy: 1 }))).toBe(false);
    });

    it('returns true with negative energy (treated as 0 via Math.max)', () => {
      const runes = [makeRune(Domain.FURY)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: -1 }))).toBe(true);
    });

    it('uses untapped runes (skips tapped)', () => {
      const runes = [makeRune(Domain.FURY, 1, true), makeRune(Domain.CALM, 1, false)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 1 }))).toBe(true);
    });
  });

  describe('domain rune requirements', () => {
    it('returns true when exactly matching domain rune is present', () => {
      const runes = [makeRune(Domain.FURY)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { fury: 1 } }))).toBe(true);
    });

    it('returns false when wrong-domain rune is present', () => {
      const runes = [makeRune(Domain.CALM)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { fury: 1 } }))).toBe(false);
    });

    it('returns true when null-domain rune satisfies a domain requirement', () => {
      const runes = [makeRune(null)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { fury: 1 } }))).toBe(true);
    });

    it('returns false when domain rune is tapped', () => {
      const runes = [makeRune(Domain.FURY, 1, true)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { fury: 1 } }))).toBe(false);
    });

    it('returns true when two of the same domain are needed and present', () => {
      const runes = [makeRune(Domain.MIND), makeRune(Domain.MIND)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { mind: 2 } }))).toBe(true);
    });

    it('returns false when only one of two required same-domain runes is present', () => {
      const runes = [makeRune(Domain.MIND)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { mind: 2 } }))).toBe(false);
    });

    it('returns true with multiple domain requirements all satisfied', () => {
      const runes = [makeRune(Domain.CALM), makeRune(Domain.MIND), makeRune(Domain.FURY)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { calm: 1, mind: 1 } }))).toBe(true);
    });

    it('returns false when one of multiple domain requirements unmet', () => {
      const runes = [makeRune(Domain.CALM)];
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { calm: 1, mind: 1 } }))).toBe(false);
    });
  });

  describe('combined energy + domain requirements', () => {
    it('returns true when energy and domain both satisfied', () => {
      // Need 1 energy + 1 fury rune = need 2 runes total
      const runes = [makeRune(Domain.FURY), makeRune(Domain.FURY)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 1, runes: { fury: 1 } }))).toBe(true);
    });

    it('returns false when only energy is satisfied but domain is not', () => {
      const runes = [makeRune(Domain.CALM)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 1, runes: { fury: 1 } }))).toBe(false);
    });

    it('returns false when only domain is satisfied but energy is not', () => {
      const runes = [makeRune(Domain.FURY)];
      // Need 2 energy + 1 fury = need 3 runes but only 1 available
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 2, runes: { fury: 1 } }))).toBe(false);
    });

    it('a typed rune used for energy also satisfies its matching domain requirement', () => {
      // Only 1 fury rune - used for energy cost, AND the same rune satisfies domain fury:1
      // because satisfyFromEnergy() double-counts typed energy selections for domain requirements
      const runes = [makeRune(Domain.FURY)];
      const cost = makeCost({ energy: 1, runes: { fury: 1 } });
      expect(canSatisfyChampionCost(runes, cost)).toBe(true);
    });

    it('returns false when typed rune covers energy+domain but second domain requirement unmet', () => {
      // 1 fury rune covers energy:1 and domain fury:1, but domain calm:1 has no rune
      const runes = [makeRune(Domain.FURY)];
      const cost = makeCost({ energy: 1, runes: { fury: 1, calm: 1 } });
      expect(canSatisfyChampionCost(runes, cost)).toBe(false);
    });
  });

  describe('requiresExhaust is ignored by canSatisfyChampionCost', () => {
    it('returns true when runes are sufficient even with requiresExhaust: true', () => {
      const runes = [makeRune(Domain.FURY)];
      expect(canSatisfyChampionCost(runes, makeCost({ energy: 1, requiresExhaust: true }))).toBe(true);
    });
  });

  describe('rune powerValue', () => {
    it('rune with powerValue 2 can satisfy domain requirement of 1 in a single rune', () => {
      const runes = [makeRune(Domain.BODY, 2)];
      // remaining starts at 1, domain rune has powerValue 2
      // remaining -= Math.max(1, 2) = 2, so remaining = -1 <= 0 -> satisfied
      expect(canSatisfyChampionCost(runes, makeCost({ runes: { body: 1 } }))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// summarizeChampionCost
// ---------------------------------------------------------------------------

describe('summarizeChampionCost', () => {
  it('returns "No cost" when everything is zero/false', () => {
    expect(summarizeChampionCost(makeCost())).toBe('No cost');
  });

  describe('energy only', () => {
    it('formats 1 energy', () => {
      expect(summarizeChampionCost(makeCost({ energy: 1 }))).toBe('1 energy');
    });

    it('formats 3 energy', () => {
      expect(summarizeChampionCost(makeCost({ energy: 3 }))).toBe('3 energy');
    });
  });

  describe('runes only', () => {
    it('formats 1 fury rune (singular)', () => {
      expect(summarizeChampionCost(makeCost({ runes: { fury: 1 } }))).toBe('1 fury rune');
    });

    it('formats 2 fury runes (plural)', () => {
      expect(summarizeChampionCost(makeCost({ runes: { fury: 2 } }))).toBe('2 fury runes');
    });

    it('formats 3 calm runes (plural)', () => {
      expect(summarizeChampionCost(makeCost({ runes: { calm: 3 } }))).toBe('3 calm runes');
    });

    it('formats multiple different domain runes joined with " + "', () => {
      const summary = summarizeChampionCost(makeCost({ runes: { fury: 1, mind: 1 } }));
      expect(summary).toContain('1 fury rune');
      expect(summary).toContain('1 mind rune');
      expect(summary).toContain('+');
    });

    it('omits rune entries with value 0', () => {
      const summary = summarizeChampionCost(makeCost({ runes: { fury: 0, calm: 1 } }));
      expect(summary).not.toContain('fury');
      expect(summary).toContain('1 calm rune');
    });
  });

  describe('exhaust only', () => {
    it('formats exhaust-only cost', () => {
      expect(summarizeChampionCost(makeCost({ requiresExhaust: true }))).toBe('exhaust legend');
    });
  });

  describe('combined costs', () => {
    it('formats energy + exhaust', () => {
      const summary = summarizeChampionCost(makeCost({ energy: 2, requiresExhaust: true }));
      expect(summary).toBe('2 energy, exhaust legend');
    });

    it('formats energy + runes', () => {
      const summary = summarizeChampionCost(makeCost({ energy: 2, runes: { body: 1 } }));
      expect(summary).toBe('2 energy, 1 body rune');
    });

    it('formats runes + exhaust', () => {
      const summary = summarizeChampionCost(makeCost({ runes: { order: 1 }, requiresExhaust: true }));
      expect(summary).toBe('1 order rune, exhaust legend');
    });

    it('formats energy + runes + exhaust', () => {
      const summary = summarizeChampionCost(makeCost({ energy: 3, runes: { mind: 2 }, requiresExhaust: true }));
      expect(summary).toBe('3 energy, 2 mind runes, exhaust legend');
    });

    it('formats complex multi-domain + exhaust', () => {
      const summary = summarizeChampionCost(
        makeCost({ energy: 1, runes: { fury: 1, calm: 2 }, requiresExhaust: true })
      );
      expect(summary).toContain('1 energy');
      expect(summary).toContain('1 fury rune');
      expect(summary).toContain('2 calm runes');
      expect(summary).toContain('exhaust legend');
    });
  });
});
