import AWS from 'aws-sdk';
import logger from '../logger';
import {
  pubSub,
  SubscriptionEvents,
  publishGameStateChange,
  publishPlayerGameStateChange,
  publishMatchCompletion,
  publishLeaderboardUpdate,
  publishCardPlayed,
  publishAttackDeclared,
  publishPhaseChange,
} from './pubsub';
import { RiftboundGameEngine } from '../game-engine';
import {
  getCardCatalog,
  findCardById as findCatalogCardById,
  findCardBySlug as findCatalogCardBySlug,
  getImageManifest,
  buildActivationStateIndex,
} from '../card-catalog';
import type { EnrichedCardRecord } from '../card-catalog';

// Initialize AWS SDK
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

// Store active games (in match-service context)
const activeGames = new Map<string, RiftboundGameEngine>();

interface LeaderboardEntry {
  userId: string;
  username?: string;
  wins: number;
  totalMatches: number;
  winRate: number;
}

interface PublishedCard {
  cardId: string;
  name: string;
  cost: number;
  power?: number;
  toughness?: number;
  type: string;
}

interface CardCatalogFilterInput {
  search?: string;
  type?: string;
  domain?: string;
  rarity?: string;
  limit?: number;
}

// ============================================================================
// QUERY RESOLVERS
// ============================================================================

