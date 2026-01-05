import type { RuneCard } from './game-engine';

export type DomainKey = 'fury' | 'calm' | 'mind' | 'body' | 'chaos' | 'order' | 'rainbow';

export interface ChampionAbilityCost {
  energy: number;
  runes: Partial<Record<DomainKey, number>>;
  requiresExhaust: boolean;
  rawText: string;
}

export const parseChampionAbilityCost = (text?: string | null): ChampionAbilityCost => {
  const normalized = text ?? '';
  const energyMatches = normalized.match(/:rb_energy_(\d+):/gi) ?? [];
  const energy = energyMatches.reduce((total, token) => {
    const [, amount] = token.match(/:rb_energy_(\d+):/i) ?? [];
    const value = Number(amount ?? 0);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);

  const runeMatches = normalized.match(/:rb_rune_(fury|calm|mind|body|chaos|order|rainbow):/gi) ?? [];
  const runes: Partial<Record<DomainKey, number>> = {};
  runeMatches.forEach((token) => {
    const [, domain] = token.match(/:rb_rune_(fury|calm|mind|body|chaos|order|rainbow):/i) ?? [];
    if (!domain) {
      return;
    }
    const key = domain.toLowerCase() as DomainKey;
    runes[key] = (runes[key] ?? 0) + 1;
  });

  const requiresExhaust = /:rb_exhaust:/i.test(normalized);

  return {
    energy,
    runes,
    requiresExhaust,
    rawText: normalized
  };
};

const cloneRunes = (runes: RuneCard[]): Array<{ domain?: string | null; powerValue?: number | null; isTapped?: boolean }> =>
  runes.map((rune) => ({
    domain: rune.domain ?? null,
    powerValue: rune.powerValue ?? 1,
    isTapped: rune.isTapped ?? false
  }));

const selectRune = (
  runes: Array<{ domain?: string | null; powerValue?: number | null; isTapped?: boolean }>,
  predicate: (entry: { domain?: string | null; powerValue?: number | null; isTapped?: boolean }) => boolean,
  options?: { allowTapped?: boolean; consumed?: Set<number> }
) => {
  const allowTapped = Boolean(options?.allowTapped);
  const consumed = options?.consumed ?? new Set<number>();
  for (let index = 0; index < runes.length; index++) {
    if (consumed.has(index)) {
      continue;
    }
    const candidate = runes[index];
    if (!allowTapped && candidate.isTapped) {
      continue;
    }
    if (predicate(candidate)) {
      consumed.add(index);
      return { entry: candidate, index };
    }
  }
  return null;
};

const allocateEnergy = (
  runes: Array<{ domain?: string | null; powerValue?: number | null; isTapped?: boolean }>,
  amount: number,
  consumed: Set<number>
) => {
  const selections: Array<{ entry: { domain?: string | null; powerValue?: number | null; isTapped?: boolean }; index: number }> = [];
  let remaining = amount;
  while (remaining > 0) {
    const claim =
      selectRune(
        runes,
        (entry) => typeof entry.domain === 'string' && entry.domain.length > 0 && !entry.isTapped,
        { consumed }
      ) ??
      selectRune(runes, (entry) => !entry.domain && !entry.isTapped, { consumed }) ??
      selectRune(runes, () => true, { consumed });
    if (!claim) {
      return { success: false, selections: [] };
    }
    selections.push(claim);
    remaining -= 1;
  }
  return { success: true, selections };
};

export const canSatisfyChampionCost = (
  runes: RuneCard[],
  cost: ChampionAbilityCost
): boolean => {
  const working = cloneRunes(runes);
  const consumed = new Set<number>();
  const energyResult = allocateEnergy(working, Math.max(0, cost.energy), consumed);
  if (!energyResult.success) {
    return false;
  }
  const domainDemand = new Map<string, number>();
  Object.entries(cost.runes).forEach(([domain, value]) => {
    const normalized = domain.toLowerCase();
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return;
    }
    domainDemand.set(normalized, numeric);
  });

  const energySelections = energyResult.selections;
  const powerAssignments = new Set<number>();

  const satisfyFromEnergy = (domain: string) => {
    for (const selection of energySelections) {
      if (powerAssignments.has(selection.index)) {
        continue;
      }
      if ((selection.entry.domain ?? '').toLowerCase() === domain && (selection.entry.powerValue ?? 1) > 0) {
        powerAssignments.add(selection.index);
        return selection;
      }
    }
    for (const selection of energySelections) {
      if (powerAssignments.has(selection.index)) {
        continue;
      }
      if (!selection.entry.domain && (selection.entry.powerValue ?? 1) > 0) {
        powerAssignments.add(selection.index);
        return selection;
      }
    }
    return null;
  };

  for (const [domain, requirement] of domainDemand.entries()) {
    let remaining = requirement;
    while (remaining > 0) {
      const selection =
        satisfyFromEnergy(domain) ??
        selectRune(
          working,
          (entry) => (entry.domain ?? '').toLowerCase() === domain && (entry.powerValue ?? 1) > 0 && !entry.isTapped,
          { consumed }
        ) ??
        selectRune(working, (entry) => !entry.domain && (entry.powerValue ?? 1) > 0 && !entry.isTapped, {
          consumed
        });
      if (!selection) {
        return false;
      }
      remaining -= Math.max(1, selection.entry.powerValue ?? 1);
    }
  }

  return true;
};

export const summarizeChampionCost = (cost: ChampionAbilityCost): string => {
  const parts: string[] = [];
  if (cost.energy > 0) {
    parts.push(`${cost.energy} energy`);
  }
  const runeParts = Object.entries(cost.runes)
    .filter(([, value]) => (value ?? 0) > 0)
    .map(([domain, value]) => `${value} ${domain} rune${value && value > 1 ? 's' : ''}`);
  if (runeParts.length > 0) {
    parts.push(runeParts.join(' + '));
  }
  if (cost.requiresExhaust) {
    parts.push('exhaust legend');
  }
  if (parts.length === 0) {
    return 'No cost';
  }
  return parts.join(', ');
};
