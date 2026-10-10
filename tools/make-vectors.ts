// Shared test vectors: the TypeScript reference implementation of the visibility
// filter produces expected outputs; the Python package must reproduce them exactly.
//   npm run vectors   →   server/python/tests/vectors.json
import { writeFileSync } from 'node:fs';
import { canEnter, canOwn, filterForViewer } from '../src/game/state';
import { toClientMap } from '../src/map/clientMap';
import { filterClientMap } from '../src/map/filterClientMap';
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
  cases.push({ progress, canEnter: probes.map((id) => [id, canEnter(staticMap, state, id)]), canOwn: probes.map((id) => [id, canOwn(staticMap, id)]), state });
}
// fog of war on geometry: the client map cut to what each viewer sees
const clientMap = JSON.parse(JSON.stringify(toClientMap(map)));
const clientCases: unknown[] = [];
{
  const state = makeTestState(map, { seed: 'vectors-0.5', progress: 0.5, praga: 0.5, countries: 9 });
  for (const viewer of [state.countries[0].id, state.countries[4].id, 'nobody']) {
    const visible = filterForViewer(staticMap, state, viewer).visible;
    clientCases.push({ viewer, visible, expected: filterClientMap(clientMap, visible) });
  }
}
writeFileSync('server/python/tests/vectors.json', JSON.stringify({ staticMap, cases }));
writeFileSync('server/python/tests/client_vectors.json', JSON.stringify({ clientMap, cases: clientCases }));
console.log(`wrote ${cases.length} cases over ${map.regions.length} regions`);
