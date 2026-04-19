import type { EffectOperation } from '../../card-catalog';
import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch,
  TriggerFire,
  ValidationResult
} from '../types';
import { emptyResult } from '../types';

interface ControlBattlefieldOp {
  type: 'control_battlefield';
  battlefieldId?: string;
  mode?: 'gain' | 'contest' | 'lose';
  forPlayer?: string;
}

interface PatchCtxShape {
  zones?: {
    board?: {
      battlefields?: Record<
        string,
        { controller?: string | null; contested?: boolean } & Record<string, unknown>
      >;
    };
  };
}

export const controlBattlefieldHandler: OpHandler<{ type: 'control_battlefield' }> = {
  op: 'control_battlefield',
  validate(ctx: EngineCtx, _op): ValidationResult {
    const op = _op as unknown as ControlBattlefieldOp;

    // Adapter path: defer to legacy behavior (always ok).
    if (ctx.engine && typeof ctx.engine.applyBattlefieldControl === 'function') return { ok: true };

    // Patch path: reject unknown battlefield IDs.
    if (!op.battlefieldId) return { ok: true };
    const shape = ctx as unknown as PatchCtxShape;
    const bf = shape.zones?.board?.battlefields?.[op.battlefieldId];
    if (!bf) {
      return { ok: false, reason: 'battlefield_not_found' };
    }
    return { ok: true };
  },
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as ControlBattlefieldOp;

    // Engine adapter path: legacy production behavior.
    if (ctx.engine?.applyBattlefieldControl && ctx.caster) {
      const operation = _op as unknown as EffectOperation;
      const points = Math.max(1, operation.magnitudeHint ?? 1);
      const chosen = ctx.operationContext?.battlefieldTarget;

      if (chosen) {
        ctx.engine.applyBattlefieldControl(ctx.caster, chosen, 'objective', {
          points,
          sourceCardId: source?.id
        });
        return emptyResult();
      }

      const effectText = (source?.text ?? '').toLowerCase();
      const grantsControl =
        /\b(gain\s+control|claim|take\s+control|conquer)\b/.test(effectText) &&
        /\bbattlefield\b/.test(effectText);
      if (!grantsControl) {
        ctx.engine.logRuleUsage?.(source, 'control_battlefield-skipped-no-target');
        return emptyResult();
      }

      const resolved = ctx.engine.resolveBattlefieldTargetForControl?.(ctx.caster, undefined);
      if (!resolved) return emptyResult();

      ctx.engine.applyBattlefieldControl(ctx.caster, resolved, 'objective', {
        points,
        sourceCardId: source?.id
      });
      return emptyResult();
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const log: LogEntry[] = [];
    const bfId = op.battlefieldId;
    if (!bfId) return emptyResult();

    const mode = op.mode ?? 'gain';
    if (mode === 'contest') {
      patches.push({
        op: 'replace',
        path: `/zones/board/battlefields/${bfId}/contested`,
        value: true
      });
    } else if (mode === 'gain') {
      patches.push({
        op: 'replace',
        path: `/zones/board/battlefields/${bfId}/contested`,
        value: true
      });
    } else if (mode === 'lose') {
      patches.push({
        op: 'replace',
        path: `/zones/board/battlefields/${bfId}/contested`,
        value: true
      });
    }
    // Cleanup request per spec 13.5: reconcile controller during cleanup.
    log.push({
      tick: 0,
      kind: 'state_based_cleanup_request_control_reconcile',
      payload: { battlefieldId: bfId, mode, forPlayer: op.forPlayer }
    });
    return { patches, triggeredAbilities: [], log };
  }
};

// ---------------------------------------------------------------------------
// scoring - increment victory points. Spec 13.5.
// ---------------------------------------------------------------------------

interface ScoringOp {
  type: 'scoring';
  player?: string;
  battlefieldId?: string | null;
  reason?: 'conquer' | 'hold' | 'effect';
  amount?: number;
}

interface ScoringRestrictionPredicate {
  source?: string;
  predicateKind?: string;
  predicatePayload?: unknown;
  player?: string;
  battlefieldId?: string | null;
  reason?: string;
}

interface ScoringCtxShape {
  players?: Array<{
    playerId: string;
    points?: number;
    victoryPoints?: number;
    scoredThisTurnByBattlefield?: Set<string> | string[];
  }>;
  zones?: {
    board?: {
      battlefields?: Record<
        string,
        { controller?: string | null; scoredBy?: Record<string, string | null> } & Record<string, unknown>
      >;
    };
  };
  scoringRestrictions?: ScoringRestrictionPredicate[];
  turnState?: { turnNumber?: number };
}

