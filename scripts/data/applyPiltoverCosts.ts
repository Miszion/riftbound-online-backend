import fs from 'node:fs';
import path from 'node:path';
import type { EnrichedCardRecord } from '../../src/card-catalog';

type CardCatalogFile = {
  generatedAt?: string;
  totalCards?: number;
  cards: EnrichedCardRecord[];
};

type PiltoverCard = {
  collector_string: string | null;
  power_cost: number | null;
  power_type: string | null;
  energy_cost: number | null;
};

const ROOT = path.resolve(__dirname, '..', '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'cards.enriched.json');
const PILTOVER_PATH = path.join(ROOT, 'data', 'piltover-archive.json');

const POWER_SYMBOL_BY_TYPE: Record<string, string> = {
  fury: 'R',
  calm: 'G',
  mind: 'B',
  body: 'O',
  chaos: 'P',
  order: 'Y'
};

const readJson = <T>(filePath: string): T => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Unable to find ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
};

const normalizeId = (value: string | null | undefined): string | null => {
  if (!value) return null;
  return value.trim().toUpperCase();
};

const loadPiltoverMap = (): Map<string, PiltoverCard> => {
  const entries = readJson<PiltoverCard[]>(PILTOVER_PATH);
  const map = new Map<string, PiltoverCard>();
  entries.forEach((entry) => {
    const key = normalizeId(entry.collector_string);
    if (key) {
      map.set(key, entry);
    }
  });
  return map;
};

const normalizePowerType = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const sanitizePowerCost = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.round(value));
  return normalized > 0 ? normalized : null;
};

const buildPowerSymbols = (powerCost: number, powerType: string | null): string[] | null => {
  if (!powerType) {
    return null;
  }
  const resolvedSymbol = POWER_SYMBOL_BY_TYPE[powerType];
  if (!resolvedSymbol) {
    return null;
  }
  if (powerCost <= 0) {
    return null;
  }
  return Array.from({ length: powerCost }, () => resolvedSymbol);
};

const symbolsMatch = (current: string[] | undefined, candidate: string[]): boolean => {
  if (!current) {
    return candidate.length === 0;
  }
  if (current.length !== candidate.length) {
    return false;
  }
  return current.every((symbol, index) => symbol === candidate[index]);
};

const deriveLookupKeys = (card: EnrichedCardRecord): string[] => {
  const keys = new Set<string>();
  const push = (value?: string | null) => {
    const normalized = normalizeId(value);
    if (normalized) {
      keys.add(normalized);
    }
  };
  push(card.id);
  push(card.slug);

  Array.from(keys).forEach((key) => {
    const match = key.match(/^([A-Z]+-\d+)(?:-[A-Z0-9]+)?$/);
    if (match && match[1]) {
      keys.add(match[1]);
    }
  });

  return Array.from(keys);
};

const applyPiltoverCosts = () => {
  const catalog = readJson<CardCatalogFile>(CATALOG_PATH);
  const piltoverMap = loadPiltoverMap();
  let updatedCount = 0;

  catalog.cards = catalog.cards.map((card) => {
    const lookupKeys = deriveLookupKeys(card);
    const piltoverCard = lookupKeys.map((key) => piltoverMap.get(key)).find((entry) => Boolean(entry));

    if (!piltoverCard) {
      return card;
    }

    const sanitizedPowerCost = sanitizePowerCost(piltoverCard.power_cost);
    const hasPowerCost = typeof sanitizedPowerCost === 'number' && sanitizedPowerCost > 0;
    const normalizedPowerType = normalizePowerType(piltoverCard.power_type);
    const resolvedPowerSymbols = hasPowerCost && sanitizedPowerCost
      ? buildPowerSymbols(sanitizedPowerCost, normalizedPowerType)
      : null;
    const energyCost =
      typeof piltoverCard.energy_cost === 'number' && Number.isFinite(piltoverCard.energy_cost)
        ? piltoverCard.energy_cost
        : null;

    if (!card.cost) {
      card.cost = {
        energy: energyCost,
        powerSymbols: resolvedPowerSymbols ?? [],
        raw: null,
        powerCost: hasPowerCost ? sanitizedPowerCost : null,
        powerType: hasPowerCost ? normalizedPowerType : null
      };
      updatedCount += 1;
      return card;
    }

    card.cost.powerSymbols = card.cost.powerSymbols ?? [];

    let changed = false;
    if (energyCost !== null && card.cost.energy !== energyCost) {
      card.cost.energy = energyCost;
      changed = true;
    }
    if (hasPowerCost) {
      if (card.cost.powerCost !== sanitizedPowerCost) {
        card.cost.powerCost = sanitizedPowerCost;
        changed = true;
      }
      if (normalizedPowerType !== (card.cost.powerType ?? null)) {
        card.cost.powerType = normalizedPowerType;
        changed = true;
      }
      if (resolvedPowerSymbols && !symbolsMatch(card.cost.powerSymbols, resolvedPowerSymbols)) {
        card.cost.powerSymbols = resolvedPowerSymbols;
        changed = true;
      }
    } else {
      if (card.cost.powerCost !== null) {
        card.cost.powerCost = null;
        changed = true;
      }
      if (card.cost.powerType) {
        card.cost.powerType = null;
        changed = true;
      }
      if (card.cost.powerSymbols.length > 0) {
        card.cost.powerSymbols = [];
        changed = true;
      }
    }

    if (changed) {
      updatedCount += 1;
    }

    return card;
  });

  catalog.generatedAt = new Date().toISOString();

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  console.log(`Updated ${updatedCount} cards with Piltover cost data.`);
};

applyPiltoverCosts();
