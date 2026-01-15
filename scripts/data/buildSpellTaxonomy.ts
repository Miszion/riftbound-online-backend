import fs from 'node:fs';
import path from 'node:path';
import {
  getCardCatalog,
  EffectOperationType,
  TargetingMode,
  TargetHint,
  EnrichedCardRecord,
  EffectOperation
} from '../../src/card-catalog';

const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'spell-taxonomy.json');

// =============================================================================
// SPELL EFFECT CATEGORIES - Used for UI and resolution
// =============================================================================

export type SpellEffectCategory =
  | 'damage_single'
  | 'damage_multi'
  | 'damage_all'
  | 'buff_single'
  | 'buff_multi'
  | 'buff_all'
  | 'debuff_single'
  | 'debuff_multi'
  | 'debuff_all'
  | 'removal_single'
  | 'removal_multi'
  | 'removal_all'
  | 'card_draw'
  | 'card_discard'
  | 'movement'
  | 'return_to_hand'
  | 'token_creation'
  | 'resource_gain'
  | 'battlefield_control'
  | 'graveyard_return'
  | 'graveyard_play'
  | 'channel_rune'
  | 'heal'
  | 'shield'
  | 'counter'
  | 'transform'
  | 'search'
  | 'utility'
  | 'complex';

export type SpellTargetScope =
  | 'none'
  | 'self'
  | 'ally_unit'
  | 'enemy_unit'
  | 'any_unit'
  | 'ally_units'
  | 'enemy_units'
  | 'all_units'
  | 'battlefield'
  | 'graveyard'
  | 'hand'
  | 'deck'
  | 'player';

export interface SpellTargetingProfile {
  scope: SpellTargetScope;
  mode: TargetingMode;
  minTargets: number;
  maxTargets: number;
  requiresSelection: boolean;
  hint?: TargetHint;
}

export interface SpellEffectDefinition {
  category: SpellEffectCategory;
  operations: EffectOperationType[];
  magnitude?: number | null;
  automated: boolean;
  timing: 'instant' | 'delayed' | 'conditional';
}

export interface SpellRecord {
  id: string;
  slug: string;
  name: string;
  color: string;
  cost: number;
  effect: string;
  category: SpellEffectCategory;
  secondaryCategories: SpellEffectCategory[];
  targeting: SpellTargetingProfile;
  effects: SpellEffectDefinition[];
  isAction: boolean;
  isReaction: boolean;
  isHidden: boolean;
  isRepeat: boolean;
  reactionWindows: string[];
  requiresTarget: boolean;
  canTargetFriendly: boolean;
  canTargetEnemy: boolean;
  hasBattlefieldContext: boolean;
  hasGraveyardInteraction: boolean;
}

export interface SpellCategoryStats {
  category: SpellEffectCategory;
  count: number;
  spells: string[];
  requiresTargetCount: number;
}

// =============================================================================
// PATTERN MATCHING FOR SPELL CATEGORIZATION
// =============================================================================

const DAMAGE_SINGLE_PATTERNS = [
  /deal\s+\d+\s+(to|damage)/i,
  /strike\s+\d+/i,
  /blast\s+an?\s+/i
];

const DAMAGE_MULTI_PATTERNS = [
  /deal\s+\d+\s+to\s+each\s+of\s+up\s+to\s+\d+/i,
  /deal\s+\d+\s+to\s+up\s+to\s+\d+/i,
  /deal\s+\d+\s+damage\s+\d+\s+times/i
];

const DAMAGE_ALL_PATTERNS = [
  /deal\s+\d+\s+to\s+(all|each)\s+(enemy\s+)?units?/i,
  /kill\s+all\s+units?/i
];

const BUFF_PATTERNS = [
  /buff\s+(a|an|the|your)?\s*unit/i,
  /give\s+[^.]*\+\d+/i,
  /grant\s+[^.]*\+\d+/i,
  /gets?\s+\+\d+/i
];

const DEBUFF_PATTERNS = [
  /debuff\s+(a|an|the|enemy)?\s*unit/i,
  /give\s+[^.]*-\d+/i,
  /gets?\s+-\d+/i
];

const REMOVAL_SINGLE_PATTERNS = [
  /kill\s+(a|an|the|target|enemy)\s*unit/i,
  /destroy\s+(a|an|the|target)?\s*(?!all)/i,
  /banish\s+(a|an|the|target)/i
];

