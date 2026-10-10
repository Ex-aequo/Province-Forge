// Builds the public demo for GitHub Pages from a map bundle:
//   node build/cli/mapgen.js create --seed demo --out build/demo-bundle --max-level 2
//   tsx tools/make-demo.ts build/demo-bundle dist/demo-map
//
// Copies ONLY the public files (tiles) and writes, per player and turn, what a real
// server would send: the view (filter_for_viewer) and the client map cut to that view
// (filter_client_map). Neither static-map.json nor the full client map is copied —
// except for the GM views, which get the full map exactly like on the server.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterForViewer } from '../src/game/state';
import { makeTestState } from '../src/game/testState';
import { toExportJson } from '../src/gen/export';
import { generateMap } from '../src/gen/generate';
import { mapContentId } from './lib/mapId';
import { filterClientMap } from '../src/map/filterClientMap';

const [bundle, out] = process.argv.slice(2);
if (!bundle || !out) { console.error('usage: make-demo <bundle-dir> <out-dir>'); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

// the generator is deterministic: same params → same map → same mapId
const map = generateMap(manifest.params);
const mapId = mapContentId(toExportJson(map));
if (mapId !== manifest.mapId) throw new Error(`regenerated map ${mapId} ≠ bundle ${manifest.mapId}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'views'), { recursive: true });
const fullClient = JSON.parse(readFileSync(join(bundle, manifest.files.client), 'utf8'));
writeFileSync(join(out, 'views/full-map.json'), JSON.stringify(fullClient));
cpSync(join(bundle, 'tiles'), join(out, 'tiles'), { recursive: true });

const staticMap = { regions: map.regions, starts: map.starts, pragaSeeds: map.pragaSeeds, fairness: map.fairness };
const turns = [
  { turn: 1, progress: 0 },
  { turn: 40, progress: 0.5 },
  { turn: 90, progress: 1 },
];
type V = { id: string; label: string; file: string; map: string };
const index: { turn: number; views: V[] }[] = [];
for (const t of turns) {
  const state = { ...makeTestState(map, { seed: `demo-${t.turn}`, progress: t.progress, praga: 0.5, countries: map.starts.length - map.params.reserveSlots }), turn: t.turn };
  const views: V[] = [];
  for (const c of state.countries.slice(0, 4)) {
    const file = `views/t${t.turn}-${c.id}.json`, mapFile = `views/t${t.turn}-${c.id}.map.json`;
    const vs = filterForViewer(staticMap, state, c.id);
    writeFileSync(join(out, file), JSON.stringify(vs));
    writeFileSync(join(out, mapFile), JSON.stringify(filterClientMap(fullClient, vs.visible)));
    views.push({ id: c.id, label: c.name.pt, file, map: mapFile });
  }
  const gmFile = `views/t${t.turn}-gm.json`;
  writeFileSync(join(out, gmFile), JSON.stringify(filterForViewer(staticMap, state, null, { gm: true })));
  views.push({ id: 'gm', label: 'Mestre de jogo', file: gmFile, map: 'views/full-map.json' });
  index.push({ turn: t.turn, views });
}
writeFileSync(join(out, 'demo.json'), JSON.stringify({ mapId, seed: manifest.seed, tiles: fullClient.tiles, turns: index }, null, 2));
console.log(`demo → ${out} (${mapId}, ${manifest.tiles.count} tiles)`);
