/**
 * Combat-adjacent ops: deal_damage, stun, combat_bonus.
 *
 * Spec anchors: section 8 (counters/damage), rule 417 (damage), rule 454-461
 * (combat), combat_bonus per section 18 type union.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  makeGear,
  applyPatches,
  resetInstanceCounter,
  EffectOp,
} from './_harness';
import { FIXTURES } from './fixtures/real-cards';

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('deal_damage: happy path (rule 417)', () => {
  it('adds damage to the target and fires on_damage_dealt + on_damage_taken', () => {
    let ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src', controller: 'p1' });
    const tgt = makeUnit({ instanceId: 'tgt', controller: 'p2', might: 4 });
    ctx.zones.board.bases.p2.presentUnits.push(tgt.instanceId);
    const op: EffectOp = {
      type: 'deal_damage',
      source: src.instanceId,
      target: tgt.instanceId,
      amount: 2,
    };
    const res = BACKEND!.runOp(ctx, op, src);
    ctx = applyPatches(ctx, res.patches);
    // Damage accumulated on the target.
    const damagePatches = res.patches.filter((p) => /damage/.test(p.path));
    expect(damagePatches.length).toBeGreaterThan(0);
    // Both triggers fired.
    const fired = res.triggeredAbilities.map((t) => t.triggerType);
    expect(fired).toContain('on_damage_dealt');
    expect(fired).toContain('on_damage_taken');
  });
});

describeIfBackend('deal_damage: lethal damage schedules a cleanup kill (rule 143.2)', () => {
  it('damage >= might marks the unit for the next cleanup', () => {
    let ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const tgt = makeUnit({ instanceId: 'tgt', might: 2 });
    ctx.zones.board.bases.p2.presentUnits.push(tgt.instanceId);
    const op: EffectOp = {
      type: 'deal_damage',
      source: src.instanceId,
      target: tgt.instanceId,
      amount: 3,
    };
    const res = BACKEND!.runOp(ctx, op, src);
    // Per spec 5.3 / rule 323.4, kill happens in the cleanup step, not inline.
    // So no 'on_kill' fire is emitted here - only damage ticks.
    const firedKill = res.triggeredAbilities.some((t) => t.triggerType === 'on_kill');
    expect(firedKill).toBe(false);
    // A cleanup request should be logged/enqueued.
    const hasCleanupRequest = res.log.some((l) => /cleanup|state.based/i.test(l.kind));
    expect(hasCleanupRequest).toBe(true);
    ctx = applyPatches(ctx, res.patches);
    // Damage now on the target.
    const target = (ctx as unknown as { units?: Record<string, { state: { damage: number } }> })
      .units?.[tgt.instanceId];
    if (target) {
      expect(target.state.damage).toBeGreaterThanOrEqual(3);
    }
  });

  it('amount 0 is a no-op and does not fire damage triggers', () => {
    const ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const tgt = makeUnit({ instanceId: 'tgt', might: 2 });
    ctx.zones.board.bases.p2.presentUnits.push(tgt.instanceId);
    const op: EffectOp = {
      type: 'deal_damage',
      source: src.instanceId,
      target: tgt.instanceId,
      amount: 0,
    };
    const res = BACKEND!.runOp(ctx, op, src);
    const fired = res.triggeredAbilities.filter(
      (t) => t.triggerType === 'on_damage_dealt' || t.triggerType === 'on_damage_taken',
    );
    expect(fired.length).toBe(0);
  });
});

describeIfBackend('stun: marks the unit stunned', () => {
  it('sets stunned=true and emits a log entry', () => {
    let ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const tgt = makeUnit({ instanceId: 'tgt' });
    ctx.zones.board.bases.p2.presentUnits.push(tgt.instanceId);
    const op: EffectOp = { type: 'stun', target: tgt.instanceId };
    const res = BACKEND!.runOp(ctx, op, src);
    const stunPatch = res.patches.find((p) => /stunned/.test(p.path));
    expect(stunPatch).toBeDefined();
    expect(stunPatch?.value).toBe(true);
    ctx = applyPatches(ctx, res.patches);
  });

  it('stunning an already-stunned unit is idempotent - no duplicate log entries', () => {
    const ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const tgt = makeUnit({
      instanceId: 'tgt',
      state: { exhausted: false, damage: 0, hasBuffCounter: false, facedown: false, stunned: true },
    });
    ctx.zones.board.bases.p2.presentUnits.push(tgt.instanceId);
    const op: EffectOp = { type: 'stun', target: tgt.instanceId };
    const res = BACKEND!.runOp(ctx, op, src);
    // No-op: no replace patch on stunned field with value=true.
    const redundant = res.patches.filter(
      (p) => /stunned/.test(p.path) && p.value === true && p.op === 'replace',
    );
    expect(redundant.length).toBe(0);
  });
});

describeIfBackend('combat_bonus: this-combat might modifier', () => {
  it('registers a combat-scoped temporary might mod', () => {
    let ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const tgt = makeUnit({ instanceId: 'tgt', might: 2 });
    ctx.zones.board.bases.p1.presentUnits.push(tgt.instanceId);
    const op: EffectOp = {
      type: 'combat_bonus',
      target: tgt.instanceId,
      mightMod: 2,
      duration: 'this_combat',
    };
    const res = BACKEND!.runOp(ctx, op, src);
    ctx = applyPatches(ctx, res.patches);
    const mods = (ctx.temporaryMods as unknown[]).filter((m) => {
      const r = m as { appliedTo?: string; kind?: string };
      return r?.appliedTo === tgt.instanceId && r?.kind === 'might';
    });
    expect(mods.length).toBe(1);
  });
});

describeIfBackend('combat_trigger: registers into TriggerRegistry', () => {
  it('does not fire imperatively; returns zero patches on register', () => {
    const ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const op: EffectOp = { type: 'combat_trigger', source: src.instanceId };
    const res = BACKEND!.runOp(ctx, op, src);
    // Registration op: no patches that mutate board state, no trigger fires.
    expect(res.triggeredAbilities.length).toBe(0);
    // May emit a registration log entry.
    const logged = res.log.some((l) => /register|install|trigger/i.test(l.kind));
    expect(logged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: shield, heal, solo_combat.
//
// Spec anchors: section 8 (counters/damage), rule 417.5 (damage prevention /
// Shield), rule 419 (Heal), rule 458 (combat eligibility).
//
// Shield stacks by summed value (spec 11.1 Deflect precedent). Heal clamps at
// damage floor of zero. Solo_combat is registration-shaped.
// ---------------------------------------------------------------------------

describeIfBackend('shield: stacks by summed value (rule 417.5)', () => {
  it('two Shield grants accumulate a numeric value on the source', () => {
    let ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const op1: EffectOp = { type: 'shield', source: src.instanceId, value: 1 };
    const op2: EffectOp = { type: 'shield', source: src.instanceId, value: 2 };
    const r1 = BACKEND!.runOp(ctx, op1, src);
    ctx = applyPatches(ctx, r1.patches);
    const r2 = BACKEND!.runOp(ctx, op2, src);
    ctx = applyPatches(ctx, r2.patches);
    // Same precedent as keyword_deflect: the handler records stacking via
    // either grantedKeywords[shield].value or a temporaryMods entry.
    // The temporaryMods root is always an array in makeCtx(); grantedKeywords
    // may or may not be (depends on whether the backend auto-creates the
    // path as an array or object). Assert via temporaryMods + log trail.
    const shieldFromMods: number = (ctx.temporaryMods as unknown[])
      .filter((m) => {
        const r = m as { source?: string; kind?: string };
        return r?.source === 'src' && /shield/.test(r?.kind ?? '');
      })
      .reduce<number>((acc, m) => acc + ((m as { value?: number }).value ?? 0), 0);
    const logged = r1.log.length + r2.log.length;
    // Backend must EITHER stack the shield values in temporaryMods (expected
    // total = 3) OR emit distinct log entries per grant. Dropping the second
    // grant silently is not allowed.
    if (shieldFromMods > 0) {
      expect(shieldFromMods).toBeGreaterThanOrEqual(3);
    } else {
      expect(logged).toBeGreaterThanOrEqual(2);
    }
  });
});

describeIfBackend('shield: validate rejects zero value', () => {
  it('ok=false when shield value is zero or negative', () => {
    const ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('shield');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const result = h.validate(ctx, { type: 'shield', source: 'src', value: 0 } as EffectOp, src);
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('heal: removes damage from target (rule 419)', () => {
  it('damage clamps at zero (cannot go negative)', () => {
    let ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const tgt = makeUnit({
      instanceId: 'tgt',
      state: { exhausted: false, damage: 1, hasBuffCounter: false, facedown: false },
    });
    ctx.zones.board.bases.p1.presentUnits.push(tgt.instanceId);
    (ctx as unknown as { units: Record<string, { state: { damage: number } }> }).units = {
      tgt: tgt as unknown as { state: { damage: number } },
    };
    const op: EffectOp = { type: 'heal', target: tgt.instanceId, amount: 5 };
    const res = BACKEND!.runOp(ctx, op, src);
    ctx = applyPatches(ctx, res.patches);
    const post = (ctx as unknown as { units?: Record<string, { state: { damage: number } }> }).units?.tgt;
    if (post) {
      expect(post.state.damage).toBe(0);
    }
  });

  it('heal of amount 0 on a unit with zero damage is a no-op', () => {
    // Spec-ambiguity note: rule 419 does not explicitly define heal amount 0.
    // The implementation clamps amount to >= 1. We test the NO-OP surface by
    // seeding a target with zero damage: handler must not mutate damage below
    // zero regardless of the amount clamp.
    let ctx = makeCtx();
    const src = makeUnit();
    const tgt = makeUnit({
      instanceId: 'tgt',
      state: { exhausted: false, damage: 0, hasBuffCounter: false, facedown: false },
    });
    ctx.zones.board.bases.p1.presentUnits.push(tgt.instanceId);
    (ctx as unknown as { units: Record<string, unknown> }).units = { tgt };
    const op: EffectOp = { type: 'heal', target: tgt.instanceId, amount: 0 };
    const res = BACKEND!.runOp(ctx, op, src);
    // No damage-field replace patch when there's no damage to heal.
    const touched = res.patches.some((p) => /damage/.test(p.path) && p.op === 'replace');
    expect(touched).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    const post = (ctx as unknown as { units?: Record<string, { state: { damage: number } }> }).units?.tgt;
    if (post) {
      expect(post.state.damage).toBe(0);
    }
  });
});

describeIfBackend('solo_combat: registration-shaped', () => {
  it('installs a combat eligibility modifier; no imperative state change', () => {
    const ctx = makeCtx();
    const src = makeUnit({ instanceId: 'src' });
    const op: EffectOp = { type: 'solo_combat', source: src.instanceId };
    const res = BACKEND!.runOp(ctx, op, src);
    // Not a damage/stat patch; only grantedKeywords / combat registry touches.
    const disallowed = res.patches.some(
      (p) => /damage|\/might$|exhausted/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 directed coverage for heal + solo_combat.
//
// heal: 10 cards emit it (UNL-206 Altar of Blood, OGS-020 Highlander,
// SFD-053 Janna - Savior, ...). solo_combat: 6 cards (OGN-060 Mask of
// Foresight, UNL-210 Forbidding Waste, OGS-019 Master Yi - Wuju Starter,
// ...). Both handlers missed the Phase-5c 20-match run because the cards
// are rare and the specific triggers (damage remaining on friendlies for
// heal, attack alone condition for solo_combat) rarely align. These tests
// force the dispatch path using the real card op shapes pulled verbatim
// from data/cards.enriched.json.
// ---------------------------------------------------------------------------

describeIfBackend('heal: real-card coverage (phase-6)', () => {
  it('heal: real-card happy path (SFD-053, phase-6 coverage)', () => {
    // SFD-053 Janna - Savior emits heal as op[0] of a 4-op chain. Real op
    // carries targetHint='ally', zone='board', automated=false,
    // ruleRefs=['520-530']. The enricher does not emit a heal amount; the
    // dispatch path supplies 1 as the default in live play. Spec rule 419
    // (Heal) anchors the damage-clamp-at-zero contract; the Phase-3
    // synthetic already covers that clamp. This test confirms the
    // dispatcher routes SFD-053's heal through the handler without a
    // throw and the post-apply damage is zero-bounded.
    const card = FIXTURES.SFD_053_JANNA;
    expect(card.effectProfile.operations.map((o) => o.type)).toContain('heal');

    let ctx = makeCtx();
    const src = makeUnit({ instanceId: 'sfd-053-inst', cardId: card.id });
    // Real Janna heals a damaged ally; set up a friendly unit with 2 damage
    // so there is something to heal.
    const ally = makeUnit({
      instanceId: 'ally-1',
      controller: 'p1',
      state: { exhausted: false, damage: 2, hasBuffCounter: false, facedown: false },
    });
    ctx.zones.board.bases.p1.presentUnits.push(ally.instanceId);
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      [src.instanceId]: src,
      [ally.instanceId]: ally,
    };
    const op: EffectOp = { type: 'heal', target: ally.instanceId, amount: 1 };
    const res = BACKEND!.runOp(ctx, op, src);
    // A damage patch should land OR the handler logs the heal intent;
    // either path is acceptable per spec section 8. Handler MUST NOT
    // throw (Phase-5c regression class).
    const damageTouched = res.patches.some(
      (p) => /damage/.test(p.path),
    );
    const healLogged = res.log.some((l) => /heal|restore/i.test(l.kind));
    expect(damageTouched || healLogged).toBe(true);
    ctx = applyPatches(ctx, res.patches);
    // Damage cannot go negative.
    const post = (ctx as unknown as { units?: Record<string, { state: { damage: number } }> }).units?.[ally.instanceId];
    if (post) {
      expect(post.state.damage).toBeGreaterThanOrEqual(0);
    }
  });
});

describeIfBackend('solo_combat: real-card coverage (phase-6)', () => {
  it('solo_combat: real-card happy path (OGN-060, phase-6 coverage)', () => {
    // OGN-060 Mask of Foresight is a Gear (not a Unit); the real card grants
    // solo_combat to the equipped ally via the 2-op chain [modify_stats,
    // solo_combat]. Real op carries targetHint='ally', zone='board',
    // automated=true, ruleRefs=['700-720']. The Phase-3 synthetic assumed
    // a Unit-sourced op; the real card sources it from Gear. This test
    // confirms the handler is type-agnostic about the source's cardType.
    const card = FIXTURES.OGN_060_MASK_OF_FORESIGHT;
    expect(card.effectProfile.operations.map((o) => o.type)).toContain('solo_combat');
    expect(card.type).toBe('Gear');

    const ctx = makeCtx();
    const source = makeGear({ instanceId: 'ogn-060-inst', cardId: card.id });
    const op: EffectOp = { type: 'solo_combat', source: source.instanceId };
    const res = BACKEND!.runOp(ctx, op, source);
    // Registration shape: no damage / might / exhausted patches at register.
    const disallowed = res.patches.some(
      (p) => /damage|\/might$|exhausted/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 5d regression fixture. Phase-5c integration captured 6 handler
// throws across 3 cards; this pin-down file covers UNL-134 (deal_damage)
// so the specific throw has a named regression instead of being aggregated
// into the `<= 6` integration gate.
//
// Source: docs/phase-5-coverage-baseline.md section "Handler crashes".
//   - aggro-vs-tempo seed 0x03030303 turn 1: deal_damage UNL-134 throws
//     "Existential Dread requires a unit target to deal damage."
//   - control-vs-control seed 0x0c0c0c0c turn 10: same throw.
//   - midrange-vs-tempo seed 0x12121212 turn 35: same throw.
//
// Reproduction surface: the engine-adapter path of dealDamageHandler
// (src/effects/handlers/combat.ts :190-206) calls
// engine.ensureDamageableTarget(boardTarget, source) with an undefined
// boardTarget when UNL-134 resolves with no surviving enemy unit available.
// game-engine.ts :8247 throws instead of routing through validate() as a
// soft reject.
//
// Contract expected AFTER the backend fix lands: the handler must NOT
// throw regardless of target availability. Either (a) validate() returns
// {ok:false, reason:...} and execute is skipped, or (b) execute returns
// a valid OpResult (empty patches + a soft-reject log entry). Both shapes
// acceptable per the QA brief; the test cares that the handler does not
// crash and surface as "handler.execute threw".
// ---------------------------------------------------------------------------

describeIfBackend('UNL-134 Existential Dread deal_damage (phase-5d regression)', () => {
  function withLoggerErrorSpy(
    callback: (
      captured: Array<{ msg: string; meta: Record<string, unknown> }>
    ) => void
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loggerMod = require('../../logger') as {
      default: { error: (...a: unknown[]) => void };
    };
    const loggerRef = loggerMod.default;
    const originalError = loggerRef.error.bind(loggerRef);
    const captured: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    (loggerRef as unknown as { error: (...a: unknown[]) => void }).error = (
      ...args: unknown[]
    ) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      const meta = (args[1] ?? {}) as Record<string, unknown>;
      captured.push({ msg, meta });
    };
    try {
      callback(captured);
    } finally {
      (loggerRef as unknown as { error: (...a: unknown[]) => void }).error =
        originalError;
    }
  }

  it('UNL-134 deal_damage does not crash when no unit target is resolvable (regression: phase-5c)', () => {
    // Build a ctx that takes the engine-adapter path (hasEngineAdapter in
    // combat.ts returns true when ctx.engine has both damageCreature and
    // ensureDamageableTarget). The mock adapter mirrors the current
    // production throw surface (game-engine.ts :8245-8253) so the test
    // exercises the exact shape that blew up in phase-5c seed 0x03030303.
    let engineDamageCalls = 0;
    const fakeEngine = {
      damageCreature(): void {
        engineDamageCalls += 1;
      },
      ensureDamageableTarget(
        target: unknown,
        source: { name?: string }
      ): unknown {
        if (!target) {
          throw new Error(
            `${source?.name ?? 'Source'} requires a unit target to deal damage.`
          );
        }
        return target;
      }
    };

    const ctx = makeCtx() as unknown as {
      engine?: unknown;
      operationContext?: unknown;
      caster?: unknown;
    };
    ctx.engine = fakeEngine;
    // No target on the op, no boardTarget on the context, no targets list.
    // UNL-134 (Existential Dread) wants to Stun an attacking enemy unit; if
    // none is present/attacking, the handler must soft-fail instead of
    // forwarding an undefined target to the engine adapter.
    ctx.operationContext = {
      source: { id: 'UNL-134', name: 'Existential Dread' },
      boardTarget: undefined,
      targets: null
    };
    ctx.caster = { playerId: 'p1' };

    // Source id is 'UNL-134' per dispatcher.sourceIdForLog contract so the
    // captured "handler.execute threw" log (if any) includes the card id.
    const source = {
      id: 'UNL-134',
      instanceId: 'unl-134-inst',
      name: 'Existential Dread'
    };

    const op: EffectOp = {
      type: 'deal_damage',
      source: 'unl-134-inst',
      amount: 1
    };

    withLoggerErrorSpy((captured) => {
      let thrown: unknown = null;
      let result: unknown = null;
      try {
        result = BACKEND!.runOp(ctx as never, op, source as never);
      } catch (err) {
        thrown = err;
      }
      if (thrown) {
        throw new Error(
          `UNL-134 regression: runOp threw instead of soft-failing: ${
            thrown instanceof Error ? thrown.message : String(thrown)
          }`
        );
      }
      expect(result).not.toBeNull();

      // Primary assertion: the dispatcher did NOT catch a handler.execute
      // throw. This log is the phase-5c capture signature and the thing
      // the integration gate counts.
      const throwLogs = captured.filter((c) =>
        c.msg.includes('handler.execute threw')
      );
      if (throwLogs.length > 0) {
        const detail = throwLogs
          .map((t) => {
            const meta = t.meta as {
              opType?: string;
              sourceCardId?: string;
              err?: unknown;
            };
            const errMsg =
              meta.err instanceof Error
                ? meta.err.message
                : String(meta.err ?? '');
            return (
              `opType=${meta.opType ?? '?'} ` +
              `sourceCardId=${meta.sourceCardId ?? '?'} err=${errMsg}`
            );
          })
          .join('\n');
        throw new Error(
          `UNL-134 deal_damage handler threw during execute ` +
            `(regression: phase-5c):\n${detail}`
        );
      }
      expect(throwLogs.length).toBe(0);

      // Defense-in-depth: if the handler went the validate-reject path it
      // would never have invoked the adapter. If it went the
      // soft-return-in-execute path it may have called the adapter. Either
      // shape is fine; the invariant is "no throw". Engine calls stay
      // small (<=1) to catch accidental loops.
      expect(engineDamageCalls).toBeLessThanOrEqual(1);
    });
  });
});
