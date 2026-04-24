/**
 * draw_cards handler contract tests.
 *
 * Spec anchors: section 9.1 (Draw), rule 413 (Draw X), rule 431 (Burn Out).
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

describeIfBackend('draw_cards: happy path (rule 413)', () => {
  it('moves top N cards from main deck to hand', () => {
    let ctx = makeCtx();
    const source = makeUnit();
    for (let i = 1; i <= 5; i += 1) {
      ctx.zones.mainDecks.p1.push(
        makeUnit({ instanceId: `d${i}`, zone: 'main-deck', owner: 'p1' }),
      );
    }
    const op: EffectOp = { type: 'draw_cards', player: 'p1', count: 3 };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    expect(ctx.zones.mainDecks.p1.length).toBe(2);
    expect(ctx.zones.hands.p1.length).toBe(3);
    // Order: top of deck = index 0 per standard convention.
    expect(ctx.zones.hands.p1.map((c) => c.instanceId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('emits one on_draw trigger fire per card drawn', () => {
    const ctx = makeCtx();
    for (let i = 1; i <= 3; i += 1) {
      ctx.zones.mainDecks.p1.push(
        makeUnit({ instanceId: `d${i}`, zone: 'main-deck', owner: 'p1' }),
      );
    }
    const op: EffectOp = { type: 'draw_cards', player: 'p1', count: 2 };
    const source = makeUnit();
    const res = BACKEND!.runOp(ctx, op, source);
    const draws = res.triggeredAbilities.filter((t) => t.triggerType === 'on_draw');
    expect(draws.length).toBe(2);
  });
});

describeIfBackend('draw_cards: empty deck triggers Burn Out (rule 431)', () => {
  it('when deck cannot satisfy the draw, recycles trash and awards a point to an opponent', () => {
    let ctx = makeCtx();
    const source = makeUnit();
    // Deck has 1 card, we draw 2. Trash has 2 cards available for recycle.
    ctx.zones.mainDecks.p1.push(makeUnit({ instanceId: 'd1', zone: 'main-deck', owner: 'p1' }));
    ctx.zones.trashes.p1.push(
      makeUnit({ instanceId: 't1', zone: 'trash', owner: 'p1' }),
      makeUnit({ instanceId: 't2', zone: 'trash', owner: 'p1' }),
    );
    const p2PointsBefore = ctx.players[1]!.points;
    const op: EffectOp = { type: 'draw_cards', player: 'p1', count: 2 };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    // d1 was drawn, then Burn Out recycled t1/t2 into the deck (randomized by
    // the RNG seed), then the remainder of the draw (1 more) completed.
    expect(ctx.zones.hands.p1.length).toBe(2);
    // An opponent gains 1 point per Burn Out event (rule 431.2).
    const p2PointsAfter = ctx.players[1]!.points;
    expect(p2PointsAfter).toBe(p2PointsBefore + 1);
    // A burn_out log entry should be recorded (spec 9.1 ops table).
    const burnOutLogged = res.log.some((l) => /burn.?out/i.test(l.kind));
    expect(burnOutLogged).toBe(true);
  });

  it('is deterministic for a fixed RNG seed (rule 416.5 randomized recycle)', () => {
    // Two runs with identical ctx and seed must produce identical hand order.
    const build = (): ReturnType<typeof makeCtx> => {
      const c = makeCtx();
      c.zones.mainDecks.p1.push(makeUnit({ instanceId: 'd1', zone: 'main-deck' }));
      c.zones.trashes.p1.push(
        makeUnit({ instanceId: 't1', zone: 'trash' }),
        makeUnit({ instanceId: 't2', zone: 'trash' }),
      );
      return c;
    };
    const a = build();
    const b = build();
    const source = makeUnit();
    const op: EffectOp = { type: 'draw_cards', player: 'p1', count: 2 };
    const resA = BACKEND!.runOp(a, op, source);
    const resB = BACKEND!.runOp(b, op, source);
    const nextA = applyPatches(a, resA.patches);
    const nextB = applyPatches(b, resB.patches);
    expect(nextA.zones.hands.p1.map((c) => c.instanceId)).toEqual(
      nextB.zones.hands.p1.map((c) => c.instanceId),
    );
  });
});
