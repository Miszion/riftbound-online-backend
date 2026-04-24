import type { EffectProfile } from '../../card-catalog.js';

export function makeEffectProfile(overrides: Partial<EffectProfile> = {}): EffectProfile {
  return {
    classes: [],
    primaryClass: null,
    operations: [],
    targeting: { mode: 'none', requiresSelection: false },
    priority: 'any',
    references: [],
    reliability: 'heuristic',
    ...overrides,
  };
}