const REMOVAL_ALL_PATTERNS = [
  /kill\s+all\s+units/i,
  /destroy\s+all/i
];

const CARD_DRAW_PATTERNS = [
  /draw\s+(\d+|a|an)\s+card/i,
  /vision\s+\d+/i,
  /look\s+at\s+the\s+top/i
];

const MOVEMENT_PATTERNS = [
  /move\s+(a|an|up\s+to)?\s*unit/i,
  /relocate/i,
  /swap\s+locations?/i
];

const TOKEN_PATTERNS = [
  /play\s+[^.]*unit\s+token/i,
  /create\s+[^.]*token/i,
  /summon\s+[^.]*token/i
];

const GRAVEYARD_RETURN_PATTERNS = [
  /return\s+[^.]*from\s+(your\s+)?(graveyard|trash)/i,
  /return\s+[^.]*to\s+your\s+hand/i
];

const GRAVEYARD_PLAY_PATTERNS = [
  /play\s+[^.]*from\s+(your\s+)?(graveyard|trash)/i
];

const CHANNEL_PATTERNS = [
  /channel\s+\d+\s+rune/i,
  /channel\s+(a|an)\s+rune/i
];

const HEAL_PATTERNS = [
  /heal\s+\d+/i,
  /restore\s+\d+/i,
  /recover\s+\d+/i
];

const COUNTER_PATTERNS = [
  /counter\s+(a|an|target|the)\s*spell/i,
  /negate\s+(a|an|target)/i,
  /cancel/i
];

const HIDDEN_PATTERN = /\[hidden\]/i;
const REPEAT_PATTERN = /\[repeat\]/i;
const REACTION_PATTERN = /\[reaction\]/i;
const ACTION_PATTERN = /action\s*[—-]/i;

// =============================================================================
// TARGETING DETECTION
// =============================================================================

const detectSpellTargetScope = (
  card: EnrichedCardRecord,
  effectText: string
): SpellTargetScope => {
  const profile = card.effectProfile?.targeting;
  const hint = profile?.hint;
  const mode = profile?.mode ?? 'none';

  // Check for graveyard targeting
  if (/from\s+(your\s+)?(graveyard|trash)/i.test(effectText)) {
    return 'graveyard';
  }

  // Check for deck/search targeting
  if (/search\s+(your\s+)?deck/i.test(effectText)) {
    return 'deck';
  }

  // Check for battlefield targeting
  if (/\bbattlefield\b/i.test(effectText) && !/unit.*battlefield/i.test(effectText)) {
    return 'battlefield';
  }

  // Check for hand targeting
  if (/from\s+(your\s+)?hand/i.test(effectText)) {
    return 'hand';
  }

  if (mode === 'none' || !profile?.requiresSelection) {
    // Check if it's self-targeting
    if (/\byour\s+units?\b/i.test(effectText) || /\bfriendly\b/i.test(effectText)) {
      return /\ball\b/i.test(effectText) ? 'ally_units' : 'ally_unit';
    }
    if (/\benemy\s+units?\b/i.test(effectText)) {
      return /\ball\b/i.test(effectText) ? 'enemy_units' : 'enemy_unit';
    }
    if (/\ball\s+units?\b/i.test(effectText)) {
      return 'all_units';
    }
    return 'none';
  }

  if (mode === 'global') {
    return 'all_units';
  }

  if (mode === 'multiple') {
    if (hint === 'ally') return 'ally_units';
    if (hint === 'enemy') return 'enemy_units';
    return 'all_units';
  }

  // Single target mode
  if (hint === 'ally') return 'ally_unit';
  if (hint === 'enemy') return 'enemy_unit';
  if (hint === 'self') return 'self';
  return 'any_unit';
};

const detectTargetCount = (effectText: string): { min: number; max: number } => {
  // "up to X units"
  const upToMatch = effectText.match(/up\s+to\s+(\d+)\s+units?/i);
  if (upToMatch) {
    return { min: 0, max: parseInt(upToMatch[1], 10) };
  }

  // "each of up to X units"
  const eachUpToMatch = effectText.match(/each\s+of\s+up\s+to\s+(\d+)\s+units?/i);
  if (eachUpToMatch) {
    return { min: 1, max: parseInt(eachUpToMatch[1], 10) };
  }

  // "X units"
  const exactMatch = effectText.match(/(\d+)\s+units?/i);
  if (exactMatch && !effectText.includes('up to')) {
    const count = parseInt(exactMatch[1], 10);
    return { min: count, max: count };
  }

  // "all units" - no explicit count needed
  if (/\ball\s+(enemy\s+)?units?\b/i.test(effectText)) {
    return { min: 0, max: 0 }; // 0 means "all applicable"
  }

  // Default single target
  return { min: 1, max: 1 };
};

