import type { Event } from "./types";

function friendlyPhase(phase: string): string {
  const map: Record<string, string> = {
    main_1: "main phase 1",
    main_2: "main phase 2",
    combat: "combat phase",
    showdown: "showdown",
    end: "end phase",
    start: "start phase",
  };
  return map[phase] ?? phase;
}

function describeCardPlayed(ev: Event): string {
  const cp = ev.cardPlayed;
  if (!cp) return "";
  const name = cp.name ?? cp.id ?? "card";
  const typ = cp.type ? ` (${cp.type})` : "";
  return ` - ${name}${typ}`;
}

export function commentary(ev: Event): string {
  // Match-over system event
  if (ev.actor === "system" || !ev.action) {
    if (ev.result) {
      const winner =
        ev.result === "P1_wins" ? "P1" : ev.result === "P2_wins" ? "P2" : null;
      if (winner) {
        return `MATCH OVER: ${winner} wins${ev.winReason ? ` - ${ev.winReason}` : ""}`;
      }
      return `MATCH OVER: draw${ev.winReason ? ` - ${ev.winReason}` : ""}`;
    }
    // No result in data yet - infer from VP
    const { P1, P2 } = ev.vp;
    if (P1 === P2) return "MATCH OVER: final state reached (draw or inconclusive)";
    return `MATCH OVER: ${P1 > P2 ? "P1" : "P2"} leads ${Math.max(P1, P2)}-${Math.min(P1, P2)} VP`;
  }

  const a = ev.action;
  const who = ev.actor;

  switch (a.kind) {
    case "play_card": {
      const idx =
        typeof (a as { cardIndex?: number }).cardIndex === "number"
          ? `#${(a as { cardIndex: number }).cardIndex}`
          : "";
      const dest = (a as { destinationId?: string | null }).destinationId;
      const targets = (a as { targets?: (string | null)[] }).targets ?? [];
      const card = describeCardPlayed(ev);
      const parts: string[] = [];
      parts.push(`${who} plays card ${idx}`.trim());
      if (dest) parts.push(`destination: ${dest}`);
      const realTargets = targets.filter((t): t is string => !!t);
      if (realTargets.length > 0) parts.push(`targets: ${realTargets.join(", ")}`);
      return parts.join(" - ") + card;
    }

    case "advance_phase":
      return `${who} advances to ${friendlyPhase(ev.phase)} (turn ${ev.turn})`;

    case "pass_priority":
      return `${who} passes priority`;

    case "respond_chain": {
      const passed = (a as { pass?: boolean }).pass;
      return passed ? `${who} declines to respond` : `${who} responds to the chain`;
    }

    case "move_unit": {
      const unit = (a as { unitId?: string }).unitId ?? "unit";
      const from = (a as { fromId?: string | null }).fromId;
      const to = (a as { toId?: string | null }).toId;
      if (from && to) return `${who} moves ${unit} from ${from} to ${to}`;
      if (to) return `${who} moves ${unit} to ${to}`;
      if (from) return `${who} moves ${unit} from ${from} to base`;
      return `${who} moves ${unit}`;
    }

    case "resolve_prompt_target": {
      const sels = (a as { selectionIds?: string[] }).selectionIds ?? [];
      if (sels.length === 0) return `${who} resolves prompt (no targets)`;
      return `${who} resolves prompt - selects ${sels.join(", ")}`;
    }

    case "declare_attackers": {
      const attackers = (a as { attackers?: string[] }).attackers ?? [];
      return `${who} declares attack with ${attackers.length} champion${attackers.length === 1 ? "" : "s"}`;
    }

    case "claim_battlefield": {
      const bf = (a as { battlefieldId?: string }).battlefieldId ?? "battlefield";
      const vp = (a as { vp?: number }).vp;
      return `${who} claims battlefield ${bf}${typeof vp === "number" ? ` for ${vp} VP` : ""}`;
    }

    case "resolve_stack":
      return `Stack resolves`;

    case "draw": {
      const n = (a as { count?: number }).count ?? 1;
      return `${who} draws ${n} card${n === 1 ? "" : "s"}`;
    }

    default:
      return `${who} performs ${a.kind}`;
  }
}
