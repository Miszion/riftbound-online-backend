import fs from 'node:fs';
import path from 'node:path';

export interface CardCostProfile {
  energy: number | null;
  powerSymbols: string[];
  raw: string | null;
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
}

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

type RawDumpValue = string | number | string[] | null;

interface RawDump {
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
const ENRICHED_DATA_PATH = path.resolve(process.cwd(), 'data', 'cards.enriched.json');
const RAW_DUMP_PATH = path.resolve(process.cwd(), 'champion-dump.json');

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

const parseCost = (raw: unknown): CardCostProfile => {
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

const reshapeDump = (raw: RawDump): EnrichedCardRecord[] => {
  return raw.data.map((row) => {
    const record: Record<string, RawDumpValue> = {};
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

let cachedCards: EnrichedCardRecord[] | null = null;

const loadFromEnrichedFile = (): EnrichedCardRecord[] | null => {
  if (!fs.existsSync(ENRICHED_DATA_PATH)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      fs.readFileSync(ENRICHED_DATA_PATH, 'utf-8')
    ) as { cards: EnrichedCardRecord[] };
    if (payload && Array.isArray(payload.cards)) {
      return payload.cards;
    }
  } catch {
    // Ignore parse failure and fall back
  }
  return null;
};

const loadFromChampionDump = (): EnrichedCardRecord[] => {
  if (!fs.existsSync(RAW_DUMP_PATH)) {
    throw new Error(`Unable to locate champion dump at ${RAW_DUMP_PATH}`);
  }
  const rawDump = JSON.parse(fs.readFileSync(RAW_DUMP_PATH, 'utf-8')) as RawDump;
  return reshapeDump(rawDump);
};

const getCachedCatalog = (): EnrichedCardRecord[] => {
  if (!cachedCards) {
    cachedCards = loadFromEnrichedFile() ?? loadFromChampionDump();
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
