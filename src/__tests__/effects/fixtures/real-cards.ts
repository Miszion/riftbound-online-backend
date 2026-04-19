/**
 * Real-card operation payloads pulled from data/cards.enriched.json.
 * Structural minimums only; we do not copy the full enriched record.
 *
 * Each entry is the subset of fields the dispatcher / catalog loader reads.
 * Pulling these inline keeps tests fast (no file I/O) and readable (the card
 * ID stays adjacent to the op-type expectations).
 */

export interface FixtureCard {
  id: string;
  name: string;
  type: 'Unit' | 'Gear' | 'Spell' | 'Rune' | 'Battlefield' | 'Legend';
  tags: string[];
  keywords: string[];
  effectProfile: {
    classes: string[];
    operations: Array<{ type: string; metadata?: Record<string, unknown>; magnitudeHint?: number }>;
  };
}

// OGN-179 - Acceptable Losses. Spell. Kills gear per player. Ops include
// manipulate_priority (from [Action] keyword) + attach_gear (because the card
// references gear in its text). This card is the poster child for the
// "attach_gear must not dispatch on classes" regression.
export const OGN_179_ACCEPTABLE_LOSSES: FixtureCard = {
  id: 'OGN-179',
  name: 'Acceptable Losses',
  type: 'Spell',
  tags: [],
  keywords: ['Chaos', 'Action', 'Gear'],
  effectProfile: {
    classes: ['priority', 'attachment'],
    operations: [
      { type: 'manipulate_priority' },
      { type: 'attach_gear' },
    ],
  },
};

// OGN-056 - Adaptatron. Unit. Conquer trigger that kills gear and buffs self.
export const OGN_056_ADAPTATRON: FixtureCard = {
  id: 'OGN-056',
  name: 'Adaptatron',
  type: 'Unit',
  tags: ['Mech', 'Piltover'],
  keywords: ['Calm', 'Mech', 'Piltover', 'Conquer', 'Buff', 'Kill'],
  effectProfile: {
    classes: ['buff', 'battlefield_control', 'removal', 'attachment', 'conquer_trigger'],
    operations: [
      { type: 'modify_stats', magnitudeHint: 1 },
      { type: 'control_battlefield' },
      { type: 'remove_permanent' },
      { type: 'attach_gear' },
      { type: 'conquer_trigger' },
    ],
  },
};

// SFD-109 - Akshan - Mischievous. Weaponmaster unit, on-play gear move+attach.
export const SFD_109_AKSHAN: FixtureCard = {
  id: 'SFD-109',
  name: 'Akshan - Mischievous',
  type: 'Unit',
  tags: ['Akshan', 'Shurima', 'Sentinel'],
  keywords: ['Body', 'Akshan', 'Shurima', 'Sentinel', 'Gear'],
  effectProfile: {
    classes: ['movement', 'attachment', 'on_play', 'keyword_weaponmaster', 'equip_trigger'],
    operations: [
      { type: 'move_unit' },
      { type: 'attach_gear' },
      { type: 'on_play_trigger' },
      { type: 'keyword_weaponmaster' },
      { type: 'equip_trigger' },
    ],
  },
};

// SFD-169 - Altar of Memories. Gear with death-trigger draw + recycle.
export const SFD_169_ALTAR: FixtureCard = {
  id: 'SFD-169',
  name: 'Altar of Memories',
  type: 'Gear',
  tags: [],
  keywords: ['Order', 'Draw'],
  effectProfile: {
    classes: ['card_draw', 'recycle', 'death_trigger'],
    operations: [
      { type: 'draw_cards', magnitudeHint: 1 },
      { type: 'recycle_card' },
      { type: 'death_trigger' },
    ],
  },
};

// OGN-275 - Altar to Unity. Battlefield with hold-trigger Recruit token.
export const OGN_275_ALTAR_TO_UNITY: FixtureCard = {
  id: 'OGN-275',
  name: 'Altar to Unity',
  type: 'Battlefield',
  tags: [],
  keywords: ['Colorless'],
  effectProfile: {
    classes: ['token', 'hold_trigger'],
    operations: [
      {
        type: 'create_token',
        magnitudeHint: 1,
        metadata: {
          tokenSpec: {
            name: 'Recruit',
            slug: 'recruit',
            might: 1,
            count: 1,
            entersReady: false,
            location: 'base',
            flexiblePlacement: false,
            variableCount: false,
            keywords: [],
          },
        },
      },
      { type: 'hold_trigger' },
    ],
  },
};

