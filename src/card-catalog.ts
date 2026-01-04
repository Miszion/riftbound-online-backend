import fs from 'node:fs';
import path from 'node:path';

export type TargetHint = 'self' | 'ally' | 'enemy' | 'any' | 'battlefield' | 'zone';

export type TargetingMode = 'none' | 'single' | 'multiple' | 'global';

export interface TargetingProfile {
  mode: TargetingMode;
  hint?: TargetHint;
  requiresSelection: boolean;
}

export type PriorityHint = 'setup' | 'main' | 'combat' | 'reaction' | 'any';

export type ZoneHint = 'hand' | 'deck' | 'board' | 'battlefield' | 'graveyard';

export type EffectOperationType =
  | 'draw_cards'
  | 'discard_cards'
  | 'modify_stats'
  | 'deal_damage'
  | 'heal'
  | 'summon_unit'
  | 'create_token'
  | 'remove_permanent'
  | 'move_unit'
  | 'control_battlefield'
  | 'gain_resource'
  | 'search_deck'
  | 'recycle_card'
  | 'channel_rune'
  | 'interact_legend'
  | 'attach_gear'
  | 'transform'
  | 'manipulate_priority'
  | 'adjust_mulligan'
  | 'shield'
  | 'generic';

export interface EffectOperation {
  type: EffectOperationType;
  targetHint?: TargetHint;
  zone?: ZoneHint;
  automated: boolean;
  ruleRefs?: string[];
  magnitudeHint?: number | null;
}

export type EffectClassId =
  | 'card_draw'
  | 'card_discard'
  | 'resource_gain'
  | 'buff'
  | 'debuff'
  | 'damage'
  | 'heal'
  | 'summon'
  | 'token'
  | 'movement'
  | 'battlefield_control'
  | 'removal'
  | 'recycle'
  | 'search'
  | 'rune'
  | 'legend'
  | 'priority'
  | 'shielding'
  | 'attachment'
  | 'transform'
  | 'mulligan'
  | 'generic';

export interface EffectClassDefinition {
  id: EffectClassId;
  label: string;
  description: string;
  ruleRefs: string[];
  patterns: RegExp[];
  operation: EffectOperation;
}

export interface EffectProfile {
  classes: EffectClassId[];
  primaryClass: EffectClassId | null;
  operations: EffectOperation[];
  targeting: TargetingProfile;
  priority: PriorityHint;
  references: string[];
  reliability: 'heuristic' | 'exact';
}

export interface CardCostProfile {
  energy: number | null;
  powerSymbols: string[];
  raw: string | null;
  powerCost?: number | null;
  powerType?: string | null;
}

export interface RuleClause {
  id: string;
  text: string;
  tags: string[];
}

export type ActivationTiming = 'action' | 'reaction' | 'triggered' | 'passive';

export interface ActivationProfile {
  timing: ActivationTiming;
  triggers: string[];
  actions: string[];
  requiresTarget: boolean;
  reactionWindows: string[];
  stateful: boolean;
}

export interface CardAssetInfo {
  remote: string | null;
  localPath: string;
}

export interface CardBehaviorHints {
  entersUntapped?: boolean;
  entersTapped?: boolean;
  ruleWarnings?: string[];
}

export interface EnrichedCardRecord {
  id: string;
  slug: string;
  name: string;
  type: string | null;
  rarity: string | null;
  setName: string | null;
  colors: string[];
  cost: CardCostProfile;
  might: number | null;
  tags: string[];
  effect: string;
  flavor: string | null;
  keywords: string[];
  effectProfile: EffectProfile;
  activation: ActivationProfile;
  rules: RuleClause[];
  assets: CardAssetInfo;
  pricing: {
    price: number | null;
    foilPrice: number | null;
    currency: string;
  };
  references: {
    marketUrl: string | null;
    source: string;
  };
  behaviorHints?: CardBehaviorHints;
}

type StoredCardRecord = Omit<EnrichedCardRecord, 'effectProfile' | 'activation'> & {
  effectProfile?: EffectProfile;
  activation?: ActivationProfile;
};

export interface ImageManifestEntry {
  id: string;
  name: string;
  remote: string | null;
  localPath: string;
}

export interface CardActivationState {
  cardId: string;
  isStateful: boolean;
  active: boolean;
  lastChangedAt?: number;
}

export type RawDumpValue = string | number | string[] | null;

export interface RawDump {
  names: string[];
  data: RawDumpValue[][];
}

