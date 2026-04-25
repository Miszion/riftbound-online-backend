/**
 * Unit tests for the `isPublicRoute` predicate exported from server.ts.
 *
 * The predicate gates the global auth middleware: routes it returns true
 * for must reach their handlers without an Authorization header. We rely
 * on it to keep the public card catalog (`/api/cards`) reachable for the
 * unauthenticated frontend.
 */

process.env.ALLOW_LOCAL_BYPASS = process.env.ALLOW_LOCAL_BYPASS || 'true';
process.env.MATCHMAKING_QUEUE_WORKER = 'false';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DISABLE_CORS = 'true';

import { isPublicRoute } from '../server';

describe('isPublicRoute', () => {
  it('treats /api/cards as public (catalog must be reachable without auth)', () => {
    expect(isPublicRoute('/api/cards')).toBe(true);
  });

  it('treats /api/cards sub-paths as public', () => {
    expect(isPublicRoute('/api/cards/some-id')).toBe(true);
    expect(isPublicRoute('/api/cards/some/nested/path')).toBe(true);
  });

  it('still recognizes the static public routes', () => {
    expect(isPublicRoute('/health')).toBe(true);
    expect(isPublicRoute('/healthz')).toBe(true);
    expect(isPublicRoute('/auth/sign-in')).toBe(true);
    expect(isPublicRoute('/auth/sign-up')).toBe(true);
    expect(isPublicRoute('/auth/refresh')).toBe(true);
  });

  it('does not leak public status to unrelated routes', () => {
    expect(isPublicRoute('/graphql')).toBe(false);
    expect(isPublicRoute('/api/match')).toBe(false);
    expect(isPublicRoute('/api/cardsX')).toBe(false);
    expect(isPublicRoute('/leaderboard')).toBe(false);
    expect(isPublicRoute('/')).toBe(false);
  });
});
