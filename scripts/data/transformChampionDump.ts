// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { parseTokenSpecs } from '../../src/card-catalog';

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const ENRICHED_OUTPUT = path.join(DATA_DIR, 'cards.enriched.json');
const IMAGE_MANIFEST_OUTPUT = path.join(DATA_DIR, 'card-images.json');
const CHAMPION_DUMP_URL = 'https://api.dotgg.gg/cgfw/getcards?game=riftbound';

const ACTION_PREFIX_CARD_TYPES = new Set(['spell', 'action']);
const UNTAPPED_PATTERN = /\b(enters?|enter)\b[^.]*\b(untapped|ready|stand)\b/i;
const TAPPED_PATTERN = /\b(enters?|enter)\b[^.]*\b(tapped|exhausted)\b/i;
const WORD_NUMBER_REGEX = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const NUMBER_WORDS = {
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

const KEYWORD_PATTERNS = [
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

const ACTION_PATTERNS = [
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
// Patterns that indicate targeting even without explicit 'target/choose/select' words
const UP_TO_TARGET_REGEX = /up\s+to\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:enemy\s+)?units?\b/i;
const ABILITY_KEYWORD_PATTERN = /^\s*\[(?<keyword>[^\]]+)\]\s*[—-]\s*(?<body>.+)$/i;
const SUPPORTED_KEYWORD_TRIGGERS = {
  deathknell: 'death'
};

const EFFECT_CLASS_DEFINITIONS = [
  {
    id: 'card_draw',
    label: 'Card draw & vision',
    patterns: [/\bdraw\b/i, /\bvision\b/i, /\bpeek\b/i, /\blook at the top\b/i],
    operation: { type: 'draw_cards', targetHint: 'self', zone: 'deck', automated: true },
    ruleRefs: ['409-410', '743']
  },
  {
    id: 'card_discard',
    label: 'Discard / hand pressure',
    patterns: [/\bdiscard\b/i, /\blose a card\b/i],
    operation: { type: 'discard_cards', targetHint: 'enemy', zone: 'hand', automated: false },
    ruleRefs: ['346', '407']
  },
  {
    id: 'resource_gain',
    label: 'Resource generation',
    patterns: [/\bgain\b.*\benergy\b/i, /\bchannel\b/i, /\brune\b/i, /\bpower\b/i],
    operation: { type: 'gain_resource', targetHint: 'self', automated: true },
    ruleRefs: ['161-170']
  },
  {
    id: 'buff',
    label: 'Buff / stat increase',
    patterns: [/\bbuff\b/i, /\bgive\b.*\+\d/i, /\bgrant\b.*\+\d/i],
    operation: { type: 'modify_stats', targetHint: 'ally', zone: 'board', automated: false },
    ruleRefs: ['430-450']
  },
  {
    id: 'debuff',
    label: 'Debuff / stat reduction',
    patterns: [/\bdebuff\b/i, /\bgive\b.*-\d/i, /\breduce\b/i],
    operation: { type: 'modify_stats', targetHint: 'enemy', zone: 'board', automated: false },
    ruleRefs: ['430-450']
  },
  {
    id: 'damage',
    label: 'Direct damage',
    patterns: [/\bdeal\b.*\bdamage\b/i, /\bstrike\b/i, /\bblast\b/i, /\bburn\b/i],
    operation: { type: 'deal_damage', targetHint: 'enemy', zone: 'board', automated: false },
    ruleRefs: ['437', '500-520']
  },
  {
    id: 'heal',
    label: 'Healing & recovery',
    patterns: [/\bheal\b/i, /\brecover\b/i, /\brestore\b/i],
    operation: { type: 'heal', targetHint: 'ally', zone: 'board', automated: false },
    ruleRefs: ['520-530']
  },
  {
    id: 'summon',
    label: 'Summon / deploy units',
    patterns: [/\bsummon\b/i, /\bplay a\b/i, /\bdeploy\b/i, /\bput\b.*onto the board/i],
    operation: { type: 'summon_unit', targetHint: 'ally', zone: 'board', automated: false },
    ruleRefs: ['340-360']
  },
  {
    id: 'token',
    label: 'Token creation',
    patterns: [/\btoken\b/i, /\bcopy\b/i],
    operation: { type: 'create_token', targetHint: 'ally', zone: 'board', automated: false },
    ruleRefs: ['340-360']
  },
  {
    id: 'movement',
    label: 'Movement / repositioning',
    patterns: [/\bmove\b/i, /\brelocate\b/i, /\bswap\b/i],
    operation: { type: 'move_unit', targetHint: 'ally', zone: 'board', automated: false },
    ruleRefs: ['430', '737']
  },
  {
    id: 'battlefield_control',
    label: 'Battlefield control',
    patterns: [/\bbattlefield\b/i, /\bconquer\b/i, /\bcapture\b/i, /\bcontrol\b.*battlefield/i],
    operation: { type: 'control_battlefield', targetHint: 'battlefield', zone: 'battlefield', automated: false },
    ruleRefs: ['106', '437']
  },
  {
    id: 'removal',
    label: 'Removal / destruction',
    patterns: [/\bkill\b/i, /\bdestroy\b/i, /\bbanish\b/i, /\bremove\b/i],
    operation: { type: 'remove_permanent', targetHint: 'enemy', zone: 'board', automated: false },
    ruleRefs: ['500-520', '716']
  },
  {
    id: 'recycle',
    label: 'Recycle / shuffle',
    patterns: [/\brecycle\b/i, /\bshuffle\b/i, /\bput\b.*bottom\b/i],
    operation: { type: 'recycle_card', targetHint: 'self', zone: 'deck', automated: true },
    ruleRefs: ['403', '409']
  },
  {
    id: 'search',
    label: 'Search / tutor',
    patterns: [/\bsearch\b/i, /\blook for\b/i, /\bchoose\b.*from your deck/i],
    operation: { type: 'search_deck', targetHint: 'self', zone: 'deck', automated: false },
    ruleRefs: ['346', '409']
  },
  {
    id: 'rune',
    label: 'Rune interaction',
    patterns: [/\brune\b/i, /\bchannel\b/i, /\bpower pip\b/i],
    operation: { type: 'channel_rune', targetHint: 'self', zone: 'board', automated: true },
    ruleRefs: ['161-170', '132.5']
  },
  {
    id: 'legend',
    label: 'Legend / leader interaction',
    patterns: [/\blegend\b/i, /\bleader\b/i, /\bchosen champion\b/i, /\bchampion\b/i],
    operation: { type: 'interact_legend', targetHint: 'self', zone: 'board', automated: false },
    ruleRefs: ['103-107', '132.6']
  },
  {
    id: 'priority',
    label: 'Priority & reaction modifiers',
    patterns: [/\bREACTION\b/i, /\bACTION\b/i, /\bshowdown\b/i, /\bpriority\b/i],
    operation: { type: 'manipulate_priority', targetHint: 'any', zone: 'board', automated: false },
    ruleRefs: ['117', '346', '739']
  },
  {
    id: 'shielding',
    label: 'Shield / prevention',
    patterns: [/\bshield\b/i, /\bprevent\b/i, /\bbarrier\b/i, /\bprotect\b/i],
    operation: { type: 'shield', targetHint: 'ally', zone: 'board', automated: false },
    ruleRefs: ['735-742']
  },
  {
    id: 'attachment',
    label: 'Attachment / gear',
    patterns: [/\bequip\b/i, /\battach\b/i, /\bgear\b/i],
    operation: { type: 'attach_gear', targetHint: 'ally', zone: 'board', automated: false },
    ruleRefs: ['716', '744']
  },
  {
    id: 'transform',
    label: 'Transform / polymorph',
    patterns: [/\btransform\b/i, /\bbecome\b/i, /\bswap\b.*form/i],
    operation: { type: 'transform', targetHint: 'any', zone: 'board', automated: false },
    ruleRefs: ['430-450']
  },
  {
    id: 'mulligan',
    label: 'Mulligan / setup modifiers',
    patterns: [/\bmulligan\b/i, /\bstarting hand\b/i],
    operation: { type: 'adjust_mulligan', targetHint: 'self', zone: 'hand', automated: true },
    ruleRefs: ['117']
  },
  {
    id: 'assault',
    label: 'Assault / attack bonus',
    patterns: [
      /\[Assault\b/i,
      /\bASSAULT\b/i,
      /\+\d+.*:rb_might:.*while.*attacker/i,
      /\+\d+.*might.*while.*attacker/i
    ],
    operation: { type: 'combat_bonus', targetHint: 'self', zone: 'board', automated: true },
    ruleRefs: ['713']
  },
  {
    id: 'shield_combat',
    label: 'Shield / defense bonus',
    patterns: [
      /\[Shield\b/i,
      /\bSHIELD\b/i,
      /\+\d+.*:rb_might:.*while.*defender/i,
      /\+\d+.*might.*while.*defender/i
    ],
    operation: { type: 'combat_bonus', targetHint: 'self', zone: 'board', automated: true },
    ruleRefs: ['714']
  },
  {
    id: 'combat_trigger',
    label: 'Combat trigger effects',
    patterns: [
      /\bwhen I attack\b/i,
      /\bwhen I defend\b/i,
      /\bwhen I attack or defend\b/i,
      /\bwhen.*attacks?\b.*deal\b/i,
      /\bwhen.*defends?\b.*deal\b/i
    ],
    operation: { type: 'combat_trigger', targetHint: 'any', zone: 'board', automated: false },
    ruleRefs: ['700-720']
  },
  {
    id: 'aura_buff',
    label: 'Aura / static buff',
    patterns: [
      /\bother friendly units\b.*\+\d/i,
      /\bother friendly units\b.*have\b/i,
      /\bfriendly units here have\b/i,
      /\bunits you control\b.*\+\d/i,
      /\bunits you control have\b/i
    ],
    operation: { type: 'aura_buff', targetHint: 'ally', zone: 'board', automated: true },
    ruleRefs: ['430-450']
  },
  {
    id: 'on_play',
    label: 'On-play effects',
    patterns: [
      /\bwhen you play me\b/i,
      /\bwhen I enter\b/i,
      /\bwhen.*played\b/i
    ],
    operation: { type: 'on_play_trigger', targetHint: 'any', zone: 'board', automated: false },
    ruleRefs: ['340-360']
  }
];

const GENERIC_CLASS = {
  id: 'generic',
  label: 'Generic effect',
  patterns: [],
  operation: { type: 'generic', targetHint: 'any', automated: false },
  ruleRefs: ['000-055']
};

const TARGET_HINT_PATTERNS = [
  { hint: 'ally', pattern: /\bfriendly\b|\ballied\b|\byou control\b/i },
  { hint: 'enemy', pattern: /\ban enemy\b|\bopponent'?s\b/i },
  { hint: 'battlefield', pattern: /\bbattlefield\b/i },
  { hint: 'self', pattern: /\bmyself\b|\bthis\b|\bme\b|\bself\b/i },
  { hint: 'any', pattern: /\bany\b|\btarget\b/i }
];

const ACTION_CLASS_MAP = {
  draw: 'card_draw',
  buff: 'buff',
  heal: 'heal',
  kill: 'removal',
  summon: 'summon',
  discard: 'card_discard',
  conquer: 'battlefield_control',
  transform: 'transform',
  recover: 'heal'
};

const normalize = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const listify = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalize).filter(Boolean);
  }

  const normalized = normalize(value);
  if (!normalized) return [];

  return normalized
    .split(/[,/]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const parseCost = (raw, colors) => {
  const normalized = normalize(raw);
  const digits = normalized ? normalized.match(/\d+/g) : null;
  const energy = digits ? Number(digits.join('')) : null;
  const bracketMatches = normalized ? normalized.match(/\[[A-Za-z]+\]/g) : null;
  const explicitSymbols = bracketMatches
    ? bracketMatches
        .map((symbol) => symbol.replace(/\[|\]/g, '').trim())
        .filter(Boolean)
        .map((symbol) => symbol[0]?.toUpperCase())
    : [];
  return {
    energy: Number.isFinite(energy) ? energy : null,
    powerSymbols: explicitSymbols,
    raw: normalized || null,
    powerCost: null,
    powerType: null
  };
};

const parseQuantityToken = (token) => {
  if (!token) return null;
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

const buildWordNumberRegex = () => WORD_NUMBER_REGEX;

const OPERATION_QUANTITY_PATTERNS = {
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

const extractMagnitudeFromEffect = (effectText, operationType) => {
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

const ensureRulesCompliantEffect = (effect, rawType) => {
  const warnings = [];
  let text = (effect || '').trim();
  if (!text) {
    warnings.push('missing-effect-text');
    text = 'No effect text provided.';
  }
  const normalizedType = (rawType || '').toLowerCase();
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

const buildBehaviorHints = (effectText, warnings) => {
  const hints = {};
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

const shouldDefaultTapped = (rawType) => {
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

const deriveKeywords = (effect, baseKeywords) => {
  const keywordSet = new Set(baseKeywords.filter(Boolean));
  KEYWORD_PATTERNS.forEach(({ keyword, pattern }) => {
    if (pattern.test(effect)) {
      keywordSet.add(keyword);
    }
  });
  return Array.from(keywordSet);
};

const deriveClauses = (cardId, effect) => {
  if (!effect) return [];
  const clauses = effect
    .split(/(?:(?<=[.!?])\s+|\n+)/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  return clauses.map((text, index) => {
    const tags = [];
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

const stripRichText = (text = '') =>
  text ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

const clauseLooksTriggered = (text = '') => {
  const normalized = stripRichText(text).toLowerCase();
  return (
    /\bwhen\b/.test(normalized) ||
    /\bwhenever\b/.test(normalized) ||
    /\bafter\b/.test(normalized) ||
    /\bdeathknell\b/.test(normalized)
  );
};

const deriveImplicitAbilityKeyword = (text = '', sequence = 1) => {
  const normalized = stripRichText(text).toLowerCase();
  if (/when you play\b/.test(normalized) || /when i play\b/.test(normalized)) {
    return 'Play';
  }
  if (/when you hold\b/.test(normalized) || /when i hold\b/.test(normalized)) {
    return 'Hold';
  }
  if (/when you conquer\b/.test(normalized) || /when i conquer\b/.test(normalized)) {
    return 'Conquer';
  }
  if (/when you attack\b/.test(normalized) || /when i attack\b/.test(normalized)) {
    return 'Attack';
  }
  if (/when you defend\b/.test(normalized) || /when i defend\b/.test(normalized)) {
    return 'Defend';
  }
  if (/when you move\b/.test(normalized) || /when i move\b/.test(normalized)) {
    return 'Move';
  }
  if (/when you win a combat\b/.test(normalized) || /when i win a combat\b/.test(normalized)) {
    return 'Combat';
  }
  if (/when i die\b/.test(normalized) || /\bdeathknell\b/.test(normalized)) {
    return 'Death';
  }
  return `Triggered ${sequence}`;
};

const deriveBattlefieldAbilityKeyword = (clauseText = '') => {
  const normalized = stripRichText(clauseText).toLowerCase();
  if (/when you hold/.test(normalized)) {
    return 'Hold';
  }
  if (/when you conquer/.test(normalized)) {
    return 'Conquer';
  }
  if (/when you defend/.test(normalized)) {
    return 'Defend';
  }
  if (/at the start/.test(normalized)) {
    return 'Start';
  }
  if (/while you control/.test(normalized)) {
    return 'Control';
  }
  return 'Battlefield';
};

const inferAbilityTriggerFromText = (keyword = '', clauseText = '') => {
  const normalizedKeyword = (keyword || '').toLowerCase();
  if (SUPPORTED_KEYWORD_TRIGGERS[normalizedKeyword]) {
    return SUPPORTED_KEYWORD_TRIGGERS[normalizedKeyword];
  }
  const normalizedText = clauseText.toLowerCase();
  if (/\bwhen i die in combat\b/.test(normalizedText)) {
    return 'death_combat';
  }
  if (/\bwhen i die\b/.test(normalizedText) || /\bdeathknell\b/.test(normalizedText)) {
    return 'death';
  }
  if (/\bwhen i enter\b|\bwhen this enters\b|\bwhen you play\b/.test(normalizedText)) {
    return 'play';
  }
  if (/when i attack or defend one on one/.test(normalizedText)) {
    return 'duel';
  }
  if (/when i attack or defend/.test(normalizedText)) {
    return 'attack_defend';
  }
  if (/when i attack\b/.test(normalizedText)) {
    return 'attack';
  }
  if (/when i defend\b/.test(normalizedText)) {
    return 'defend';
  }
  if (/when i win a combat/.test(normalizedText)) {
    return 'combat_win';
  }
  if (/when i conquer after an attack/.test(normalizedText)) {
    return 'conquer_after_attack';
  }
  if (/when i conquer an open battlefield/.test(normalizedText)) {
    return 'conquer_open';
  }
  if (/when i conquer\b/.test(normalizedText)) {
    return 'conquer';
  }
  if (/when i hold\b/.test(normalizedText)) {
    return 'hold';
  }
  if (/when i move to [^.,;]+battlefield/.test(normalizedText)) {
    return 'move_to_battlefield';
  }
  if (/when i move from [^.,;]+battlefield/.test(normalizedText)) {
    return 'move_from_battlefield';
  }
  if (/\bwhen i move\b/.test(normalizedText)) {
    return 'move';
  }
  if (/\bwhen (?:a|any) unit moves from here\b/.test(normalizedText)) {
    return 'unit_move_from';
  }
  if (/\bwhile you control this battlefield\b/.test(normalizedText)) {
    return 'control';
  }
  if (/\bat the start of each player'?s first beginning phase\b/.test(normalizedText)) {
    return 'turn_start';
  }
  if (/\bat the start of each player'?s beginning phase\b/.test(normalizedText)) {
    return 'turn_start';
  }
  if (/\bincrease the points needed to win the game\b/.test(normalizedText)) {
    return 'setup';
  }
  if (/\byou may hide an additional card here\b/.test(normalizedText)) {
    return 'setup';
  }
  return undefined;
};

const enhanceAbilityOperationsFromText = (operations = [], description = '') => {
  const requiresExhausted = /\bexhausted\b/i.test(description);
  const normalized = description.toLowerCase();
  return operations.map((operation) => {
    if (operation.type === 'channel_rune' && requiresExhausted) {
      return {
        ...operation,
        metadata: {
          ...(operation.metadata ?? {}),
          enterTapped: true
        }
      };
    }
    if (operation.type === 'move_unit') {
      const metadata = {
        ...(operation.metadata ?? {})
      };
      if (/\bbase\b/i.test(normalized)) {
        Object.assign(metadata, { destination: 'base' });
      } else if (/\bbattlefield\b/i.test(normalized) || /\bhere\b/i.test(normalized)) {
        Object.assign(metadata, { destination: 'battlefield' });
      }
      if (Object.keys(metadata).length > 0) {
        return {
          ...operation,
          metadata
        };
      }
    }
    return { ...operation };
  });
};

const supplementOperationsFromText = (operations = [], description = '') => {
  const extras = [];
  const normalized = description.toLowerCase();
  if (
    !operations.some((operation) => operation.type === 'mill_cards') &&
    /put the top\s+(\d+)\s+cards?\s+of your (?:main\s+)?deck into your trash/.test(normalized)
  ) {
    const match = normalized.match(
      /put the top\s+(\d+)\s+cards?\s+of your (?:main\s+)?deck into your trash/
    );
    const count = match ? Math.max(1, parseInt(match[1], 10) || 1) : 1;
    extras.push({
      type: 'mill_cards',
      targetHint: 'self',
      automated: true,
      ruleRefs: ['400'],
      magnitudeHint: count,
      metadata: {
        count
      }
    });
  }
  if (extras.length === 0) {
    return operations;
  }
  return operations.concat(extras);
};

const buildCardAbilities = (record) => {
  const clauses = record.rules || [];
  if (!clauses.length) {
    return [];
  }
  const isBattlefield = (record.type || '').toLowerCase() === 'battlefield';
  const abilities = [];
  clauses.forEach((clause) => {
    const clauseText = clause.text || '';
    if (!clauseText) {
      return;
    }
    const match = clauseText.match(ABILITY_KEYWORD_PATTERN);
    let keyword = null;
    let rawBody = null;
    if (match) {
      keyword = (match.groups?.keyword || '').trim();
      rawBody = (match.groups?.body || '').trim();
    } else if (isBattlefield) {
      keyword = deriveBattlefieldAbilityKeyword(clauseText);
      rawBody = clauseText;
    } else if (clauseLooksTriggered(clauseText)) {
      keyword = deriveImplicitAbilityKeyword(clauseText, abilities.length + 1);
      rawBody = clauseText;
    }
    if (!rawBody) {
      return;
    }
    if (!keyword) {
      keyword = `Ability ${abilities.length + 1}`;
    }
    const description = stripRichText(rawBody);
    if (!description) {
      return;
    }
    const normalizedKeyword = keyword.toLowerCase();
    const supportedTrigger = SUPPORTED_KEYWORD_TRIGGERS[normalizedKeyword];
    const triggerType =
      supportedTrigger ?? inferAbilityTriggerFromText(keyword, description);
    if (!triggerType) {
      return;
    }
    const clauseActivation = buildActivation(description);
    const clauseProfile = buildEffectProfile(
      description,
      clauseActivation,
      parseTokenSpecs(description)
    );
    if (!clauseProfile.operations.length) {
      return;
    }
    let operations = enhanceAbilityOperationsFromText(clauseProfile.operations, description);
    operations = supplementOperationsFromText(operations, description);
    if (!operations.length) {
      return;
    }
    abilities.push({
      name: keyword,
      keyword,
      description,
      triggerType,
      timing: clauseActivation.timing,
      requiresTarget: clauseActivation.requiresTarget,
      triggerWindows: clauseActivation.triggers,
      reactionWindows: clauseActivation.reactionWindows,
      effectClasses: clauseProfile.classes,
      references: clauseProfile.references,
      priorityHint: clauseProfile.priority,
      targeting: clauseProfile.targeting,
      operations
    });
  });
  return abilities;
};

const deriveTriggers = (effect) => {
  const triggers = [];
  const triggerRegex = /\b(When|Whenever|After|Before|While|During)\b([^.;]+)/gi;
  let match = null;
  while ((match = triggerRegex.exec(effect)) !== null) {
    const [, keyword, clause] = match;
    triggers.push(`${keyword.trim()}${clause.trim()}`);
  }
  return triggers;
};

const deriveActions = (effect) => {
  const actions = new Set();
  ACTION_PATTERNS.forEach(({ label, pattern }) => {
    if (pattern.test(effect)) actions.add(label);
  });
  return Array.from(actions);
};

const deriveReactionWindows = (effect) => {
  const windows = [];
  if (/showdown/i.test(effect)) windows.push('showdown');
  if (/opponent'?s turn/i.test(effect)) windows.push('opponent-turn');
  if (/your turn/i.test(effect)) windows.push('your-turn');
  return windows;
};

const deriveTiming = (effect) => {
  if (/^ACTION\b/i.test(effect) || /\bACTION\b/i.test(effect)) return 'action';
  if (/^REACTION\b/i.test(effect) || /\bREACTION\b/i.test(effect)) return 'reaction';
  if (/\bWhen\b|\bWhenever\b/i.test(effect)) return 'triggered';
  return 'passive';
};

const buildActivation = (effect) => {
  const text = effect || '';
  // Check for targeting patterns - include 'up to X units' patterns
  const requiresTarget = TARGET_REGEX.test(text) || UP_TO_TARGET_REGEX.test(text);
  return {
    timing: deriveTiming(text),
    triggers: deriveTriggers(text),
    actions: deriveActions(text),
    requiresTarget,
    reactionWindows: deriveReactionWindows(text),
    stateful: /\bbuff\b|\bheal\b|\btransform\b|\bsummon\b/i.test(text)
  };
};

const detectTargetHint = (text) => {
  for (const { hint, pattern } of TARGET_HINT_PATTERNS) {
    if (pattern.test(text)) {
      return hint;
    }
  }
  return undefined;
};

const detectTargetMode = (text, requiresTarget) => {
  if (!requiresTarget) {
    return 'none';
  }
  if (MULTI_TARGET_REGEX.test(text)) {
    return 'multiple';
  }
  if (/\bglobal\b/i.test(text) || /\ball\b.*players\b/i.test(text)) {
    return 'global';
  }
  return 'single';
};

const detectPriority = (text, activation) => {
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

const matchEffectClasses = (text, activation) => {
  let matches = EFFECT_CLASS_DEFINITIONS.filter((definition) =>
    definition.patterns.some((pattern) => pattern.test(text))
  );
  const hasTokenMatch = matches.some((definition) => definition.id === 'token');
  if (hasTokenMatch) {
    matches = matches.filter((definition) => definition.id !== 'summon');
  }
  if (matches.length > 0) {
    return matches;
  }
  const inferred = activation.actions
    .map((action) => ACTION_CLASS_MAP[action])
    .filter(Boolean);
  if (inferred.length > 0) {
    return EFFECT_CLASS_DEFINITIONS.filter((definition) => inferred.includes(definition.id));
  }
  return [GENERIC_CLASS];
};

const buildEffectProfile = (effect, activation, tokenSpecs = []) => {
  const text = effect || '';
  const classes = matchEffectClasses(text, activation);
  let tokenCursor = 0;
  const operations = classes.map((definition) => {
    const operation = {
      ...definition.operation,
      ruleRefs: definition.ruleRefs
    };
    const magnitude = extractMagnitudeFromEffect(text, operation.type);
    if (magnitude !== null) {
      operation.magnitudeHint = magnitude;
    }
    if (
      (operation.type === 'create_token' || operation.type === 'summon_unit') &&
      tokenCursor < tokenSpecs.length
    ) {
      const tokenSpec = tokenSpecs[tokenCursor];
      tokenCursor += 1;
      operation.metadata = {
        ...(operation.metadata ?? {}),
        tokenSpec
      };
      if (operation.magnitudeHint == null && !tokenSpec.variableCount) {
        operation.magnitudeHint = tokenSpec.count;
      }
    }
    return operation;
  });
  const references = Array.from(new Set(classes.flatMap((definition) => definition.ruleRefs)));
  const targeting = {
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

const normalizeRawRecords = (raw) => {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && Array.isArray(raw.names) && Array.isArray(raw.data)) {
    return raw.data.map((row) => {
      const record = {};
      raw.names.forEach((field, index) => {
        record[field] = row[index] ?? null;
      });
      return record;
    });
  }
  throw new Error('Unsupported champion dump format');
};

const reshapeDump = (raw) => {
  const records = normalizeRawRecords(raw);
  return records.map((record) => {
    const id = normalize(record.id);
    const slug = normalize(record.slug) || id;
    const effect = normalize(record.effect);
    const { text: normalizedEffect, warnings } = ensureRulesCompliantEffect(effect, record.type);
    const colors = listify(record.color);
    const tags = listify(record.tags);
    const keywords = deriveKeywords(normalizedEffect, [...colors, ...tags]);
    const rules = deriveClauses(id, normalizedEffect);
    const activation = buildActivation(normalizedEffect);
    const tokenSpecs = parseTokenSpecs(normalizedEffect);
    const effectProfile = buildEffectProfile(normalizedEffect, activation, tokenSpecs);
    const behaviorHints = buildBehaviorHints(normalizedEffect, warnings);
    if (shouldDefaultTapped(record.type) && !behaviorHints.entersUntapped) {
      behaviorHints.entersTapped = true;
    }
    const cardRecord = {
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
      activation,
      effectProfile,
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
        source: CHAMPION_DUMP_URL
      }
    };

    if (Object.keys(behaviorHints).length > 0) {
      cardRecord.behaviorHints = behaviorHints;
    }
    const abilities = buildCardAbilities(cardRecord);
    if (abilities.length > 0) {
      cardRecord.abilities = abilities;
    }

    return cardRecord;
  });
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const fetchChampionDump = async () => {
  console.log(`Fetching champion data from ${CHAMPION_DUMP_URL}...`);
  const response = await fetch(CHAMPION_DUMP_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch champion data (${response.status} ${response.statusText}). Check ${CHAMPION_DUMP_URL}.`
    );
  }
  return response.json();
};

/**
 * Apply card-specific fixes to correct parsing errors or semantic issues
 */
const applyCardSpecificFixes = (cards) => {
  return cards.map((card) => {
    // Fix Traveling Merchant (OGN-185): discard should target self, not enemy
    // and remove the move_unit operation that causes duplicate effects
    if (card.id === 'OGN-185') {
      if (card.effectProfile?.operations) {
        const discard = card.effectProfile.operations.find((op) => op.type === 'discard_cards');
        if (discard && discard.targetHint === 'enemy') {
          discard.targetHint = 'self';
        }
        
        // Remove move_unit operation if it exists (it's incorrectly added and causes double-triggering)
        card.effectProfile.operations = card.effectProfile.operations.filter(
          (op) => op.type !== 'move_unit'
        );
      }
      
      // Apply same fixes to abilities if they exist
      if (card.abilities?.[0]?.operations) {
        const discard = card.abilities[0].operations.find((op) => op.type === 'discard_cards');
        if (discard && discard.targetHint === 'enemy') {
          discard.targetHint = 'self';
        }
        
        card.abilities[0].operations = card.abilities[0].operations.filter(
          (op) => op.type !== 'move_unit'
        );
      }
    }
    
    return card;
  });
};

const main = async () => {
  const rawDump = await fetchChampionDump();
  let cards = reshapeDump(rawDump);
  cards = applyCardSpecificFixes(cards);
  const manifest = cards.map((card) => ({
    id: card.id,
    name: card.name,
    remote: card.assets.remote,
    localPath: card.assets.localPath
  }));

  ensureDir(DATA_DIR);
  fs.writeFileSync(
    ENRICHED_OUTPUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalCards: cards.length,
        cards
      },
      null,
      2
    ),
    'utf-8'
  );
  fs.writeFileSync(IMAGE_MANIFEST_OUTPUT, JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`Wrote ${cards.length} cards to ${ENRICHED_OUTPUT}`);
  console.log(`Wrote ${manifest.length} image entries to ${IMAGE_MANIFEST_OUTPUT}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