const KEYWORD_PATTERNS: Array<{ keyword: string; pattern: RegExp }> = [
  { keyword: 'Action', pattern: /\bACTION\b/gi },
  { keyword: 'Reaction', pattern: /\bREACTION\b/gi },
  { keyword: 'Showdown', pattern: /\bshowdown\b/gi },
  { keyword: 'Conquer', pattern: /\bconquer\b/gi },
  { keyword: 'Gear', pattern: /\bgear\b/gi },
  { keyword: 'Rune', pattern: /\brune\b/gi },
  { keyword: 'Heal', pattern: /\bheal\b/gi },
  { keyword: 'Buff', pattern: /\bbuff\b/gi },
  { keyword: 'Draw', pattern: /\bdraw\b/gi },
  { keyword: 'Kill', pattern: /\bkill\b/gi }
];

const ACTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'kill', pattern: /\bkill(s|ed)?\b/i },
  { label: 'buff', pattern: /\bbuff(s|ed)?\b/i },
  { label: 'heal', pattern: /\bheal(s|ed)?\b/i },
  { label: 'draw', pattern: /\bdraw(s|n)?\b/i },
  { label: 'summon', pattern: /\bsummon(s|ed)?\b/i },
  { label: 'discard', pattern: /\bdiscard(s|ed)?\b/i },
  { label: 'conquer', pattern: /\bconquer(s|ed)?\b/i },
  { label: 'transform', pattern: /\btransform(s|ed)?\b/i },
  { label: 'recover', pattern: /\brecover(s|ed)?\b/i }
];

const TARGET_REGEX = /\btarget\b|\bchoose\b|\bselect\b/i;
const MULTI_TARGET_REGEX = /\b(all|each|every)\b/i;

const PATTERN = (value: RegExp | string): RegExp =>
  typeof value === 'string' ? new RegExp(value, 'i') : value;

const buildPatterns = (values: Array<RegExp | string>): RegExp[] => values.map((value) => PATTERN(value));

