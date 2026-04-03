/**
 * Game State Serializer - Comprehensive Unit Tests
 *
 * Tests cover: serializeGameState, serializePlayerState, buildOpponentView,
 * viewer perspective / hidden info, board state, resources, all sub-serializers.
 */
import {
  serializeGameState,
  serializePlayerState,
  buildOpponentView,
  PlayerVisibility
} from '../game-state-serializer';
import {
  GameState,
  PlayerState,
  BoardCard,
  Card,
  RuneCard,
  BattlefieldState,
  HiddenCard,
  GameStatus,
  GamePhase,
  CardType,
  CardRarity,
  Domain,
  TemporaryEffect,
  GamePrompt,
  PriorityWindow,
  PendingSpellResolution,
  ReactionChain,
  ChainItem,
  GameStateSnapshot,
  DuelLogEntry,
  ChatMessage,
  CombatContext
} from '../game-engine';
import {
  makeCreature,
  makeSpell,
  makeArtifact,
  makeRuneCard,
  resetCardCounter
} from './test-helpers';

// ---------------------------------------------------------------------------
// Minimal factory helpers
// ---------------------------------------------------------------------------

function makeResourcePool() {
  return {
    energy: 3,
    universalPower: 1,
    power: {
      fury: 0,
      calm: 0,
      mind: 0,
      body: 0,
      chaos: 0,
      order: 0
    } as Record<Domain, number>
  };
}

function makeBoardCard(overrides: Partial<BoardCard> = {}): BoardCard {
  const base = makeCreature({ id: 'board-card-1', name: 'Board Creature' });
  return {
    ...base,
    instanceId: 'inst-1',
    currentToughness: 3,
    isTapped: false,
    summoned: false,
    counters: {},
    activationState: {
      cardId: base.id,
      isStateful: false,
      active: false,
      lastChangedAt: 1000,
      history: []
    },
    ruleLog: [],
    location: { zone: 'base' },
    ...overrides
  } as BoardCard;
}

function makePlayerState(playerId: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    playerId,
    name: `Player ${playerId}`,
    victoryPoints: 0,
    victoryScore: 0,
    mana: 2,
    maxMana: 4,
    deck: [makeCreature({ id: 'deck-c-1' })],
    runeDeck: [makeRuneCard(0)],
    channeledRunes: [],
    hand: [makeCreature({ id: 'hand-c-1' })],
    graveyard: [],
    exile: [],
    board: {
      playerId,
      creatures: [],
      artifacts: [],
      enchantments: []
    },
    resources: makeResourcePool(),
    temporaryEffects: [],
    battlefieldPool: [],
    firstTurnRuneBoost: 0,
    championLegend: null,
    championLeader: null,
    championLegendStatus: null,
    championLeaderStatus: null,
    ...overrides
  } as PlayerState;
}

function makeBattlefield(overrides: Partial<BattlefieldState> = {}): BattlefieldState {
  return {
    battlefieldId: 'bf-1',
    slug: 'test-battlefield',
    name: 'Test Battlefield',
    ownerId: 'player-1',
    controller: null,
    contestedBy: [],
    hiddenCards: [],
    ...overrides
  } as BattlefieldState;
}

function makeMinimalGameState(overrides: Partial<GameState> = {}): GameState {
  const p1 = makePlayerState('player-1');
  const p2 = makePlayerState('player-2');
  return {
    matchId: 'match-123',
    players: [p1, p2],
    currentPlayerIndex: 0,
    currentPhase: GamePhase.MAIN_1,
    turnNumber: 1,
    status: GameStatus.IN_PROGRESS,
    winner: undefined,
    initiativeWinner: null,
    initiativeLoser: null,
    initiativeSelections: {},
    initiativeDecidedAt: null,
    moveHistory: [],
    timestamp: 1700000000000,
    victoryScore: 8,
    scoreLog: [],
    endReason: undefined,
    prompts: [],
    priorityWindow: null,
    snapshots: [],
    battlefields: [makeBattlefield()],
    duelLog: [],
    chatLog: [],
    pendingMainPhaseEntry: false,
    turnSequenceStep: null,
    focusPlayerId: null,
    combatContext: null,
    pendingEffects: [],
    pendingSpellResolution: null,
    reactionChain: null,
    ...overrides
  } as unknown as GameState;
}

// ---------------------------------------------------------------------------
// Reset counter before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetCardCounter();
});

// ===========================================================================
// serializeGameState
// ===========================================================================

