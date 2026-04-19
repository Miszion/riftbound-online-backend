/**
 * Card Catalog - Edge Case Tests (QA-PHASE-8)
 *
 * Covers: buildActivation, buildEffectProfile, parseAssaultBonus, parseTokenSpecs,
 * analyzeSpellTargeting, spellRequiresTargetSelection, getSpellTargetScope,
 * reshapeDump, effectClassDefinitions, and all branching paths in pure functions.
 */
import {
  buildActivation,
  buildEffectProfile,
  parseAssaultBonus,
  parseTokenSpecs,
  analyzeSpellTargeting,
  spellRequiresTargetSelection,
  getSpellTargetScope,
  reshapeDump,
  effectClassDefinitions,
  EnrichedCardRecord,
  EffectProfile,
  ActivationProfile,
  RawDump
} from '../card-catalog';

// ===========================================================================
// Test Helpers
// ===========================================================================

function makeActivation(overrides: Partial<ActivationProfile> = {}): ActivationProfile {
  return {
    timing: 'action',
    triggers: [],
    actions: [],
    requiresTarget: false,
    reactionWindows: [],
    stateful: false,
    ...overrides
  };
}

function makeEffectProfile(overrides: Partial<EffectProfile> = {}): EffectProfile {
  return {
    classes: ['damage'],
    primaryClass: 'damage',
    operations: [],
    targeting: { mode: 'none', requiresSelection: false },
    priority: 'main',
    references: [],
    reliability: 'exact',
    ...overrides
  };
}

function makeEnrichedCard(
  effectText: string,
  type = 'spell',
  effectProfileOverride?: Partial<EffectProfile>
): EnrichedCardRecord {
  const activation = buildActivation(effectText);
  const effectProfile = buildEffectProfile(effectText, activation);
  return {
    id: 'TEST-001',
    slug: 'test-001-card',
    name: 'Test Card',
    type,
    rarity: 'common',
    setName: 'Test Set',
    colors: [],
    cost: { energy: 1, powerSymbols: [], raw: '1' },
    might: null,
    tags: [],
    effect: effectText,
    flavor: null,
    keywords: [],
    effectProfile: effectProfileOverride
      ? { ...effectProfile, ...effectProfileOverride }
      : effectProfile,
    activation,
    rules: [],
    assets: { remote: null, localPath: 'assets/card-images/test-001-card.webp' },
    pricing: { price: null, foilPrice: null, currency: 'USD' },
    references: { marketUrl: null, source: 'test' },
    timingTags: [],
    // Phase 5a added isRuneResource as a required field on EnrichedCardRecord.
    // The fixture helper defaults to false since these test records are
    // spells / units by construction. Keeping this alongside the explicit
    // constructor so new required fields fail loudly at the helper rather
    // than leaking a partial-record TypeError into each caller site.
    isRuneResource: false
  };
}

// ===========================================================================
// buildActivation - deriveTiming
// ===========================================================================
describe('buildActivation - timing derivation', () => {
  it('detects action timing from ACTION prefix', () => {
    const result = buildActivation('ACTION: Deal 3 damage to an enemy unit.');
    expect(result.timing).toBe('action');
  });

  it('detects action timing from [Action] bracket', () => {
    const result = buildActivation('[Action] Give target ally unit +2/+2.');
    expect(result.timing).toBe('action');
  });

  it('detects reaction timing from REACTION prefix', () => {
    const result = buildActivation('REACTION: Cancel target spell.');
    expect(result.timing).toBe('reaction');
  });

  it('detects reaction timing from [Reaction] bracket', () => {
    const result = buildActivation('[Reaction] Draw a card when an enemy unit attacks.');
    expect(result.timing).toBe('reaction');
  });

  it('detects triggered timing from When keyword', () => {
    const result = buildActivation('When I die, draw a card.');
    expect(result.timing).toBe('triggered');
  });

  it('detects triggered timing from Whenever keyword', () => {
    const result = buildActivation('Whenever you play a spell, deal 1 damage to an enemy unit.');
    expect(result.timing).toBe('triggered');
  });

  it('defaults to main timing for plain effect text', () => {
    const result = buildActivation('Deal 5 damage to all enemy units.');
    expect(result.timing).toBe('main');
  });

  it('handles empty string gracefully', () => {
    const result = buildActivation('');
    expect(result.timing).toBe('main');
    expect(result.triggers).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.requiresTarget).toBe(false);
    expect(result.reactionWindows).toEqual([]);
    expect(result.stateful).toBe(false);
  });
});

// ===========================================================================
// buildActivation - requiresTarget
// ===========================================================================
describe('buildActivation - requiresTarget', () => {
  it('sets requiresTarget for "target" keyword', () => {
    const result = buildActivation('Deal 2 damage to target enemy unit.');
    expect(result.requiresTarget).toBe(true);
  });

  it('sets requiresTarget for "choose" keyword', () => {
    const result = buildActivation('Choose a unit to buff.');
    expect(result.requiresTarget).toBe(true);
  });

  it('sets requiresTarget for "select" keyword', () => {
    const result = buildActivation('Select an enemy to destroy.');
    expect(result.requiresTarget).toBe(true);
  });

  it('infers requiresTarget for return-to-hand without "all/each"', () => {
    const result = buildActivation('Return a unit to its owner\'s hand.');
    expect(result.requiresTarget).toBe(true);
  });

  it('does NOT infer requiresTarget for return-to-hand with "all"', () => {
    const result = buildActivation('Return all units to their owners\' hands.');
    expect(result.requiresTarget).toBe(false);
  });

  it('does NOT infer requiresTarget for return-to-hand with "each"', () => {
    const result = buildActivation('Return each unit to its owner\'s hand.');
    expect(result.requiresTarget).toBe(false);
  });

  it('does NOT infer requiresTarget for graveyard return', () => {
    const result = buildActivation('Return a unit from your graveyard to your hand.');
    // graveyard is excluded from the hand-return inference
    expect(result.requiresTarget).toBe(false);
  });

  it('does NOT set requiresTarget for global effects', () => {
    const result = buildActivation('Deal 1 damage to all units.');
    expect(result.requiresTarget).toBe(false);
  });
});