const EFFECT_CLASS_DEFINITIONS: EffectClassDefinition[] = [
  {
    id: 'card_draw',
    label: 'Card draw & vision',
    description: 'Adds cards to hand or manipulates the top of the deck (rules 409-410, 743).',
    ruleRefs: ['409-410', '743'],
    patterns: buildPatterns([/\bdraw\b/i, /\bvision\b/i, /\bpeek\b/i, /\blook at the top\b/i]),
    operation: { type: 'draw_cards', targetHint: 'self', zone: 'deck', automated: true }
  },
  {
    id: 'card_discard',
    label: 'Discard / hand pressure',
    description: 'Forces a player to discard or lose access to cards (rules 346, 407).',
    ruleRefs: ['346', '407'],
    patterns: buildPatterns([/\bdiscard\b/i, /\bdiscarded\b/i, /\blose a card\b/i]),
    operation: { type: 'discard_cards', targetHint: 'enemy', zone: 'hand', automated: false }
  },
  {
    id: 'resource_gain',
    label: 'Resource generation',
    description: 'Generates energy, power, or rune advantage (rules 161-170).',
    ruleRefs: ['161-170'],
    patterns: buildPatterns([/\bgain\b.*\benergy\b/i, /\bpower\b/i, /\bchannel\b/i, /\brune\b/i]),
    operation: { type: 'gain_resource', targetHint: 'self', automated: true }
  },
  {
    id: 'buff',
    label: 'Buff / stat increase',
    description: 'Improves stats or grants bonuses (rules 430-450).',
    ruleRefs: ['430-450'],
    patterns: buildPatterns([/\bbuff\b/i, /\bgive\b.*\+\d/i, /\bgrant\b.*\+\d/i]),
    operation: { type: 'modify_stats', targetHint: 'ally', zone: 'board', automated: false }
  },
  {
    id: 'debuff',
    label: 'Debuff / stat reduction',
    description: 'Reduces stats or imposes penalties (rules 430-450).',
    ruleRefs: ['430-450'],
    patterns: buildPatterns([/\bdebuff\b/i, /\bgive\b.*-\d/i, /\breduce\b/i]),
    operation: { type: 'modify_stats', targetHint: 'enemy', zone: 'board', automated: false }
  },
  {
    id: 'damage',
    label: 'Direct damage',
    description: 'Deals damage outside combat (rules 500-520, 437).',
    ruleRefs: ['437', '500-520'],
    patterns: buildPatterns([/\bdeal\b.*\bdamage\b/i, /\bstrike\b/i, /\bblast\b/i, /\bburn\b/i]),
    operation: { type: 'deal_damage', targetHint: 'enemy', zone: 'board', automated: false }
  },
  {
    id: 'heal',
    label: 'Healing & recovery',
    description: 'Restores health or removes damage (rules 520-530).',
    ruleRefs: ['520-530'],
    patterns: buildPatterns([/\bheal\b/i, /\brecover\b/i, /\brestore\b/i]),
    operation: { type: 'heal', targetHint: 'ally', zone: 'board', automated: false }
  },
  {
    id: 'summon',
    label: 'Summon / deploy units',
    description: 'Creates or plays additional units (rules 340-360).',
    ruleRefs: ['340-360'],
    patterns: buildPatterns([/\bsummon\b/i, /\bplay a\b/i, /\bdeploy\b/i, /\bput\b.*onto the board/i]),
    operation: { type: 'summon_unit', targetHint: 'ally', zone: 'board', automated: false }
  },
  {
    id: 'token',
    label: 'Token creation',
    description: 'Creates token units or copies (rules 340-360).',
    ruleRefs: ['340-360'],
    patterns: buildPatterns([/\btoken\b/i, /\bcopy\b/i]),
    operation: { type: 'create_token', targetHint: 'ally', zone: 'board', automated: false }
  },
  {
    id: 'movement',
    label: 'Movement / repositioning',
    description: 'Moves cards between locations or battlefields (rules 430, 737).',
    ruleRefs: ['430', '737'],
    patterns: buildPatterns([/\bmove\b/i, /\brelocate\b/i, /\bswap\b/i]),
    operation: { type: 'move_unit', targetHint: 'ally', zone: 'board', automated: false }
  },
  {
    id: 'battlefield_control',
    label: 'Battlefield control',
    description: 'Captures or influences battlefields (rules 106, 437).',
    ruleRefs: ['106', '437'],
    patterns: buildPatterns([/\bbattlefield\b/i, /\bconquer\b/i, /\bcapture\b/i, /\bcontrol\b.*battlefield/i]),
    operation: { type: 'control_battlefield', targetHint: 'battlefield', zone: 'battlefield', automated: false }
  },
  {
    id: 'removal',
    label: 'Removal / destruction',
    description: 'Destroys or banishes cards (rules 500-520, 716).',
    ruleRefs: ['500-520', '716'],
    patterns: buildPatterns([/\bkill\b/i, /\bdestroy\b/i, /\bbanish\b/i, /\bremove\b/i]),
    operation: { type: 'remove_permanent', targetHint: 'enemy', zone: 'board', automated: false }
  },
  {
    id: 'recycle',
    label: 'Recycle / shuffle',
    description: 'Recycles or returns cards to decks (rules 403, 409).',
    ruleRefs: ['403', '409'],
    patterns: buildPatterns([/\brecycle\b/i, /\bshuffle\b/i, /\bput\b.*bottom\b/i]),
    operation: { type: 'recycle_card', targetHint: 'self', zone: 'deck', automated: true }
  },
  {
    id: 'search',
    label: 'Search / tutor',
    description: 'Searches decks or looks for cards (rules 346, 409).',
    ruleRefs: ['346', '409'],
    patterns: buildPatterns([/\bsearch\b/i, /\blook for\b/i, /\bchoose\b.*from your deck/i]),
    operation: { type: 'search_deck', targetHint: 'self', zone: 'deck', automated: false }
  },
  {
    id: 'rune',
    label: 'Rune interaction',
    description: 'Channels or manipulates runes (rules 161-170, 132.5).',
    ruleRefs: ['161-170', '132.5'],
    patterns: buildPatterns([/\brune\b/i, /\bchannel\b/i, /\bpower pip\b/i]),
    operation: { type: 'channel_rune', targetHint: 'self', zone: 'board', automated: true }
  },
  {
    id: 'legend',
    label: 'Legend / leader interaction',
    description: 'References champion legends or leaders (rules 103-107).',
    ruleRefs: ['103-107', '132.6'],
    patterns: buildPatterns([/\blegend\b/i, /\bleader\b/i, /\bchosen champion\b/i, /\bchampion\b/i]),
    operation: { type: 'interact_legend', targetHint: 'self', zone: 'board', automated: false }
  },
  {
    id: 'priority',
    label: 'Priority & reaction modifiers',
    description: 'Changes timing, reactions, or priority windows (rules 117, 346, 739).',
    ruleRefs: ['117', '346', '739'],
    patterns: buildPatterns([/\bREACTION\b/i, /\bACTION\b/i, /\bshowdown\b/i, /\bpriority\b/i]),
    operation: { type: 'manipulate_priority', targetHint: 'any', zone: 'board', automated: false }
  },
  {
    id: 'shielding',
    label: 'Shield / prevention',
    description: 'Prevents or redirects damage (rules 735-742).',
    ruleRefs: ['735-742'],
    patterns: buildPatterns([/\bshield\b/i, /\bprevent\b/i, /\bbarrier\b/i, /\bprotect\b/i]),
    operation: { type: 'shield', targetHint: 'ally', zone: 'board', automated: false }
  },
  {
    id: 'attachment',
    label: 'Attachment / gear',
    description: 'Attaches gear or equipment (rules 716, 744).',
    ruleRefs: ['716', '744'],
    patterns: buildPatterns([/\bequip\b/i, /\battach\b/i, /\bgear\b/i]),
    operation: { type: 'attach_gear', targetHint: 'ally', zone: 'board', automated: false }
  },
  {
    id: 'transform',
    label: 'Transform / polymorph',
    description: 'Transforms cards or swaps forms (rules 430-450).',
    ruleRefs: ['430-450'],
    patterns: buildPatterns([/\btransform\b/i, /\bbecome\b/i, /\bswap\b.*form/i]),
    operation: { type: 'transform', targetHint: 'any', zone: 'board', automated: false }
  },
  {
    id: 'mulligan',
    label: 'Mulligan / setup modifiers',
    description: 'Changes opening hand or mulligan rules (rule 117).',
    ruleRefs: ['117'],
    patterns: buildPatterns([/\bmulligan\b/i, /\bstarting hand\b/i]),
    operation: { type: 'adjust_mulligan', targetHint: 'self', zone: 'hand', automated: true }
  }
];