describe('serializeGameState', () => {
  describe('top-level fields', () => {
    it('includes all required top-level fields', () => {
      const state = makeMinimalGameState();
      const result = serializeGameState(state);

      expect(result.matchId).toBe('match-123');
      expect(result.players).toHaveLength(2);
      expect(result.currentPlayerIndex).toBe(0);
      expect(result.currentPhase).toBe(GamePhase.MAIN_1);
      expect(result.turnNumber).toBe(1);
      expect(result.status).toBe(GameStatus.IN_PROGRESS);
      expect(result.winner).toBeNull();
      expect(result.moveHistory).toEqual([]);
      expect(result.victoryScore).toBe(8);
      expect(result.scoreLog).toEqual([]);
      expect(Array.isArray(result.prompts)).toBe(true);
      expect(Array.isArray(result.battlefields)).toBe(true);
      expect(Array.isArray(result.duelLog)).toBe(true);
      expect(Array.isArray(result.chatLog)).toBe(true);
      expect(result.endReason).toBeNull();
      expect(result.turnSequenceStep).toBeNull();
      expect(result.focusPlayerId).toBeNull();
      expect(result.pendingSpellResolution).toBeNull();
      expect(result.reactionChain).toBeNull();
      expect(result.combatContext).toBeNull();
    });

    it('converts timestamp number to Date', () => {
      const ts = 1700000000000;
      const state = makeMinimalGameState({ timestamp: ts });
      const result = serializeGameState(state);
      expect(result.timestamp).toEqual(new Date(ts));
    });

    it('handles undefined timestamp gracefully', () => {
      const state = makeMinimalGameState({ timestamp: undefined as any });
      const result = serializeGameState(state);
      expect(result.timestamp).toBeNull();
    });

    it('includes initiativeWinner/Loser/Selections', () => {
      const state = makeMinimalGameState({
        initiativeWinner: 'player-1',
        initiativeLoser: 'player-2',
        initiativeSelections: { 'player-1': 0, 'player-2': 1 },
        initiativeDecidedAt: 1700000000000
      });
      const result = serializeGameState(state);
      expect(result.initiativeWinner).toBe('player-1');
      expect(result.initiativeLoser).toBe('player-2');
      expect(result.initiativeSelections).toEqual({ 'player-1': 0, 'player-2': 1 });
      expect(result.initiativeDecidedAt).toEqual(new Date(1700000000000));
    });
  });

  describe('viewer perspective', () => {
    it('without viewerId: both players get spectator view (hands visible)', () => {
      const state = makeMinimalGameState();
      const result = serializeGameState(state);
      // spectator: hand is shown (not hidden)
      expect(result.players[0].hand).toHaveLength(1);
      expect(result.players[1].hand).toHaveLength(1);
    });

    it('with viewerId = player-1: player-1 is self, player-2 is opponent', () => {
      const state = makeMinimalGameState();
      const result = serializeGameState(state, { viewerId: 'player-1' });

      // Self: hand visible
      expect(result.players[0].hand).toHaveLength(1);
      // Opponent: hand hidden
      expect(result.players[1].hand).toHaveLength(0);
    });

    it('with viewerId = player-2: player-2 is self, player-1 is opponent', () => {
      const state = makeMinimalGameState();
      const result = serializeGameState(state, { viewerId: 'player-2' });

      expect(result.players[0].hand).toHaveLength(0); // opponent
      expect(result.players[1].hand).toHaveLength(1); // self
    });

    it('with viewerId = null: spectator view', () => {
      const state = makeMinimalGameState();
      const result = serializeGameState(state, { viewerId: null });
      expect(result.players[0].hand).toHaveLength(1);
      expect(result.players[1].hand).toHaveLength(1);
    });

    it('unknown viewerId: all players are opponents (hands hidden)', () => {
      const state = makeMinimalGameState();
      const result = serializeGameState(state, { viewerId: 'spectator-unknown' });
      // Not matching any player - treated as opponent for all
      expect(result.players[0].hand).toHaveLength(0);
      expect(result.players[1].hand).toHaveLength(0);
    });
  });

  describe('score log', () => {
    it('serializes score log entries with timestamp as Date', () => {
      const state = makeMinimalGameState({
        scoreLog: [
          {
            playerId: 'player-1',
            amount: 2,
            reason: 'hold',
            sourceCardId: 'card-x',
            timestamp: 1700000001000
          }
        ]
      });
      const result = serializeGameState(state);
      expect(result.scoreLog).toHaveLength(1);
      expect(result.scoreLog[0].playerId).toBe('player-1');
      expect(result.scoreLog[0].amount).toBe(2);
      expect(result.scoreLog[0].reason).toBe('hold');
      expect(result.scoreLog[0].sourceCardId).toBe('card-x');
      expect(result.scoreLog[0].timestamp).toEqual(new Date(1700000001000));
    });

    it('handles missing sourceCardId in score log', () => {
      const state = makeMinimalGameState({
        scoreLog: [{ playerId: 'player-1', amount: 1, reason: 'combat', timestamp: 100 }]
      });
      const result = serializeGameState(state);
      expect(result.scoreLog[0].sourceCardId).toBeNull();
    });
  });

  describe('combat context', () => {
    it('serializes combat context when present', () => {
      const ctx: CombatContext = {
        battlefieldId: 'bf-1',
        initiatedBy: 'player-1',
        defendingPlayerId: 'player-2',
        attackingUnitIds: ['inst-1'],
        defendingUnitIds: ['inst-2'],
        priorityStage: 'action',
        actionPasses: 0
      };
      const state = makeMinimalGameState({ combatContext: ctx });
      const result = serializeGameState(state);
      expect(result.combatContext).not.toBeNull();
      expect(result.combatContext!.battlefieldId).toBe('bf-1');
      expect(result.combatContext!.initiatedBy).toBe('player-1');
      expect(result.combatContext!.defendingPlayerId).toBe('player-2');
      expect(result.combatContext!.attackingUnitIds).toEqual(['inst-1']);
      expect(result.combatContext!.defendingUnitIds).toEqual(['inst-2']);
      expect(result.combatContext!.priorityStage).toBe('action');
    });

    it('returns null combatContext when not set', () => {
      const state = makeMinimalGameState({ combatContext: null });
      const result = serializeGameState(state);
      expect(result.combatContext).toBeNull();
    });
  });

  describe('duelLog and chatLog', () => {
    it('serializes duel log entries', () => {
      const state = makeMinimalGameState({
        duelLog: [
          {
            id: 'log-1',
            message: 'A creature attacks',
            tone: 'info',
            timestamp: 1700000002000,
            playerId: 'player-1',
            actorName: 'Hero'
          }
        ]
      });
      const result = serializeGameState(state);
      expect(result.duelLog).toHaveLength(1);
      expect(result.duelLog[0].id).toBe('log-1');
      expect(result.duelLog[0].message).toBe('A creature attacks');
      expect(result.duelLog[0].tone).toBe('info');
      expect(result.duelLog[0].playerId).toBe('player-1');
      expect(result.duelLog[0].actorName).toBe('Hero');
      expect(result.duelLog[0].timestamp).toEqual(new Date(1700000002000));
    });

    it('serializes chat log entries', () => {
      const state = makeMinimalGameState({
        chatLog: [
          {
            id: 'chat-1',
            playerId: 'player-1',
            playerName: 'Alice',
            message: 'gg',
            timestamp: 1700000003000
          }
        ]
      });
      const result = serializeGameState(state);
      expect(result.chatLog).toHaveLength(1);
      expect(result.chatLog[0].id).toBe('chat-1');
      expect(result.chatLog[0].playerId).toBe('player-1');
      expect(result.chatLog[0].playerName).toBe('Alice');
      expect(result.chatLog[0].message).toBe('gg');
      expect(result.chatLog[0].timestamp).toEqual(new Date(1700000003000));
    });

    it('handles null/undefined duelLog gracefully', () => {
      const state = makeMinimalGameState({ duelLog: undefined as any });
      const result = serializeGameState(state);
      expect(result.duelLog).toEqual([]);
    });

    it('handles null/undefined chatLog gracefully', () => {
      const state = makeMinimalGameState({ chatLog: undefined as any });
      const result = serializeGameState(state);
      expect(result.chatLog).toEqual([]);
    });
  });

  describe('prompts', () => {
    it('serializes game prompts', () => {
      const prompt: GamePrompt = {
        id: 'prompt-1',
        type: 'mulligan',
        playerId: 'player-1',
        data: { cards: [] },
        resolved: false,
        createdAt: 1700000000000,
        resolvedAt: undefined,
        resolution: undefined
      };
      const state = makeMinimalGameState({ prompts: [prompt] });
      const result = serializeGameState(state);
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].id).toBe('prompt-1');
      expect(result.prompts[0].type).toBe('mulligan');
      expect(result.prompts[0].playerId).toBe('player-1');
      expect(result.prompts[0].resolved).toBe(false);
      expect(result.prompts[0].createdAt).toEqual(new Date(1700000000000));
      expect(result.prompts[0].resolvedAt).toBeNull();
      expect(result.prompts[0].resolution).toBeNull();
    });

    it('serializes resolved prompts with resolution data', () => {
      const prompt: GamePrompt = {
        id: 'prompt-2',
        type: 'action',
        playerId: 'player-2',
        data: {},
        resolved: true,
        createdAt: 1700000000100,
        resolvedAt: 1700000000200,
        resolution: { choice: 'keep' }
      };
      const state = makeMinimalGameState({ prompts: [prompt] });
      const result = serializeGameState(state);
      expect(result.prompts[0].resolved).toBe(true);
      expect(result.prompts[0].resolvedAt).toEqual(new Date(1700000000200));
      expect(result.prompts[0].resolution).toEqual({ choice: 'keep' });
    });
  });

  describe('priorityWindow', () => {
    it('returns null when no priority window', () => {
      const state = makeMinimalGameState({ priorityWindow: null });
      const result = serializeGameState(state);
      expect(result.priorityWindow).toBeNull();
    });

    it('serializes priority window with timestamps', () => {
      const window: PriorityWindow = {
        id: 'pw-1',
        type: 'main',
        holder: 'player-1',
        openedAt: 1700000000000,
        expiresAt: 1700000030000,
        event: 'card_played'
      };
      const state = makeMinimalGameState({ priorityWindow: window });
      const result = serializeGameState(state);
      expect(result.priorityWindow).not.toBeNull();
      expect(result.priorityWindow!.id).toBe('pw-1');
      expect(result.priorityWindow!.type).toBe('main');
      expect(result.priorityWindow!.holder).toBe('player-1');
      expect(result.priorityWindow!.openedAt).toEqual(new Date(1700000000000));
      expect(result.priorityWindow!.expiresAt).toEqual(new Date(1700000030000));
      expect(result.priorityWindow!.event).toBe('card_played');
    });

    it('serializes priority window with no expiresAt', () => {
      const window: PriorityWindow = {
        id: 'pw-2',
        type: 'reaction',
        holder: 'player-2',
        openedAt: 1700000000000
      };
      const state = makeMinimalGameState({ priorityWindow: window });
      const result = serializeGameState(state);
      expect(result.priorityWindow!.expiresAt).toBeNull();
      expect(result.priorityWindow!.event).toBeNull();
    });
  });

  describe('snapshots', () => {
    it('serializes state snapshots', () => {
      const snapshot: GameStateSnapshot = {
        turn: 3,
        phase: GamePhase.COMBAT,
        timestamp: 1700000005000,
        reason: 'combat_start',
        summary: 'Combat begins'
      };
      const state = makeMinimalGameState({ snapshots: [snapshot] });
      const result = serializeGameState(state);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].turn).toBe(3);
      expect(result.snapshots[0].phase).toBe(GamePhase.COMBAT);
      expect(result.snapshots[0].timestamp).toEqual(new Date(1700000005000));
      expect(result.snapshots[0].reason).toBe('combat_start');
      expect(result.snapshots[0].summary).toBe('Combat begins');
    });
  });

  describe('pendingSpellResolution', () => {
    it('returns null when no pending spell', () => {
      const state = makeMinimalGameState({ pendingSpellResolution: null });
      const result = serializeGameState(state);
      expect(result.pendingSpellResolution).toBeNull();
    });

    it('serializes pending spell resolution', () => {
      const spell = makeSpell({ id: 'spell-1', name: 'Test Bolt' });
      const pending: PendingSpellResolution = {
        id: 'psr-1',
        spell,
        casterId: 'player-1',
        targets: ['inst-2'],
        targetDescriptions: ['Enemy Creature'],
        createdAt: 1700000000000,
        reactorId: 'player-2',
        resolved: false
      };
      const state = makeMinimalGameState({ pendingSpellResolution: pending });
      const result = serializeGameState(state);
      expect(result.pendingSpellResolution).not.toBeNull();
      expect(result.pendingSpellResolution!.id).toBe('psr-1');
      expect(result.pendingSpellResolution!.casterId).toBe('player-1');
      expect(result.pendingSpellResolution!.targets).toEqual(['inst-2']);
      expect(result.pendingSpellResolution!.targetDescriptions).toEqual(['Enemy Creature']);
      expect(result.pendingSpellResolution!.reactorId).toBe('player-2');
      expect(result.pendingSpellResolution!.resolved).toBe(false);
      expect(result.pendingSpellResolution!.createdAt).toEqual(new Date(1700000000000));
      expect(result.pendingSpellResolution!.spell.name).toBe('Test Bolt');
    });
  });

  describe('reactionChain', () => {
    it('returns null when no reaction chain', () => {
      const state = makeMinimalGameState({ reactionChain: null });
      const result = serializeGameState(state);
      expect(result.reactionChain).toBeNull();
    });

    it('serializes reaction chain with items', () => {
      const chainCard = makeSpell({ id: 'chain-spell', name: 'Counter Spell' });
      const item: ChainItem = {
        id: 'ci-1',
        type: 'spell',
        card: chainCard,
        casterId: 'player-2',
        targets: ['inst-x'],
        targetDescriptions: ['Target'],
        createdAt: 1700000000100,
        abilityName: undefined,
        sourceInstanceId: undefined
      };
      const chain: ReactionChain = {
        id: 'rc-1',
        items: [item],
        currentReactorId: 'player-1',
        originalCasterId: 'player-2',
        awaitingResponse: true,
        createdAt: 1700000000000,
        lastUpdatedAt: 1700000000100
      };
      const state = makeMinimalGameState({ reactionChain: chain });
      const result = serializeGameState(state);
      expect(result.reactionChain).not.toBeNull();
      expect(result.reactionChain!.id).toBe('rc-1');
      expect(result.reactionChain!.currentReactorId).toBe('player-1');
      expect(result.reactionChain!.originalCasterId).toBe('player-2');
      expect(result.reactionChain!.awaitingResponse).toBe(true);
      expect(result.reactionChain!.createdAt).toEqual(new Date(1700000000000));
      expect(result.reactionChain!.lastUpdatedAt).toEqual(new Date(1700000000100));
      expect(result.reactionChain!.items).toHaveLength(1);
      expect(result.reactionChain!.items[0].id).toBe('ci-1');
      expect(result.reactionChain!.items[0].card.name).toBe('Counter Spell');
      expect(result.reactionChain!.items[0].abilityName).toBeNull();
      expect(result.reactionChain!.items[0].sourceInstanceId).toBeNull();
    });
  });

  describe('JSON serialization', () => {
    it('produces output that is JSON-serializable', () => {
      const state = makeMinimalGameState();
      const result = serializeGameState(state);
      expect(() => JSON.stringify(result)).not.toThrow();
    });
  });
});

