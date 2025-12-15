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
