'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const RAW_INPUT = path.join(ROOT, 'champion-dump.json');
const DATA_DIR = path.join(ROOT, 'data');
const ENRICHED_OUTPUT = path.join(DATA_DIR, 'cards.enriched.json');
const IMAGE_MANIFEST_OUTPUT = path.join(DATA_DIR, 'card-images.json');

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

const parseCost = (raw) => {
  const normalized = normalize(raw);
  if (!normalized) return { energy: null, powerSymbols: [], raw: null };

  const digits = normalized.match(/\d+/g);
  const energy = digits ? Number(digits.join('')) : null;
  const powerSymbols = Array.from(
    new Set((normalized.match(/\[[A-Z]\]/g) || []).map((symbol) => symbol.replace(/\[|\]/g, '')))
  );

  return {
    energy: Number.isFinite(energy) ? energy : null,
    powerSymbols,
    raw: normalized
  };
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
  return {
    timing: deriveTiming(text),
    triggers: deriveTriggers(text),
    actions: deriveActions(text),
    requiresTarget: TARGET_REGEX.test(text),
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
  const matches = EFFECT_CLASS_DEFINITIONS.filter((definition) =>
    definition.patterns.some((pattern) => pattern.test(text))
  );
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

const buildEffectProfile = (effect, activation) => {
  const text = effect || '';
  const classes = matchEffectClasses(text, activation);
  const operations = classes.map((definition) => ({
    ...definition.operation,
    ruleRefs: definition.ruleRefs
  }));
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

const reshapeDump = (raw) => {
  return raw.data.map((row) => {
    const record = {};
    raw.names.forEach((field, index) => {
      record[field] = row[index] ?? null;
    });

    const id = normalize(record.id);
    const slug = normalize(record.slug) || id;
    const effect = normalize(record.effect);
    const colors = listify(record.color);
    const tags = listify(record.tags);
    const keywords = deriveKeywords(effect, [...colors, ...tags]);
    const rules = deriveClauses(id, effect);
    const activation = buildActivation(effect);
    const effectProfile = buildEffectProfile(effect, activation);

    return {
      id,
      slug,
      name: normalize(record.name),
      type: normalize(record.type) || null,
      rarity: normalize(record.rarity) || null,
      setName: normalize(record.set_name) || null,
      colors,
      cost: parseCost(record.cost),
      might: toNumber(record.might),
      tags,
      effect,
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
        source: 'champion-dump.json'
      }
    };
  });
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const main = () => {
  if (!fs.existsSync(RAW_INPUT)) {
    throw new Error(`Cannot find champion dump at ${RAW_INPUT}`);
  }

  const rawDump = JSON.parse(fs.readFileSync(RAW_INPUT, 'utf-8'));
  const cards = reshapeDump(rawDump);
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

main();