// ===========================================================================
// serializePlayerState
// ===========================================================================

describe('serializePlayerState', () => {
  describe('self visibility', () => {
    it('includes full hand for self', () => {
      const player = makePlayerState('p1', {
        hand: [makeCreature({ id: 'h1' }), makeCreature({ id: 'h2' })]
      });
      const result = serializePlayerState(player, 'self');
      expect(result.hand).toHaveLength(2);
      expect(result.handSize).toBe(2);
    });

    it('includes runeDeck for self', () => {
      const player = makePlayerState('p1', {
        runeDeck: [makeRuneCard(0), makeRuneCard(1)]
      });
      const result = serializePlayerState(player, 'self');
      expect(result.runeDeck).toHaveLength(2);
      expect(result.runeDeckSize).toBe(2);
    });

    it('includes champion status for self', () => {
      const player = makePlayerState('p1', {
        championLegendStatus: {
          canActivate: true,
          hasManualActivation: true,
          reason: null,
          cost: { energy: 2, runes: {}, requiresExhaust: false },
          costSummary: '2 energy'
        },
        championLeaderStatus: {
          canActivate: false,
          hasManualActivation: true,
          reason: 'insufficient energy',
          cost: { energy: 4, runes: { fury: 1 }, requiresExhaust: true },
          costSummary: '4 energy + 1 fury'
        }
      });
      const result = serializePlayerState(player, 'self');
      expect(result.championLegendState).not.toBeNull();
      expect(result.championLegendState!.canActivate).toBe(true);
      expect(result.championLegendState!.cost).not.toBeNull();
      expect(result.championLegendState!.cost!.energy).toBe(2);
      expect(result.championLegendState!.cost!.exhausts).toBe(false);

      expect(result.championLeaderState).not.toBeNull();
      expect(result.championLeaderState!.canActivate).toBe(false);
      expect(result.championLeaderState!.reason).toBe('insufficient energy');
      expect(result.championLeaderState!.cost!.exhausts).toBe(true);
    });

    it('returns null championState when status is null', () => {
      const player = makePlayerState('p1', {
        championLegendStatus: null,
        championLeaderStatus: null
      });
      const result = serializePlayerState(player, 'self');
      expect(result.championLegendState).toBeNull();
      expect(result.championLeaderState).toBeNull();
    });
  });

  describe('opponent visibility', () => {
    it('hides hand (returns empty array) for opponent', () => {
      const player = makePlayerState('p2', {
        hand: [makeCreature({ id: 'h1' }), makeCreature({ id: 'h2' }), makeCreature({ id: 'h3' })]
      });
      const result = serializePlayerState(player, 'opponent');
      expect(result.hand).toEqual([]);
      expect(result.handSize).toBe(3); // handSize still accurate
    });

    it('hides runeDeck (returns empty array) for opponent', () => {
      const player = makePlayerState('p2', {
        runeDeck: [makeRuneCard(0), makeRuneCard(1), makeRuneCard(2)]
      });
      const result = serializePlayerState(player, 'opponent');
      expect(result.runeDeck).toEqual([]);
      expect(result.runeDeckSize).toBe(3); // size still accurate
    });

    it('hides champion status for opponent', () => {
      const player = makePlayerState('p2', {
        championLegendStatus: {
          canActivate: true,
          hasManualActivation: true,
          reason: null,
          cost: { energy: 1, runes: {}, requiresExhaust: false },
          costSummary: '1 energy'
        }
      });
      const result = serializePlayerState(player, 'opponent');
      expect(result.championLegendState).toBeNull();
      expect(result.championLeaderState).toBeNull();
    });

    it('reveals deckCount but hides deck contents', () => {
      const player = makePlayerState('p2', {
        deck: [makeCreature({ id: 'd1' }), makeCreature({ id: 'd2' })]
      });
      const result = serializePlayerState(player, 'opponent');
      expect(result.deckCount).toBe(2);
    });
  });

  describe('spectator visibility', () => {
    it('shows hand for spectator', () => {
      const player = makePlayerState('p1', {
        hand: [makeCreature({ id: 'h1' })]
      });
      const result = serializePlayerState(player, 'spectator');
      expect(result.hand).toHaveLength(1);
    });

    it('shows runeDeck for spectator', () => {
      const player = makePlayerState('p1', {
        runeDeck: [makeRuneCard(0)]
      });
      const result = serializePlayerState(player, 'spectator');
      expect(result.runeDeck).toHaveLength(1);
    });

    it('includes champion status for spectator (spectator is not opponent)', () => {
      const player = makePlayerState('p1', {
        championLegendStatus: {
          canActivate: true,
          hasManualActivation: true,
          reason: null,
          cost: { energy: 1, runes: {}, requiresExhaust: false },
          costSummary: '1'
        }
      });
      const result = serializePlayerState(player, 'spectator');
      // spectator visibility !== 'opponent', so champion status IS included
      expect(result.championLegendState).not.toBeNull();
      expect(result.championLegendState!.canActivate).toBe(true);
    });
  });

  describe('resources', () => {
    it('serializes energy and universalPower', () => {
      const player = makePlayerState('p1', {
        resources: {
          energy: 5,
          universalPower: 3,
          power: { fury: 2, calm: 0, mind: 0, body: 1, chaos: 0, order: 0 } as Record<Domain, number>
        }
      });
      const result = serializePlayerState(player, 'self');
      expect(result.resources.energy).toBe(5);
      expect(result.resources.universalPower).toBe(3);
      expect(result.resources.power.fury).toBe(2);
      expect(result.resources.power.body).toBe(1);
    });

    it('clones the power object (no reference sharing)', () => {
      const player = makePlayerState('p1');
      const result = serializePlayerState(player, 'self');
      result.resources.power.fury = 999;
      expect(player.resources.power.fury).toBe(0);
    });
  });

  describe('board serialization', () => {
    it('serializes board zones', () => {
      const creature = makeBoardCard({ instanceId: 'inst-c1' });
      const artifact = makeBoardCard({
        ...makeArtifact({ id: 'art-1', name: 'Test Artifact' }),
        instanceId: 'inst-a1',
        currentToughness: 0,
        summoned: false,
        activationState: { cardId: 'art-1', isStateful: false, active: false, lastChangedAt: 0, history: [] },
        ruleLog: [],
        location: { zone: 'base' }
      } as BoardCard);
      const player = makePlayerState('p1', {
        board: {
          playerId: 'p1',
          creatures: [creature],
          artifacts: [artifact],
          enchantments: []
        }
      });
      const result = serializePlayerState(player, 'self');
      expect(result.board.creatures).toHaveLength(1);
      expect(result.board.artifacts).toHaveLength(1);
      expect(result.board.enchantments).toHaveLength(0);
      expect(result.board.creatures[0].instanceId).toBe('inst-c1');
    });
  });

  describe('graveyard and exile', () => {
    it('serializes graveyard cards', () => {
      const player = makePlayerState('p1', {
        graveyard: [makeCreature({ id: 'dead-1', name: 'Dead Creature' })]
      });
      const result = serializePlayerState(player, 'self');
      expect(result.graveyard).toHaveLength(1);
      expect(result.graveyard[0].name).toBe('Dead Creature');
    });

    it('serializes exile cards', () => {
      const player = makePlayerState('p1', {
        exile: [makeSpell({ id: 'exiled-spell', name: 'Exiled Spell' })]
      });
      const result = serializePlayerState(player, 'self');
      expect(result.exile).toHaveLength(1);
      expect(result.exile[0].name).toBe('Exiled Spell');
    });
  });

  describe('channeledRunes', () => {
    it('serializes channeled runes', () => {
      const rune = makeRuneCard(0, Domain.FURY);
      const player = makePlayerState('p1', {
        channeledRunes: [rune]
      });
      const result = serializePlayerState(player, 'self');
      expect(result.channeledRunes).toHaveLength(1);
      expect(result.channeledRunes[0].runeId).toBe(rune.id);
      expect(result.channeledRunes[0].domain).toBe(Domain.FURY);
      expect(result.channeledRunes[0].isTapped).toBe(false);
    });

    it('serializes tapped rune correctly', () => {
      const rune = { ...makeRuneCard(0), isTapped: true };
      const player = makePlayerState('p1', { channeledRunes: [rune] });
      const result = serializePlayerState(player, 'self');
      expect(result.channeledRunes[0].isTapped).toBe(true);
      expect(result.channeledRunes[0].tapped).toBe(true);
    });

    it('serializes rune with cardSnapshot', () => {
      const snapshot = makeCreature({ id: 'snap-1', name: 'Snapshot Creature' });
      const rune: RuneCard = { ...makeRuneCard(1), cardSnapshot: snapshot };
      const player = makePlayerState('p1', { channeledRunes: [rune] });
      const result = serializePlayerState(player, 'self');
      expect(result.channeledRunes[0].cardSnapshot).not.toBeNull();
      expect(result.channeledRunes[0].cardSnapshot!.name).toBe('Snapshot Creature');
    });
  });

  describe('temporaryEffects', () => {
    it('serializes temporary effects', () => {
      const effect: TemporaryEffect = {
        id: 'te-1',
        affectedCards: ['inst-1', 'inst-2'],
        affectedPlayer: 'p1',
        duration: 2,
        effect: { type: 'damage_boost', value: 3 }
      };
      const player = makePlayerState('p1', { temporaryEffects: [effect] });
      const result = serializePlayerState(player, 'self');
      expect(result.temporaryEffects).toHaveLength(1);
      expect(result.temporaryEffects[0].id).toBe('te-1');
      expect(result.temporaryEffects[0].affectedCards).toEqual(['inst-1', 'inst-2']);
      expect(result.temporaryEffects[0].affectedPlayer).toBe('p1');
      expect(result.temporaryEffects[0].duration).toBe(2);
      expect(result.temporaryEffects[0].effect.type).toBe('damage_boost');
      expect(result.temporaryEffects[0].effect.value).toBe(3);
    });

    it('handles effect without affectedCards or value', () => {
      const effect: TemporaryEffect = {
        id: 'te-2',
        duration: 1,
        effect: { type: 'draw_card' }
      };
      const player = makePlayerState('p1', { temporaryEffects: [effect] });
      const result = serializePlayerState(player, 'self');
      expect(result.temporaryEffects[0].affectedCards).toEqual([]);
      expect(result.temporaryEffects[0].affectedPlayer).toBeNull();
      expect(result.temporaryEffects[0].effect.value).toBeNull();
    });
  });

  describe('champion cards', () => {
    it('serializes championLegend card', () => {
      const legend = makeCreature({ id: 'legend-1', name: 'The Legend' });
      const player = makePlayerState('p1', { championLegend: legend });
      const result = serializePlayerState(player, 'self');
      expect(result.championLegend).not.toBeNull();
      expect(result.championLegend!.name).toBe('The Legend');
    });

    it('returns null when no championLegend', () => {
      const player = makePlayerState('p1', { championLegend: null });
      const result = serializePlayerState(player, 'self');
      expect(result.championLegend).toBeNull();
    });

    it('serializes championLeader card', () => {
      const leader = makeCreature({ id: 'leader-1', name: 'The Leader' });
      const player = makePlayerState('p1', { championLeader: leader });
      const result = serializePlayerState(player, 'self');
      expect(result.championLeader).not.toBeNull();
      expect(result.championLeader!.name).toBe('The Leader');
    });
  });
});