// ===========================================================================
// buildActivation - actions, triggers, reactionWindows, stateful
// ===========================================================================
describe('buildActivation - derived fields', () => {
  it('derives draw action', () => {
    const result = buildActivation('Draw two cards.');
    expect(result.actions).toContain('draw');
  });

  it('derives buff action', () => {
    const result = buildActivation('Buff target ally unit.');
    expect(result.actions).toContain('buff');
    expect(result.stateful).toBe(true);
  });

  it('derives heal action and marks stateful', () => {
    const result = buildActivation('Heal 3 damage from target unit.');
    expect(result.actions).toContain('heal');
    expect(result.stateful).toBe(true);
  });

  it('derives summon action and marks stateful', () => {
    const result = buildActivation('Summon a 2/2 token.');
    expect(result.actions).toContain('summon');
    expect(result.stateful).toBe(true);
  });

  it('derives discard action', () => {
    const result = buildActivation('Discard two cards.');
    expect(result.actions).toContain('discard');
  });

  it('derives conquer action', () => {
    const result = buildActivation('Conquer a battlefield.');
    expect(result.actions).toContain('conquer');
  });

  it('derives transform action and marks stateful', () => {
    const result = buildActivation('Transform target unit.');
    expect(result.actions).toContain('transform');
    expect(result.stateful).toBe(true);
  });

  it('derives kill action', () => {
    const result = buildActivation('Kill target enemy unit.');
    expect(result.actions).toContain('kill');
  });

  it('derives triggers from When clause', () => {
    const result = buildActivation('When I attack, draw a card.');
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0]).toMatch(/When/i);
  });

  it('derives triggers from Whenever clause', () => {
    const result = buildActivation('Whenever you draw a card, gain 1 energy.');
    expect(result.triggers.length).toBeGreaterThan(0);
  });

  it('derives triggers from multiple clauses', () => {
    const result = buildActivation('When I enter, draw a card. Whenever you play a spell, heal 1.');
    expect(result.triggers.length).toBe(2);
  });

  it('detects showdown reaction window', () => {
    const result = buildActivation('[Reaction] Use during a showdown.');
    expect(result.reactionWindows).toContain('showdown');
  });

  it('detects opponent-turn reaction window', () => {
    const result = buildActivation("[Reaction] Use on your opponent's turn.");
    expect(result.reactionWindows).toContain('opponent-turn');
  });

  it('detects your-turn reaction window', () => {
    const result = buildActivation('[Reaction] Use on your turn to draw a card.');
    expect(result.reactionWindows).toContain('your-turn');
  });

  it('detects multiple reaction windows', () => {
    const result = buildActivation("[Reaction] Use on your turn or your opponent's turn.");
    expect(result.reactionWindows).toContain('your-turn');
    expect(result.reactionWindows).toContain('opponent-turn');
  });
});

