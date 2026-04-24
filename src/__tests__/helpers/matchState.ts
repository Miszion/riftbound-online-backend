import type {
  serializeGameState,
  serializePlayerState
} from '../../game-state-serializer';
import { GamePhase, GameStatus } from '../../game-engine';

export type MatchState = ReturnType<typeof serializeGameState>;
export type PlayerState = ReturnType<typeof serializePlayerState>;

export function makePlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    playerId: 'player-1',
    name: 'Player 1',
    victoryPoints: 0,
    victoryScore: 0,
    mana: 0,
    maxMana: 0,
    handSize: 0,
    deckCount: 0,
    runeDeckSize: 0,
    hand: [],
    board: { creatures: [], artifacts: [], enchantments: [] },
    graveyard: [],
    exile: [],
    resources: {
      energy: 0,
      universalPower: 0,
      power: { fury: 0, calm: 0, mind: 0, body: 0, chaos: 0, order: 0 }
    },
    channeledRunes: [],
    runeDeck: [],
    temporaryEffects: [],
    championLegend: null,
    championLeader: null,
    championLegendState: null,
    championLeaderState: null,
    burnedOut: false,
    ...overrides,
  };
}

export function makeMatchState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: 'match-1',
    players: [],
    currentPlayerIndex: 0,
    currentPhase: GamePhase.MAIN_1,
    turnNumber: 0,
    status: GameStatus.IN_PROGRESS,
    winner: null,
    initiativeWinner: null,
    initiativeLoser: null,
    initiativeSelections: null,
    initiativeDecidedAt: null,
    moveHistory: [],
    timestamp: null,
    victoryScore: 0,
    scoreLog: [],
    turnSequenceStep: null,
    endReason: null,
    prompts: [],
    priorityWindow: null,
    snapshots: [],
    battlefields: [],
    duelLog: [],
    chatLog: [],
    focusPlayerId: null,
    combatContext: null,
    pendingSpellResolution: null,
    reactionChain: null,
    ...overrides,
  };
}
