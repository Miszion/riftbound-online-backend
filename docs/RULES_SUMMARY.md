# Riftbound TCG - Rules Summary & Implementation Guide

This document summarizes the key game rules from the Riftbound Core Rules (v1.2) for the Match Service implementation.

## Game Structure

### Deck Construction
- **Main Deck**: Minimum 40 cards (excluding Champion and Battlefields)
- **Champion Legend**: 1 card that determines domain identity  
- **Chosen Champion Unit**: 1 champion unit matching the Champion Legend's domain
- **Rune Deck**: 12 rune cards
- **Battlefields**: Mode-dependent number (typically 1-3)
- **Card Limit**: Up to 3 copies of the same named card
- **Domain Identity**: Cards must match Champion Legend's domain(s)

### Game Setup (Rule 110-118)
1. Place Champion Legend in Legend Zone
2. Place Chosen Champion in Champion Zone  
3. Set aside Battlefields
4. Shuffle and place Main Deck and Rune Deck
5. Determine turn order (random selection for first player)
6. Each player **draws 4 cards**
7. Mulligan phase: Players can exchange up to 2 cards with deck
8. First player begins their turn

## Game Zones

### Board Zones
- **Base**: Player's main play area for units and gear (one per player)
- **Battlefields**: Contested areas where combat occurs
- **Facedown Zone**: Hidden card space per battlefield (max 1 card)
- **Legend Zone**: Champion Legend location (permanent, cannot be removed)
- **Champion Zone**: Chosen Champion starting location

### Non-Board Zones
- **Main Deck**: Face-down playing cards
- **Rune Deck**: Face-down rune cards
- **Trash**: Discarded cards, public information
- **Banishment**: Removed from play (permanent removal)
- **Hand**: Secret information
- **Exile**: Temporarily removed from play

## Domains (Rule 133)

Six domains, each with color and symbol:
- **Fury [R]**: Red
- **Calm [G]**: Green  
- **Mind [B]**: Blue
- **Body [O]**: Orange
- **Chaos [P]**: Purple
- **Order [Y]**: Yellow

## Card Types & Characteristics

### Main Deck Cards
- **Units**: Permanent with Power and Toughness
- **Gear**: Equipment that attaches to units
- **Spells**: Non-permanent, resolve then go to trash

### Special Cards
- **Runes**: Channeled (not played), produce Energy and Power resources
- **Battlefields**: Non-deck cards that define play areas
- **Legends**: Start in Legend Zone, cannot be moved

### Card Characteristics
- **Play Cost**: Energy and Domain-specific Power (top-left corner)
- **Power**: Unit attack value
- **Toughness**: Unit health/durability
- **Abilities**: Play effects, triggered abilities, static effects
- **Keywords**: Shorthand for longer abilities

## Resources & Costs (Rule 158-161)

### Resource Types
- **Energy**: Generic resource (no domain)
- **Power**: Domain-specific resource, each domain produces its own
- **Universal Power**: Can substitute for any domain

### Cost Structure
- **Energy Cost**: Numeric value (e.g., "3" = 3 Energy)
- **Power Cost**: Domain symbols (e.g., "[R][R]" = 2 Fury)
- **Equip Cost**: Cost to attach gear to units

## Turn Structure (Rule 310-340)

### Standard Turn Phases
1. **Beginning Phase** (Rule 315)
   - Rune Channel Step: Channel up to 2 runes from Rune Deck
   - Draw Step: Draw 1 card
   - Custom effects trigger

2. **Main Phase 1** (Rule 320)
   - Play units, gear, spells
   - No inherent action limit

3. **Combat Phase** (Rule 330-340)
   - Showdown system
   - Battle contested battlefields
   - Determine control changes

4. **Main Phase 2** (Rule 325)
   - Same actions as Main Phase 1

5. **End Step** (Rule 340+)
   - Cleanup phase
   - Discard down to hand limit (typically 7)
   - Temporary effects expire

### Chain System (Rule 330-333)
- **Chain**: Stack of pending card plays and abilities
- **Open State**: No chain (can play cards/abilities)
- **Closed State**: Chain exists (restricted play)
- **Finalize Step**: Complete pending items before resolution
- **Execute Step**: Resolve chain items

## Combat System (Rule 437+)

### Showdown Structure
- Combat occurs when a Battlefield is "Contested"
- Player with Focus (aggressive player) initiates
- Defender is the player controlling the contested Battlefield
- Combat resolves using ability chain system
- Control of Battlefield is determined after combat resolution

### Attack/Defense
- Units declare attacks
- Defender declares blocks
- Damage calculation determines unit survival
- Units with Summoning Sickness cannot attack same turn played

### Damage (Rule 404+)
- **Deal**: Assign damage to units or players
- **Unit Damage**: Reduces toughness; unit dies when toughness reaches 0
- **Player Damage**: Reduces health total
- **Damage Source**: Card or effect creating the damage

## Win Conditions (Rule 450+)

### Standard Win Conditions
- Reduce opponent health to 0
- Opponent cannot draw cards (deck empty + burn out)
- Alternative win conditions on specific cards

### Loss Conditions
- Health reaches 0
- Cannot draw when required (Burn Out)
- Specific card effects

## Resource Management (Rule 400+)

### Drawing Cards (Rule 400)
- Draw 1 per turn during Draw Step
- Draw as many as possible if fewer remain
- Burn Out if deck runs out

### Recycling (Rule 403)
- Return cards to Rune Deck
- Shuffle back into deck
- Used during Mulligan and certain effects

### Mana/Energy
- Produced by channeled Runes
- Spent to play cards
- Carries forward each turn (can accumulate)

## Game Effects & Abilities

### Ability Types
- **Play Effects**: Trigger when card is played
- **Triggered Abilities**: Trigger on specific game events
- **Static Abilities**: Continuous passive effects
- **Activated Abilities**: Player-activated effects

### Common Keywords
- **Keywords** are shorthand for abilities (see rule 726+)
- **Reminder Text**: Italic parentheses, explains keywords, non-functional

### Card Interactions
- **Golden Rule**: Card text overrides rules text
- **Silver Rule**: Card text interpreted per the comprehensive rules
- **Can't Beats Can**: Prohibition always overrides permission

## Damage & Healing

### Damage Assignment
- Source of damage is indicated on card
- Damage can be targeted to specific units/players  
- Cumulative damage marker tracking

### Healing
- Restore health to players/units
- Cannot exceed maximum health
- Remove damage markers when healing

## Game Concepts

### Control
- A player controls cards they own in play
- Control can be transferred by effects
- Player loses control when Battlefield changes control

### Battlefield Control
- Battlefields can be uncontrolled initially
- Combat Showdowns determine control
- Control determines who uses Facedown Zone

### Summoning Sickness
- Units cannot attack the turn they're played
- Temporary effect that clears at end of turn
- Specific abilities may ignore this

## Implementation Notes

For match-service implementation:
- Maintain strict turn order and phase progression
- Implement chain/stack system for simultaneous effects
- Track all temporary effects with duration
- Validate all costs before card play
- Check domain identity before card play
- Implement Showdown combat system properly
- Track resources (Energy and Power) per player
- Validate attack/block declarations before combat
- Implement damage and health tracking
- Check win conditions at appropriate times