// =============================================================================
// CATEGORY DETECTION
// =============================================================================

const matchesAnyPattern = (text: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(text));

const categorizeSpell = (card: EnrichedCardRecord): SpellEffectCategory => {
  const effectText = card.effect ?? '';
  const classes = card.effectProfile?.classes ?? [];
  const operations = card.effectProfile?.operations ?? [];

  // Check for counter spells first (high priority)
  if (matchesAnyPattern(effectText, COUNTER_PATTERNS)) {
    return 'counter';
  }

  // Check for complex multi-effect spells
  const effectTypeCount = new Set(operations.map((op) => op.type)).size;
  if (effectTypeCount > 3) {
    return 'complex';
  }

  // Damage categorization
  if (classes.includes('damage') || operations.some((op) => op.type === 'deal_damage')) {
    if (matchesAnyPattern(effectText, DAMAGE_ALL_PATTERNS)) return 'damage_all';
    if (matchesAnyPattern(effectText, DAMAGE_MULTI_PATTERNS)) return 'damage_multi';
    return 'damage_single';
  }

  // Removal categorization
  if (classes.includes('removal') || operations.some((op) => op.type === 'remove_permanent')) {
    if (matchesAnyPattern(effectText, REMOVAL_ALL_PATTERNS)) return 'removal_all';
    if (/up\s+to\s+\d+/i.test(effectText)) return 'removal_multi';
    return 'removal_single';
  }

  // Buff categorization
  if (classes.includes('buff') || operations.some((op) => op.type === 'modify_stats' && op.targetHint === 'ally')) {
    if (/\ball\s+(your\s+)?units?\b/i.test(effectText)) return 'buff_all';
    if (/up\s+to\s+\d+/i.test(effectText)) return 'buff_multi';
    return 'buff_single';
  }

  // Debuff categorization
  if (classes.includes('debuff') || operations.some((op) => op.type === 'modify_stats' && op.targetHint === 'enemy')) {
    if (/\ball\s+enemy\s+units?\b/i.test(effectText)) return 'debuff_all';
    if (/up\s+to\s+\d+/i.test(effectText)) return 'debuff_multi';
    return 'debuff_single';
  }

  // Card draw
  if (classes.includes('card_draw') || operations.some((op) => op.type === 'draw_cards')) {
    return 'card_draw';
  }

  // Card discard
  if (classes.includes('card_discard') || operations.some((op) => op.type === 'discard_cards')) {
    return 'card_discard';
  }

  // Graveyard interactions
  if (matchesAnyPattern(effectText, GRAVEYARD_PLAY_PATTERNS)) {
    return 'graveyard_play';
  }
  if (matchesAnyPattern(effectText, GRAVEYARD_RETURN_PATTERNS) || 
      operations.some((op) => op.type === 'return_from_graveyard')) {
    return 'graveyard_return';
  }

  // Token creation
  if (classes.includes('token') || operations.some((op) => op.type === 'create_token')) {
    return 'token_creation';
  }

  // Movement
  if (classes.includes('movement') || operations.some((op) => op.type === 'move_unit')) {
    return 'movement';
  }

  // Return to hand
  if (classes.includes('hand_return') || operations.some((op) => op.type === 'return_to_hand')) {
    return 'return_to_hand';
  }

  // Battlefield control
  if (classes.includes('battlefield_control') || operations.some((op) => op.type === 'control_battlefield')) {
    return 'battlefield_control';
  }

  // Resource gain
  if (classes.includes('resource_gain') || operations.some((op) => op.type === 'gain_resource')) {
    return 'resource_gain';
  }

  // Channel rune
  if (classes.includes('rune') || operations.some((op) => op.type === 'channel_rune')) {
    return 'channel_rune';
  }

  // Heal
  if (classes.includes('heal') || operations.some((op) => op.type === 'heal')) {
    return 'heal';
  }

  // Shield
  if (classes.includes('shielding') || operations.some((op) => op.type === 'shield')) {
    return 'shield';
  }

  // Transform
  if (classes.includes('transform') || operations.some((op) => op.type === 'transform')) {
    return 'transform';
  }

  // Search
  if (classes.includes('search') || operations.some((op) => op.type === 'search_deck')) {
    return 'search';
  }

  return 'utility';
};

