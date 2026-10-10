// Builds the public demo for GitHub Pages from a map bundle:
//   node build/cli/mapgen.js create --seed demo --out build/demo-bundle --max-level 2
//   tsx tools/make-demo.ts build/demo-bundle dist/demo-map
//
// Copies ONLY the public files (client map + tiles) and writes per-player views that a
// real server would produce with filter_for_viewer. static-map.json is NOT copied.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterForViewer } from '../src/game/state';
import { makeTestState } from '../src/game/testState';
import { toExportJson } from '../src/gen/export';
import { generateMap } from '../src/gen/generate';
import { mapContentId } from './lib/mapId';

const [bundle, out] = process.argv.slice(2);
if (!bundle || !out) { console.error('usage: make-demo <bundle-dir> <out-dir>'); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

// the generator is deterministic: same params → same map → same mapId
const map = generateMap(manifest.params);
const mapId = mapContentId(toExportJson(map));
if (mapId !== manifest.mapId) throw new Error(`regenerated map ${mapId} ≠ bundle ${manifest.mapId}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'views'), { recursive: true });
cpSync(join(bundle, manifest.files.client), join(out, manifest.files.client));
cpSync(join(bundle, 'tiles'), join(out, 'tiles'), { recursive: true });

const staticMap = { regions: map.regions, starts: map.starts, pragaSeeds: map.pragaSeeds, fairness: map.fairness };
const turns = [
  { turn: 1, progress: 0 },
  { turn: 40, progress: 0.5 },
  { turn: 90, progress: 1 },
];
const index: { turn: number; views: { id: string; label: string; file: string }[] }[] = [];
for (const t of turns) {
  const state = { ...makeTestState(map, { seed: `demo-${t.turn}`, progress: t.progress, praga: 0.5, countries: map.starts.length - map.params.reserveSlots }), turn: t.turn };
  const views: { id: string; label: string; file: string }[] = [];
  for (const c of state.countries.slice(0, 4)) {
    const file = `views/t${t.turn}-${c.id}.json`;
    writeFileSync(join(out, file), JSON.stringify(filterForViewer(staticMap, state, c.id)));
    views.push({ id: c.id, label: c.name.pt, file });
  }
  const gmFile = `views/t${t.turn}-gm.json`;
  writeFileSync(join(out, gmFile), JSON.stringify(filterForViewer(staticMap, state, null, { gm: true })));
  views.push({ id: 'gm', label: 'Mestre de jogo', file: gmFile });
  index.push({ turn: t.turn, views });
}
writeFileSync(join(out, 'demo.json'), JSON.stringify({ mapId, seed: manifest.seed, clientMap: manifest.files.client, turns: index }, null, 2));
console.log(`demo → ${out} (${mapId}, ${manifest.tiles.count} tiles)`);