const GENERIC_EFFECT_CLASS: EffectClassDefinition = {
  id: 'generic',
  label: 'Generic effect',
  description: 'Covers bespoke text without a detectable automation pattern.',
  ruleRefs: ['000-055'],
  patterns: [],
  operation: { type: 'generic', targetHint: 'any', automated: false }
};

export const effectClassDefinitions = [...EFFECT_CLASS_DEFINITIONS, GENERIC_EFFECT_CLASS];

const TARGET_HINT_PATTERNS: Array<{ hint: TargetHint; pattern: RegExp }> = [
  { hint: 'ally', pattern: /\bfriendly\b|\ballied\b|\byou control\b/i },
  { hint: 'enemy', pattern: /\ban enemy\b|\bopponent'?s\b/i },
  { hint: 'battlefield', pattern: /\bbattlefield\b/i },
  { hint: 'self', pattern: /\bmyself\b|\bthis\b|\bme\b|\bself\b/i },
  { hint: 'any', pattern: /\bany\b|\btarget\b/i }
];

const ACTION_CLASS_MAP: Partial<Record<string, EffectClassId>> = {
  draw: 'card_draw',
  buff: 'buff',
  heal: 'heal',
  kill: 'removal',
  summon: 'summon',
  discard: 'card_discard',
  conquer: 'battlefield_control',
  transform: 'transform',
  recover: 'heal',
  heal_player: 'heal'
};

const detectTargetHint = (text: string): TargetHint | undefined => {
  for (const { hint, pattern } of TARGET_HINT_PATTERNS) {
    if (pattern.test(text)) {
      return hint;
    }
  }
  return undefined;
};

const detectTargetMode = (text: string, requiresTarget: boolean): TargetingMode => {
  if (!requiresTarget) {
    return 'none';
  }
  if (MULTI_TARGET_REGEX.test(text)) {
    return 'multiple';
  }
  if (/global/i.test(text) || /\ball\b.*players\b/i.test(text)) {
    return 'global';
  }
  return 'single';
};

const detectPriority = (text: string, activation: ActivationProfile): PriorityHint => {
  if (activation.timing === 'reaction' || activation.reactionWindows.length > 0) {
    if (activation.reactionWindows.includes('showdown') || /\bshowdown\b/i.test(text)) {
      return 'combat';
    }
    return 'reaction';
  }
  if (activation.timing === 'triggered') {
    return 'any';
  }
  if (/\bmulligan\b/i.test(text)) {
    return 'setup';
  }
  return 'main';
};

const matchEffectClasses = (text: string, activation: ActivationProfile): EffectClassDefinition[] => {
  const matches = EFFECT_CLASS_DEFINITIONS.filter((definition) =>
    definition.patterns.some((pattern) => pattern.test(text))
  );
  if (matches.length > 0) {
    return matches;
  }
  const inferred = activation.actions
    .map((action) => ACTION_CLASS_MAP[action])
    .filter((value): value is EffectClassId => Boolean(value));
  if (inferred.length > 0) {
    return EFFECT_CLASS_DEFINITIONS.filter((definition) => inferred.includes(definition.id));
  }
  return [GENERIC_EFFECT_CLASS];
};

export const buildEffectProfile = (
  effect: string,
  activation: ActivationProfile
): EffectProfile => {
  const text = effect || '';
  const classes = matchEffectClasses(text, activation);
  const operations = classes.map((definition) => {
    const operation = {
      ...definition.operation,
      ruleRefs: definition.ruleRefs
    };
    const magnitude = extractMagnitudeFromEffect(text, operation.type);
    if (magnitude !== null) {
      operation.magnitudeHint = magnitude;
    }
    return operation;
  });
  const references = Array.from(new Set(classes.flatMap((definition) => definition.ruleRefs)));
  const targeting: TargetingProfile = {
    mode: detectTargetMode(text, activation.requiresTarget),
    hint: detectTargetHint(text),
    requiresSelection: activation.requiresTarget
  };

  return {
    classes: classes.map((definition) => definition.id),
    primaryClass: classes[0]?.id ?? null,
    operations,
    targeting,
    priority: detectPriority(text, activation),
    references,
    reliability: classes.some((definition) => definition.id === 'generic') ? 'heuristic' : 'exact'
  };
};
const ENRICHED_DATA_PATH = path.resolve(process.cwd(), 'data', 'cards.enriched.json');

const DOMAIN_SYMBOL_BY_COLOR: Record<string, string> = {
  fury: 'R',
  calm: 'G',
  mind: 'B',
  body: 'O',
  chaos: 'P',
  order: 'Y'
};

const ACTION_PREFIX_CARD_TYPES = new Set<string>(['spell', 'action']);
const UNTAPPED_PATTERN = /\b(enters?|enter)\b[^.]*\b(untapped|ready|stand)\b/i;
const TAPPED_PATTERN = /\b(enters?|enter)\b[^.]*\b(tapped|exhausted)\b/i;
const WORD_NUMBER_REGEX = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};