// ===========================================================================
// serializeCardSnapshot (tested via serializePlayerState)
// ===========================================================================

describe('card snapshot serialization', () => {
  it('serializes a Card (non-board) without boardCard fields', () => {
    const card = makeCreature({ id: 'c1', name: 'Test', power: 4, toughness: 5 });
    const player = makePlayerState('p1', { hand: [card] });
    const result = serializePlayerState(player, 'self');
    const serialized = result.hand[0];

    expect(serialized.cardId).toBe('c1');
    expect(serialized.name).toBe('Test');
    expect(serialized.type).toBe(CardType.CREATURE);
    expect(serialized.power).toBe(4);
    expect(serialized.toughness).toBe(5);
    expect(serialized.summoned).toBeNull();
    expect(serialized.counters).toBeNull();
    expect(serialized.activationState).toBeNull();
    expect(serialized.location).toBeNull();
  });

  it('serializes a BoardCard with instance fields', () => {
    const boardCard = makeBoardCard({
      instanceId: 'inst-bc',
      currentToughness: 2,
      isTapped: true,
      summoned: true,
      counters: { fire: 3 },
      location: { zone: 'battlefield', battlefieldId: 'bf-1' }
    });
    const player = makePlayerState('p1', {
      board: { playerId: 'p1', creatures: [boardCard], artifacts: [], enchantments: [] }
    });
    const result = serializePlayerState(player, 'self');
    const serialized = result.board.creatures[0];

    expect(serialized.instanceId).toBe('inst-bc');
    expect(serialized.currentToughness).toBe(2);
    expect(serialized.isTapped).toBe(true);
    expect(serialized.tapped).toBe(true);
    expect(serialized.summoned).toBe(true);
    expect(serialized.counters).toEqual({ fire: 3 });
    expect(serialized.location).toEqual({ zone: 'battlefield', battlefieldId: 'bf-1' });
  });

  it('serializes location zone=base correctly', () => {
    const boardCard = makeBoardCard({ location: { zone: 'base' } });
    const player = makePlayerState('p1', {
      board: { playerId: 'p1', creatures: [boardCard], artifacts: [], enchantments: [] }
    });
    const result = serializePlayerState(player, 'self');
    expect(result.board.creatures[0].location).toEqual({ zone: 'base', battlefieldId: null });
  });

  it('serializes card rarity and cost fields', () => {
    const card = makeCreature({
      id: 'c2',
      rarity: CardRarity.LEGENDARY,
      energyCost: 4,
      powerCost: { fury: 2 }
    });
    const player = makePlayerState('p1', { hand: [card] });
    const result = serializePlayerState(player, 'self');
    expect(result.hand[0].rarity).toBe(CardRarity.LEGENDARY);
    expect(result.hand[0].cost).toBe(4);
    expect(result.hand[0].powerCost).toEqual({ fury: 2 });
  });

  it('serializes card with abilities', () => {
    const card = makeCreature({
      id: 'ability-card',
      abilities: [
        { name: 'Flying', description: 'Can fly', triggerType: 'passive' },
        { name: '', description: 'Unnamed ability', triggerType: 'passive' },
        { name: 'Deathtouch', description: '', triggerType: 'passive' }
      ]
    });
    const player = makePlayerState('p1', { hand: [card] });
    const result = serializePlayerState(player, 'self');
    // 'Flying' should be included; empty name falls back to description 'Unnamed ability'; 'Deathtouch' included
    expect(result.hand[0].abilities).toContain('Flying');
    expect(result.hand[0].abilities).toContain('Unnamed ability');
    expect(result.hand[0].abilities).toContain('Deathtouch');
  });

  it('returns empty ability labels for card without abilities', () => {
    const card = makeCreature({ id: 'plain', abilities: [] });
    const player = makePlayerState('p1', { hand: [card] });
    const result = serializePlayerState(player, 'self');
    expect(result.hand[0].abilities).toEqual([]);
  });

  it('handles card with null abilities', () => {
    const card = makeCreature({ id: 'no-abilities', abilities: undefined });
    const player = makePlayerState('p1', { hand: [card] });
    const result = serializePlayerState(player, 'self');
    expect(result.hand[0].abilities).toEqual([]);
  });

  it('serializes manaCost fallback when energyCost missing', () => {
    const card = makeCreature({ id: 'mana-card', energyCost: undefined, manaCost: 3 });
    const player = makePlayerState('p1', { hand: [card] });
    const result = serializePlayerState(player, 'self');
    expect(result.hand[0].cost).toBe(3);
  });

  it('returns null cost when both energyCost and manaCost missing', () => {
    const card = makeCreature({ id: 'no-cost', energyCost: undefined, manaCost: undefined });
    const player = makePlayerState('p1', { hand: [card] });
    const result = serializePlayerState(player, 'self');
    expect(result.hand[0].cost).toBeNull();
  });
});

