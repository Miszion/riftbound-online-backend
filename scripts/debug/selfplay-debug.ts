import { playOneGame, HarnessConfig } from '../../src/self-play';

const cfg: HarnessConfig = {
  games: 1,
  seed: 42,
  seedProvided: true,
  turnLimit: 100,
  actionLimit: 4000,
  strategyA: 'heuristic',
  strategyB: 'heuristic',
  quiet: false,
  quick: true,
  emitJsonl: true,
  jsonlDir: '/tmp/riftbound-test',
  report: '/tmp/riftbound-test-report.json'
};

for (const seed of [42, 101, 202, 303, 404]) {
  const res = playOneGame(0, { ...cfg, seed }, seed, null, null, () => {});
  console.log(`seed=${seed} status=${res.record.status} winner=${res.record.winner} terminator=${res.record.terminator} turns=${res.record.turns}`);
}
