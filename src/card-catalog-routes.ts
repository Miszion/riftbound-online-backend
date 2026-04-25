/**
 * REST endpoint backing the deckbuilder catalog browser. Replaces the
 * previous `cardCatalog` GraphQL query, which the frontend used to bulk
 * download into an in-memory cache. Match, replay, and spectate payloads
 * already inline a per-card snapshot via `serializeCardSnapshot`, so this
 * route is the only path that still serves the raw catalog shape.
 *
 * Mounted at `/api/cards`. The catalog is already in-memory via
 * `getCardCatalog()`, so filtering, sorting, and pagination are pure
 * synchronous slices over that array.
 */
import express, { Request, Response, Router } from 'express';
import logger from './logger';
import { getCardCatalog, type EnrichedCardRecord } from './card-catalog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

const VALID_SORTS = new Set(['name', 'cost', 'rarity']);
const VALID_ORDERS = new Set(['asc', 'desc']);

// Fixed rank for `sort=rarity`. Unknown rarities sort to the end.
const RARITY_RANK: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  mythic: 5
};
const RARITY_UNKNOWN_RANK = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Cursor codec
// ---------------------------------------------------------------------------

interface CursorPayload {
  offset: number;
}

const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');

const decodeCursor = (raw: string): CursorPayload => {
  if (Buffer.byteLength(raw) > 1024) {
    throw new HttpError(400, 'Invalid cursor');
  }
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new HttpError(400, 'Invalid cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new HttpError(400, 'Invalid cursor');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { offset?: unknown }).offset !== 'number' ||
    !Number.isInteger((parsed as { offset: number }).offset) ||
    (parsed as { offset: number }).offset < 0
  ) {
    throw new HttpError(400, 'Invalid cursor');
  }
  return { offset: (parsed as { offset: number }).offset };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

interface ParsedQuery {
  domain: string | null;
  type: string | null;
  rarity: string | null;
  q: string | null;
  sort: 'name' | 'cost' | 'rarity';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const readScalar = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const parseLimit = (raw: unknown): number => {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_LIMIT;
  }
  const value = typeof raw === 'string' ? raw : String(raw);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new HttpError(400, 'Invalid limit');
  }
  if (parsed > MAX_LIMIT) {
    throw new HttpError(400, `limit exceeds maximum of ${MAX_LIMIT}`);
  }
  return parsed;
};

const parseQuery = (req: Request): ParsedQuery => {
  const domain = readScalar(req.query.domain)?.toLowerCase() ?? null;
  const type = readScalar(req.query.type);
  const rarity = readScalar(req.query.rarity);
  const q = readScalar(req.query.q);

  const sortRaw = readScalar(req.query.sort) ?? 'name';
  if (!VALID_SORTS.has(sortRaw)) {
    throw new HttpError(400, `Invalid sort: ${sortRaw}`);
  }

  const orderRaw = readScalar(req.query.order) ?? 'asc';
  if (!VALID_ORDERS.has(orderRaw)) {
    throw new HttpError(400, `Invalid order: ${orderRaw}`);
  }

  const limit = parseLimit(req.query.limit);

  let offset = 0;
  const cursor = readScalar(req.query.cursor);
  if (cursor) {
    offset = decodeCursor(cursor).offset;
  }

  return {
    domain,
    type,
    rarity,
    q,
    sort: sortRaw as 'name' | 'cost' | 'rarity',
    order: orderRaw as 'asc' | 'desc',
    limit,
    offset
  };
};

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const matchesDomain = (card: EnrichedCardRecord, domain: string): boolean =>
  card.colors.some((color) => color.toLowerCase() === domain);

const matchesType = (card: EnrichedCardRecord, type: string): boolean =>
  (card.type ?? '').toLowerCase() === type.toLowerCase();

const matchesRarity = (card: EnrichedCardRecord, rarity: string): boolean =>
  (card.rarity ?? '').toLowerCase() === rarity.toLowerCase();

const matchesSearch = (card: EnrichedCardRecord, term: string): boolean => {
  const needle = term.toLowerCase();
  if (card.name.toLowerCase().includes(needle)) return true;
  if (card.effect.toLowerCase().includes(needle)) return true;
  if (card.keywords.some((keyword) => keyword.toLowerCase().includes(needle))) return true;
  if (card.tags.some((tag) => tag.toLowerCase().includes(needle))) return true;
  return false;
};