// ===========================================================================
// activationState serialization
// ===========================================================================

describe('activationState serialization', () => {
  it('serializes activationState with history', () => {
    const boardCard = makeBoardCard({
      activationState: {
        cardId: 'board-card-1',
        isStateful: true,
        active: true,
        lastChangedAt: 1700000000000,
        history: [
          { at: 1700000000000, reason: 'card_played', active: true }
        ]
      }
    });
    const player = makePlayerState('p1', {
      board: { playerId: 'p1', creatures: [boardCard], artifacts: [], enchantments: [] }
    });
    const result = serializePlayerState(player, 'self');
    const state = result.board.creatures[0].activationState;
    expect(state).not.toBeNull();
    expect(state!.isStateful).toBe(true);
    expect(state!.active).toBe(true);
    expect(state!.lastChangedAt).toEqual(new Date(1700000000000));
    expect(state!.history).toHaveLength(1);
    expect(state!.history[0].at).toEqual(new Date(1700000000000));
    expect(state!.history[0].reason).toBe('card_played');
    expect(state!.history[0].active).toBe(true);
  });

  it('returns null activationState when missing', () => {
    const boardCard = makeBoardCard({ activationState: null as any });
    const player = makePlayerState('p1', {
      board: { playerId: 'p1', creatures: [boardCard], artifacts: [], enchantments: [] }
    });
    const result = serializePlayerState(player, 'self');
    expect(result.board.creatures[0].activationState).toBeNull();
  });
});