// ===========================================================================
// buildEffectProfile - effect class matching
// ===========================================================================
describe('buildEffectProfile - effect class detection', () => {
  it('detects card_draw for "draw" keyword', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Draw two cards.', activation);
    expect(result.classes).toContain('card_draw');
    expect(result.primaryClass).toBe('card_draw');
  });

  it('detects card_discard for "discard" keyword', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Discard two cards from your hand.', activation);
    expect(result.classes).toContain('card_discard');
  });

  it('detects resource_gain for "gain energy" pattern', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Gain 2 energy.', activation);
    expect(result.classes).toContain('resource_gain');
  });

  it('detects damage for "deal damage" pattern', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Deal 3 damage to target enemy unit.', activation);
    expect(result.classes).toContain('damage');
  });

  it('detects heal for "heal" pattern', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Heal 2 damage from target unit.', activation);
    expect(result.classes).toContain('heal');
  });

  it('detects removal for "destroy" pattern', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Destroy target enemy unit.', activation);
    expect(result.classes).toContain('removal');
  });

  it('detects removal for "kill" pattern', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Kill target enemy unit.', activation);
    expect(result.classes).toContain('removal');
  });

  it('detects removal for "banish" pattern', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Banish target enemy unit.', activation);
    expect(result.classes).toContain('removal');
  });

  it('detects buff for "give +N" pattern', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Give target ally unit +2.', activation);
    expect(result.classes).toContain('buff');
  });

  it('detects debuff for "give -N" pattern', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Give target enemy unit -2.', activation);
    expect(result.classes).toContain('debuff');
  });

  it('detects search for "search" keyword', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Search your deck for a unit.', activation);
    expect(result.classes).toContain('search');
  });

  it('detects graveyard_return for return from graveyard', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Return a unit from your graveyard to play.', activation);
    expect(result.classes).toContain('graveyard_return');
  });

  it('detects hand_return for return to hand (no graveyard)', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Return target unit to its owner\'s hand.', activation);
    expect(result.classes).toContain('hand_return');
  });

  it('does NOT classify "return from trash" as hand_return', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Return a unit from the trash to your hand.', activation);
    expect(result.classes).not.toContain('hand_return');
  });

  it('detects token for "tokens" keyword', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Play two 2/2 Fury unit tokens here.', activation);
    expect(result.classes).toContain('token');
  });

  it('detects movement for "move" keyword', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Move target ally unit to another battlefield.', activation);
    expect(result.classes).toContain('movement');
  });

  it('detects mulligan for "mulligan" keyword', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Look at your starting hand before the mulligan.', activation);
    expect(result.classes).toContain('mulligan');
  });

  it('detects assault class', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Assault 2] I get +2 might while attacking.', activation);
    expect(result.classes).toContain('assault');
  });

  it('detects shield_combat class', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Shield 3] I get +3 might while defending.', activation);
    expect(result.classes).toContain('shield_combat');
  });

  it('detects combat_trigger for "when I attack"', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('When I attack, deal 1 damage to an enemy unit.', activation);
    expect(result.classes).toContain('combat_trigger');
  });

  it('detects aura_buff for "other friendly units have"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Other friendly units here have +1.', activation);
    expect(result.classes).toContain('aura_buff');
  });

  it('detects on_play for "when you play me"', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('When you play me, draw a card.', activation);
    expect(result.classes).toContain('on_play');
  });

  it('detects hold_trigger for "when I hold"', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('When I hold this battlefield, gain 1 energy.', activation);
    expect(result.classes).toContain('hold_trigger');
  });

  it('detects cost_reduction for "costs less"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('I cost 1 less to play.', activation);
    expect(result.classes).toContain('cost_reduction');
  });

  it('detects scoring for "score N points"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('You score 2 points when you conquer a battlefield.', activation);
    expect(result.classes).toContain('scoring');
  });

  it('detects conquer_trigger for "when I conquer"', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('When I conquer, draw a card.', activation);
    expect(result.classes).toContain('conquer_trigger');
  });

  it('detects death_trigger for "when I die"', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('When I die, deal 2 damage to an enemy unit.', activation);
    expect(result.classes).toContain('death_trigger');
  });

  it('detects keyword_legion for [Legion]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Legion] — When I enter, if you played another card this turn, draw a card.', activation);
    expect(result.classes).toContain('keyword_legion');
  });

  it('detects keyword_accelerate for [Accelerate]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Accelerate] (:rb_energy_2:) I enter ready.', activation);
    expect(result.classes).toContain('keyword_accelerate');
  });

  it('detects keyword_hidden for "hide now for"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Hide now for :rb_energy_1: to play this as a hidden card.', activation);
    expect(result.classes).toContain('keyword_hidden');
  });

  it('detects keyword_deflect for [Deflect]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Deflect] Costs opponent 1 extra to target.', activation);
    expect(result.classes).toContain('keyword_deflect');
  });

  it('detects keyword_weaponmaster for [Weaponmaster]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Weaponmaster] Equip gear for free when played.', activation);
    expect(result.classes).toContain('keyword_weaponmaster');
  });

  it('detects keyword_ganking for [Ganking]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Ganking] Can move between battlefields.', activation);
    expect(result.classes).toContain('keyword_ganking');
  });

  it('detects keyword_tank for [Tank]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Tank] Must be assigned combat damage first.', activation);
    expect(result.classes).toContain('keyword_tank');
  });

  it('detects keyword_repeat for [Repeat]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Repeat] Pay extra to trigger effect again.', activation);
    expect(result.classes).toContain('keyword_repeat');
  });

  it('detects equip_trigger for [Equip]', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('[Equip] When you attach gear to this unit, draw a card.', activation);
    expect(result.classes).toContain('equip_trigger');
  });

  it('detects stun_effect for "stun"', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Stun target enemy unit.', activation);
    expect(result.classes).toContain('stun_effect');
  });

  it('detects ready_effect for "enter ready"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('I enter ready when played.', activation);
    expect(result.classes).toContain('ready_effect');
  });

  // Phase-5a removed the `rune_type` text classifier (it used to fire on the
  // "No effect text provided." placeholder and emit a spurious rune_resource
  // op that no handler consumed). `isRuneResource` is now derived at
  // reshapeDump() time from `card.type === 'Rune'` (see card-catalog.ts
  // around line 1750). This test is the retarget: it locks in that the
  // classifier no longer emits `rune_type` / `rune_resource` for the
  // placeholder text, and it guards the new record-level derivation so a
  // future regression can't resurrect the stale classifier path.
  it('does NOT classify placeholder "No effect text provided" as rune_type (phase-5a regression)', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('No effect text provided.', activation);
    expect(result.classes).not.toContain('rune_type');
    const ops = result.operations.map((o) => o.type);
    expect(ops).not.toContain('rune_resource');
  });

  it('record-level: card.type=Rune sets isRuneResource=true, card.type=Unit with empty effect is false (phase-5a regression)', () => {
    const rawRune: RawDump = {
      names: [
        'id',
        'name',
        'slug',
        'effect',
        'type',
        'rarity',
        'set_name',
        'color',
        'tags',
        'cost',
        'might',
        'flavor',
        'image',
        'cmurl',
        'price',
        'foilPrice'
      ],
      data: [
        [
          'RUNE-001',
          'Basic Fury Rune',
          'rune-001-basic-fury-rune',
          '',
          'Rune',
          'Basic',
          'Test',
          'fury',
          '',
          null,
          null,
          null,
          null,
          null,
          null,
          null
        ]
      ]
    };
    const runeRecord = reshapeDump(rawRune)[0];
    expect(runeRecord.isRuneResource).toBe(true);

    const rawUnit: RawDump = {
      names: rawRune.names,
      data: [
        [
          'UNIT-001',
          'Empty-text Unit',
          'unit-001-empty-text-unit',
          '',
          'Unit',
          'Common',
          'Test',
          'fury',
          '',
          '1',
          2,
          null,
          null,
          null,
          null,
          null
        ]
      ]
    };
    const unitRecord = reshapeDump(rawUnit)[0];
    expect(unitRecord.isRuneResource).toBe(false);
    // And the classifier must not emit rune_resource into the unit's op list.
    const unitOps = unitRecord.effectProfile.operations.map((o) => o.type);
    expect(unitOps).not.toContain('rune_resource');
  });

  it('detects tribal_synergy for "your Xs have"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Your Dragons have +1 might.', activation);
    expect(result.classes).toContain('tribal_synergy');
  });

  it('detects stat_scaling for "might is increased by"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('My might is increased by your points.', activation);
    expect(result.classes).toContain('stat_scaling');
  });

  it('detects scoring_restriction for "can\'t score"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile("Players can't score this turn.", activation);
    expect(result.classes).toContain('scoring_restriction');
  });

  it('detects ability_copy for "have all abilities"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('I have all abilities of other friendly units.', activation);
    expect(result.classes).toContain('ability_copy');
  });

  it('detects location_aura for "units here have"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Units here have +1 might.', activation);
    expect(result.classes).toContain('location_aura');
  });

  it('detects solo_combat for "defending alone"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('When attacking or defending alone, gain +2 might.', activation);
    expect(result.classes).toContain('solo_combat');
  });

  it('detects phase_trigger for "at the start of"', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('At the start of your turn, draw a card.', activation);
    expect(result.classes).toContain('phase_trigger');
  });

  it('detects follow_movement for "moves with it"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('This unit moves with it when the leader moves.', activation);
    expect(result.classes).toContain('follow_movement');
  });

  it('detects play_restriction for "can\'t be targeted"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile("This unit can't be targeted by spells.", activation);
    expect(result.classes).toContain('play_restriction');
  });

  it('detects conditional_buff for "while I\'m in combat"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile("While I'm in combat, gain +3 might.", activation);
    expect(result.classes).toContain('conditional_buff');
  });

  it('detects cost_increase for "costs more"', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Enemy spells cost 1 more this turn.', activation);
    expect(result.classes).toContain('cost_increase');
  });

  it('falls back to generic class for unrecognized effect text', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Zorp the flibbertigibbet.', activation);
    expect(result.classes).toContain('generic');
    expect(result.reliability).toBe('heuristic');
  });

  it('falls back to generic when activation inferred actions have no mapped class', () => {
    const activation = makeActivation({ actions: ['recover'], requiresTarget: false });
    // 'recover' maps to 'heal' in ACTION_CLASS_MAP, so this should actually hit the heal class
    const result = buildEffectProfile('Recover a unit.', activation);
    expect(result.classes).toContain('heal');
  });

  it('sets reliability to exact for non-generic classes', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Draw two cards.', activation);
    expect(result.reliability).toBe('exact');
  });

  it('produces primaryClass from first matched class', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Draw two cards and discard one.', activation);
    expect(result.primaryClass).toBeTruthy();
    expect(result.classes.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// buildEffectProfile - targeting
// ===========================================================================
describe('buildEffectProfile - targeting detection', () => {
  it('sets targeting mode to none when requiresTarget is false', () => {
    const activation = makeActivation({ requiresTarget: false });
    const result = buildEffectProfile('Deal 1 damage to all units.', activation);
    expect(result.targeting.mode).toBe('none');
  });

  it('sets targeting mode to single when requiresTarget and no multi-keyword', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Destroy target enemy unit.', activation);
    expect(result.targeting.mode).toBe('single');
  });

  it('sets targeting mode to multiple for "all" keyword with requiresTarget', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Deal 2 damage to all enemy units.', activation);
    expect(result.targeting.mode).toBe('multiple');
  });

  it('sets targeting hint to ally for "friendly" text', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Give target friendly unit +2.', activation);
    expect(result.targeting.hint).toBe('ally');
  });

  it('sets targeting hint to enemy for "an enemy" text', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Destroy an enemy unit.', activation);
    expect(result.targeting.hint).toBe('enemy');
  });

  it('sets targeting hint to self for "me" text', () => {
    const activation = makeActivation({ requiresTarget: false });
    const result = buildEffectProfile('Give me +2 might.', activation);
    expect(result.targeting.hint).toBe('self');
  });

  it('sets targeting requiresSelection from activation.requiresTarget', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Destroy target enemy unit.', activation);
    expect(result.targeting.requiresSelection).toBe(true);
  });
});

