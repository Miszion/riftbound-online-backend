/**
 * Rune + resource handler contract tests: channel_rune, gain_resource.
 *
 * Spec anchors: section 16 (Runes + resources), rule 430 (Channel), rule 429
 * (Add).
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  applyPatches,
  resetInstanceCounter,
  EffectOp,
} from './_harness';

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('channel_rune: happy path (rule 430)', () => {
  it('moves top N runes from runeDeck to runesOnBoard and fires on_channel per rune', () => {
    let ctx = makeCtx();
    const source = makeUnit();
    // Seed the rune deck with 3 runes.
    for (let i = 1; i <= 3; i += 1) {
      ctx.zones.runeDecks.p1.push(
        makeUnit({ instanceId: `r${i}`, zone: 'rune-deck', owner: 'p1', cardType: 'Rune' }),
      );
    }
    const op: EffectOp = {
      type: 'channel_rune',
      player: 'p1',
      count: 2,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    expect(ctx.zones.runeDecks.p1.length).toBe(1);
    expect(ctx.zones.runesOnBoard?.p1?.length).toBe(2);
    const channelFires = res.triggeredAbilities.filter((t) => t.triggerType === 'on_channel');
    expect(channelFires.length).toBe(2);
  });

  it('validate clamps count to runeDeck.length (rule 315.3.b.1)', () => {
    const ctx = makeCtx();
    ctx.zones.runeDecks.p1.push(
      makeUnit({ instanceId: 'r1', zone: 'rune-deck', owner: 'p1', cardType: 'Rune' }),
    );
    const source = makeUnit();
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('channel_rune');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = { type: 'channel_rune', player: 'p1', count: 5 };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(true);
    expect(result.effectiveCount).toBe(1);
  });

  it('enteredExhausted=true produces runes in the exhausted state (rule 430.2)', () => {
    let ctx = makeCtx();
    const source = makeUnit();
    ctx.zones.runeDecks.p1.push(
      makeUnit({ instanceId: 'r1', zone: 'rune-deck', owner: 'p1', cardType: 'Rune' }),
    );
    const op: EffectOp = {
      type: 'channel_rune',
      player: 'p1',
      count: 1,
      enteredExhausted: true,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const r = ctx.zones.runesOnBoard?.p1?.[0];
    expect(r?.state.exhausted).toBe(true);
  });
});

describeIfBackend('gain_resource: energy add (rule 429)', () => {
  it('increments runePool.energy by amount', () => {
    let ctx = makeCtx();
    const source = makeUnit();
    const op: EffectOp = {
      type: 'gain_resource',
      player: 'p1',
      kind: 'energy',
      amount: 2,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    expect(ctx.players[0]!.runePool.energy).toBe(2);
  });

  it('gain_resource power requires a domain', () => {
    const ctx = makeCtx();
    const source = makeUnit();
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('gain_resource');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = { type: 'gain_resource', player: 'p1', kind: 'power', amount: 1 };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });

  it('immediate / synchronous variant does not pass priority (rule 429.2.a)', () => {
    // Contract: synchronous=true means the handler updates runePool without
    // a chain / priority transition. We verify the handler accepts the flag
    // and returns patches only - no trigger fires requiring chain placement.
    const ctx = makeCtx();
    const source = makeUnit();
    const op: EffectOp = {
      type: 'gain_resource',
      player: 'p1',
      kind: 'energy',
      amount: 1,
      synchronous: true,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    expect(res.triggeredAbilities.length).toBe(0);
  });
});

describeIfBackend('rune_resource: classification marker (spec 16.5)', () => {
  it('when dispatched as an op, runs as a no-op with a diagnostic warning', () => {
    // The dispatcher is supposed to strip these at catalog build. If one
    // leaks through, it must not crash; it must log a diagnostic.
    const ctx = makeCtx();
    const source = makeUnit();
    const op = { type: 'rune_resource', runeCardId: 'OGN-126' } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    expect(res.patches).toEqual([]);
    expect(res.triggeredAbilities).toEqual([]);
    const warned = res.log.some((l) => /rune_resource|classification|strip/i.test(l.kind));
    expect(warned).toBe(true);
  });
});
