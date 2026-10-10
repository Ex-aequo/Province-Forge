// Shared test vectors: the TypeScript reference implementation of the visibility
// filter produces expected outputs; the Python package must reproduce them exactly.
//   npm run vectors   →   server/python/tests/vectors.json
import { writeFileSync } from 'node:fs';
import { canEnter, filterForViewer } from '../src/game/state';
import { makeTestState } from '../src/game/testState';
import { generateMap } from '../src/gen/generate';
import { DEFAULT_PARAMS } from '../src/gen/types';

const map = generateMap({
  ...DEFAULT_PARAMS, seed: 'vectors', cellCount: 9000, landProvinces: 220,
  playerSlots: 9, reserveSlots: 3, startProvinces: 5, coastalZoneCells: 25, oceanZoneCells: 110,
});
// the static-map subset the server-side filter needs
const staticMap = {
  regions: map.regions.map((r) => ({ id: r.id, kind: r.kind, neighbors: r.neighbors, resource: r.resource ?? null, amount: r.amount ?? null, value: r.value ?? null })),
  starts: map.starts,
  pragaSeeds: map.pragaSeeds,
  fairness: map.fairness,
};
const cases: unknown[] = [];
for (const progress of [0, 0.5, 1]) {
  const state = makeTestState(map, { seed: `vectors-${progress}`, progress, praga: 0.5, countries: 9 });
  const viewers = [null, ...state.countries.slice(0, 3).map((c) => c.id), 'nobody'];
  for (const viewer of viewers) {
    for (const gm of viewer === null ? [true] : [false, true]) {
      cases.push({ progress, viewer, gm, state, expected: filterForViewer(staticMap, state, viewer, { gm }) });
    }
  }
  const probes = map.regions.filter((_, i) => i % 7 === 0).map((r) => r.id);
  cases.push({ progress, canEnter: probes.map((id) => [id, canEnter(staticMap, state, id)]), state });
}
writeFileSync('server/python/tests/vectors.json', JSON.stringify({ staticMap, cases }));
console.log(`wrote ${cases.length} cases over ${map.regions.length} regions`);