// ===========================================================================
// Battlefield serialization
// ===========================================================================

describe('battlefield serialization', () => {
  it('serializes battlefield with basic fields', () => {
    const bf = makeBattlefield({
      battlefieldId: 'bf-x',
      name: 'Volcano Peak',
      ownerId: 'player-1',
      controller: 'player-1',
      contestedBy: ['player-2'],
      lastConqueredTurn: 3,
      lastHoldTurn: 4,
      lastCombatTurn: 5
    });
    const state = makeMinimalGameState({ battlefields: [bf] });
    const result = serializeGameState(state);
    const serializedBf = result.battlefields[0];

    expect(serializedBf.battlefieldId).toBe('bf-x');
    expect(serializedBf.name).toBe('Volcano Peak');
    expect(serializedBf.ownerId).toBe('player-1');
    expect(serializedBf.controller).toBe('player-1');
    expect(serializedBf.contestedBy).toEqual(['player-2']);
    expect(serializedBf.lastConqueredTurn).toBe(3);
    expect(serializedBf.lastHoldTurn).toBe(4);
    expect(serializedBf.lastCombatTurn).toBe(5);
  });

  it('includes battlefield card when present', () => {
    const card = makeCreature({ id: 'bf-card-1', name: 'Battlefield Enchantment' });
    const bf = makeBattlefield({ card });
    const state = makeMinimalGameState({ battlefields: [bf] });
    const result = serializeGameState(state);
    expect(result.battlefields[0].card).not.toBeNull();
    expect(result.battlefields[0].card!.name).toBe('Battlefield Enchantment');
  });

  it('returns null card when battlefield has no card', () => {
    const bf = makeBattlefield({ card: undefined });
    const state = makeMinimalGameState({ battlefields: [bf] });
    const result = serializeGameState(state);
    expect(result.battlefields[0].card).toBeNull();
  });

  describe('hiddenCards', () => {
    it('reveals hidden card to owner', () => {
      const hiddenCard: HiddenCard = {
        instanceId: 'hc-1',
        card: makeCreature({ id: 'secret-card', name: 'Secret Creature' }),
        ownerId: 'player-1',
        hiddenOnTurn: 2,
        battlefieldId: 'bf-1'
      };
      const bf = makeBattlefield({ hiddenCards: [hiddenCard] });
      const state = makeMinimalGameState({ battlefields: [bf] });
      const result = serializeGameState(state, { viewerId: 'player-1' });
      const hc = result.battlefields[0].hiddenCards[0];
      expect(hc.isRevealed).toBe(true);
      expect(hc.card).not.toBeNull();
      expect(hc.card!.name).toBe('Secret Creature');
    });

    it('hides card details from non-owner', () => {
      const hiddenCard: HiddenCard = {
        instanceId: 'hc-2',
        card: makeCreature({ id: 'secret-card-2', name: 'Hidden Secret' }),
        ownerId: 'player-1',
        hiddenOnTurn: 1,
        battlefieldId: 'bf-1'
      };
      const bf = makeBattlefield({ hiddenCards: [hiddenCard] });
      const state = makeMinimalGameState({ battlefields: [bf] });
      const result = serializeGameState(state, { viewerId: 'player-2' });
      const hc = result.battlefields[0].hiddenCards[0];
      expect(hc.isRevealed).toBe(false);
      expect(hc.card).toBeNull();
      expect(hc.instanceId).toBe('hc-2');
      expect(hc.ownerId).toBe('player-1');
    });

    it('hides card from spectator (null viewerId)', () => {
      const hiddenCard: HiddenCard = {
        instanceId: 'hc-3',
        card: makeCreature({ id: 'spec-card', name: 'Spectator Hidden' }),
        ownerId: 'player-1',
        hiddenOnTurn: 1,
        battlefieldId: 'bf-1'
      };
      const bf = makeBattlefield({ hiddenCards: [hiddenCard] });
      const state = makeMinimalGameState({ battlefields: [bf] });
      const result = serializeGameState(state, { viewerId: null });
      expect(result.battlefields[0].hiddenCards[0].isRevealed).toBe(false);
      expect(result.battlefields[0].hiddenCards[0].card).toBeNull();
    });

    it('includes hiddenOnTurn in serialized hidden card', () => {
      const hiddenCard: HiddenCard = {
        instanceId: 'hc-4',
        card: makeCreature({ id: 'test', name: 'Test' }),
        ownerId: 'player-2',
        hiddenOnTurn: 5,
        battlefieldId: 'bf-1'
      };
      const bf = makeBattlefield({ hiddenCards: [hiddenCard] });
      const state = makeMinimalGameState({ battlefields: [bf] });
      const result = serializeGameState(state, { viewerId: 'player-2' });
      expect(result.battlefields[0].hiddenCards[0].hiddenOnTurn).toBe(5);
    });
  });

  describe('battlefield presence', () => {
    it('calculates presence from creatures on battlefield', () => {
      const creature = makeBoardCard({
        instanceId: 'pres-inst-1',
        location: { zone: 'battlefield', battlefieldId: 'bf-pres' },
        power: 5,
        currentToughness: 3
      });
      const p1 = makePlayerState('player-1', {
        board: { playerId: 'player-1', creatures: [creature], artifacts: [], enchantments: [] }
      });
      const bf = makeBattlefield({ battlefieldId: 'bf-pres' });
      const state = makeMinimalGameState({
        players: [p1, makePlayerState('player-2')],
        battlefields: [bf]
      });
      const result = serializeGameState(state);
      const presence = result.battlefields[0].presence;
      expect(presence).toHaveLength(1);
      expect(presence[0].playerId).toBe('player-1');
      expect(presence[0].totalMight).toBe(5);
      expect(presence[0].unitCount).toBe(1);
    });

    it('aggregates multiple creatures for same player', () => {
      const c1 = makeBoardCard({
        instanceId: 'c1', id: 'cid-1', name: 'C1',
        location: { zone: 'battlefield', battlefieldId: 'bf-agg' }, power: 3
      });
      const c2 = makeBoardCard({
        instanceId: 'c2', id: 'cid-2', name: 'C2',
        location: { zone: 'battlefield', battlefieldId: 'bf-agg' }, power: 4
      });
      const p1 = makePlayerState('player-1', {
        board: { playerId: 'player-1', creatures: [c1, c2], artifacts: [], enchantments: [] }
      });
      const bf = makeBattlefield({ battlefieldId: 'bf-agg' });
      const state = makeMinimalGameState({
        players: [p1, makePlayerState('player-2')],
        battlefields: [bf]
      });
      const result = serializeGameState(state);
      const presence = result.battlefields[0].presence;
      expect(presence[0].totalMight).toBe(7);
      expect(presence[0].unitCount).toBe(2);
    });

    it('excludes creatures at base or wrong battlefield', () => {
      const c1 = makeBoardCard({
        instanceId: 'base-c', location: { zone: 'base' }, power: 10
      });
      const c2 = makeBoardCard({
        instanceId: 'other-bf', id: 'other-id',
        location: { zone: 'battlefield', battlefieldId: 'bf-other' }, power: 7
      });
      const p1 = makePlayerState('player-1', {
        board: { playerId: 'player-1', creatures: [c1, c2], artifacts: [], enchantments: [] }
      });
      const bf = makeBattlefield({ battlefieldId: 'bf-correct' });
      const state = makeMinimalGameState({
        players: [p1, makePlayerState('player-2')],
        battlefields: [bf]
      });
      const result = serializeGameState(state);
      expect(result.battlefields[0].presence).toHaveLength(0);
    });

    it('uses currentToughness as might fallback when power is missing', () => {
      const creature = makeBoardCard({
        instanceId: 'tough-c',
        power: undefined as any,
        currentToughness: 6,
        location: { zone: 'battlefield', battlefieldId: 'bf-t' }
      });
      const p1 = makePlayerState('player-1', {
        board: { playerId: 'player-1', creatures: [creature], artifacts: [], enchantments: [] }
      });
      const bf = makeBattlefield({ battlefieldId: 'bf-t' });
      const state = makeMinimalGameState({
        players: [p1, makePlayerState('player-2')],
        battlefields: [bf]
      });
      const result = serializeGameState(state);
      expect(result.battlefields[0].presence[0].totalMight).toBe(6);
    });

    it('counts presence from both players', () => {
      const c1 = makeBoardCard({
        instanceId: 'p1-c', id: 'p1-id',
        location: { zone: 'battlefield', battlefieldId: 'bf-both' }, power: 2
      });
      const c2 = makeBoardCard({
        instanceId: 'p2-c', id: 'p2-id',
        location: { zone: 'battlefield', battlefieldId: 'bf-both' }, power: 3
      });
      const p1 = makePlayerState('player-1', {
        board: { playerId: 'player-1', creatures: [c1], artifacts: [], enchantments: [] }
      });
      const p2 = makePlayerState('player-2', {
        board: { playerId: 'player-2', creatures: [c2], artifacts: [], enchantments: [] }
      });
      const bf = makeBattlefield({ battlefieldId: 'bf-both' });
      const state = makeMinimalGameState({ players: [p1, p2], battlefields: [bf] });
      const result = serializeGameState(state);
      expect(result.battlefields[0].presence).toHaveLength(2);
    });
  });
});