export const queryResolvers = {
  // User Queries
  async user(_parent: any, { userId }: { userId: string }) {
    try {
      const result = await dynamodb.get({
        TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
        Key: { UserId: userId }
      }).promise();

      if (!result.Item) {
        throw new Error('User not found');
      }

      return {
        userId: result.Item.UserId,
        username: result.Item.Username,
        email: result.Item.Email,
        userLevel: result.Item.UserLevel,
        wins: result.Item.Wins,
        totalMatches: result.Item.TotalMatches,
        lastLogin: result.Item.LastLogin ? new Date(result.Item.LastLogin) : null,
        createdAt: result.Item.CreatedAt ? new Date(result.Item.CreatedAt) : null,
      };
    } catch (error) {
      logger.error('Error fetching user:', error);
      throw error;
    }
  },

  async leaderboard(_parent: any, { limit = 100 }: { limit?: number }) {
    try {
      return await fetchLeaderboardEntries(limit);
    } catch (error) {
      logger.error('Error fetching leaderboard:', error);
      throw error;
    }
  },

  // Match Queries
  match(_parent: any, { matchId }: { matchId: string }) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }
      return engine.getGameState();
    } catch (error) {
      logger.error('Error fetching match:', error);
      throw error;
    }
  },

  playerMatch(_parent: any, { matchId, playerId }: { matchId: string; playerId: string }) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      const playerState = engine.getPlayerState(playerId);
      if (!playerState) {
        throw new Error('Player not found in match');
      }

      const opponentState = engine.getGameState().players.find((p: any) => p.playerId !== playerId);

      return {
        matchId,
        currentPlayer: playerState,
        opponent: {
          playerId: opponentState?.playerId,
          health: opponentState?.health,
          handSize: opponentState?.hand?.length || 0,
          board: opponentState?.board || [],
        },
        gameState: {
          matchId,
          currentPhase: engine.getGameState().currentPhase,
          turnNumber: engine.getGameState().turnNumber,
          currentPlayerIndex: engine.getGameState().currentPlayerIndex,
          canAct: engine.canPlayerAct(playerId),
        },
      };
    } catch (error) {
      logger.error('Error fetching player match:', error);
      throw error;
    }
  },

  async matchHistory(_parent: any, { userId, limit = 10 }: { userId: string; limit?: number }) {
    try {
      const result = await dynamodb.query({
        TableName: process.env.MATCH_HISTORY_TABLE || 'riftbound-online-match-history-dev',
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'UserId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
        Limit: limit,
        ScanIndexForward: false,
      }).promise();

      return (result.Items || []).map((item: any) => ({
        matchId: item.MatchId,
        timestamp: new Date(item.Timestamp),
        players: item.Players || [],
        winner: item.Winner,
        loser: item.Loser,
        duration: item.Duration,
        turns: item.Turns,
        moveCount: item.MoveCount,
        status: item.Status || 'completed',
      }));
    } catch (error) {
      logger.error('Error fetching match history:', error);
      throw error;
    }
  },

  async matchResult(_parent: any, { matchId }: { matchId: string }) {
    try {
      const result = await dynamodb.get({
        TableName: process.env.MATCH_TABLE || 'riftbound-online-matches-dev',
        Key: { MatchId: matchId }
      }).promise();

      if (!result.Item) {
        return null;
      }

      return {
        matchId: result.Item.MatchId,
        winner: result.Item.Winner,
        loser: result.Item.Loser,
        reason: result.Item.Reason,
        duration: result.Item.Duration,
        turns: result.Item.Turns,
        moves: result.Item.MoveCount,
      };
    } catch (error) {
      logger.error('Error fetching match result:', error);
      throw error;
    }
  },

  cardCatalog(_parent: any, { filter }: { filter?: CardCatalogFilterInput }) {
    try {
      const catalog = getCardCatalog();
      let filtered: EnrichedCardRecord[] = catalog;

      if (filter?.search) {
        const term = filter.search.toLowerCase();
        filtered = filtered.filter(
          (card) =>
            card.name.toLowerCase().includes(term) ||
            card.effect.toLowerCase().includes(term) ||
            card.tags.some((tag) => tag.toLowerCase().includes(term)) ||
            card.keywords.some((keyword) => keyword.toLowerCase().includes(term))
        );
      }

      if (filter?.type) {
        const normalizedType = filter.type.toLowerCase();
        filtered = filtered.filter((card) => card.type?.toLowerCase() === normalizedType);
      }

      if (filter?.domain) {
        const normalizedDomain = filter.domain.toLowerCase();
        filtered = filtered.filter((card) =>
          card.colors.some((color) => color.toLowerCase() === normalizedDomain)
        );
      }

      if (filter?.rarity) {
        const normalizedRarity = filter.rarity.toLowerCase();
        filtered = filtered.filter((card) => card.rarity?.toLowerCase() === normalizedRarity);
      }

      if (filter?.limit && filter.limit > 0) {
        filtered = filtered.slice(0, filter.limit);
      }

      return filtered;
    } catch (error) {
      logger.error('Error fetching card catalog:', error);
      throw error;
    }
  },

  cardById(_parent: any, { id }: { id: string }) {
    return findCatalogCardById(id);
  },

  cardBySlug(_parent: any, { slug }: { slug: string }) {
    return findCatalogCardBySlug(slug);
  },

  cardImageManifest() {
    return getImageManifest();
  },

  cardActivationStates() {
    return Object.values(buildActivationStateIndex());
  },
};

// ============================================================================
// MUTATION RESOLVERS
// ============================================================================