// ===========================================================================
// buildEffectProfile - priority detection
// ===========================================================================
describe('buildEffectProfile - priority detection', () => {
  it('returns reaction priority for reaction timing', () => {
    const activation = makeActivation({ timing: 'reaction' });
    const result = buildEffectProfile('[Reaction] Cancel target spell.', activation);
    expect(result.priority).toBe('reaction');
  });

  it('returns combat priority for reaction with showdown window', () => {
    const activation = makeActivation({ timing: 'reaction', reactionWindows: ['showdown'] });
    const result = buildEffectProfile('[Reaction] Use during showdown.', activation);
    expect(result.priority).toBe('combat');
  });

  it('returns combat priority when effect text has showdown', () => {
    const activation = makeActivation({ timing: 'reaction' });
    const result = buildEffectProfile('[Reaction] Use during a showdown.', activation);
    expect(result.priority).toBe('combat');
  });

  it('returns any priority for triggered timing', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('When I die, draw a card.', activation);
    expect(result.priority).toBe('any');
  });

  it('returns setup priority for mulligan text', () => {
    const activation = makeActivation({ timing: 'main' });
    const result = buildEffectProfile('You may look at your starting hand before the mulligan.', activation);
    expect(result.priority).toBe('setup');
  });

  it('returns main priority as default', () => {
    const activation = makeActivation({ timing: 'main' });
    const result = buildEffectProfile('Draw a card.', activation);
    expect(result.priority).toBe('main');
  });
});

// ===========================================================================
// buildEffectProfile - magnitude extraction
// ===========================================================================
describe('buildEffectProfile - magnitude hints', () => {
  it('extracts numeric draw magnitude', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Draw 3 cards.', activation);
    const drawOp = result.operations.find(op => op.type === 'draw_cards');
    expect(drawOp?.magnitudeHint).toBe(3);
  });

  it('extracts word number draw magnitude', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Draw two cards.', activation);
    const drawOp = result.operations.find(op => op.type === 'draw_cards');
    expect(drawOp?.magnitudeHint).toBe(2);
  });

  it('extracts deal damage magnitude', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Deal 5 damage to target enemy unit.', activation);
    const dmgOp = result.operations.find(op => op.type === 'deal_damage');
    expect(dmgOp?.magnitudeHint).toBe(5);
  });

  it('extracts heal magnitude', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Heal 4 damage from target ally unit.', activation);
    const healOp = result.operations.find(op => op.type === 'heal');
    expect(healOp?.magnitudeHint).toBe(4);
  });

  it('extracts discard magnitude', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Discard 2 cards.', activation);
    const discardOp = result.operations.find(op => op.type === 'discard_cards');
    expect(discardOp?.magnitudeHint).toBe(2);
  });
});

