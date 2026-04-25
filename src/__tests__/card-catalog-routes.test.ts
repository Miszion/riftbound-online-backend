/**
 * REST /api/cards endpoint - unit tests.
 *
 * Mocks `getCardCatalog` to return a deterministic 12-card fixture so we can
 * assert filtering, sorting, and cursor-based pagination contracts without
 * relying on the regenerated catalog file on disk.
 */

jest.mock('dotenv/config', () => ({}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../card-catalog', () => ({
  __esModule: true,
  getCardCatalog: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { cardCatalogRouter } from '../card-catalog-routes';
import { getCardCatalog, type EnrichedCardRecord } from '../card-catalog';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cards', cardCatalogRouter);
  return app;
};

const mockGetCardCatalog = getCardCatalog as jest.MockedFunction<typeof getCardCatalog>;

const makeCard = (overrides: Partial<EnrichedCardRecord>): EnrichedCardRecord => {
  const id = overrides.id ?? 'card-x';
  return {
    id,
    slug: overrides.slug ?? id,
    name: overrides.name ?? 'Card X',
    type: overrides.type ?? 'Unit',
    rarity: overrides.rarity ?? 'Common',
    setName: overrides.setName ?? 'OGN',
    colors: overrides.colors ?? ['fury'],
    cost: overrides.cost ?? { energy: 1, powerSymbols: [], raw: '1', powerCost: 0, powerType: '' },
    might: overrides.might ?? 1,
    tags: overrides.tags ?? [],
    effect: overrides.effect ?? '',
    flavor: overrides.flavor ?? null,
    keywords: overrides.keywords ?? [],
    effectProfile: overrides.effectProfile ?? ({ operations: [] } as any),
    activation: overrides.activation ?? ({ timing: 'static', triggers: [], actions: [], requiresTarget: false, reactionWindows: [], stateful: false } as any),
    rules: overrides.rules ?? [],
    assets: overrides.assets ?? { remote: null, localPath: `images/${id}.png` },
    pricing: overrides.pricing ?? { price: null, foilPrice: null, currency: 'USD' },
    references: overrides.references ?? { marketUrl: null, source: 'local' },
    timingTags: overrides.timingTags ?? [],
    isRuneResource: overrides.isRuneResource ?? false,
  } as EnrichedCardRecord;
};

const makeCatalog = (): EnrichedCardRecord[] => [
  makeCard({ id: 'a', name: 'Aurelion Spark', type: 'Unit',     rarity: 'Common',    colors: ['fury'],  cost: { energy: 1, powerSymbols: [], raw: '1', powerCost: 0, powerType: '' }, effect: 'deals 1 damage', keywords: ['Action'], tags: ['burn'] }),
  makeCard({ id: 'b', name: 'Brave Vanguard', type: 'Unit',     rarity: 'Uncommon',  colors: ['order'], cost: { energy: 2, powerSymbols: [], raw: '2', powerCost: 0, powerType: '' }, effect: 'rallies allies', keywords: ['Reaction'], tags: ['support'] }),
  makeCard({ id: 'c', name: 'Crystal Spire',  type: 'Battlefield', rarity: 'Rare',   colors: ['mind'],  cost: { energy: 3, powerSymbols: [], raw: '3', powerCost: 0, powerType: '' }, effect: 'channels arcana', keywords: [], tags: ['arcana'] }),
  makeCard({ id: 'd', name: 'Dread Sentinel', type: 'Unit',     rarity: 'Epic',      colors: ['body'],  cost: { energy: 4, powerSymbols: [], raw: '4', powerCost: 0, powerType: '' }, effect: 'guards the gate', keywords: ['Action'], tags: ['guardian'] }),
  makeCard({ id: 'e', name: 'Ember Veil',     type: 'Spell',    rarity: 'Common',    colors: ['fury'],  cost: { energy: 1, powerSymbols: [], raw: '1', powerCost: 0, powerType: '' }, effect: 'cloaks in flame', keywords: [], tags: ['stealth'] }),
  makeCard({ id: 'f', name: 'Frozen Tide',    type: 'Spell',    rarity: 'Legendary', colors: ['mind'],  cost: { energy: 5, powerSymbols: [], raw: '5', powerCost: 0, powerType: '' }, effect: 'instant freeze', keywords: ['Reaction'], tags: ['control'] }),
  makeCard({ id: 'g', name: 'Glacial Bolt',   type: 'Spell',    rarity: 'Uncommon',  colors: ['mind'],  cost: { energy: 2, powerSymbols: [], raw: '2', powerCost: 0, powerType: '' }, effect: 'freezes target', keywords: [], tags: ['control'] }),
  makeCard({ id: 'h', name: 'Halo Bearer',    type: 'Champion', rarity: 'Mythic',    colors: ['order', 'calm'], cost: { energy: 6, powerSymbols: [], raw: '6', powerCost: 0, powerType: '' }, effect: 'protects all', keywords: ['Action'], tags: ['protection'] }),
  makeCard({ id: 'i', name: 'Iron Champion',  type: 'Champion', rarity: 'Rare',      colors: ['order'], cost: { energy: 4, powerSymbols: [], raw: '4', powerCost: 0, powerType: '' }, effect: 'leads charge', keywords: [], tags: ['leader'] }),
  makeCard({ id: 'j', name: 'Jagged Maw',     type: 'Unit',     rarity: 'Common',    colors: ['chaos'], cost: { energy: 2, powerSymbols: [], raw: '2', powerCost: 0, powerType: '' }, effect: 'bites foes',     keywords: [], tags: ['beast'] }),
  makeCard({ id: 'k', name: 'Kindled Ember',  type: 'Rune',     rarity: 'Common',    colors: ['fury'],  cost: { energy: null as any, powerSymbols: [], raw: null as any, powerCost: 0, powerType: '' }, effect: '', keywords: [], tags: ['rune'] }),
  makeCard({ id: 'l', name: 'Lurking Shade',  type: 'Unit',     rarity: 'Uncommon',  colors: ['chaos'], cost: { energy: 3, powerSymbols: [], raw: '3', powerCost: 0, powerType: '' }, effect: 'ambushes target', keywords: ['Action'], tags: ['stealth', 'ambush'] }),
];

describe('GET /api/cards', () => {
  let app: express.Express;

  beforeEach(() => {
    mockGetCardCatalog.mockReturnValue(makeCatalog());
    app = buildApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Defaults + pagination
  // -------------------------------------------------------------------------
  it('returns the default page with full catalog metadata', async () => {
    const res = await request(app).get('/api/cards').query({ limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.pageInfo.total).toBe(12);
    expect(res.body.pageInfo.hasMore).toBe(true);
    expect(typeof res.body.pageInfo.nextCursor).toBe('string');

    const first = res.body.items[0];
    // Required + full set per CatalogCardDTO contract
    for (const key of [
      'id', 'slug', 'name', 'type', 'rarity', 'setName', 'colors',
      'cost', 'might', 'tags', 'effect', 'flavor', 'keywords',
      'activation', 'rules', 'assets', 'pricing', 'references'
    ]) {
      expect(first).toHaveProperty(key);
    }
    expect(first.cost).toHaveProperty('energy');
    expect(first.cost).toHaveProperty('powerSymbols');
    expect(first.cost).toHaveProperty('raw');
    expect(first.activation).toHaveProperty('timing');
    expect(first.activation).toHaveProperty('stateful');
    expect(first.assets).toHaveProperty('remote');
    expect(first.assets).toHaveProperty('localPath');
  });

  it('paginates via opaque cursor and ends with nextCursor=null', async () => {
    const limit = 5;
    const collected: string[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    let pages = 0;

    while (hasMore && pages < 10) {
      pages += 1;
      const query: Record<string, string | number> = { limit, sort: 'name' };
      if (cursor) query.cursor = cursor;
      const res = await request(app).get('/api/cards').query(query);
      expect(res.status).toBe(200);
      for (const item of res.body.items) {
        collected.push(item.id);
      }
      hasMore = res.body.pageInfo.hasMore;
      cursor = res.body.pageInfo.nextCursor;
    }

    expect(pages).toBe(3); // 12 / 5 = 3 pages
    expect(collected).toHaveLength(12);
    expect(new Set(collected).size).toBe(12);
    expect(cursor).toBeNull();
  });

  it('returns empty items when catalog is exhausted past the end', async () => {
    const lastCursor = Buffer.from(JSON.stringify({ offset: 12 }), 'utf8').toString('base64');
    const res = await request(app).get('/api/cards').query({ cursor: lastCursor });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.pageInfo.hasMore).toBe(false);
    expect(res.body.pageInfo.nextCursor).toBeNull();
    expect(res.body.pageInfo.total).toBe(12);
  });

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------
  it('filters by domain (color match, lowercased)', async () => {
    const res = await request(app).get('/api/cards').query({ domain: 'fury' });
    expect(res.status).toBe(200);
    expect(res.body.items.every((c: any) => c.colors.includes('fury'))).toBe(true);
    expect(res.body.items.length).toBe(3);
  });

  it('filters by type (case-insensitive)', async () => {
    const res = await request(app).get('/api/cards').query({ type: 'spell' });
    expect(res.status).toBe(200);
    expect(res.body.items.every((c: any) => c.type === 'Spell')).toBe(true);
    expect(res.body.items.length).toBe(3);
  });

  it('filters by rarity (case-insensitive)', async () => {
    const res = await request(app).get('/api/cards').query({ rarity: 'COMMON' });
    expect(res.status).toBe(200);
    expect(res.body.items.every((c: any) => c.rarity === 'Common')).toBe(true);
    expect(res.body.items.length).toBe(4);
  });

  it('combines filters (domain + type)', async () => {
    const res = await request(app).get('/api/cards').query({ domain: 'mind', type: 'spell' });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    expect(res.body.items.every((c: any) => c.type === 'Spell' && c.colors.includes('mind'))).toBe(true);
  });

  it('q matches case-insensitively across name/effect/keywords/tags', async () => {
    // name match
    const byName = await request(app).get('/api/cards').query({ q: 'AURELION' });
    expect(byName.body.items.map((c: any) => c.id)).toContain('a');

    // effect match
    const byEffect = await request(app).get('/api/cards').query({ q: 'freeze' });
    expect(byEffect.body.items.map((c: any) => c.id).sort()).toEqual(['f', 'g']);

    // keyword match
    const byKeyword = await request(app).get('/api/cards').query({ q: 'reaction' });
    const ids = byKeyword.body.items.map((c: any) => c.id);
    expect(ids).toContain('b');
    expect(ids).toContain('f');

    // tag match
    const byTag = await request(app).get('/api/cards').query({ q: 'stealth' });
    const tagIds = byTag.body.items.map((c: any) => c.id).sort();
    expect(tagIds).toEqual(['e', 'l']);
  });

  it('returns 200 with empty items when valid filters match nothing', async () => {
    const res = await request(app).get('/api/cards').query({ domain: 'fury', type: 'rune', rarity: 'mythic' });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.pageInfo.total).toBe(0);
    expect(res.body.pageInfo.hasMore).toBe(false);
    expect(res.body.pageInfo.nextCursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------
  it('sort=cost order=desc produces non-increasing energy cost', async () => {
    const res = await request(app).get('/api/cards').query({ sort: 'cost', order: 'desc', limit: 200 });
    expect(res.status).toBe(200);
    const energies = res.body.items.map((c: any) => c.cost.energy ?? 0);
    for (let i = 1; i < energies.length; i += 1) {
      expect(energies[i]).toBeLessThanOrEqual(energies[i - 1]);
    }
  });

  it('sort=name asc returns alphabetically sorted', async () => {
    const res = await request(app).get('/api/cards').query({ sort: 'name', order: 'asc', limit: 200 });
    expect(res.status).toBe(200);
    const names = res.body.items.map((c: any) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('sort=rarity asc respects fixed rank Common < Uncommon < Rare < Epic < Legendary < Mythic', async () => {
    const rank: Record<string, number> = {
      Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4, Mythic: 5,
    };
    const res = await request(app).get('/api/cards').query({ sort: 'rarity', order: 'asc', limit: 200 });
    expect(res.status).toBe(200);
    const ranks = res.body.items.map((c: any) => rank[c.rarity] ?? Number.MAX_SAFE_INTEGER);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
  });

  // -------------------------------------------------------------------------
  // 400 error contract
  // -------------------------------------------------------------------------
  it('returns 400 when cursor is malformed base64 garbage', async () => {
    const res = await request(app).get('/api/cards').query({ cursor: 'not!!!base64@@@' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('returns 400 when cursor decodes to invalid JSON', async () => {
    const bad = Buffer.from('{not-json', 'utf8').toString('base64');
    const res = await request(app).get('/api/cards').query({ cursor: bad });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('returns 400 when cursor JSON lacks numeric offset', async () => {
    const bad = Buffer.from(JSON.stringify({ offset: 'abc' }), 'utf8').toString('base64');
    const res = await request(app).get('/api/cards').query({ cursor: bad });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('returns 400 when cursor exceeds 1024 byte cap', async () => {
    const oversized = 'A'.repeat(1025);
    const res = await request(app).get('/api/cards').query({ cursor: oversized });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('returns 400 when limit exceeds 200', async () => {
    const res = await request(app).get('/api/cards').query({ limit: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it('returns 400 when limit is non-numeric', async () => {
    const res = await request(app).get('/api/cards').query({ limit: 'foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it('returns 400 when sort is unknown', async () => {
    const res = await request(app).get('/api/cards').query({ sort: 'foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sort/i);
  });

  it('returns 400 when order is unknown', async () => {
    const res = await request(app).get('/api/cards').query({ order: 'sideways' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/order/i);
  });
});