export const mutationResolvers = {
  async updateUser(
    _parent: any,
    {
      userId,
      username,
      userLevel,
      wins,
      totalMatches,
    }: {
      userId: string;
      username?: string;
      userLevel?: number;
      wins?: number;
      totalMatches?: number;
    }
  ) {
    try {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};
      let index = 0;

      if (username) {
        updateExpressions.push(`#n = :${index}`);
        expressionAttributeNames['#n'] = 'Username';
        expressionAttributeValues[`:${index}`] = username;
        index++;
      }

      if (userLevel !== undefined) {
        updateExpressions.push(`#l = :${index}`);
        expressionAttributeNames['#l'] = 'UserLevel';
        expressionAttributeValues[`:${index}`] = userLevel;
        index++;
      }

      if (wins !== undefined) {
        updateExpressions.push(`#w = :${index}`);
        expressionAttributeNames['#w'] = 'Wins';
        expressionAttributeValues[`:${index}`] = wins;
        index++;
      }

      if (totalMatches !== undefined) {
        updateExpressions.push(`#tm = :${index}`);
        expressionAttributeNames['#tm'] = 'TotalMatches';
        expressionAttributeValues[`:${index}`] = totalMatches;
        index++;
      }

      updateExpressions.push(`#ll = :${index}`);
      expressionAttributeNames['#ll'] = 'LastLogin';
      expressionAttributeValues[`:${index}`] = Date.now();

      const result = await dynamodb.update({
        TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
        Key: { UserId: userId },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      }).promise();

      const item = result.Attributes;
      if (!item) {
        throw new Error('Failed to update user');
      }

      const updatedUser = {
        userId: item.UserId,
        username: item.Username,
        email: item.Email,
        userLevel: item.UserLevel,
        wins: item.Wins,
        totalMatches: item.TotalMatches,
        lastLogin: item.LastLogin ? new Date(item.LastLogin) : null,
        createdAt: item.CreatedAt ? new Date(item.CreatedAt) : null,
      };

      await broadcastLeaderboardUpdate();
      return updatedUser;
    } catch (error) {
      logger.error('Error updating user:', error);
      throw error;
    }
  },

  async initMatch(
    _parent: any,
    {
      matchId,
      player1,
      player2,
      decks,
    }: {
      matchId: string;
      player1: string;
      player2: string;
      decks: any;
    }
  ) {
    try {
      if (activeGames.has(matchId)) {
        throw new Error('Match already exists');
      }

      const engine = new RiftboundGameEngine(matchId, [player1, player2]);
      engine.initializeGame(decks);

      activeGames.set(matchId, engine);

      // Save initial state
      await saveGameState(matchId, engine);

      const gameState = engine.getGameState();

      logger.info(`[MATCH-INIT] Match ${matchId} initialized between ${player1} and ${player2}`);

      return {
        matchId,
        status: 'initialized',
        players: [player1, player2],
        gameState,
      };
    } catch (error) {
      logger.error('[MATCH-INIT] Error:', error);
      throw error;
    }
  },

  async playCard(
    _parent: any,
    {
      matchId,
      playerId,
      cardIndex,
      targets,
    }: {
      matchId: string;
      playerId: string;
      cardIndex: number;
      targets?: string[];
    }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      if (!engine.canPlayerAct(playerId)) {
        throw new Error('Not your turn');
      }

      const playerView = engine.getPlayerState(playerId);
      const selectedCard = playerView?.hand?.[cardIndex];
      const cardSnapshot: PublishedCard | null = selectedCard
        ? {
            cardId: selectedCard.id,
            name: selectedCard.name,
            cost: selectedCard.energyCost ?? selectedCard.manaCost ?? 0,
            power: selectedCard.power ?? 0,
            toughness: selectedCard.toughness ?? 0,
            type: selectedCard.type,
          }
        : null;

      engine.playCard(playerId, cardIndex, targets);
      await saveGameState(matchId, engine);

      const gameState = engine.getGameState();

      // Publish real-time update
      publishGameStateChange(matchId, gameState);
      publishPlayerGameStateChange(matchId, playerId, {
        matchId,
        currentPlayer: engine.getPlayerState(playerId),
        opponent: {
          playerId: gameState.players.find((p: any) => p.playerId !== playerId)?.playerId,
          health: gameState.players.find((p: any) => p.playerId !== playerId)?.health,
          handSize: gameState.players.find((p: any) => p.playerId !== playerId)?.hand?.length || 0,
          board: gameState.players.find((p: any) => p.playerId !== playerId)?.board || [],
        },
        gameState: {
          matchId,
          currentPhase: gameState.currentPhase,
          turnNumber: gameState.turnNumber,
          currentPlayerIndex: gameState.currentPlayerIndex,
          canAct: engine.canPlayerAct(playerId),
        },
      });

      if (cardSnapshot) {
        publishCardPlayed(matchId, {
          matchId,
          playerId,
          card: cardSnapshot,
          timestamp: new Date(),
        });
      }

      logger.info(`[PLAY-CARD] Player ${playerId} played card in match ${matchId}`);

      return {
        success: true,
        gameState,
        currentPhase: gameState.currentPhase,
      };
    } catch (error: any) {
      logger.error('[PLAY-CARD] Error:', error);
      throw error;
    }
  },

  async attack(
    _parent: any,
    {
      matchId,
      playerId,
      creatureInstanceId,
      defenderId,
    }: {
      matchId: string;
      playerId: string;
      creatureInstanceId: string;
      defenderId?: string;
    }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      if (!engine.canPlayerAct(playerId)) {
        throw new Error('Not your turn');
      }

      engine.declareAttacker(playerId, creatureInstanceId, defenderId);
      await saveGameState(matchId, engine);

      const gameState = engine.getGameState();

      // Publish real-time update
      publishGameStateChange(matchId, gameState);
      publishAttackDeclared(matchId, {
        matchId,
        playerId,
        creatureInstanceId,
        defenderId,
        timestamp: new Date(),
      });

      logger.info(`[ATTACK] Player ${playerId} declared attack in match ${matchId}`);

      return {
        success: true,
        gameState,
        currentPhase: gameState.currentPhase,
      };
    } catch (error: any) {
      logger.error('[ATTACK] Error:', error);
      throw error;
    }
  },

  async nextPhase(
    _parent: any,
    { matchId, playerId }: { matchId: string; playerId: string }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      if (!engine.canPlayerAct(playerId)) {
        throw new Error('Not your turn');
      }

      engine.proceedToNextPhase();
      await saveGameState(matchId, engine);

      const gameState = engine.getGameState();

      // Publish real-time update
      publishGameStateChange(matchId, gameState);
      publishPhaseChange(matchId, {
        matchId,
        newPhase: gameState.currentPhase,
        turnNumber: gameState.turnNumber,
        timestamp: new Date(),
      });

      logger.info(`[NEXT-PHASE] Player ${playerId} advanced phase in match ${matchId}`);

      return {
        success: true,
        gameState,
        currentPhase: gameState.currentPhase,
      };
    } catch (error: any) {
      logger.error('[NEXT-PHASE] Error:', error);
      throw error;
    }
  },

  async reportMatchResult(
    _parent: any,
    { matchId, winner, reason }: { matchId: string; winner: string; reason: string }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      const gameState = engine.getGameState();
      const matchResult = {
        matchId,
        winner,
        loser: gameState.players.find((p: any) => p.playerId !== winner)?.playerId,
        reason: reason || 'health_depletion',
        duration: Date.now() - gameState.timestamp,
        turns: gameState.turnNumber,
        moves: gameState.moveHistory || [],
      };

      // Save to DynamoDB
      await dynamodb.put({
        TableName: process.env.MATCH_TABLE || 'riftbound-online-matches-dev',
        Item: {
          MatchId: matchId,
          Winner: matchResult.winner,
          Loser: matchResult.loser,
          Reason: matchResult.reason,
          Duration: matchResult.duration,
          Turns: matchResult.turns,
          MoveCount: matchResult.moves.length,
          CreatedAt: Date.now(),
          Status: 'completed',
        },
      }).promise();

      activeGames.delete(matchId);

      // Publish match completion
      publishMatchCompletion(matchId, matchResult);

      logger.info(`[MATCH-COMPLETE] Match ${matchId} completed. Winner: ${winner}`);

      return {
        success: true,
        matchResult,
      };
    } catch (error) {
      logger.error('[RESULT] Error:', error);
      throw error;
    }
  },

  async concedeMatch(
    _parent: any,
    { matchId, playerId }: { matchId: string; playerId: string }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      const gameState = engine.getGameState();
      const opponent = gameState.players.find((p: any) => p.playerId !== playerId);
      if (!opponent) {
        throw new Error('Opponent not found');
      }

      const matchResult = {
        matchId,
        winner: opponent.playerId,
        loser: playerId,
        reason: 'concede',
        duration: Date.now() - gameState.timestamp,
        turns: gameState.turnNumber,
        moves: gameState.moveHistory || [],
      };

      // Save to DynamoDB
      await dynamodb.put({
        TableName: process.env.MATCH_TABLE || 'riftbound-online-matches-dev',
        Item: {
          MatchId: matchId,
          Winner: matchResult.winner,
          Loser: matchResult.loser,
          Reason: matchResult.reason,
          Duration: matchResult.duration,
          Turns: matchResult.turns,
          MoveCount: matchResult.moves.length,
          CreatedAt: Date.now(),
          Status: 'completed',
        },
      }).promise();

      activeGames.delete(matchId);

      // Publish match completion
      publishMatchCompletion(matchId, matchResult);

      logger.info(`[MATCH-CONCEDE] Match ${matchId} ended. Winner: ${opponent.playerId}`);

      return {
        success: true,
        matchResult,
      };
    } catch (error) {
      logger.error('[CONCEDE] Error:', error);
      throw error;
    }
  },
};