const normalize = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const listify = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry)).filter(Boolean);
  }

  const normalized = normalize(value);
  if (!normalized) return [];

  return normalized
    .split(/[,/]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const deriveDomainSymbolsFromColors = (colors: string[]): string[] => {
  const seen = new Set<string>();
  const resolved: string[] = [];
  colors.forEach((color) => {
    const symbol = DOMAIN_SYMBOL_BY_COLOR[color?.toLowerCase()];
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      resolved.push(symbol);
    }
  });
  return resolved;
};

const parseCost = (raw: unknown, colors: string[]): CardCostProfile => {
  const normalized = normalize(raw);
  const digits = normalized ? normalized.match(/\d+/g) : null;
  const energy = digits ? Number(digits.join('')) : null;
  const bracketMatches = normalized ? normalized.match(/\[[A-Za-z]+\]/g) : null;
  const explicitSymbols = bracketMatches
    ? bracketMatches
        .map((symbol) => symbol.replace(/\[|\]/g, '').trim())
        .filter(Boolean)
        .map((symbol) => symbol[0]?.toUpperCase() ?? '')
        .filter(Boolean)
    : [];
  const fallbackSymbols =
    explicitSymbols.length > 0 ? explicitSymbols : deriveDomainSymbolsFromColors(colors);

  return {
    energy: Number.isFinite(energy) ? energy : null,
    powerSymbols: fallbackSymbols,
    raw: normalized || null
  };
};

const buildWordNumberRegex = () => WORD_NUMBER_REGEX;

const parseQuantityToken = (token?: string | null): number | null => {
  if (!token) {
    return null;
  }
  const numericMatch = token.match(/-?\d+/);
  if (numericMatch) {
    const value = Number(numericMatch[0]);
    if (Number.isFinite(value)) {
      return Math.abs(value);
    }
  }
  const normalized = token.toLowerCase();
  return NUMBER_WORDS[normalized] ?? null;
};