// ===========================================================================
// buildOpponentView
// ===========================================================================

describe('buildOpponentView', () => {
  it('returns opponent player view when found', () => {
    const state = makeMinimalGameState();
    const view = buildOpponentView(state, 'player-1');

    expect(view.playerId).toBe('player-2');
    expect(view.handSize).toBe(1);
    expect(view.board).toBeDefined();
    expect(view.board.creatures).toBeDefined();
  });

  it('returns empty view when both players share the viewerId (no "other" player)', () => {
    // With only one player in the state, buildOpponentView returns empty view
    const singlePlayer = makePlayerState('player-1');
    const state = makeMinimalGameState({ players: [singlePlayer] });
    const view = buildOpponentView(state, 'player-1');

    expect(view.playerId).toBeNull();
    expect(view.victoryPoints).toBe(0);
    expect(view.handSize).toBe(0);
    expect(view.runeDeckSize).toBe(0);
    expect(view.board.creatures).toEqual([]);
    expect(view.board.artifacts).toEqual([]);
    expect(view.board.enchantments).toEqual([]);
  });

  it('hides opponent hand (returns handSize not actual cards)', () => {
    const state = makeMinimalGameState();
    const view = buildOpponentView(state, 'player-1');
    // opponent view has handSize but board doesn't expose hand cards
    expect(view.handSize).toBe(1);
    expect((view as any).hand).toBeUndefined();
  });

  it('exposes opponent victory points and score', () => {
    const p1 = makePlayerState('player-1');
    const p2 = makePlayerState('player-2', { victoryPoints: 3, victoryScore: 5 });
    const state = makeMinimalGameState({ players: [p1, p2] });
    const view = buildOpponentView(state, 'player-1');
    expect(view.victoryPoints).toBe(3);
    expect(view.victoryScore).toBe(5);
  });

  it('exposes champion cards', () => {
    const legend = makeCreature({ id: 'legend-opp', name: 'Opponent Legend' });
    const p2 = makePlayerState('player-2', { championLegend: legend });
    const state = makeMinimalGameState({
      players: [makePlayerState('player-1'), p2]
    });
    const view = buildOpponentView(state, 'player-1');
    expect(view.championLegend).not.toBeNull();
    expect(view.championLegend!.name).toBe('Opponent Legend');
  });

  it('exposes runeDeckSize accurately', () => {
    const p2 = makePlayerState('player-2', {
      runeDeck: [makeRuneCard(0), makeRuneCard(1), makeRuneCard(2)]
    });
    const state = makeMinimalGameState({
      players: [makePlayerState('player-1'), p2]
    });
    const view = buildOpponentView(state, 'player-1');
    expect(view.runeDeckSize).toBe(3);
  });

  it('exposes opponent board creatures', () => {
    const creature = makeBoardCard({ instanceId: 'opp-inst-1' });
    const p2 = makePlayerState('player-2', {
      board: { playerId: 'player-2', creatures: [creature], artifacts: [], enchantments: [] }
    });
    const state = makeMinimalGameState({
      players: [makePlayerState('player-1'), p2]
    });
    const view = buildOpponentView(state, 'player-1');
    expect(view.board.creatures).toHaveLength(1);
    expect(view.board.creatures[0].instanceId).toBe('opp-inst-1');
  });
});

