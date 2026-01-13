import type {
  BattlefieldState,
  BoardCard,
  Card,
  CardLocation,
  ChatMessage,
  DuelLogEntry,
  GamePrompt,
  GameState,
  GameStateSnapshot,
  PlayerState,
  PlayerBoard,
  PriorityWindow,
  RuneCard,
  TemporaryEffect,
  ChampionAbilityRuntimeState
} from './game-engine';

export type PlayerVisibility = 'self' | 'opponent' | 'spectator';

interface SerializeGameStateOptions {
  viewerId?: string | null;
}

const toDate = (value?: number | null): Date | null => {
  if (!value && value !== 0) {
    return null;
  }
  try {
    return new Date(value);
  } catch {
    return null;
  }
};

const abilityLabels = (card: Card): string[] => {
  if (!card.abilities || card.abilities.length === 0) {
    return [];
  }
  return card.abilities
    .map((ability) => ability.name || ability.description || '')
    .filter((label): label is string => Boolean(label && label.trim().length > 0));
};

const isBoardCard = (card: Card | BoardCard): card is BoardCard => {
  return typeof (card as BoardCard).instanceId === 'string';
};

const serializeLocation = (location?: CardLocation | null) => {
  if (!location) {
    return null;
  }
  if (location.zone === 'base') {
    return {
      zone: 'base',
      battlefieldId: null
    };
  }
  return {
    zone: 'battlefield',
    battlefieldId: location.battlefieldId
  };
};

const serializeActivationState = (card: BoardCard) => {
  const state = card.activationState;
  if (!state) {
    return null;
  }

  return {
    cardId: state.cardId,
    isStateful: state.isStateful,
    active: state.active,
    lastChangedAt: toDate(state.lastChangedAt),
    history:
      state.history?.map((entry) => ({
        at: toDate(entry.at),
        reason: entry.reason,
        active: entry.active
      })) ?? []
  };
};

const serializeCardSnapshot = (card: Card | BoardCard) => {
  const resolvedInstanceId =
    (isBoardCard(card) ? card.instanceId : (card as Card).instanceId) ?? null;
  const base = {
    cardId: card.id,
    instanceId: resolvedInstanceId,
    name: card.name,
    type: card.type,
    rarity: card.rarity ?? null,
    cost: card.energyCost ?? card.manaCost ?? null,
    powerCost: card.powerCost ?? null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    currentToughness: isBoardCard(card) ? card.currentToughness ?? card.toughness ?? null : card.toughness ?? null,
    keywords: card.keywords ?? [],
    tags: card.tags ?? [],
    abilities: abilityLabels(card),
    text: card.text ?? null,
    effect: card.text ?? null,
    assets: card.assets ?? null,
    metadata: card.metadata ?? null,
    location: null as ReturnType<typeof serializeLocation>,
    isTapped: card.isTapped ?? null,
    tapped: card.isTapped ?? null
  };

  if (!isBoardCard(card)) {
    return {
      ...base,
      summoned: null,
      counters: null,
      activationState: null,
      location: null
    };
  }

  const permanentTapped = card.isTapped === true;
  return {
    ...base,
    isTapped: permanentTapped,
    tapped: permanentTapped,
    summoned: card.summoned,
    counters: card.counters ?? null,
    activationState: serializeActivationState(card),
    location: serializeLocation(card.location)
  };
};

const serializeCardZone = (cards: (Card | BoardCard)[]) => cards.map((card) => serializeCardSnapshot(card));

const serializePlayerBoard = (board: PlayerBoard) => ({
  creatures: serializeCardZone(board.creatures),
  artifacts: serializeCardZone(board.artifacts),
  enchantments: serializeCardZone(board.enchantments)
});

const serializeBattlefieldState = (state: GameState, battlefield: BattlefieldState) => ({
  battlefieldId: battlefield.battlefieldId,
  slug: battlefield.slug ?? null,
  name: battlefield.name,
  ownerId: battlefield.ownerId,
  controller: battlefield.controller ?? null,
  contestedBy: battlefield.contestedBy,
  lastConqueredTurn: battlefield.lastConqueredTurn ?? null,
  lastHoldTurn: battlefield.lastHoldTurn ?? null,
  lastCombatTurn: battlefield.lastCombatTurn ?? null,
  lastHoldScoreTurn: battlefield.lastHoldScoreTurn ?? null,
  combatTurnByPlayer: battlefield.combatTurnByPlayer ?? null,
  effectState: battlefield.effectState ?? null,
  presence: resolveBattlefieldPresence(state, battlefield),
  card: battlefield.card ? serializeCardSnapshot(battlefield.card) : null
});