const OPERATION_QUANTITY_PATTERNS: Partial<Record<EffectOperationType, RegExp[]>> = {
  draw_cards: [
    new RegExp(`draw\\s+(?:up to\\s+)?(\\d+)`, 'i'),
    new RegExp(`draw\\s+(?:up to\\s+)?(${buildWordNumberRegex()})`, 'i')
  ],
  discard_cards: [
    new RegExp(`discard\\s+(\\d+)`, 'i'),
    new RegExp(`discard\\s+(${buildWordNumberRegex()})`, 'i')
  ],
  gain_resource: [
    new RegExp(`gain\\s+(?:\\[)?(\\d+)(?:\\])?`, 'i'),
    new RegExp(`gain\\s+(${buildWordNumberRegex()})`, 'i'),
    new RegExp(`add\\s+(?:\\[)?(\\d+)(?:\\])?`, 'i')
  ],
  channel_rune: [
    new RegExp(`channel\\s+(?:\\[)?(\\d+)(?:\\])?`, 'i'),
    new RegExp(`channel\\s+(${buildWordNumberRegex()})`, 'i'),
    new RegExp(`add\\s+(?:\\[)?(\\d+)(?:\\])?\\s+rune`, 'i')
  ],
  modify_stats: [
    /\+(\d+)/i,
    new RegExp(`plus\\s+(${buildWordNumberRegex()})`, 'i'),
    /-(\d+)/i
  ],
  deal_damage: [
    new RegExp(`deal\\s+(\\d+)`, 'i'),
    new RegExp(`deal\\s+(${buildWordNumberRegex()})`, 'i'),
    new RegExp(`deal[^\\d]*(\\d+)`, 'i')
  ],
  heal: [
    new RegExp(`heal\\s+(\\d+)`, 'i'),
    new RegExp(`heal\\s+(${buildWordNumberRegex()})`, 'i'),
    new RegExp(`restore\\s+(\\d+)`, 'i')
  ],
  summon_unit: [
    new RegExp(`summon\\s+(\\d+)`, 'i'),
    new RegExp(`summon\\s+(${buildWordNumberRegex()})`, 'i'),
    new RegExp(`play\\s+(\\d+)`, 'i'),
    new RegExp(`create\\s+(\\d+)`, 'i')
  ],
  create_token: [
    new RegExp(`create\\s+(\\d+)`, 'i'),
    new RegExp(`create\\s+(${buildWordNumberRegex()})`, 'i'),
    new RegExp(`put\\s+(\\d+)`, 'i')
  ],
  shield: [
    new RegExp(`prevent\\s+(\\d+)`, 'i'),
    new RegExp(`prevent\\s+(${buildWordNumberRegex()})`, 'i'),
    new RegExp(`shield\\s+(\\d+)`, 'i')
  ],
  recycle_card: [
    new RegExp(`recycle\\s+(\\d+)`, 'i'),
    new RegExp(`recycle\\s+(${buildWordNumberRegex()})`, 'i')
  ],
  search_deck: [
    new RegExp(`search\\s+(\\d+)`, 'i'),
    new RegExp(`search\\s+(${buildWordNumberRegex()})`, 'i')
  ]
};