const getSecondaryCategories = (card: EnrichedCardRecord): SpellEffectCategory[] => {
  const categories: SpellEffectCategory[] = [];
  const effectText = card.effect ?? '';
  const operations = card.effectProfile?.operations ?? [];

  // Check each category
  if (matchesAnyPattern(effectText, CARD_DRAW_PATTERNS) || operations.some((op) => op.type === 'draw_cards')) {
    categories.push('card_draw');
  }
  if (matchesAnyPattern(effectText, BUFF_PATTERNS) || operations.some((op) => op.type === 'modify_stats' && op.targetHint === 'ally')) {
    categories.push('buff_single');
  }
  if (matchesAnyPattern(effectText, DEBUFF_PATTERNS) || operations.some((op) => op.type === 'modify_stats' && op.targetHint === 'enemy')) {
    categories.push('debuff_single');
  }
  if (matchesAnyPattern(effectText, DAMAGE_SINGLE_PATTERNS) || operations.some((op) => op.type === 'deal_damage')) {
    categories.push('damage_single');
  }
  if (matchesAnyPattern(effectText, REMOVAL_SINGLE_PATTERNS) || operations.some((op) => op.type === 'remove_permanent')) {
    categories.push('removal_single');
  }
  if (matchesAnyPattern(effectText, TOKEN_PATTERNS) || operations.some((op) => op.type === 'create_token')) {
    categories.push('token_creation');
  }
  if (matchesAnyPattern(effectText, MOVEMENT_PATTERNS) || operations.some((op) => op.type === 'move_unit')) {
    categories.push('movement');
  }
  if (matchesAnyPattern(effectText, CHANNEL_PATTERNS) || operations.some((op) => op.type === 'channel_rune')) {
    categories.push('channel_rune');
  }
  if (matchesAnyPattern(effectText, HEAL_PATTERNS) || operations.some((op) => op.type === 'heal')) {
    categories.push('heal');
  }

  return categories;
};

// =============================================================================
// EFFECT DEFINITION EXTRACTION
// =============================================================================

const extractEffectDefinitions = (card: EnrichedCardRecord): SpellEffectDefinition[] => {
  const operations = card.effectProfile?.operations ?? [];
  const effectText = card.effect ?? '';

  return operations.map((op): SpellEffectDefinition => {
    const isConditional = /\bif\b/i.test(effectText) || /\bwhen\b/i.test(effectText);
    
    return {
      category: mapOperationToCategory(op),
      operations: [op.type],
      magnitude: op.magnitudeHint ?? null,
      automated: op.automated,
      timing: isConditional ? 'conditional' : 'instant'
    };
  });
};

const mapOperationToCategory = (op: EffectOperation): SpellEffectCategory => {
  switch (op.type) {
    case 'deal_damage':
      return op.targetHint === 'enemy' ? 'damage_single' : 'damage_single';
    case 'modify_stats':
      return op.targetHint === 'enemy' ? 'debuff_single' : 'buff_single';
    case 'remove_permanent':
      return 'removal_single';
    case 'draw_cards':
      return 'card_draw';
    case 'discard_cards':
      return 'card_discard';
    case 'move_unit':
      return 'movement';
    case 'return_to_hand':
      return 'return_to_hand';
    case 'create_token':
    case 'summon_unit':
      return 'token_creation';
    case 'gain_resource':
      return 'resource_gain';
    case 'control_battlefield':
      return 'battlefield_control';
    case 'return_from_graveyard':
      return 'graveyard_return';
    case 'channel_rune':
      return 'channel_rune';
    case 'heal':
      return 'heal';
    case 'shield':
      return 'shield';
    case 'transform':
      return 'transform';
    case 'search_deck':
      return 'search';
    default:
      return 'utility';
  }
};

// =============================================================================
// MAIN PROCESSING
// =============================================================================