// ===========================================================================
// Edge cases and null handling
// ===========================================================================

describe('edge cases', () => {
  it('handles empty players array gracefully', () => {
    const state = makeMinimalGameState({ players: [] });
    const result = serializeGameState(state);
    expect(result.players).toEqual([]);
  });

  it('handles null winner field', () => {
    const state = makeMinimalGameState({ winner: undefined });
    const result = serializeGameState(state);
    expect(result.winner).toBeNull();
  });

  it('handles explicit winner field', () => {
    const state = makeMinimalGameState({ winner: 'player-1' });
    const result = serializeGameState(state);
    expect(result.winner).toBe('player-1');
  });

  it('handles battlefields with empty hiddenCards array', () => {
    const bf = makeBattlefield({ hiddenCards: [] });
    const state = makeMinimalGameState({ battlefields: [bf] });
    const result = serializeGameState(state);
    expect(result.battlefields[0].hiddenCards).toEqual([]);
  });

  it('handles battlefields with undefined hiddenCards', () => {
    const bf = makeBattlefield({ hiddenCards: undefined as any });
    const state = makeMinimalGameState({ battlefields: [bf] });
    const result = serializeGameState(state);
    expect(result.battlefields[0].hiddenCards).toEqual([]);
  });

  it('serializes endReason when present', () => {
    const state = makeMinimalGameState({ endReason: 'concede' as any });
    const result = serializeGameState(state);
    expect(result.endReason).toBe('concede');
  });

  it('serializes multiple battlefields', () => {
    const bf1 = makeBattlefield({ battlefieldId: 'bf-1', name: 'Field One' });
    const bf2 = makeBattlefield({ battlefieldId: 'bf-2', name: 'Field Two' });
    const state = makeMinimalGameState({ battlefields: [bf1, bf2] });
    const result = serializeGameState(state);
    expect(result.battlefields).toHaveLength(2);
    expect(result.battlefields[0].battlefieldId).toBe('bf-1');
    expect(result.battlefields[1].battlefieldId).toBe('bf-2');
  });

  it('does not expose pendingEffects or pendingMainPhaseEntry', () => {
    const state = makeMinimalGameState();
    const result = serializeGameState(state);
    expect((result as any).pendingEffects).toBeUndefined();
    expect((result as any).pendingMainPhaseEntry).toBeUndefined();
  });

  it('handles focusPlayerId field', () => {
    const state = makeMinimalGameState({ focusPlayerId: 'player-1' });
    const result = serializeGameState(state);
    expect(result.focusPlayerId).toBe('player-1');
  });

  it('handles combatTurnByPlayer and effectState in battlefield', () => {
    const bf = makeBattlefield({
      combatTurnByPlayer: { 'player-1': 3, 'player-2': 2 },
      effectState: { frozen: true }
    });
    const state = makeMinimalGameState({ battlefields: [bf] });
    const result = serializeGameState(state);
    expect(result.battlefields[0].combatTurnByPlayer).toEqual({ 'player-1': 3, 'player-2': 2 });
    expect(result.battlefields[0].effectState).toEqual({ frozen: true });
  });
});