const resolveBattlefieldPresence = (state: GameState, battlefield: BattlefieldState) => {
  const track = new Map<string, { playerId: string; totalMight: number; unitCount: number }>();
  state.players.forEach((player) => {
    player.board.creatures.forEach((creature) => {
      if (
        creature.location.zone === 'battlefield' &&
        creature.location.battlefieldId === battlefield.battlefieldId
      ) {
        const key = player.playerId;
        const record =
          track.get(key) ??
          {
            playerId: key,
            totalMight: 0,
            unitCount: 0
          };
        const might =
          typeof creature.power === 'number'
            ? creature.power
            : typeof creature.currentToughness === 'number'
              ? creature.currentToughness
              : 0;
        record.totalMight += Number.isFinite(might) ? might : 0;
        record.unitCount += 1;
        track.set(key, record);
      }
    });
  });
  return Array.from(track.values());
};

const resolveRuneSnapshot = (rune: RuneCard): Card | null => {
  return rune.cardSnapshot ?? null;
};

const serializeRuneCard = (rune: RuneCard) => {
  const snapshot = resolveRuneSnapshot(rune);
  const tapped = rune.isTapped === true;
  return {
    runeId: rune.id,
    name: rune.name,
    domain: rune.domain ?? null,
    energyValue: rune.energyValue ?? null,
    powerValue: rune.powerValue ?? null,
    slug: rune.slug ?? null,
    assets: rune.assets ?? null,
    isTapped: tapped,
    tapped,
    cardSnapshot: snapshot ? serializeCardSnapshot(snapshot) : null
  };
};

const serializeTemporaryEffect = (effect: TemporaryEffect) => ({
  id: effect.id,
  affectedCards: effect.affectedCards ?? [],
  affectedPlayer: effect.affectedPlayer ?? null,
  duration: effect.duration,
  effect: {
    type: effect.effect.type,
    value: effect.effect.value ?? null
  }
});

const serializePrompt = (prompt: GamePrompt) => ({
  id: prompt.id,
  type: prompt.type,
  playerId: prompt.playerId,
  data: prompt.data,
  resolved: prompt.resolved,
  createdAt: toDate(prompt.createdAt),
  resolvedAt: toDate(prompt.resolvedAt),
  resolution: prompt.resolution ?? null
});

const serializePriorityWindow = (window: PriorityWindow | null) => {
  if (!window) {
    return null;
  }
  return {
    id: window.id,
    type: window.type,
    holder: window.holder,
    openedAt: toDate(window.openedAt),
    expiresAt: window.expiresAt ? toDate(window.expiresAt) : null,
    event: window.event ?? null
  };
};

const serializeSnapshot = (snapshot: GameStateSnapshot) => ({
  turn: snapshot.turn,
  phase: snapshot.phase,
  timestamp: toDate(snapshot.timestamp),
  reason: snapshot.reason,
  summary: snapshot.summary
});

const serializeDuelLogEntry = (entry: DuelLogEntry) => ({
  id: entry.id,
  message: entry.message,
  tone: entry.tone,
  playerId: entry.playerId ?? null,
  actorName: entry.actorName ?? null,
  timestamp: toDate(entry.timestamp)
});

const serializeChatMessage = (entry: ChatMessage) => ({
  id: entry.id,
  playerId: entry.playerId ?? null,
  playerName: entry.playerName ?? null,
  message: entry.message,
  timestamp: toDate(entry.timestamp)
});

const serializeChampionAbilityState = (
  state?: ChampionAbilityRuntimeState | null
): {
  canActivate: boolean;
  hasManualActivation: boolean;
  reason: string | null;
  costSummary: string | null;
  cost: {
    energy: number;
    runes: Record<string, number | null | undefined>;
    exhausts: boolean;
  } | null;
} | null => {
  if (!state) {
    return null;
  }
  return {
    canActivate: state.canActivate,
    hasManualActivation: state.hasManualActivation,
    reason: state.reason ?? null,
    costSummary: state.costSummary ?? null,
    cost: state.cost
      ? {
          energy: state.cost.energy,
          runes: state.cost.runes,
          exhausts: state.cost.requiresExhaust
        }
      : null
  };
};