const buildSpellRecord = (card: EnrichedCardRecord): SpellRecord => {
  const effectText = card.effect ?? '';
  const profile = card.effectProfile;
  const activation = card.activation;

  const primaryCategory = categorizeSpell(card);
  const secondaryCategories = getSecondaryCategories(card).filter((c) => c !== primaryCategory);
  const targetScope = detectSpellTargetScope(card, effectText);
  const targetCount = detectTargetCount(effectText);

  const targeting: SpellTargetingProfile = {
    scope: targetScope,
    mode: profile?.targeting?.mode ?? 'none',
    minTargets: targetCount.min,
    maxTargets: targetCount.max,
    requiresSelection: profile?.targeting?.requiresSelection ?? false,
    hint: profile?.targeting?.hint
  };

  const canTargetFriendly = 
    targetScope === 'ally_unit' || 
    targetScope === 'ally_units' || 
    targetScope === 'any_unit' || 
    targetScope === 'all_units' ||
    targetScope === 'self';

  const canTargetEnemy = 
    targetScope === 'enemy_unit' || 
    targetScope === 'enemy_units' || 
    targetScope === 'any_unit' || 
    targetScope === 'all_units';

  return {
    id: card.id,
    slug: card.slug,
    name: card.name,
    color: card.colors?.[0] ?? 'Colorless',
    cost: card.cost?.energy ?? 0,
    effect: effectText,
    category: primaryCategory,
    secondaryCategories,
    targeting,
    effects: extractEffectDefinitions(card),
    isAction: ACTION_PATTERN.test(effectText) || activation?.timing === 'action',
    isReaction: REACTION_PATTERN.test(effectText) || activation?.timing === 'reaction',
    isHidden: HIDDEN_PATTERN.test(effectText),
    isRepeat: REPEAT_PATTERN.test(effectText),
    reactionWindows: activation?.reactionWindows ?? [],
    requiresTarget: profile?.targeting?.requiresSelection ?? false,
    canTargetFriendly,
    canTargetEnemy,
    hasBattlefieldContext: /\bbattlefield\b/i.test(effectText),
    hasGraveyardInteraction: /\b(graveyard|trash)\b/i.test(effectText)
  };
};

const ensureDir = (filepath: string) => {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const main = () => {
  const catalog = getCardCatalog();
  const spells = catalog.filter((card) => card.type?.toLowerCase() === 'spell');

  console.log(`Found ${spells.length} spells out of ${catalog.length} total cards.`);

  const spellRecords = spells.map(buildSpellRecord);

  // Build category statistics
  const categoryStats = new Map<SpellEffectCategory, SpellCategoryStats>();
  spellRecords.forEach((spell) => {
    if (!categoryStats.has(spell.category)) {
      categoryStats.set(spell.category, {
        category: spell.category,
        count: 0,
        spells: [],
        requiresTargetCount: 0
      });
    }
    const stats = categoryStats.get(spell.category)!;
    stats.count++;
    stats.spells.push(spell.name);
    if (spell.requiresTarget) {
      stats.requiresTargetCount++;
    }
  });

  // Build targeting summary
  const targetingByScope: Record<string, string[]> = {};
  spellRecords.forEach((spell) => {
    const scope = spell.targeting.scope;
    if (!targetingByScope[scope]) {
      targetingByScope[scope] = [];
    }
    targetingByScope[scope].push(spell.name);
  });

  // Sort spells by category for output
  const sortedSpells = [...spellRecords].sort((a, b) => {
    const catCompare = a.category.localeCompare(b.category);
    if (catCompare !== 0) return catCompare;
    return a.name.localeCompare(b.name);
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    totalSpells: spells.length,
    totalCards: catalog.length,
    categoryStats: Array.from(categoryStats.values()).sort((a, b) => b.count - a.count),
    targetingByScope,
    spellsRequiringTarget: spellRecords.filter((s) => s.requiresTarget).map((s) => ({
      id: s.id,
      name: s.name,
      scope: s.targeting.scope,
      minTargets: s.targeting.minTargets,
      maxTargets: s.targeting.maxTargets
    })),
    spells: sortedSpells
  };

  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');

  console.log('\n=== Spell Taxonomy Summary ===\n');
  console.log(`Total Spells: ${payload.totalSpells}`);
  console.log('\nBy Category:');
  payload.categoryStats.forEach((stat) => {
    console.log(`  ${stat.category}: ${stat.count} spells (${stat.requiresTargetCount} require targeting)`);
  });
  console.log('\nBy Target Scope:');
  Object.entries(targetingByScope).forEach(([scope, names]) => {
    console.log(`  ${scope}: ${names.length} spells`);
  });
  console.log(`\nSpells requiring explicit targeting: ${payload.spellsRequiringTarget.length}`);
  console.log(`\nOutput written to: ${OUTPUT_PATH}`);
};

main();