const extractMagnitudeFromEffect = (
  effectText: string,
  operationType: EffectOperationType
): number | null => {
  const patterns = OPERATION_QUANTITY_PATTERNS[operationType];
  if (!patterns) {
    return null;
  }
  for (const pattern of patterns) {
    const match = pattern.exec(effectText);
    if (match && match[1]) {
      const value = parseQuantityToken(match[1]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
};

const ensureRulesCompliantEffect = (effect: string, rawType: unknown) => {
  const warnings: string[] = [];
  let text = effect.trim();
  if (!text) {
    warnings.push('missing-effect-text');
    text = 'No effect text provided.';
  }
  const normalizedType = normalize(rawType).toLowerCase();
  if (
    ACTION_PREFIX_CARD_TYPES.has(normalizedType) &&
    !/^(ACTION|REACTION|SHOWDOWN)\b/i.test(text)
  ) {
    warnings.push('action-prefix-added');
    text = `ACTION — ${text}`;
  }
  if (!/[.!?]\s*$/.test(text)) {
    text = `${text}.`;
  }
  return { text, warnings };
};

const buildBehaviorHints = (effectText: string, warnings: string[]): CardBehaviorHints => {
  const hints: CardBehaviorHints = {};
  if (UNTAPPED_PATTERN.test(effectText)) {
    hints.entersUntapped = true;
  }
  if (TAPPED_PATTERN.test(effectText)) {
    hints.entersTapped = true;
  }
  if (warnings.length > 0) {
    hints.ruleWarnings = warnings;
  }
  return hints;
};

const shouldDefaultTapped = (rawType: unknown): boolean => {
  const normalized = normalize(rawType).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('unit') ||
    normalized.includes('creature') ||
    normalized.includes('champion') ||
    normalized.includes('legend') ||
    normalized.includes('artifact') ||
    normalized.includes('enchantment') ||
    normalized.includes('gear')
  );
};

const deriveKeywords = (effect: string, baseKeywords: string[]): string[] => {
  const keywordSet = new Set(baseKeywords.filter(Boolean));
  KEYWORD_PATTERNS.forEach(({ keyword, pattern }) => {
    if (pattern.test(effect)) {
      keywordSet.add(keyword);
    }
  });
  return Array.from(keywordSet);
};

const deriveClauses = (cardId: string, effect: string): RuleClause[] => {
  if (!effect) return [];
  const clauses = effect
    .split(/(?:(?<=[.!?])\s+|\n+)/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  return clauses.map((text, index) => {
    const tags: string[] = [];
    if (/^ACTION\b/i.test(text)) tags.push('action');
    if (/^REACTION\b/i.test(text)) tags.push('reaction');
    if (/\bWhen\b|\bWhenever\b/i.test(text)) tags.push('trigger');
    if (/\bBuff\b/i.test(text)) tags.push('buff');
    if (/\bKill\b/i.test(text)) tags.push('removal');
    if (/\bHeal\b/i.test(text)) tags.push('healing');
    return {
      id: `${cardId}-clause-${index + 1}`,
      text,
      tags
    };
  });
};

const deriveTriggers = (effect: string): string[] => {
  const triggers: string[] = [];
  const triggerRegex = /\b(When|Whenever|After|Before|While|During)\b([^.;]+)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = triggerRegex.exec(effect)) !== null) {
    const [, keyword, clause] = match;
    triggers.push(`${keyword.trim()}${clause.trim()}`);
  }
  return triggers;
};

const deriveActions = (effect: string): string[] => {
  const actions = new Set<string>();
  ACTION_PATTERNS.forEach(({ label, pattern }) => {
    if (pattern.test(effect)) actions.add(label);
  });
  return Array.from(actions);
};

const deriveReactionWindows = (effect: string): string[] => {
  const windows: string[] = [];
  if (/showdown/i.test(effect)) windows.push('showdown');
  if (/opponent'?s turn/i.test(effect)) windows.push('opponent-turn');
  if (/your turn/i.test(effect)) windows.push('your-turn');
  return windows;
};

const deriveTiming = (effect: string): ActivationTiming => {
  if (/^ACTION\b/i.test(effect) || /\bACTION\b/i.test(effect)) return 'action';
  if (/^REACTION\b/i.test(effect) || /\bREACTION\b/i.test(effect)) return 'reaction';
  if (/\bWhen\b|\bWhenever\b/i.test(effect)) return 'triggered';
  return 'passive';
};

const buildActivation = (effect: string): ActivationProfile => {
  const text = effect || '';
  return {
    timing: deriveTiming(text),
    triggers: deriveTriggers(text),
    actions: deriveActions(text),
    requiresTarget: TARGET_REGEX.test(text),
    reactionWindows: deriveReactionWindows(text),
    stateful: /\bbuff\b|\bheal\b|\btransform\b|\bsummon\b/i.test(text)
  };
};

export const reshapeDump = (raw: RawDump): EnrichedCardRecord[] => {
  return raw.data.map((row) => {
    const record: Record<string, RawDumpValue> = {};
    raw.names.forEach((field, index) => {
      record[field] = row[index] ?? null;
    });

    const id = normalize(record.id);
    const slug = normalize(record.slug) || id;
    const effect = normalize(record.effect);
    const { text: normalizedEffect, warnings } = ensureRulesCompliantEffect(effect, record.type);
    const colors = listify(record.color);
    const tags = listify(record.tags);
    const keywords = deriveKeywords(normalizedEffect, [...colors, ...tags]);
    const rules = deriveClauses(id, normalizedEffect);
    const activation = buildActivation(normalizedEffect);
    const effectProfile = buildEffectProfile(normalizedEffect, activation);
    const behaviorHints = buildBehaviorHints(normalizedEffect, warnings);
    if (shouldDefaultTapped(record.type) && !behaviorHints.entersUntapped) {
      behaviorHints.entersTapped = true;
    }

    const cardRecord: EnrichedCardRecord = {
      id,
      slug,
      name: normalize(record.name),
      type: normalize(record.type) || null,
      rarity: normalize(record.rarity) || null,
      setName: normalize(record.set_name) || null,
      colors,
      cost: parseCost(record.cost, colors),
      might: toNumber(record.might),
      tags,
      effect: normalizedEffect,
      flavor: normalize(record.flavor) || null,
      keywords,
      effectProfile,
      activation,
      rules,
      assets: {
        remote: normalize(record.image) || null,
        localPath: path.posix.join('assets', 'card-images', `${slug || id}.webp`)
      },
      pricing: {
        price: toNumber(record.price),
        foilPrice: toNumber(record.foilPrice),
        currency: 'USD'
      },
      references: {
        marketUrl: normalize(record.cmurl) || null,
        source: 'champion-dump-api'
      }
    };

    if (Object.keys(behaviorHints).length > 0) {
      cardRecord.behaviorHints = behaviorHints;
    }

    return cardRecord;
  });
};

const normalizeCatalogRecord = (record: StoredCardRecord): EnrichedCardRecord => {
  const activation = record.activation ?? buildActivation(record.effect);
  const effectProfile = record.effectProfile ?? buildEffectProfile(record.effect, activation);
  return {
    ...record,
    activation,
    effectProfile
  };
};

let cachedCards: EnrichedCardRecord[] | null = null;

const loadFromEnrichedFile = (): EnrichedCardRecord[] | null => {
  if (!fs.existsSync(ENRICHED_DATA_PATH)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      fs.readFileSync(ENRICHED_DATA_PATH, 'utf-8')
    ) as { cards: StoredCardRecord[] };
    if (payload && Array.isArray(payload.cards)) {
      return payload.cards.map((card) => normalizeCatalogRecord(card));
    }
  } catch {
    // Ignore parse failure and fall back
  }
  return null;
};

const requireEnrichedCatalog = (): EnrichedCardRecord[] => {
  const enriched = loadFromEnrichedFile();
  if (!enriched) {
    throw new Error(
      `Unable to load card catalog. Expected ${ENRICHED_DATA_PATH}. Run "npm run generate:cards" first.`
    );
  }
  return enriched;
};

const getCachedCatalog = (): EnrichedCardRecord[] => {
  if (!cachedCards) {
    cachedCards = requireEnrichedCatalog();
  }
  return cachedCards;
};

export const getCardCatalog = (): EnrichedCardRecord[] => getCachedCatalog();

export const findCardById = (id: string): EnrichedCardRecord | undefined => {
  return getCachedCatalog().find((card) => card.id.toLowerCase() === id.toLowerCase());
};

export const findCardBySlug = (slug: string): EnrichedCardRecord | undefined => {
  return getCachedCatalog().find((card) => card.slug.toLowerCase() === slug.toLowerCase());
};

export const getImageManifest = (): ImageManifestEntry[] => {
  return getCachedCatalog().map((card) => ({
    id: card.id,
    name: card.name,
    remote: card.assets.remote,
    localPath: card.assets.localPath
  }));
};

export const buildActivationStateIndex = (): Record<string, CardActivationState> => {
  return getCachedCatalog().reduce<Record<string, CardActivationState>>((acc, card) => {
    acc[card.id] = {
      cardId: card.id,
      isStateful: card.activation.stateful,
      active: false
    };
    return acc;
  }, {});
};

export const writeCatalogToDisk = (destination = ENRICHED_DATA_PATH): string => {
  const payload = {
    generatedAt: new Date().toISOString(),
    totalCards: getCachedCatalog().length,
    cards: getCachedCatalog()
  };
  const dir = path.dirname(destination);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(destination, JSON.stringify(payload, null, 2));
  return destination;
};

export const writeImageManifestToDisk = (
  destination = path.resolve(process.cwd(), 'data', 'card-images.json')
): string => {
  const manifest = getImageManifest();
  const dir = path.dirname(destination);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(destination, JSON.stringify(manifest, null, 2));
  return destination;
};
