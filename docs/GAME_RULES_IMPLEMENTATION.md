# Game Rules & Match Service Implementation Guide

This guide connects the Riftbound TCG rules to the actual match service implementation, helping developers understand how game rules are enforced in `src/game-engine.ts`.

## Table of Contents

1. [Game Setup & Initialization](#game-setup--initialization)
2. [Turn Structure Implementation](#turn-structure-implementation)
3. [Card Play & Validation](#card-play--validation)
4. [Combat System](#combat-system)
5. [Resource Management](#resource-management)
6. [Win Conditions](#win-conditions)
7. [Testing Checklist](#testing-checklist)

## Game Setup & Initialization

### Rules Reference
- **Main Deck**: 40+ cards minimum
- **Rune Deck**: 12 runes
- **Champion Legend**: Determines domain identity
- **Chosen Champion**: Unit matching champion domain
- **Starting Health**: 21 (standard 1v1 format)
- **Starting Hand**: 4 cards after mulligan

### Implementation in `game-engine.ts`

```typescript
class RiftboundGameEngine {
  // Constructor initializes game state
  constructor(player1Deck, player2Deck, championLegends) {
    this.players = [
      { 
        id: 'p1',
        health: 21,
        maxHealth: 21,
        deck: player1Deck,
        hand: [],
        board: { units: [], gear: [] },
        resources: { energy: 0, power: {} }
      },
      { 
        id: 'p2',
        health: 21,
        maxHealth: 21,
        deck: player2Deck,
        hand: [],
        board: { units: [], gear: [] },
        resources: { energy: 0, power: {} }
      }
    ]
    
    // Draw 4 cards for mulligan
    this.players.forEach(p => {
      for (let i = 0; i < 4; i++) {
        p.hand.push(this.drawCard(p.id));
      }
    });
  }
  
  // Mulligan system
  mulligan(playerId, cardsToReturn) {
    const player = this.getPlayer(playerId);
    // Remove specified cards, shuffle back into deck
    // Draw same number
    cardsToReturn.forEach(cardId => {
      player.deck.push(player.hand.find(c => c.id === cardId));
    });
    // Redraw
    for (let i = 0; i < cardsToReturn.length; i++) {
      player.hand.push(this.drawCard(playerId));
    }
  }
}
```

**Required Validations**:
- ✅ Deck has minimum 40 cards
- ✅ Rune deck has exactly 12 runes  
- ✅ Cards match domain identity
- ✅ No more than 3 copies of same card
- ✅ Champion unit matches champion legend tag

## Turn Structure Implementation

### Rules Reference (Rules 310-340)

**Turn Phases**:
1. **Beginning Phase** (315)
   - Rune Channel Step: Channel up to 2 runes
   - Draw Step: Draw 1 card
   - Custom effects trigger

2. **Main Phase 1** (320)
   - Play units, gear, spells

3. **Combat Phase** (330+)
   - Declare battles
   - Showdown combat resolution

4. **Main Phase 2** (325)
   - Play units, gear, spells (again)

5. **End Step**
   - Cleanup: Discard to 7 card hand
   - Temporary effects expire

### Implementation in `game-engine.ts`

```typescript
class RiftboundGameEngine {
  beginTurn(playerId) {
    this.currentPhase = 'BEGIN';
    this.turnPlayer = playerId;
    
    // Rune Channel Step
    this.channelRunes(playerId, 2); // Up to 2 runes from deck
    
    // Draw Step  
    const card = this.drawCard(playerId);
    if (!card) {
      this.burnOut(playerId); // No cards to draw = burn out
    }
    
    // Trigger any beginning-of-turn effects
    this.triggerAbilities(playerId, 'begin-of-turn');
    
    this.currentPhase = 'MAIN_1';
  }
  
  playCard(playerId, cardId, targetId) {
    if (this.currentPhase !== 'MAIN_1' && this.currentPhase !== 'MAIN_2') {
      throw new Error('Can only play cards in Main phases');
    }
    
    const player = this.getPlayer(playerId);
    const card = player.hand.find(c => c.id === cardId);
    
    // Validate resources
    const cost = this.calculateCost(card, player);
    if (!this.canPayCost(player, cost)) {
      throw new Error('Insufficient resources');
    }
    
    // Pay cost
    this.payCost(player, cost);
    
    // Play the card
    this.playCardToBoard(card, player, targetId);
    
    // Trigger play effects
    this.triggerAbilities(card, 'play', player);
    
    // Remove from hand
    player.hand = player.hand.filter(c => c.id !== cardId);
  }
  
  endPhase() {
    const player = this.getPlayer(this.turnPlayer);
    
    // Discard down to 7 cards
    while (player.hand.length > 7) {
      // Player chooses which to discard
      // (In API: /action?type=discard&card=<id>)
    }
    
    // Clear temporary effects
    player.temporaryEffects.forEach(effect => {
      effect.duration--;
      if (effect.duration <= 0) {
        this.removeEffect(effect);
      }
    });
    
    // Pass turn to next player
    this.turnPlayer = this.getNextPlayer(this.turnPlayer);
    this.beginTurn(this.turnPlayer);
  }
}
```

**Key Methods Required**:
- `channelRunes(playerId, count)` - Draw runes from rune deck
- `drawCard(playerId)` - Draw from main deck
- `playCard(playerId, cardId, target)` - Play card from hand
- `endPhase()` - Transition to next phase
- `calculateCost(card, player)` - Determine energy/power needed
- `canPayCost(player, cost)` - Check if player has resources

## Card Play & Validation

### Rules Reference

**Card Types**:
- **Units**: Power/Toughness, stay on board after play
- **Gear**: Attach to units, stay on board
- **Spells**: Resolve then go to trash
- **Runes**: Channeled (not played), produce resources

**Play Validation** (Rule 346):
- Cost must be payable
- Card must be in hand (except Chosen Champion from zone)
- Type-specific rules apply
- Domain identity restrictions

### Implementation

```typescript
playCard(playerId, cardId, targetId?) {
  const player = this.getPlayer(playerId);
  const card = player.hand.find(c => c.id === cardId);
  
  if (!card) {
    throw new Error('Card not in hand');
  }
  
  // 1. Check phase
  if (card.type === 'SPELL') {
    if (this.chainState === 'CLOSED') {
      throw new Error('Cannot play spells during chain');
    }
  }
  
  // 2. Calculate cost
  const cost = {
    energy: card.energyCost,
    power: card.powerCost // { [domain]: amount }
  };
  
  // 3. Check cost payment
  if (player.resources.energy < cost.energy) {
    throw new Error('Insufficient energy');
  }
  
  for (const [domain, amount] of Object.entries(cost.power)) {
    if ((player.resources.power[domain] || 0) < amount) {
      throw new Error(`Insufficient ${domain} power`);
    }
  }
  
  // 4. Pay cost
  player.resources.energy -= cost.energy;
  for (const [domain, amount] of Object.entries(cost.power)) {
    player.resources.power[domain] -= amount;
  }
  
  // 5. Place on board
  if (card.type === 'UNIT') {
    this.placeUnitOnBoard(card, player);
  } else if (card.type === 'GEAR') {
    if (!targetId) throw new Error('Gear requires target unit');
    this.attachGear(card, targetId, player);
  } else if (card.type === 'SPELL') {
    this.resolveSpell(card, player, targetId);
  }
  
  // 6. Remove from hand
  player.hand = player.hand.filter(c => c.id !== cardId);
  
  // 7. Trigger play abilities
  card.abilities?.forEach(ability => {
    if (ability.triggerType === 'play') {
      this.executeAbility(ability, card, player);
    }
  });
}
```

**Validation Checklist**:
- ✅ Card in hand
- ✅ Phase allows play
- ✅ Resources available
- ✅ Valid targets (if needed)
- ✅ No conflict with other rules

## Combat System

### Rules Reference (Rules 330-340)

**Combat Flow**:
1. Declare battles (attacks)
2. Defender declares blocks
3. Damage calculations
4. Apply damage
5. Remove dead units
6. Determine battlefield control

**Showdown State**:
- Creates chain for triggered abilities
- Focus passes between players
- Contested battlefield resolves

### Implementation

```typescript
declareAttack(playerId, unitId, targetBattlefieldId) {
  const unit = this.getUnit(unitId, playerId);
  
  // Check if unit can attack
  if (unit.hasSummoningSickness) {
    throw new Error('Cannot attack turn summoned');
  }
  
  if (unit.isTapped) {
    throw new Error('Cannot attack while tapped');
  }
  
  // Add to attacks list
  this.currentBattle.attacks.push({
    unit: unit,
    attackingPlayer: playerId,
    targetBattlefield: targetBattlefieldId
  });
  
  unit.isTapped = true;
}

declareBlock(playerId, blockingUnitId, attackingUnitId) {
  const blockingUnit = this.getUnit(blockingUnitId, playerId);
  const attackingUnit = this.getUnit(attackingUnitId);
  
  // Add to blocks list
  this.currentBattle.blocks.push({
    blocking: blockingUnit,
    attacking: attackingUnit
  });
}

resolveCombat() {
  // Calculate damage for each block
  this.currentBattle.blocks.forEach(block => {
    // Attacking unit deals damage to blocking unit
    const damage = block.attacking.power || 0;
    this.applyDamage(block.blocking, damage);
    
    // Blocking unit deals damage back
    const counterDamage = block.blocking.power || 0;
    this.applyDamage(block.attacking, counterDamage);
  });
  
  // Unblocked attacks damage opponent
  this.currentBattle.attacks.forEach(attack => {
    const isBlocked = this.currentBattle.blocks.some(
      b => b.attacking === attack.unit
    );
    
    if (!isBlocked) {
      const defender = this.getOpponent(attack.attackingPlayer);
      this.applyDamage(defender, attack.unit.power || 0);
    }
  });
  
  // Remove dead units
  this.removeDeadUnits();
  
  // Determine battlefield control
  this.determineBattlefieldControl();
}

applyDamage(target, damageAmount) {
  if (target.type === 'UNIT') {
    target.currentToughness -= damageAmount;
  } else {
    // Player damage
    target.health -= damageAmount;
    
    if (target.health <= 0) {
      this.endGame(this.getOpponent(target.id), 'VICTORY');
    }
  }
}
```

**Combat Checklist**:
- ✅ Validate unit can attack
- ✅ Process declared blocks
- ✅ Calculate damage
- ✅ Remove dead units
- ✅ Update battlefield control
- ✅ Check for win condition

## Resource Management

### Rules Reference (Rules 158-161)

**Resources**:
- **Energy**: Generic resource, produced by runes
- **Power**: Domain-specific, each domain produces its type
- **Mana Pool**: Carries forward between turns, no upper limit

### Implementation

```typescript
channelRunes(playerId, count) {
  const player = this.getPlayer(playerId);
  const runesToChannel = [];
  
  // Draw up to `count` runes from rune deck
  for (let i = 0; i < count && player.runeDeck.length > 0; i++) {
    const rune = player.runeDeck.pop();
    runesToChannel.push(rune);
  }
  
  // Place on board
  runesToChannel.forEach(rune => {
    player.runes.push(rune);
    
    // Generate resources
    rune.abilities?.forEach(ability => {
      if (ability.type === 'PRODUCE_ENERGY') {
        player.resources.energy += ability.value;
      } else if (ability.type === 'PRODUCE_POWER') {
        const domain = ability.domain;
        player.resources.power[domain] = 
          (player.resources.power[domain] || 0) + ability.value;
      }
    });
  });
}

// Note: Mana/Energy doesn't reset each turn
// Unused resources carry forward to next turn
```

**Resource Tracking**:
- ✅ Energy production from runes
- ✅ Power production by domain
- ✅ Resource spending on cards
- ✅ Carry-over between turns
- ✅ No upper limit on resources

## Win Conditions

### Rules Reference (Rules 450+)

**Win Conditions**:
1. **Health to 0**: Opponent health reaches 0
2. **Deck Out**: Cannot draw (Burn Out)
3. **Card Effects**: Some cards may have alternate win conditions

### Implementation

```typescript
applyDamage(target, damageAmount) {
  if (target.type === 'PLAYER') {
    target.health -= damageAmount;
    
    if (target.health <= 0) {
      this.endGame(this.getOpponent(target.id), 'HEALTH_ZERO');
    }
  }
}

drawCard(playerId) {
  const player = this.getPlayer(playerId);
  
  if (player.deck.length === 0) {
    // Burn Out: Cannot draw = loss
    this.endGame(this.getOpponent(playerId), 'BURN_OUT');
    return null;
  }
  
  return player.deck.pop();
}

checkWinCondition() {
  // Check each player for loss condition
  this.players.forEach(player => {
    if (player.health <= 0) {
      this.endGame(
        this.getOpponent(player.id), 
        'HEALTH_ZERO'
      );
    }
  });
}
```

**Win Condition Checks**:
- ✅ Health damage tracking
- ✅ Health ≤ 0 ends game
- ✅ Deck depletion triggers burn out
- ✅ No cards to draw = loss
- ✅ Card-based win conditions (if any)

## Testing Checklist

### Unit Tests
- [ ] Game initialization (health, hand size)
- [ ] Mulligan system
- [ ] Card play validation
- [ ] Cost calculations
- [ ] Resource management
- [ ] Damage calculation
- [ ] Combat resolution
- [ ] Win conditions

### Integration Tests
- [ ] Full game turn sequence
- [ ] Multi-turn games
- [ ] Complex combat scenarios
- [ ] Resource accumulation
- [ ] Effect interactions

### Validation Tests
- [ ] Invalid card plays are rejected
- [ ] Insufficient resources prevents play
- [ ] Out-of-phase actions rejected
- [ ] Dead units removed
- [ ] Damaged units tracked

### Test Example

```typescript
describe('GameEngine', () => {
  let engine: RiftboundGameEngine;
  
  beforeEach(() => {
    const deck1 = createTestDeck(40);
    const deck2 = createTestDeck(40);
    engine = new RiftboundGameEngine(deck1, deck2);
  });
  
  it('should start with 21 health', () => {
    expect(engine.getPlayer('p1').health).toBe(21);
    expect(engine.getPlayer('p2').health).toBe(21);
  });
  
  it('should draw 4 cards during setup', () => {
    expect(engine.getPlayer('p1').hand.length).toBe(4);
  });
  
  it('should apply damage correctly', () => {
    const player = engine.getPlayer('p1');
    engine.applyDamage(player, 5);
    expect(player.health).toBe(16);
  });
  
  it('should end game when health reaches 0', () => {
    const player = engine.getPlayer('p1');
    engine.applyDamage(player, 21);
    expect(engine.gameStatus).toBe('END');
    expect(engine.winner).toBe('p2');
  });
});
```

---

## Summary

This guide maps Riftbound TCG rules (from Riftbound Core Rules v1.2) to implementation in `src/game-engine.ts`. Use this as a reference when:

- Implementing new game mechanics
- Validating game logic
- Debugging game state issues
- Adding new card abilities
- Writing tests

For full rules, see [RULES_SUMMARY.md](./RULES_SUMMARY.md) and [RIFTBOUND_RULES.md](./RIFTBOUND_RULES.md).