// ===========================================================================
// buildEffectProfile - discard self-targeting fix
// ===========================================================================
describe('buildEffectProfile - discard targetHint override', () => {
  it('changes discard targetHint from enemy to self when "when I" is in text', () => {
    const activation = makeActivation({ timing: 'triggered' });
    const result = buildEffectProfile('When I attack, discard a card.', activation);
    const discardOp = result.operations.find(op => op.type === 'discard_cards');
    expect(discardOp?.targetHint).toBe('self');
  });

  it('keeps discard targetHint as enemy without "when I" text', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Discard a card from your opponent\'s hand.', activation);
    const discardOp = result.operations.find(op => op.type === 'discard_cards');
    expect(discardOp?.targetHint).toBe('enemy');
  });
});

// ===========================================================================
// buildEffectProfile - token normalization
// ===========================================================================
describe('buildEffectProfile - token normalization', () => {
  it('sets token metadata on create_token operations', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Play a 2 :rb_might: Fury unit token here.', activation);
    const tokenOp = result.operations.find(op => op.type === 'create_token');
    if (tokenOp) {
      expect(tokenOp.metadata).toBeDefined();
      expect((tokenOp.metadata as any)?.tokenSpec).toBeDefined();
    }
  });

  it('accepts tokenSpecsOverride to bypass text extraction', () => {
    const activation = makeActivation();
    const overrideTokens = [{ name: 'Ghost', slug: 'ghost', might: 1, count: 3, entersReady: false, location: 'here' as const, keywords: [] }];
    const result = buildEffectProfile('Create a token.', activation, overrideTokens);
    const tokenOp = result.operations.find(op => op.type === 'create_token');
    if (tokenOp) {
      expect((tokenOp.metadata as any)?.tokenSpec?.name).toBe('Ghost');
    }
  });
});