// OGN-126 - Body Rune. Rune card. rune_resource is the only op and MUST be
// stripped at catalog load (Phase 2a cleanup).
export const OGN_126_BODY_RUNE: FixtureCard = {
  id: 'OGN-126',
  name: 'Body Rune',
  type: 'Rune',
  tags: [],
  keywords: ['Body'],
  effectProfile: {
    classes: ['rune_type'],
    operations: [{ type: 'rune_resource' }],
  },
};

// OGN-088 - Mega-Mech. Non-rune card mislabeled rune_resource in the CSV. Same
// cleanup pass must strip it from a non-Rune card.
export const OGN_088_MEGA_MECH: FixtureCard = {
  id: 'OGN-088',
  name: 'Mega-Mech',
  type: 'Unit',
  tags: ['Mech'],
  keywords: ['Colorless', 'Mech'],
  effectProfile: {
    classes: [],
    operations: [{ type: 'rune_resource' }],
  },
};

// OGN-268 - Bullet Time. Spell. deal_damage + control_battlefield + priority.
export const OGN_268_BULLET_TIME: FixtureCard = {
  id: 'OGN-268',
  name: 'Bullet Time',
  type: 'Spell',
  tags: ['Miss Fortune'],
  keywords: ['Body', 'Chaos', 'Miss Fortune', 'Action'],
  effectProfile: {
    classes: ['damage', 'battlefield_control', 'priority'],
    operations: [
      { type: 'deal_damage' },
      { type: 'control_battlefield' },
      { type: 'manipulate_priority' },
    ],
  },
};

// SFD-079 - Bard - Mercurial. Move + stun_effect class.
export const SFD_079_BARD: FixtureCard = {
  id: 'SFD-079',
  name: 'Bard - Mercurial',
  type: 'Unit',
  tags: ['Bard'],
  keywords: ['Mind', 'Bard'],
  effectProfile: {
    classes: ['movement', 'battlefield_control', 'legend', 'on_play', 'stun_effect'],
    operations: [
      { type: 'move_unit' },
      { type: 'control_battlefield' },
      { type: 'on_play_trigger' },
      { type: 'stun' },
    ],
  },
};

