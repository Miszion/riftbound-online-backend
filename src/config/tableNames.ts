const selectFirstValue = (...candidates: Array<string | undefined | null>): string | null => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
};

const normalizeEnvName = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'dev';
};

const environment =
  normalizeEnvName(process.env.ENVIRONMENT || process.env.STAGE || 'dev');
const tablePrefix = (process.env.TABLE_NAME_PREFIX || 'riftbound').trim();

const buildCanonicalName = (suffix: string) => {
  const prefixSegment = tablePrefix.length > 0 ? `${tablePrefix}-` : '';
  return `${prefixSegment}${environment}-${suffix}`;
};

const resolveTableName = (
  suffix: string,
  legacyName: string,
  ...candidates: Array<string | undefined | null>
): string => {
  const provided = selectFirstValue(...candidates);
  if (provided) {
    return provided;
  }
  const canonical = buildCanonicalName(suffix);
  return canonical.length > 0 ? canonical : legacyName;
};

export const TABLE_NAMES = {
  MATCHES: resolveTableName(
    'matches',
    'riftbound-online-matches-dev',
    process.env.MATCH_TABLE
  ),
  MATCH_HISTORY: resolveTableName(
    'match-history',
    'riftbound-online-match-history-dev',
    process.env.MATCH_HISTORY_TABLE
  ),
  MATCH_STATES: resolveTableName(
    'match-states',
    'riftbound-online-match-states-dev',
    process.env.STATE_TABLE,
    process.env.MATCH_STATE_TABLE
  ),
  MATCHMAKING_QUEUE: resolveTableName(
    'matchmaking-queue',
    'riftbound-online-matchmaking-queue-dev',
    process.env.MATCHMAKING_QUEUE_TABLE
  ),
  DECKLISTS: resolveTableName(
    'decklists',
    'riftbound-online-decklists-dev',
    process.env.DECKLISTS_TABLE,
    process.env.DECKS_TABLE
  ),
  USERS: resolveTableName(
    'users',
    'riftbound-online-users-dev',
    process.env.USERS_TABLE
  )
};

export type TableNameKey = keyof typeof TABLE_NAMES;
