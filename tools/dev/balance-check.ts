// Dev check: provinces per country in test states (min / max / spread).
import { generateMap } from '../../src/gen/generate';
import { DEFAULT_PARAMS } from '../../src/gen/types';
import { makeTestState } from '../../src/game/testState';
for (const seed of ['ex-aequo', 'beta', 'theta']) {
  const map = generateMap({ ...DEFAULT_PARAMS, seed });
  for (const progress of [0, 0.3, 0.6, 1]) {
    const st = makeTestState(map, { seed, progress, praga: 0, countries: 25 });
    const counts = st.countries.map((c) => Object.values(st.provinces).filter((p) => p.owner === c.id).length).sort((a, b) => a - b);
    console.log(`${seed} p=${progress}: min ${counts[0]} max ${counts[counts.length - 1]} median ${counts[12]}`);
  }
}
