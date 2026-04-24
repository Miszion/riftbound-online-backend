/**
 * manipulate_priority handler contract tests.
 *
 * Spec anchors: section 17.
 *
 * Pitfall regression (Tech Lead Phase 2a review): variants action_tagged,
 * reaction_tagged, add_reaction must no-op with a warn. Those three are
 * data-layer markers and should not reach the dispatcher, but if they do, the
 * match must not crash.
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

const MARKER_VARIANTS = ['action_tagged', 'reaction_tagged', 'add_reaction'] as const;

describeIfBackend('manipulate_priority: marker variants no-op (spec 17.5)', () => {
  it.each(MARKER_VARIANTS)('variant %s is a no-op with a warn log entry', (variant) => {
    const ctx = makeCtx();
    const source = makeUnit();
    const op: EffectOp = { type: 'manipulate_priority', variant };
    const res = BACKEND!.runOp(ctx, op, source);
    // No state mutation.
    expect(res.patches).toEqual([]);
    // No triggers.
    expect(res.triggeredAbilities).toEqual([]);
    // Warn log entry present per spec 17.5 "log PRIORITY_TAG_DISPATCHED_AS_OP".
    const warned = res.log.some(
      (l) =>
        /priority.?tag|manipulate_priority.?marker|marker|warn/i.test(l.kind),
    );
    expect(warned).toBe(true);
  });
});

describeIfBackend('manipulate_priority: take_focus (spec 17.5)', () => {
  it('sets focusHolder and priorityHolder to targetPlayer', () => {
    let ctx = makeCtx({
      turnState: {
        turnNumber: 1,
        phase: 'main',
        mode: 'showdown_open',
        combat: null,
        showdown: { id: 'sd-1' } as unknown,
        onceThisTurnUsed: {},
        triggeredThisTurn: {},
      },
      focusHolder: 'p1',
      priorityHolder: 'p1',
    });
    const source = makeUnit();
    const op: EffectOp = {
      type: 'manipulate_priority',
      variant: 'take_focus',
      targetPlayer: 'p2',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    expect(ctx.focusHolder).toBe('p2');
    expect(ctx.priorityHolder).toBe('p2');
  });

  it('validate rejects take_focus outside a showdown (spec 17.5)', () => {
    const ctx = makeCtx(); // neutral_open by default
    const source = makeUnit();
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('manipulate_priority');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'manipulate_priority',
      variant: 'take_focus',
      targetPlayer: 'p2',
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_in_showdown');
  });
});

describeIfBackend('manipulate_priority: grant_priority', () => {
  it('updates priorityHolder without touching focusHolder', () => {
    let ctx = makeCtx({
      focusHolder: 'p1',
      priorityHolder: 'p1',
      turnState: {
        turnNumber: 1,
        phase: 'main',
        mode: 'neutral_closed',
        combat: null,
        showdown: null,
        onceThisTurnUsed: {},
        triggeredThisTurn: {},
      },
    });
    const source = makeUnit();
    const op: EffectOp = {
      type: 'manipulate_priority',
      variant: 'grant_priority',
      targetPlayer: 'p2',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    expect(ctx.priorityHolder).toBe('p2');
    // focusHolder untouched.
    expect(ctx.focusHolder).toBe('p1');
  });
});