// ============================================================================
// SUBSCRIPTION RESOLVERS
// ============================================================================

export const subscriptionResolvers = {
  gameStateChanged: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.GAME_STATE_CHANGED}:${matchId}`]);
    },
  },

  playerGameStateChanged: {
    subscribe: (_parent: any, { matchId, playerId }: { matchId: string; playerId: string }) => {
      return pubSub.asyncIterator([
        `${SubscriptionEvents.PLAYER_GAME_STATE_CHANGED}:${matchId}:${playerId}`,
      ]);
    },
  },

  matchCompleted: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.MATCH_COMPLETED}:${matchId}`]);
    },
  },

  leaderboardUpdated: {
    subscribe: () => {
      return pubSub.asyncIterator([SubscriptionEvents.LEADERBOARD_UPDATED]);
    },
  },

  cardPlayed: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.CARD_PLAYED}:${matchId}`]);
    },
  },

  attackDeclared: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.ATTACK_DECLARED}:${matchId}`]);
    },
  },

  phaseChanged: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.PHASE_CHANGED}:${matchId}`]);
    },
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function fetchLeaderboardEntries(limit = 100): Promise<LeaderboardEntry[]> {
  const result = await dynamodb.scan({
    TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
    Limit: limit
  }).promise();

  return (result.Items || [])
    .map((item: any) => ({
      userId: item.UserId,
      username: item.Username,
      wins: item.Wins || 0,
      totalMatches: item.TotalMatches || 0,
      winRate: item.TotalMatches ? ((item.Wins || 0) / item.TotalMatches) : 0,
    }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, limit);
}

async function broadcastLeaderboardUpdate(limit = 100): Promise<void> {
  try {
    const leaderboard = await fetchLeaderboardEntries(limit);
    publishLeaderboardUpdate(leaderboard);
  } catch (error) {
    logger.error('[LEADERBOARD] Failed to publish update:', error);
  }
}

async function saveGameState(matchId: string, engine: RiftboundGameEngine): Promise<void> {
  try {
    const gameState = engine.getGameState();
    await dynamodb.put({
      TableName: process.env.STATE_TABLE || 'riftbound-online-match-states-dev',
      Item: {
        MatchId: matchId,
        GameState: gameState,
        Timestamp: Date.now(),
        Status: gameState.status,
        TurnNumber: gameState.turnNumber,
        CurrentPhase: gameState.currentPhase,
      },
    }).promise();
  } catch (error) {
    logger.error('[STATE-SAVE] Failed to save game state:', error);
  }
}

// Export active games map for use in server setup
export { activeGames };
