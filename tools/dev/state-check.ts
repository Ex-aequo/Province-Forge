// Dev check: test states across progress levels — ownership, occupation, Praga, visibility.
import { generateMap } from '../../src/gen/generate';
import { DEFAULT_PARAMS } from '../../src/gen/types';
import { makeTestState } from '../../src/game/testState';
import { filterForViewer } from '../../src/game/state';
import { renderPolitical } from '../../src/render/political';
import { toClientMap } from '../../src/map/clientMap';
import { RenderMap } from '../../src/map/renderMap';
for (const seed of ['ex-aequo', 'beta', 'theta']) {
  const map = generateMap({ ...DEFAULT_PARAMS, seed });
  const rm = new RenderMap(toClientMap(map));
  for (const progress of [0, 0.5, 1]) {
    const st = makeTestState(map, { seed, progress, praga: 0.5, countries: 25 });
    const ps = Object.values(st.provinces);
    const owned = ps.filter((p) => p.owner).length, occ = ps.filter((p) => p.controller !== p.owner).length, praga = ps.filter((p) => p.praga).length;
    const colors = new Set(st.countries.map((c) => c.color)).size;
    const vs = filterForViewer(map, st, 'c1');
    const leaked = Object.keys(vs.provinces).filter((id) => !vs.visible.includes(Number(id))).length;
    const t0 = performance.now();
    const svg = renderPolitical(rm, filterForViewer(map, st, null, { gm: true }), { lang: 'en', mode: 'political' });
    console.log(`${seed} p=${progress}: owned ${owned}/${Object.keys(st.provinces).length}, occupied ${occ}, praga ${praga}, colours ${colors}/25, c1 sees ${vs.visible.length}, leaked ${leaked}, render ${Math.round(performance.now() - t0)} ms, ${(svg.length / 1e6).toFixed(1)} MB`);
  }
}
