# Riftbound Online – Docs Directory Index

This index lists every document that lives inside the `docs/` directory and explains when to use each one. Use it as the local table of contents for this folder; broader repo references (Quickstart, README, etc.) live alongside this directory and are intentionally omitted here.

## Available Documents

| File | Description |
|------|-------------|
| [INFRASTRUCTURE_OVERVIEW.md](./INFRASTRUCTURE_OVERVIEW.md) | Consolidated backend infrastructure guide covering AWS architecture, deployment workflows, and stack reference details. |
| [RULES_SUMMARY.md](./RULES_SUMMARY.md) | Developer-friendly summary of Riftbound’s game rules: phases, zones, domains, resources, combat, and win conditions. |
| [GAME_RULES_IMPLEMENTATION.md](./GAME_RULES_IMPLEMENTATION.md) | Maps the written rules to code: setup, turn structure, card play validation, combat resolution, resource handling, and testing guidance. |
| [RIFTBOUND_GAME_ENGINE_GUIDE.md](./RIFTBOUND_GAME_ENGINE_GUIDE.md) | Expectations for the automated game engine, player flow (Dorans, battlefield, mulligan), and how UI/gameplay phases should behave. |

## How to Navigate

### Need the system architecture?
Read **INFRASTRUCTURE_OVERVIEW.md** for the AWS topology, deployment scripts, and operational runbooks.

### Need to understand the Riftbound rules?
Start with **RULES_SUMMARY.md** for terminology and mechanics, then switch to **GAME_RULES_IMPLEMENTATION.md** when translating those rules into code.

### Need engine workflow guidance?
Open **RIFTBOUND_GAME_ENGINE_GUIDE.md** to see end-to-end flow expectations (selection steps, prompts, UI timing).

## Maintenance Notes

- When adding a new document to this folder, update the table above with a short description so the index stays accurate.
- If a document is renamed or moved out of `docs/`, remove it from the list to avoid stale links.

_Last updated: January 2025_