const applyFilters = (cards: EnrichedCardRecord[], query: ParsedQuery): EnrichedCardRecord[] => {
  let filtered = cards;
  if (query.domain) {
    filtered = filtered.filter((card) => matchesDomain(card, query.domain as string));
  }
  if (query.type) {
    filtered = filtered.filter((card) => matchesType(card, query.type as string));
  }
  if (query.rarity) {
    filtered = filtered.filter((card) => matchesRarity(card, query.rarity as string));
  }
  if (query.q) {
    filtered = filtered.filter((card) => matchesSearch(card, query.q as string));
  }
  return filtered;
};

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const compareName = (a: EnrichedCardRecord, b: EnrichedCardRecord): number =>
  a.name.localeCompare(b.name);

const compareCost = (a: EnrichedCardRecord, b: EnrichedCardRecord): number => {
  const ca = a.cost?.energy ?? 0;
  const cb = b.cost?.energy ?? 0;
  return ca - cb;
};

const compareRarity = (a: EnrichedCardRecord, b: EnrichedCardRecord): number => {
  const ra = a.rarity ? RARITY_RANK[a.rarity.toLowerCase()] ?? RARITY_UNKNOWN_RANK : RARITY_UNKNOWN_RANK;
  const rb = b.rarity ? RARITY_RANK[b.rarity.toLowerCase()] ?? RARITY_UNKNOWN_RANK : RARITY_UNKNOWN_RANK;
  return ra - rb;
};

const PRIMARY_COMPARATORS: Record<ParsedQuery['sort'], (a: EnrichedCardRecord, b: EnrichedCardRecord) => number> = {
  name: compareName,
  cost: compareCost,
  rarity: compareRarity
};

const applySort = (cards: EnrichedCardRecord[], query: ParsedQuery): EnrichedCardRecord[] => {
  const primary = PRIMARY_COMPARATORS[query.sort];
  const direction = query.order === 'desc' ? -1 : 1;
  // Stable secondary sort by id so cursor pagination is deterministic.
  return [...cards].sort((a, b) => {
    const cmp = primary(a, b);
    if (cmp !== 0) return cmp * direction;
    return a.id.localeCompare(b.id);
  });
};

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

interface CatalogCardDTO {
  id: string;
  slug: string;
  name: string;
  type: string | null;
  rarity: string | null;
  setName: string | null;
  colors: string[];
  cost: {
    energy: number | null;
    powerSymbols: string[];
    raw: string | null;
  };
  might: number | null;
  tags: string[];
  effect: string;
  flavor: string | null;
  keywords: string[];
  activation: {
    timing: string;
    stateful: boolean;
  };
  rules: EnrichedCardRecord['rules'];
  assets: {
    remote: string | null;
    localPath: string;
  };
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

const toDTO = (card: EnrichedCardRecord): CatalogCardDTO => ({
  id: card.id,
  slug: card.slug,
  name: card.name,
  type: card.type,
  rarity: card.rarity,
  setName: card.setName,
  colors: card.colors,
  cost: {
    energy: card.cost?.energy ?? null,
    powerSymbols: card.cost?.powerSymbols ?? [],
    raw: card.cost?.raw ?? null
  },
  might: card.might,
  tags: card.tags,
  effect: card.effect,
  flavor: card.flavor,
  keywords: card.keywords,
  activation: {
    timing: card.activation.timing,
    stateful: card.activation.stateful
  },
  rules: card.rules,
  assets: {
    remote: card.assets.remote,
    localPath: card.assets.localPath
  },
  pricing: {
    price: card.pricing.price,
    foilPrice: card.pricing.foilPrice,
    currency: card.pricing.currency
  },
  references: {
    marketUrl: card.references.marketUrl,
    source: card.references.source
  }
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const cardCatalogRouter: Router = express.Router();

cardCatalogRouter.get('/', (req: Request, res: Response): void => {
  let query: ParsedQuery;
  try {
    query = parseQuery(req);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error('[CARDS] unexpected error parsing query', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  try {
    const catalog = getCardCatalog();
    const filtered = applyFilters(catalog, query);
    const sorted = applySort(filtered, query);
    const total = sorted.length;
    const start = Math.min(query.offset, total);
    const end = Math.min(start + query.limit, total);
    const slice = sorted.slice(start, end);
    const hasMore = end < total;
    const nextCursor = hasMore ? encodeCursor(end) : null;

    res.status(200).json({
      items: slice.map(toDTO),
      pageInfo: {
        nextCursor,
        total,
        hasMore
      }
    });
  } catch (err) {
    logger.error('[CARDS] error serving catalog', { error: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default cardCatalogRouter;