export const serializePlayerState = (player: PlayerState, visibility: PlayerVisibility) => {
  const hideHand = visibility === 'opponent';
  const hideRuneDeck = visibility === 'opponent';
  const includeChampionStatus = visibility !== 'opponent';

  return {
    playerId: player.playerId,
    name: player.name,
    victoryPoints: player.victoryPoints,
    victoryScore: player.victoryScore,
    mana: player.mana,
    maxMana: player.maxMana,
    handSize: player.hand.length,
    deckCount: player.deck.length,
    runeDeckSize: player.runeDeck.length,
    hand: hideHand ? [] : serializeCardZone(player.hand),
    board: serializePlayerBoard(player.board),
    graveyard: serializeCardZone(player.graveyard),
    exile: serializeCardZone(player.exile),
    resources: {
      energy: player.resources.energy,
      universalPower: player.resources.universalPower,
      power: { ...player.resources.power }
    },
    channeledRunes: player.channeledRunes.map(serializeRuneCard),
    runeDeck: hideRuneDeck ? [] : player.runeDeck.map(serializeRuneCard),
    temporaryEffects: player.temporaryEffects.map(serializeTemporaryEffect),
    championLegend: player.championLegend ? serializeCardSnapshot(player.championLegend) : null,
    championLeader: player.championLeader ? serializeCardSnapshot(player.championLeader) : null,
    championLegendState: includeChampionStatus
      ? serializeChampionAbilityState(player.championLegendStatus)
      : null,
    championLeaderState: includeChampionStatus
      ? serializeChampionAbilityState(player.championLeaderStatus)
      : null
  };
};

export const serializeGameState = (state: GameState, options?: SerializeGameStateOptions) => {
  const viewerId = options?.viewerId ?? null;
  const duelLogEntries = Array.isArray(state.duelLog) ? state.duelLog : [];
  const chatLogEntries = Array.isArray(state.chatLog) ? state.chatLog : [];
  return {
    matchId: state.matchId,
    players: state.players.map((player) =>
      serializePlayerState(
        player,
        viewerId
          ? viewerId === player.playerId
            ? 'self'
            : 'opponent'
          : 'spectator'
      )
    ),
    currentPlayerIndex: state.currentPlayerIndex,
    currentPhase: state.currentPhase,
    turnNumber: state.turnNumber,
    status: state.status,
    winner: state.winner ?? null,
    initiativeWinner: state.initiativeWinner ?? null,
    initiativeLoser: state.initiativeLoser ?? null,
    initiativeSelections: state.initiativeSelections ?? null,
    initiativeDecidedAt: toDate(state.initiativeDecidedAt ?? null),
    moveHistory: state.moveHistory,
    timestamp: toDate(state.timestamp),
    victoryScore: state.victoryScore,
    scoreLog: state.scoreLog.map((entry) => ({
      playerId: entry.playerId,
      amount: entry.amount,
      reason: entry.reason,
      sourceCardId: entry.sourceCardId ?? null,
      timestamp: toDate(entry.timestamp)
    })),
    turnSequenceStep: state.turnSequenceStep ?? null,
    endReason: state.endReason ?? null,
    prompts: state.prompts.map(serializePrompt),
    priorityWindow: serializePriorityWindow(state.priorityWindow),
    snapshots: state.snapshots.map(serializeSnapshot),
    battlefields: state.battlefields.map((battlefield) =>
      serializeBattlefieldState(state, battlefield)
    ),
    duelLog: duelLogEntries.map(serializeDuelLogEntry),
    chatLog: chatLogEntries.map(serializeChatMessage),
    focusPlayerId: state.focusPlayerId ?? null,
    combatContext: state.combatContext
      ? {
          battlefieldId: state.combatContext.battlefieldId,
          initiatedBy: state.combatContext.initiatedBy,
          defendingPlayerId: state.combatContext.defendingPlayerId ?? null,
          attackingUnitIds: state.combatContext.attackingUnitIds ?? [],
          defendingUnitIds: state.combatContext.defendingUnitIds ?? [],
          priorityStage: state.combatContext.priorityStage
        }
      : null
  };
};

export const buildOpponentView = (state: GameState, playerId: string) => {
  const opponent = state.players.find((p) => p.playerId !== playerId);
  if (!opponent) {
    return {
      playerId: null,
      victoryPoints: 0,
      victoryScore: state.victoryScore,
      handSize: 0,
      runeDeckSize: 0,
      board: {
        creatures: [],
        artifacts: [],
        enchantments: []
      }
    };
  }

  const snapshot = serializePlayerState(opponent, 'opponent');
  return {
    playerId: opponent.playerId,
    victoryPoints: opponent.victoryPoints,
    victoryScore: opponent.victoryScore ?? state.victoryScore,
    handSize: opponent.hand?.length || 0,
    runeDeckSize: snapshot.runeDeckSize ?? opponent.runeDeck?.length ?? 0,
    board: snapshot.board || {
      creatures: [],
      artifacts: [],
      enchantments: []
    },
    championLegend: snapshot.championLegend ?? null,
    championLeader: snapshot.championLeader ?? null
  };
};