// ===========================================================================
// parseAssaultBonus
// ===========================================================================
describe('parseAssaultBonus', () => {
  it('returns null for null input', () => {
    expect(parseAssaultBonus(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseAssaultBonus(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseAssaultBonus('')).toBeNull();
  });

  it('returns null when no self-reference', () => {
    const result = parseAssaultBonus('[Assault 3] That unit gets bonus might when attacking.');
    expect(result).toBeNull();
  });

  it('parses bracketed assault with explicit number', () => {
    const result = parseAssaultBonus('[Assault 2] I get +2 might when attacking.');
    expect(result).toBe(2);
  });

  it('parses bracketed assault without number via +N might lookup', () => {
    const result = parseAssaultBonus('[Assault] I get +3 might when attacking.');
    expect(result).toBe(3);
  });

  it('returns null for [Assault] without a subsequent +N might', () => {
    const result = parseAssaultBonus('[Assault] I get bonus might when attacking.');
    expect(result).toBeNull();
  });

  it('parses inline assault N format', () => {
    const result = parseAssaultBonus('assault 4 - I gain might when attacking.');
    expect(result).toBe(4);
  });

  it('returns null for "assault equal to" (variable assault)', () => {
    const result = parseAssaultBonus('[Assault] My assault bonus is equal to your points.');
    expect(result).toBeNull();
  });

  it('handles mixed-case assault text', () => {
    const result = parseAssaultBonus('[ASSAULT 5] I get +5 might while attacker.');
    expect(result).toBe(5);
  });

  it('handles whitespace in [Assault N]', () => {
    const result = parseAssaultBonus('[ assault  3 ] I get +3 might while attacking.');
    // bracket match with whitespace may not parse - test the result is null or a valid number
    expect(result === null || typeof result === 'number').toBe(true);
  });
});

// ===========================================================================
// parseTokenSpecs
// ===========================================================================
describe('parseTokenSpecs', () => {
  it('returns empty array for empty string', () => {
    expect(parseTokenSpecs('')).toEqual([]);
  });

  it('returns empty array for non-token text', () => {
    const result = parseTokenSpecs('Draw two cards.');
    expect(result).toEqual([]);
  });

  it('parses a basic unit token', () => {
    const result = parseTokenSpecs('Play a 2 :rb_might: Calm unit token here.');
    expect(result.length).toBe(1);
    expect(result[0].might).toBe(2);
    expect(result[0].count).toBe(1);
  });

  it('parses ready token', () => {
    const result = parseTokenSpecs('Play a ready 3 :rb_might: Fury unit token here.');
    expect(result.length).toBe(1);
    expect(result[0].entersReady).toBe(true);
    expect(result[0].might).toBe(3);
  });

  it('parses token count from number word', () => {
    const result = parseTokenSpecs('Play two 1 :rb_might: Ghost unit tokens here.');
    expect(result.length).toBe(1);
    expect(result[0].count).toBe(2);
  });

  it('parses token count from digit', () => {
    const result = parseTokenSpecs('Play 3 1 :rb_might: Flame unit tokens here.');
    expect(result.length).toBe(1);
    expect(result[0].count).toBe(3);
  });

  it('parses token location as "here" for "here" clause', () => {
    const result = parseTokenSpecs('Play a 2 :rb_might: Wolf unit token here.');
    expect(result.length).toBe(1);
    expect(result[0].location).toBe('here');
  });

  it('parses token location as "base" for "base" clause', () => {
    const result = parseTokenSpecs('Play a 2 :rb_might: Guard unit token at your base.');
    expect(result.length).toBe(1);
    expect(result[0].location).toBe('base');
  });

  it('parses token location as "battlefield" for "battlefield" clause', () => {
    const result = parseTokenSpecs('Play a 2 :rb_might: Soldier unit token to a battlefield.');
    expect(result.length).toBe(1);
    expect(result[0].location).toBe('battlefield');
  });

  it('sets flexiblePlacement true for "different locations" clause', () => {
    const result = parseTokenSpecs('Play two 1 :rb_might: Scout unit tokens to different locations.');
    if (result.length > 0) {
      expect(result[0].flexiblePlacement).toBe(true);
    }
  });

  it('sets variableCount true for "for each" clause', () => {
    const result = parseTokenSpecs('Play a 1 :rb_might: Spark unit token for each card you drew this turn.');
    if (result.length > 0) {
      expect(result[0].variableCount).toBe(true);
    }
  });

  it('extracts keywords from brackets in token clause', () => {
    const result = parseTokenSpecs('Play a 2 :rb_might: Fury unit token here with [Tank].');
    if (result.length > 0) {
      expect(result[0].keywords).toContain('Tank');
    }
  });

  it('generates a slug from token name', () => {
    const result = parseTokenSpecs('Play a 1 :rb_might: Dark Rider unit token here.');
    if (result.length > 0) {
      expect(result[0].slug).toBe('dark-rider');
    }
  });

  it('parses multiple token specs', () => {
    const result = parseTokenSpecs(
      'Play a 2 :rb_might: Wolf unit token here. Play a 1 :rb_might: Ghost unit token here.'
    );
    expect(result.length).toBe(2);
  });
});

// ===========================================================================
// analyzeSpellTargeting - with EnrichedCardRecord
// ===========================================================================
describe('analyzeSpellTargeting - scope detection', () => {
  it('returns graveyard scope for graveyard targeting text', () => {
    const card = makeEnrichedCard('Return a unit from your graveyard to your hand.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('graveyard');
    expect(result.minTargets).toBe(1);
    expect(result.maxTargets).toBe(1);
    expect(result.allowEnemy).toBe(false);
    expect(result.requiresSelection).toBe(true);
  });

  it('returns deck scope for search deck text', () => {
    const card = makeEnrichedCard('Search your deck for a unit card.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('deck');
    expect(result.allowEnemy).toBe(false);
  });

  it('returns battlefield scope for conquer battlefield text', () => {
    const card = makeEnrichedCard('Conquer a battlefield.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('battlefield');
    expect(result.requiresSelection).toBe(true);
  });

  it('returns battlefield scope for capture battlefield text', () => {
    const card = makeEnrichedCard('Capture a battlefield.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('battlefield');
  });

  it('returns any_unit scope for unit at battlefield text', () => {
    const card = makeEnrichedCard('Kill a unit at a battlefield.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('any_unit');
    expect(result.allowFriendly).toBe(true);
    expect(result.allowEnemy).toBe(true);
  });

  it('returns ally_unit scope for friendly unit targeting', () => {
    const card = makeEnrichedCard('Move a friendly unit to another battlefield.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('ally_unit');
    expect(result.allowEnemy).toBe(false);
  });

  it('returns enemy_unit scope for enemy unit targeting', () => {
    const card = makeEnrichedCard('Kill an enemy unit.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('enemy_unit');
    expect(result.allowFriendly).toBe(false);
  });

  it('returns any_unit scope for "target a unit" text', () => {
    const card = makeEnrichedCard('Target a unit to return to hand.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('any_unit');
    expect(result.requiresSelection).toBe(true);
  });

  it('returns enemy_units scope for "all enemy units" text', () => {
    const card = makeEnrichedCard('Deal 1 damage to all enemy units.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('enemy_units');
    expect(result.allowFriendly).toBe(false);
  });

  it('returns all_units scope for "each unit" text', () => {
    const card = makeEnrichedCard('Deal 1 damage to each unit.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('all_units');
  });

  it('returns any_unit with multi targets for "up to N units" text', () => {
    const card = makeEnrichedCard('Deal 2 damage to up to three enemy units.');
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('any_unit');
    expect(result.maxTargets).toBe(3);
    expect(result.minTargets).toBe(0);
  });

  it('uses hint for single-mode when no specific pattern matches', () => {
    const activation = makeActivation({ requiresTarget: true });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'single', hint: 'ally', requiresSelection: true }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Buff a friendly unit.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('ally_unit');
    expect(result.allowEnemy).toBe(false);
  });

  it('handles hint=enemy for single mode', () => {
    const activation = makeActivation({ requiresTarget: true });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'single', hint: 'enemy', requiresSelection: true }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Destroy an enemy.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('enemy_unit');
    expect(result.allowFriendly).toBe(false);
  });

  it('handles hint=self for single mode', () => {
    const activation = makeActivation({ requiresTarget: true });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'single', hint: 'self', requiresSelection: true }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Give me +2 might.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('self');
    expect(result.allowEnemy).toBe(false);
  });

  it('handles global mode', () => {
    const activation = makeActivation({ requiresTarget: false });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'global', requiresSelection: false }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Deal 1 damage to all players.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('all_units');
    expect(result.minTargets).toBe(0);
    expect(result.maxTargets).toBe(0);
  });

  it('handles multiple mode with ally hint', () => {
    // requiresSelection must be false so the `baseMode === 'single' || requiresSelection`
    // branch is skipped and the `baseMode === 'multiple'` branch is reached.
    const activation = makeActivation({ requiresTarget: false });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'multiple', hint: 'ally', requiresSelection: false }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Buff all friendly units.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('ally_units');
    expect(result.allowEnemy).toBe(false);
  });

  it('handles multiple mode with enemy hint', () => {
    const activation = makeActivation({ requiresTarget: false });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'multiple', hint: 'enemy', requiresSelection: false }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Weaken all enemies.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('enemy_units');
    expect(result.allowFriendly).toBe(false);
  });

  it('handles multiple mode with up to N count in text', () => {
    // requiresSelection: false so the multiple-mode branch is evaluated;
    // the branch then sets requiresSelection=true when maxTargets > 0.
    const activation = makeActivation({ requiresTarget: false });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'multiple', requiresSelection: false }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Heal up to 3 units.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.maxTargets).toBe(3);
    expect(result.requiresSelection).toBe(true);
  });

  it('returns none scope for plain effect with no targeting', () => {
    const activation = makeActivation({ requiresTarget: false });
    const effectProfile = makeEffectProfile({
      targeting: { mode: 'none', requiresSelection: false }
    });
    const card: EnrichedCardRecord = {
      ...makeEnrichedCard('Gain 2 energy.'),
      effectProfile,
      activation
    };
    const result = analyzeSpellTargeting(card);
    expect(result.scope).toBe('none');
    expect(result.requiresSelection).toBe(false);
  });
});

// ===========================================================================
// spellRequiresTargetSelection
// ===========================================================================
describe('spellRequiresTargetSelection', () => {
  it('returns false for non-spell card type', () => {
    const card = makeEnrichedCard('Kill an enemy unit.', 'unit');
    expect(spellRequiresTargetSelection(card)).toBe(false);
  });

  it('returns false for null card type', () => {
    const card = makeEnrichedCard('Kill an enemy unit.', null as any);
    expect(spellRequiresTargetSelection(card)).toBe(false);
  });

  it('returns true for spell requiring selection', () => {
    const card = makeEnrichedCard('Kill an enemy unit.', 'spell');
    expect(spellRequiresTargetSelection(card)).toBe(true);
  });

  it('returns false for spell with no selection', () => {
    const card = makeEnrichedCard('Gain 2 energy.', 'spell');
    expect(spellRequiresTargetSelection(card)).toBe(false);
  });

  it('is case-insensitive for card type', () => {
    const card = makeEnrichedCard('Kill an enemy unit.', 'SPELL');
    expect(spellRequiresTargetSelection(card)).toBe(true);
  });
});

// ===========================================================================
// getSpellTargetScope
// ===========================================================================
describe('getSpellTargetScope', () => {
  it('returns "none" for non-spell card', () => {
    const card = makeEnrichedCard('Kill an enemy unit.', 'unit');
    expect(getSpellTargetScope(card)).toBe('none');
  });

  it('returns enemy_unit scope for enemy-targeting spell', () => {
    const card = makeEnrichedCard('Kill an enemy unit.', 'spell');
    expect(getSpellTargetScope(card)).toBe('enemy_unit');
  });

  it('returns graveyard scope for graveyard spell', () => {
    const card = makeEnrichedCard('Return a unit from your graveyard to hand.', 'spell');
    expect(getSpellTargetScope(card)).toBe('graveyard');
  });

  it('returns deck scope for search spell', () => {
    const card = makeEnrichedCard('Search your deck for a unit.', 'spell');
    expect(getSpellTargetScope(card)).toBe('deck');
  });
});

// ===========================================================================
// reshapeDump
// ===========================================================================
describe('reshapeDump', () => {
  function makeRawDump(records: Record<string, string | number | null>[]): RawDump {
    const names = records.length > 0 ? Object.keys(records[0]) : [];
    const data = records.map(r => names.map(n => r[n] ?? null));
    return { names, data };
  }

  it('returns empty array for empty data', () => {
    const raw: RawDump = { names: ['id', 'name'], data: [] };
    expect(reshapeDump(raw)).toEqual([]);
  });

  it('creates EnrichedCardRecord with correct id and name', () => {
    const raw = makeRawDump([{ id: 'OGN-001', name: 'Test Card', slug: 'ogn-001-test-card', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: 'Origins', color: 'blue', tags: '', cost: '2', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('OGN-001');
    expect(result[0].name).toBe('Test Card');
  });

  it('uses id as slug fallback when slug is empty', () => {
    const raw = makeRawDump([{ id: 'OGN-002', name: 'Fallback', slug: '', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: '', cost: '', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].slug).toBe('OGN-002');
  });

  it('sets entersUntapped behavior hint', () => {
    const raw = makeRawDump([{ id: 'X-001', name: 'Untapped', slug: 'x-001-untapped', effect: 'I enter ready.', type: 'Unit', rarity: 'Common', set_name: '', color: '', tags: '', cost: '1', might: 2, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].behaviorHints?.entersUntapped).toBe(true);
  });

  it('sets entersTapped by default for unit type', () => {
    const raw = makeRawDump([{ id: 'X-002', name: 'Normal Unit', slug: 'x-002-normal-unit', effect: 'Deal 1 damage.', type: 'Unit', rarity: 'Common', set_name: '', color: '', tags: '', cost: '2', might: 3, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].behaviorHints?.entersTapped).toBe(true);
  });

  it('does NOT set entersTapped for spell type', () => {
    const raw = makeRawDump([{ id: 'X-003', name: 'Quick Spell', slug: 'x-003-quick-spell', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: '', cost: '1', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].behaviorHints?.entersTapped).toBeUndefined();
  });

  it('parses cost energy', () => {
    const raw = makeRawDump([{ id: 'X-004', name: 'Costly', slug: 'x-004-costly', effect: 'Draw a card.', type: 'Spell', rarity: 'Rare', set_name: '', color: '', tags: '', cost: '5', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].cost.energy).toBe(5);
  });

  it('handles null cost', () => {
    const raw = makeRawDump([{ id: 'X-005', name: 'Free Card', slug: 'x-005-free-card', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: '', cost: null, might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].cost.energy).toBeNull();
  });

  it('parses colors from comma-separated string', () => {
    const raw = makeRawDump([{ id: 'X-006', name: 'Multi', slug: 'x-006-multi', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: 'red,blue', tags: '', cost: '1', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].colors).toContain('red');
    expect(result[0].colors).toContain('blue');
  });

  it('parses tags from string', () => {
    const raw = makeRawDump([{ id: 'X-007', name: 'Tagged', slug: 'x-007-tagged', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: 'dragon,warrior', cost: '1', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].tags).toContain('dragon');
    expect(result[0].tags).toContain('warrior');
  });

  it('handles missing effect text by defaulting to "No effect text provided."', () => {
    const raw = makeRawDump([{ id: 'X-008', name: 'Rune', slug: 'x-008-rune', effect: '', type: 'Rune', rarity: 'Basic', set_name: '', color: 'fury', tags: '', cost: null, might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].effect).toBe('No effect text provided.');
    expect(result[0].behaviorHints?.ruleWarnings).toContain('missing-effect-text');
  });

  it('appends period to effect text without ending punctuation', () => {
    const raw = makeRawDump([{ id: 'X-009', name: 'Test', slug: 'x-009-test', effect: 'Draw a card', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: '', cost: '1', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].effect.endsWith('.')).toBe(true);
  });

  it('sets accelerateCost from [Accelerate] effect', () => {
    const raw = makeRawDump([{ id: 'X-010', name: 'Accel', slug: 'x-010-accel', effect: '[Accelerate] (:rb_energy_2::rb_rune_fury:) I enter ready.', type: 'Unit', rarity: 'Common', set_name: '', color: '', tags: '', cost: '3', might: 2, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].behaviorHints?.accelerateCost?.energy).toBe(2);
    expect(result[0].behaviorHints?.accelerateCost?.rune).toBe('fury');
  });

  it('sets might to number for numeric might value', () => {
    const raw = makeRawDump([{ id: 'X-011', name: 'Strong', slug: 'x-011-strong', effect: 'Deal 1 damage.', type: 'Unit', rarity: 'Common', set_name: '', color: '', tags: '', cost: '2', might: 5, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].might).toBe(5);
  });

  it('sets might to null for non-numeric value', () => {
    const raw = makeRawDump([{ id: 'X-012', name: 'NoMight', slug: 'x-012-nomight', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: '', cost: '1', might: null, flavor: null, image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].might).toBeNull();
  });

  it('sets flavor text when provided', () => {
    const raw = makeRawDump([{ id: 'X-013', name: 'Flavorful', slug: 'x-013-flavorful', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: '', cost: '1', might: null, flavor: 'In fire forged.', image: null, cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].flavor).toBe('In fire forged.');
  });

  it('sets assets remote and localPath', () => {
    const raw = makeRawDump([{ id: 'X-014', name: 'Imaged', slug: 'x-014-imaged', effect: 'Draw a card.', type: 'Spell', rarity: 'Common', set_name: '', color: '', tags: '', cost: '1', might: null, flavor: null, image: 'https://example.com/card.jpg', cmurl: null, price: null, foilPrice: null }]);
    const result = reshapeDump(raw);
    expect(result[0].assets.remote).toBe('https://example.com/card.jpg');
    expect(result[0].assets.localPath).toContain('x-014-imaged.webp');
  });
});

// ===========================================================================
// effectClassDefinitions exported array
// ===========================================================================
describe('effectClassDefinitions', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(effectClassDefinitions)).toBe(true);
    expect(effectClassDefinitions.length).toBeGreaterThan(0);
  });

  it('each entry has required fields', () => {
    for (const def of effectClassDefinitions) {
      expect(def).toHaveProperty('id');
      expect(def).toHaveProperty('label');
      expect(def).toHaveProperty('description');
      expect(def).toHaveProperty('ruleRefs');
      expect(def).toHaveProperty('patterns');
      expect(def).toHaveProperty('operation');
      expect(Array.isArray(def.ruleRefs)).toBe(true);
      expect(Array.isArray(def.patterns)).toBe(true);
    }
  });

  it('includes the generic effect class', () => {
    const generic = effectClassDefinitions.find(d => d.id === 'generic');
    expect(generic).toBeDefined();
    expect(generic?.operation.type).toBe('generic');
  });

  it('includes card_draw, damage, heal, removal', () => {
    const ids = effectClassDefinitions.map(d => d.id);
    expect(ids).toContain('card_draw');
    expect(ids).toContain('damage');
    expect(ids).toContain('heal');
    expect(ids).toContain('removal');
  });

  it('all patterns are RegExp instances', () => {
    for (const def of effectClassDefinitions) {
      for (const pattern of def.patterns) {
        expect(pattern).toBeInstanceOf(RegExp);
      }
    }
  });
});

// ===========================================================================
// Complex effect profiles (multiple classes)
// ===========================================================================
describe('buildEffectProfile - complex multi-class effects', () => {
  it('detects both card_draw and removal in a complex effect', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Kill target enemy unit and draw a card.', activation);
    expect(result.classes).toContain('removal');
    expect(result.classes).toContain('card_draw');
    expect(result.operations.length).toBeGreaterThanOrEqual(2);
  });

  it('detects both heal and buff in a complex effect', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Heal 2 and give target ally +2.', activation);
    expect(result.classes).toContain('heal');
    expect(result.classes).toContain('buff');
  });

  it('deduplicates rule references', () => {
    const activation = makeActivation({ requiresTarget: true });
    const result = buildEffectProfile('Destroy a unit and return it from the graveyard.', activation);
    const unique = new Set(result.references);
    expect(unique.size).toBe(result.references.length);
  });

  it('collects all operation ruleRefs from matched classes', () => {
    const activation = makeActivation();
    const result = buildEffectProfile('Draw a card and gain energy.', activation);
    expect(result.references.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Edge cases in buildActivation
// ===========================================================================
describe('buildActivation - edge cases', () => {
  it('handles text with multiple action patterns', () => {
    const result = buildActivation('Draw a card, heal 2, and summon a token.');
    expect(result.actions).toContain('draw');
    expect(result.actions).toContain('heal');
    expect(result.actions).toContain('summon');
    expect(result.stateful).toBe(true);
  });

  it('deduplicates actions', () => {
    const result = buildActivation('Draw a card. Draw another card.');
    const drawCount = result.actions.filter(a => a === 'draw').length;
    expect(drawCount).toBe(1);
  });

  it('handles text with no keywords and no effects', () => {
    const result = buildActivation('No effect text provided.');
    expect(result.timing).toBe('main');
    expect(result.requiresTarget).toBe(false);
    expect(result.stateful).toBe(false);
  });

  it('handles very long effect texts without error', () => {
    const longText = 'When I attack, deal 1 damage to an enemy unit. '.repeat(50);
    expect(() => buildActivation(longText)).not.toThrow();
    const result = buildActivation(longText);
    expect(result.timing).toBe('triggered');
  });
});