// SFD-001 - Against the Odds. Reaction-tagged spell, real op is modify_stats.
export const SFD_001_AGAINST_THE_ODDS: FixtureCard = {
  id: 'SFD-001',
  name: 'Against the Odds',
  type: 'Spell',
  tags: [],
  keywords: ['Fury', 'Reaction'],
  effectProfile: {
    classes: ['priority', 'buff'],
    operations: [
      { type: 'manipulate_priority' },
      { type: 'modify_stats' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Phase 3 fixtures. Representative cards for the 30 long-tail ops. These are
// curated from data/cards.enriched.json using the example_card_ids column of
// docs/effect-ops-frequency.csv. Shapes kept minimal (type, ops list only)
// because the handler dispatch contract reads operations[].type only.
// ---------------------------------------------------------------------------

// OGN-107 Resplendent Armada - summon_unit + cost_reduction exemplar.
export const OGN_107_RESPLENDENT_ARMADA: FixtureCard = {
  id: 'OGN-107',
  name: 'Resplendent Armada',
  type: 'Spell',
  tags: [],
  keywords: ['Calm', 'Demacia', 'Human', 'Action'],
  effectProfile: {
    classes: ['summon', 'cost_reduction'],
    operations: [
      { type: 'summon_unit' },
      { type: 'cost_reduction' },
    ],
  },
};

// OGS-010 return_to_hand + return_from_graveyard exemplar.
export const OGS_010_TACTICAL_RETREAT: FixtureCard = {
  id: 'OGS-010',
  name: 'Tactical Retreat',
  type: 'Spell',
  tags: [],
  keywords: ['Mind', 'Action'],
  effectProfile: {
    classes: ['return', 'return_to_hand', 'return_from_graveyard'],
    operations: [
      { type: 'return_to_hand' },
      { type: 'return_from_graveyard' },
    ],
  },
};

// OGN-057 Shield + Tank exemplar.
export const OGN_057_BULWARK: FixtureCard = {
  id: 'OGN-057',
  name: 'Bulwark',
  type: 'Unit',
  tags: ['Demacia'],
  keywords: ['Calm', 'Demacia', 'Tank', 'Shield'],
  effectProfile: {
    classes: ['shield', 'keyword_tank'],
    operations: [
      { type: 'shield' },
      { type: 'keyword_tank' },
    ],
  },
};

// OGN-002 Discard exemplar.
export const OGN_002_DARK_BARGAIN: FixtureCard = {
  id: 'OGN-002',
  name: 'Dark Bargain',
  type: 'Spell',
  tags: [],
  keywords: ['Chaos', 'Action'],
  effectProfile: {
    classes: ['discard', 'draw'],
    operations: [
      { type: 'discard_cards' },
      { type: 'draw_cards' },
    ],
  },
};

// OGN-066 Ahri - Alluring. hold_trigger + scoring exemplar.
export const OGN_066_AHRI: FixtureCard = {
  id: 'OGN-066',
  name: 'Ahri - Alluring',
  type: 'Unit',
  tags: ['Ahri', 'Vastaya'],
  keywords: ['Mind', 'Ahri', 'Vastaya'],
  effectProfile: {
    classes: ['hold_trigger', 'scoring'],
    operations: [
      { type: 'hold_trigger' },
      { type: 'scoring' },
    ],
  },
};

// OGS-017 Temporal Rewind. phase_trigger exemplar.
export const OGS_017_TEMPORAL_REWIND: FixtureCard = {
  id: 'OGS-017',
  name: 'Temporal Rewind',
  type: 'Unit',
  tags: [],
  keywords: ['Mind', 'Action'],
  effectProfile: {
    classes: ['phase_trigger', 'ready'],
    operations: [
      { type: 'phase_trigger' },
      { type: 'ready' },
    ],
  },
};

// OGN-015 Location aura + aura buff exemplar.
export const OGN_015_RADIANT_FIELD: FixtureCard = {
  id: 'OGN-015',
  name: 'Radiant Field',
  type: 'Battlefield',
  tags: [],
  keywords: ['Calm'],
  effectProfile: {
    classes: ['aura_buff', 'location_aura'],
    operations: [
      { type: 'aura_buff' },
      { type: 'location_aura' },
    ],
  },
};

// SFD-209 Forgotten Monument. scoring_restriction exemplar.
export const SFD_209_FORGOTTEN_MONUMENT: FixtureCard = {
  id: 'SFD-209',
  name: 'Forgotten Monument',
  type: 'Battlefield',
  tags: [],
  keywords: ['Colorless'],
  effectProfile: {
    classes: ['scoring_restriction'],
    operations: [{ type: 'scoring_restriction' }],
  },
};

// SFD-141 Targeting Discount exemplar.
export const SFD_141_PRECISION: FixtureCard = {
  id: 'SFD-141',
  name: 'Precision Volley',
  type: 'Spell',
  tags: [],
  keywords: ['Body'],
  effectProfile: {
    classes: ['targeting_discount'],
    operations: [{ type: 'targeting_discount' }],
  },
};

// SFD-216 Play Restriction exemplar.
export const SFD_216_WARD_OF_STILLNESS: FixtureCard = {
  id: 'SFD-216',
  name: 'Ward of Stillness',
  type: 'Battlefield',
  tags: [],
  keywords: ['Order'],
  effectProfile: {
    classes: ['play_restriction'],
    operations: [{ type: 'play_restriction' }],
  },
};

// OGN-177 Stealthy Pursuer. follow_movement exemplar.
export const OGN_177_STEALTHY_PURSUER: FixtureCard = {
  id: 'OGN-177',
  name: 'Stealthy Pursuer',
  type: 'Unit',
  tags: [],
  keywords: ['Body'],
  effectProfile: {
    classes: ['follow_movement'],
    operations: [{ type: 'follow_movement' }],
  },
};

// SFD-159 Conditional Buff exemplar.
export const SFD_159_STEADFAST_GUARD: FixtureCard = {
  id: 'SFD-159',
  name: 'Steadfast Guard',
  type: 'Unit',
  tags: [],
  keywords: ['Calm'],
  effectProfile: {
    classes: ['conditional_buff'],
    operations: [{ type: 'conditional_buff' }],
  },
};

// OGN-278 Hide modifier exemplar.
export const OGN_278_CLOAKED_BLADE: FixtureCard = {
  id: 'OGN-278',
  name: 'Cloaked Blade',
  type: 'Gear',
  tags: [],
  keywords: ['Chaos'],
  effectProfile: {
    classes: ['hide_modifier'],
    operations: [{ type: 'hide_modifier' }],
  },
};

// OGN-029 Generic catch-all exemplar.
export const OGN_029_GENERIC: FixtureCard = {
  id: 'OGN-029',
  name: 'Miscellaneous Oddity',
  type: 'Spell',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['generic'],
    operations: [{ type: 'generic' }],
  },
};

// ARC-003 Ability copy exemplar.
export const ARC_003_ECHO_SPELL: FixtureCard = {
  id: 'ARC-003',
  name: 'Echo Spell',
  type: 'Spell',
  tags: [],
  keywords: ['Mind'],
  effectProfile: {
    classes: ['ability_copy'],
    operations: [{ type: 'ability_copy' }],
  },
};

// SFD-053 Heal exemplar.
export const SFD_053_RESTORATIVE_WINDS: FixtureCard = {
  id: 'SFD-053',
  name: 'Restorative Winds',
  type: 'Spell',
  tags: [],
  keywords: ['Mind'],
  effectProfile: {
    classes: ['heal'],
    operations: [{ type: 'heal' }],
  },
};

// OGS-001 Effect amplifier exemplar.
export const OGS_001_SURGE: FixtureCard = {
  id: 'OGS-001',
  name: 'Surge',
  type: 'Spell',
  tags: [],
  keywords: ['Fury'],
  effectProfile: {
    classes: ['effect_amplifier', 'damage'],
    operations: [
      { type: 'effect_amplifier' },
      { type: 'deal_damage' },
    ],
  },
};

// SFD-131 Weaponmaster + Accelerate exemplar (keyword_weaponmaster coverage).
export const SFD_131_MASTER_AT_ARMS: FixtureCard = {
  id: 'SFD-131',
  name: 'Master at Arms',
  type: 'Unit',
  tags: [],
  keywords: ['Body', 'Weaponmaster', 'Accelerate'],
  effectProfile: {
    classes: ['keyword_weaponmaster', 'keyword_accelerate'],
    operations: [
      { type: 'keyword_weaponmaster' },
      { type: 'keyword_accelerate' },
    ],
  },
};

// SFD-080 Repeat keyword exemplar.
export const SFD_080_ARCANE_REPETITION: FixtureCard = {
  id: 'SFD-080',
  name: 'Arcane Repetition',
  type: 'Spell',
  tags: [],
  keywords: ['Mind', 'Repeat'],
  effectProfile: {
    classes: ['keyword_repeat'],
    operations: [{ type: 'keyword_repeat' }],
  },
};

// OGN-016 Legion keyword exemplar.
export const OGN_016_LEGION_CAPTAIN: FixtureCard = {
  id: 'OGN-016',
  name: 'Legion Captain',
  type: 'Unit',
  tags: ['Human', 'Demacia'],
  keywords: ['Calm', 'Legion'],
  effectProfile: {
    classes: ['keyword_legion'],
    operations: [{ type: 'keyword_legion' }],
  },
};

// SFD-071 Tribal synergy exemplar.
export const SFD_071_PACK_HUNTER: FixtureCard = {
  id: 'SFD-071',
  name: 'Pack Hunter',
  type: 'Unit',
  tags: ['Beast'],
  keywords: ['Fury'],
  effectProfile: {
    classes: ['tribal_synergy'],
    operations: [{ type: 'tribal_synergy' }],
  },
};

// SFD-079 Bard - Mercurial. interact_legend exemplar (via SFD-079 in CSV).
export const SFD_210_LEGENDARY_ECHO: FixtureCard = {
  id: 'SFD-210',
  name: 'Legendary Echo',
  type: 'Unit',
  tags: [],
  keywords: ['Mind'],
  effectProfile: {
    classes: ['interact_legend'],
    operations: [{ type: 'interact_legend' }],
  },
};

// OGN-045 Cost increase exemplar.
export const OGN_045_ARCANE_TAX: FixtureCard = {
  id: 'OGN-045',
  name: 'Arcane Tax',
  type: 'Battlefield',
  tags: [],
  keywords: ['Order'],
  effectProfile: {
    classes: ['cost_increase'],
    operations: [{ type: 'cost_increase' }],
  },
};

// OGN-060 Solo combat exemplar.
export const OGN_060_LONE_WOLF: FixtureCard = {
  id: 'OGN-060',
  name: 'Lone Wolf',
  type: 'Unit',
  tags: [],
  keywords: ['Fury'],
  effectProfile: {
    classes: ['solo_combat'],
    operations: [{ type: 'solo_combat' }],
  },
};

// OGN-109 Stat scaling exemplar.
export const OGN_109_RISING_CHAMPION: FixtureCard = {
  id: 'OGN-109',
  name: 'Rising Champion',
  type: 'Unit',
  tags: [],
  keywords: ['Fury'],
  effectProfile: {
    classes: ['stat_scaling'],
    operations: [{ type: 'stat_scaling' }],
  },
};

// ---------------------------------------------------------------------------
// Phase 6 real-card fixtures. These are the actual card IDs in
// data/cards.enriched.json that emit the 12 dormant ops. Phase 3 shipped
// *synthetic* fixtures (above) under invented names; Phase 6 adds the real
// IDs so the directed coverage tests exercise realistic op shapes sourced
// from the enriched catalog. See docs/phase-6-coverage-gap.md framing.
//
// Op shapes mirror data/cards.enriched.json verbatim (targetHint / zone /
// automated / ruleRefs). Where the real op carries no magnitudeHint and the
// handler needs a magnitude anyway (aura_buff mightMod, heal amount), the
// test builds a reasonable default inline and notes the spec ambiguity.
// ---------------------------------------------------------------------------

// OGN-111 Heimerdinger - Inventor. Real card emitting ability_copy.
export const OGN_111_HEIMERDINGER: FixtureCard = {
  id: 'OGN-111',
  name: 'Heimerdinger - Inventor',
  type: 'Unit',
  tags: [],
  keywords: ['Mind'],
  effectProfile: {
    classes: ['attachment', 'ability_copy'],
    operations: [
      { type: 'attach_gear' },
      { type: 'ability_copy' },
    ],
  },
};

// UNL-147 Baron Nashor. Real card emitting aura_buff + play_restriction.
export const UNL_147_BARON_NASHOR: FixtureCard = {
  id: 'UNL-147',
  name: 'Baron Nashor',
  type: 'Unit',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['token', 'movement', 'battlefield_control', 'aura_buff', 'tribal_synergy', 'play_restriction'],
    operations: [
      { type: 'create_token' },
      { type: 'move_unit' },
      { type: 'control_battlefield' },
      { type: 'aura_buff' },
      { type: 'tribal_synergy' },
      { type: 'play_restriction' },
    ],
  },
};

// SFD-159 Trusty Ramhound. Real card emitting conditional_buff.
// Note: same card ID as Phase-3 synthetic Steadfast Guard fixture, but real
// name from catalog is Trusty Ramhound. We keep the real label here.
export const SFD_159_TRUSTY_RAMHOUND: FixtureCard = {
  id: 'SFD-159',
  name: 'Trusty Ramhound',
  type: 'Unit',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['conditional_buff'],
    operations: [{ type: 'conditional_buff' }],
  },
};

// OGN-177 Stealthy Pursuer - real catalog label matches Phase-3 synthetic.
// Re-exported under a Phase-6 alias so test files read as real-card fixtures.
export const OGN_177_STEALTHY_PURSUER_REAL: FixtureCard = OGN_177_STEALTHY_PURSUER;

// SFD-053 Janna - Savior. Real card emitting heal + move_unit + control_bf.
export const SFD_053_JANNA: FixtureCard = {
  id: 'SFD-053',
  name: 'Janna - Savior',
  type: 'Unit',
  tags: [],
  keywords: ['Mind'],
  effectProfile: {
    classes: ['heal', 'movement', 'battlefield_control', 'on_play'],
    operations: [
      { type: 'heal' },
      { type: 'move_unit' },
      { type: 'control_battlefield' },
      { type: 'on_play_trigger' },
    ],
  },
};

// OGN-278 Bandle Tree. Real card emitting hide_modifier (battlefield type).
export const OGN_278_BANDLE_TREE: FixtureCard = {
  id: 'OGN-278',
  name: 'Bandle Tree',
  type: 'Battlefield',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['hide_modifier'],
    operations: [{ type: 'hide_modifier' }],
  },
};