function parseScoreAmountFromText(text: string): number | null {
  if (!text) return null;
  // "score N point(s)" / "you score N point(s)" covers both card text variants.
  const match = /score\s+(\d+)\s+point/i.exec(text);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function restrictionApplies(
  r: ScoringRestrictionPredicate,
  player: string,
  battlefieldId: string | null,
  reason: string,
  ctx: ScoringCtxShape
): boolean {
  if (r.predicateKind === 'per_battlefield_turn_gate') {
    const payload = r.predicatePayload as { battlefieldId?: string; untilTurn?: number } | undefined;
    if (payload?.battlefieldId && battlefieldId && payload.battlefieldId !== battlefieldId) return false;
    const turn = ctx.turnState?.turnNumber ?? 1;
    if (typeof payload?.untilTurn === 'number' && turn < payload.untilTurn) return true;
    return false;
  }
  if (r.predicateKind === 'per_player_while_present') {
    const payload = r.predicatePayload as { blockedPlayer?: string } | undefined;
    if (payload?.blockedPlayer && payload.blockedPlayer !== player) return false;
    return true;
  }
  // Default: fields match explicitly.
  if (r.player && r.player !== player) return false;
  if (r.battlefieldId && battlefieldId && r.battlefieldId !== battlefieldId) return false;
  if (r.reason && r.reason !== reason) return false;
  return true;
}

export const scoringHandler: OpHandler<{ type: 'scoring' }> = {
  op: 'scoring',
  validate(ctx, _op) {
    const op = _op as unknown as ScoringOp;
    const shape = ctx as unknown as ScoringCtxShape;
    const player = op.player ?? 'p1';
    const reason = op.reason ?? 'effect';
    const bf = op.battlefieldId ?? null;

    // Restriction predicates (spec 13.5).
    const restrictions = shape.scoringRestrictions ?? [];
    for (const r of restrictions) {
      if (restrictionApplies(r, player, bf, reason, shape)) {
        return { ok: false, reason: 'battlefield_score_locked' };
      }
    }

    // Rule 465: one Score per Battlefield per player per turn for
    // Conquer/Hold (effect-scoring is exempt).
    if ((reason === 'conquer' || reason === 'hold') && bf) {
      const p = (shape.players ?? []).find((x) => x.playerId === player);
      const scored = p?.scoredThisTurnByBattlefield;
      if (scored) {
        const has = scored instanceof Set ? scored.has(bf) : scored.includes(bf);
        if (has) return { ok: false, reason: 'already_scored_this_turn' };
      }
    }
    return { ok: true };
  },
  execute(ctx, _op, source): OpResult {
    const op = _op as unknown as ScoringOp;
    const operation = _op as unknown as EffectOperation;
    const shape = ctx as unknown as ScoringCtxShape;
    const patches: Patch[] = [];
    const triggered: TriggerFire[] = [];
    const log: LogEntry[] = [];

    // Engine adapter path: mutate caster.victoryPoints on the live engine.
    // Parse "score N point(s)" from source text (rule 13.5 allows any numeric
    // specification in the card text to override the marker op); fall back to
    // magnitudeHint, then op.amount. Marker-only ops (no text, no
    // magnitudeHint) are intentional no-ops.
    if (ctx.engine && ctx.caster) {
      const parsedFromText = parseScoreAmountFromText(source?.text ?? '');
      const resolvedAmount =
        parsedFromText ??
        (typeof operation.magnitudeHint === 'number' ? operation.magnitudeHint : undefined) ??
        (typeof op.amount === 'number' ? op.amount : undefined);
      if (resolvedAmount && resolvedAmount > 0) {
        ctx.caster.victoryPoints = (ctx.caster.victoryPoints ?? 0) + resolvedAmount;
        ctx.engine.logRuleUsage?.(source as never, 'scoring');
      }
      return emptyResult();
    }

    const player = op.player ?? 'p1';
    const reason = op.reason ?? 'effect';
    const bf = op.battlefieldId ?? null;
    const amount = typeof op.amount === 'number' ? op.amount : 1;

    const idx = (shape.players ?? []).findIndex((p) => p.playerId === player);
    if (idx < 0) return emptyResult();
    const currentPoints = shape.players![idx]!.points ?? 0;
    const currentVP = shape.players![idx]!.victoryPoints ?? currentPoints;
    // Emit both the canonical `points` (harness) and `victoryPoints` (spec)
    // so either shape reads the incremented value.
    patches.push({
      op: 'replace',
      path: `/players/${idx}/points`,
      value: currentPoints + amount
    });
    patches.push({
      op: 'replace',
      path: `/players/${idx}/victoryPoints`,
      value: currentVP + amount
    });

    if (bf && (reason === 'conquer' || reason === 'hold')) {
      // Mark scored on the battlefield and the per-player set.
      patches.push({
        op: 'add',
        path: `/zones/board/battlefields/${bf}/scoredBy/${player}`,
        value: reason
      });
      const p = shape.players![idx]!;
      const existing =
        p.scoredThisTurnByBattlefield instanceof Set
          ? Array.from(p.scoredThisTurnByBattlefield)
          : (p.scoredThisTurnByBattlefield ?? []);
      if (!existing.includes(bf)) {
        patches.push({
          op: 'replace',
          path: `/players/${idx}/scoredThisTurnByBattlefield`,
          value: [...existing, bf]
        });
      }
    }

    const sourceInstanceId =
      (source as unknown as { instanceId?: string; id?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (reason === 'conquer') {
      triggered.push({
        triggerType: 'on_conquer',
        sourceInstanceId,
        sourceController: player,
        eventSnapshot: { kind: 'on_conquer', payload: { player, battlefieldId: bf, amount } }
      });
    } else if (reason === 'hold') {
      triggered.push({
        triggerType: 'on_hold',
        sourceInstanceId,
        sourceController: player,
        eventSnapshot: { kind: 'on_hold', payload: { player, battlefieldId: bf, amount } }
      });
    }

    log.push({ tick: 0, kind: 'scoring_applied', payload: { player, battlefieldId: bf, reason, amount } });
    return { patches, triggeredAbilities: triggered, log };
  }
};

// ---------------------------------------------------------------------------
// scoring_restriction - Registration op that installs a predicate.
// ---------------------------------------------------------------------------

interface ScoringRestrictionOp {
  type: 'scoring_restriction';
  source?: string;
  predicateKind?: 'per_battlefield_turn_gate' | 'per_player_while_present' | 'custom';
  predicatePayload?: unknown;
}

export const scoringRestrictionHandler: OpHandler<{ type: 'scoring_restriction' }> = {
  op: 'scoring_restriction',
  execute(ctx, _op, source): OpResult {
    const op = _op as unknown as ScoringRestrictionOp;
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (!sourceInstanceId) return emptyResult();

    const shape = ctx as unknown as { scoringRestrictions?: ScoringRestrictionPredicate[] };
    const existing = shape.scoringRestrictions ?? [];
    if (existing.some((r) => r.source === sourceInstanceId)) {
      return {
        patches: [],
        triggeredAbilities: [],
        log: [{ tick: 0, kind: 'scoring_restriction_redundant_noop', payload: { source: sourceInstanceId } }]
      };
    }

    return {
      patches: [
        {
          op: 'add',
          path: '/scoringRestrictions/-',
          value: {
            source: sourceInstanceId,
            predicateKind: op.predicateKind ?? 'custom',
            predicatePayload: op.predicatePayload ?? {}
          }
        }
      ],
      triggeredAbilities: [],
      log: [
        {
          tick: 0,
          kind: 'scoring_restriction_registered',
          payload: { source: sourceInstanceId, predicateKind: op.predicateKind ?? 'custom' }
        }
      ]
    };
  }
};

// ---------------------------------------------------------------------------
// location_aura - Passive aura tied to a battlefield/location.
// ---------------------------------------------------------------------------

interface LocationAuraOp {
  type: 'location_aura';
  source?: string;
  battlefieldId?: string;
  effect?: string;
  amount?: number;
}

export const locationAuraHandler: OpHandler<{ type: 'location_aura' }> = {
  op: 'location_aura',
  validate(ctx, _op): ValidationResult {
    const op = _op as unknown as LocationAuraOp;
    if (!op.battlefieldId) return { ok: true };
    const shape = ctx as unknown as PatchCtxShape;
    const bf = shape.zones?.board?.battlefields?.[op.battlefieldId];
    if (!bf) return { ok: false, reason: 'battlefield_not_found' };
    return { ok: true };
  },
  execute(_ctx, _op, source): OpResult {
    const op = _op as unknown as LocationAuraOp;
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (!sourceInstanceId) return emptyResult();

    return {
      patches: [
        {
          op: 'add',
          path: `/units/${sourceInstanceId}/locationAuras/-`,
          value: {
            source: sourceInstanceId,
            battlefieldId: op.battlefieldId ?? null,
            effect: op.effect ?? 'buff_friendly_might',
            amount: typeof op.amount === 'number' ? op.amount : 1
          }
        }
      ],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: 'location_aura_registered', payload: { source: sourceInstanceId } }]
    };
  }
};

// ---------------------------------------------------------------------------
// play_restriction - Registration op that blocks plays under a predicate.
// ---------------------------------------------------------------------------

interface PlayRestrictionOp {
  type: 'play_restriction';
  source?: string;
  predicateKind?: string;
  predicatePayload?: unknown;
}

export const playRestrictionHandler: OpHandler<{ type: 'play_restriction' }> = {
  op: 'play_restriction',
  execute(ctx, _op, source): OpResult {
    const op = _op as unknown as PlayRestrictionOp;
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (!sourceInstanceId) return emptyResult();

    const shape = ctx as unknown as { playRestrictions?: Array<{ source?: string }> };
    const existing = shape.playRestrictions ?? [];
    if (existing.some((r) => r.source === sourceInstanceId)) {
      return {
        patches: [],
        triggeredAbilities: [],
        log: [{ tick: 0, kind: 'play_restriction_redundant_noop', payload: { source: sourceInstanceId } }]
      };
    }

    return {
      patches: [
        {
          op: 'add',
          path: '/playRestrictions/-',
          value: {
            source: sourceInstanceId,
            predicateKind: op.predicateKind ?? 'custom',
            predicatePayload: op.predicatePayload ?? {}
          }
        }
      ],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: 'play_restriction_registered', payload: { source: sourceInstanceId } }]
    };
  }
};
