// Dev check: client map size, ring rebuild, picking agreement with the generator.
import { gzipSync } from 'node:zlib';
import { generateMap } from '../../src/gen/generate';
import { DEFAULT_PARAMS } from '../../src/gen/types';
import { toClientMap } from '../../src/map/clientMap';
import { RenderMap } from '../../src/map/renderMap';
import { createRng } from '../../src/gen/rng';
const map = generateMap({ ...DEFAULT_PARAMS, seed: process.argv[2] ?? 'ex-aequo' });
const t0 = performance.now();
const cm = toClientMap(map);
const json = JSON.stringify(cm);
console.log(`client map: ${(json.length / 1e6).toFixed(2)} MB raw, ${(gzipSync(json).length / 1e3).toFixed(0)} KB gzip, built in ${Math.round(performance.now() - t0)} ms`);
const full = JSON.stringify(map.regions.map((r) => r.rings));
console.log(`(full-detail rings alone: ${(full.length / 1e6).toFixed(2)} MB)`);
const rm = new RenderMap(cm);
let pts0 = 0, pts1 = 0, ptsFull = 0;
for (const r of map.regions) { ptsFull += r.rings.reduce((s, x) => s + x.length / 2, 0); pts0 += rm.rings(r.id, 0).reduce((s, x) => s + x.length / 2, 0); pts1 += rm.rings(r.id, 1).reduce((s, x) => s + x.length / 2, 0); }
console.log(`ring points: full ${ptsFull}, lod1 ${pts1} (${Math.round(100 * pts1 / ptsFull)}%), lod0 ${pts0} (${Math.round(100 * pts0 / ptsFull)}%)`);
// closure: every rebuilt ring must end where it starts
let open = 0;
for (const r of map.regions) for (const ring of rm.rings(r.id, 0)) { const n = ring.length; if (Math.hypot(ring[0] - ring[n - 2], ring[1] - ring[n - 1]) > 0.5) open++; }
console.log('rings not closed at lod0:', open);
// picking vs generator cells
const rng = createRng('pick');
let agree = 0, total = 0, miss = 0;
for (let i = 0; i < 20000; i++) {
  const x = rng() * map.width, y = rng() * map.height;
  const truth = map.cellRegion[map.findCell(x, y)];
  const got = rm.pick(x, y);
  total++;
  if (got === truth) agree++; else if (got < 0) miss++;
}
console.log(`pick agreement ${(100 * agree / total).toFixed(2)}% (misses ${miss}) — disagreements are points within a cell of a smoothed border`);