// OGN-015 Captain Farron. Real card emitting location_aura + aura_buff.
export const OGN_015_CAPTAIN_FARRON: FixtureCard = {
  id: 'OGN-015',
  name: 'Captain Farron',
  type: 'Unit',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['combat_bonus', 'aura_buff', 'location_aura'],
    operations: [
      { type: 'combat_bonus' },
      { type: 'aura_buff' },
      { type: 'location_aura' },
    ],
  },
};

// UNL-057 Alpha Wildclaw. Real card emitting play_restriction + keyword_tank.
export const UNL_057_ALPHA_WILDCLAW: FixtureCard = {
  id: 'UNL-057',
  name: 'Alpha Wildclaw',
  type: 'Unit',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['keyword_tank', 'play_restriction'],
    operations: [
      { type: 'keyword_tank' },
      { type: 'play_restriction' },
    ],
  },
};

// SFD-209 Forgotten Monument - real catalog label matches Phase-3 synthetic.
// Alias as a Phase-6 real-card fixture for semantic clarity in tests.
export const SFD_209_FORGOTTEN_MONUMENT_REAL: FixtureCard = SFD_209_FORGOTTEN_MONUMENT;

// OGN-060 Mask of Foresight. Real card emitting solo_combat (a Gear, not a
// Unit - the Phase-3 Lone Wolf synthetic was a unit; the real catalog entry
// is a Gear that grants solo_combat via equip).
export const OGN_060_MASK_OF_FORESIGHT: FixtureCard = {
  id: 'OGN-060',
  name: 'Mask of Foresight',
  type: 'Gear',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['buff', 'solo_combat'],
    operations: [
      { type: 'modify_stats', magnitudeHint: 1 },
      { type: 'solo_combat' },
    ],
  },
};

