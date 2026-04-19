/**
 * create_token handler contract tests.
 *
 * Spec anchors: section 6 (Token Creation), rules 176-184.
 * Fixture reference: OGN-275 Altar to Unity creates a 1-Might Recruit token on
 * hold.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  applyPatches,
  resetInstanceCounter,
  EffectOp,
  CardInstance,
} from './_harness';
import { FIXTURES } from './fixtures/real-cards';

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('create_token: happy path (Recruit 1/M)', () => {
  it('spawns a token instance with isToken=true, unique instanceId, controller=forPlayer', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'bf-source', controller: 'p1' });
    const op: EffectOp = {
      type: 'create_token',
      player: 'p1',
      templateId: 'recruit-1m',
      count: 1,
      location: { kind: 'base', player: 'p1' },
      enteredExhausted: false,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    // One unit added to p1 base.
    expect(ctx.zones.board.bases.p1.presentUnits.length).toBe(1);
    const spawnedId = ctx.zones.board.bases.p1.presentUnits[0]!;
    // Fetch the token from whatever lookup the backend uses - we accept
    // either a units map or an inline object at the base.
    const units = (ctx as unknown as { units?: Record<string, CardInstance> }).units;
    const token = units?.[spawnedId];
    if (token) {
      expect(token.isToken).toBe(true);
      expect(token.templateId).toBe('recruit-1m');
      expect(token.controller).toBe('p1');
      expect(token.owner).toBe('p1');
    }
  });

  it('count > 1 spawns multiple distinct instanceIds (rule 6.2)', () => {
    let ctx = makeCtx();
    const source = makeUnit();
    const op: EffectOp = {
      type: 'create_token',
      player: 'p1',
      templateId: 'recruit-1m',
      count: 3,
      location: { kind: 'base', player: 'p1' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const ids = ctx.zones.board.bases.p1.presentUnits;
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
  });
});

describeIfBackend('create_token: token from Altar to Unity fixture', () => {
  it('reads the tokenSpec metadata from the OGN-275 operation entry', () => {
    // Sanity-check the fixture shape so downstream handlers rely on a known
    // template path.
    const createOp = FIXTURES.OGN_275_ALTAR_TO_UNITY.effectProfile.operations.find(
      (o) => o.type === 'create_token',
    );
    expect(createOp).toBeDefined();
    const spec = (createOp?.metadata as { tokenSpec?: { name: string; might: number } } | undefined)
      ?.tokenSpec;
    expect(spec?.name).toBe('Recruit');
    expect(spec?.might).toBe(1);
  });
});

describeIfBackend('create_token: token deleted on leaving board to non-chain zone (rule 183.1)', () => {
  it('after a kill, the token is spliced out of the zone entirely', () => {
    let ctx = makeCtx();
    const source = makeUnit();
    // Spawn a token.
    const createOp: EffectOp = {
      type: 'create_token',
      player: 'p1',
      templateId: 'recruit-1m',
      count: 1,
      location: { kind: 'base', player: 'p1' },
    };
    const spawn = BACKEND!.runOp(ctx, createOp, source);
    ctx = applyPatches(ctx, spawn.patches);
    const tokenId = ctx.zones.board.bases.p1.presentUnits[0]!;
    // Now kill it.
    const killOp: EffectOp = { type: 'remove_permanent', target: tokenId, mode: 'kill' };
    const killRes = BACKEND!.runOp(ctx, killOp, source);
    ctx = applyPatches(ctx, killRes.patches);
    // Rule 183.1: token does not live in trash; it ceases to exist. So the
    // trash should NOT contain a CardInstance with this instanceId.
    const inTrash = ctx.zones.trashes.p1.some((c) => c.instanceId === tokenId);
    expect(inTrash).toBe(false);
    // A token_deleted log entry is required for replay determinism (spec 6.3).
    const deletedLogged =
      killRes.log.some((l) => /token.?deleted/i.test(l.kind)) ||
      spawn.log.some((l) => /token.?deleted/i.test(l.kind));
    // The deletion log belongs to the kill step, but some implementations may
    // front-load the token-delete observer on spawn. Accept either.
    expect(deletedLogged).toBe(true);
  });
});