// OGN-109 Dr. Mundo - Expert. Real card emitting stat_scaling.
export const OGN_109_DR_MUNDO: FixtureCard = {
  id: 'OGN-109',
  name: 'Dr. Mundo - Expert',
  type: 'Unit',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['recycle', 'stat_scaling', 'phase_trigger'],
    operations: [
      { type: 'recycle_card', magnitudeHint: 3 },
      { type: 'stat_scaling' },
      { type: 'phase_trigger' },
    ],
  },
};

// SFD-141 Irelia - Graceful. Real card emitting targeting_discount.
export const SFD_141_IRELIA: FixtureCard = {
  id: 'SFD-141',
  name: 'Irelia - Graceful',
  type: 'Unit',
  tags: [],
  keywords: [],
  effectProfile: {
    classes: ['targeting_discount'],
    operations: [{ type: 'targeting_discount' }],
  },
};

export const FIXTURES = {
  OGN_179_ACCEPTABLE_LOSSES,
  OGN_056_ADAPTATRON,
  SFD_109_AKSHAN,
  SFD_169_ALTAR,
  OGN_275_ALTAR_TO_UNITY,
  OGN_126_BODY_RUNE,
  OGN_088_MEGA_MECH,
  OGN_268_BULLET_TIME,
  SFD_079_BARD,
  SFD_001_AGAINST_THE_ODDS,
  // Phase 3
  OGN_107_RESPLENDENT_ARMADA,
  OGS_010_TACTICAL_RETREAT,
  OGN_057_BULWARK,
  OGN_002_DARK_BARGAIN,
  OGN_066_AHRI,
  OGS_017_TEMPORAL_REWIND,
  OGN_015_RADIANT_FIELD,
  SFD_209_FORGOTTEN_MONUMENT,
  SFD_141_PRECISION,
  SFD_216_WARD_OF_STILLNESS,
  OGN_177_STEALTHY_PURSUER,
  SFD_159_STEADFAST_GUARD,
  OGN_278_CLOAKED_BLADE,
  OGN_029_GENERIC,
  ARC_003_ECHO_SPELL,
  SFD_053_RESTORATIVE_WINDS,
  OGS_001_SURGE,
  SFD_131_MASTER_AT_ARMS,
  SFD_080_ARCANE_REPETITION,
  OGN_016_LEGION_CAPTAIN,
  SFD_071_PACK_HUNTER,
  SFD_210_LEGENDARY_ECHO,
  OGN_045_ARCANE_TAX,
  OGN_060_LONE_WOLF,
  OGN_109_RISING_CHAMPION,
  // Phase 6 real-card fixtures for dormant handlers.
  OGN_111_HEIMERDINGER,
  UNL_147_BARON_NASHOR,
  SFD_159_TRUSTY_RAMHOUND,
  OGN_177_STEALTHY_PURSUER_REAL,
  SFD_053_JANNA,
  OGN_278_BANDLE_TREE,
  OGN_015_CAPTAIN_FARRON,
  UNL_057_ALPHA_WILDCLAW,
  SFD_209_FORGOTTEN_MONUMENT_REAL,
  OGN_060_MASK_OF_FORESIGHT,
  OGN_109_DR_MUNDO,
  SFD_141_IRELIA,
};
