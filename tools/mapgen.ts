// Production CLI.
//
//   npm run build:cli      (once; bundles to build/cli/ — no TypeScript needed on the server)
//   node build/cli/mapgen.js create --seed <seed> --out <dir> [--max-level 4] [--threads N]
//                                   [--params params.json] [--quality 82]
//
// Writes into <dir>:
//   static-map.json           FULL map — server only (resources, values, start positions…)
//   client-map.<hash>.json    what players download (no secrets, cacheable forever)
//   tiles/{z}/{x}/{y}.webp    terrain pyramid, levels 0..max-level
//   manifest.json             ids, versions, hashes, fairness — read by the server
//
// Progress is printed as JSON lines on stdout ({"stage": …}) so the FastAPI job runner
// can follow it. Exit code 0 = success.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { toExportJson } from '../src/gen/export';
import { GENERATOR_VERSION, generateMap } from '../src/gen/generate';
import { DEFAULT_PARAMS, type GenParams } from '../src/gen/types';
import { toClientMap, type TileSpec } from '../src/map/clientMap';
import { mapContentId } from './lib/mapId';
import { BASE_PX, TILE, TerrainRenderer, buildTerrainData } from '../src/render/terrain';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

if (cmd !== 'create') {
  console.error('usage: mapgen create --seed <seed> --out <dir> [--max-level 4] [--threads N] [--params file.json] [--quality 82]');
  process.exit(2);
}

const seed = opt('seed');
const out = opt('out');
if (!seed || !out) { console.error('--seed and --out are required'); process.exit(2); }
const maxLevel = Math.max(0, Math.min(6, Number(opt('max-level', '4'))));
const threads = Math.max(1, Number(opt('threads', String(Math.max(1, cpus().length)))));
const quality = Math.max(40, Math.min(100, Number(opt('quality', '82'))));
const extra = opt('params') ? JSON.parse(readFileSync(opt('params')!, 'utf8')) as Partial<GenParams> : {};

const t0 = performance.now();
// build into a temp dir and swap at the end, so a half-written map is never served
const tmp = `${out}.partial`;
rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, 'tiles'), { recursive: true });

// ---- 1. generate
log({ stage: 'generate', seed });
const params: GenParams = { ...DEFAULT_PARAMS, ...extra, seed };
const map = generateMap(params);
const errors = map.issues.filter((i) => i.level === 'error');
if (errors.length) { log({ stage: 'failed', reason: 'validation', issues: map.issues }); process.exit(1); }

// ---- 2. static + client map
const staticExp = toExportJson(map);
const staticJson = JSON.stringify(staticExp);
const mapId = mapContentId(staticExp);
writeFileSync(join(tmp, 'static-map.json'), staticJson);
const tiles: TileSpec = { tile: TILE, basePx: BASE_PX, maxLevel, format: 'webp', path: 'tiles/{z}/{x}/{y}.webp' };
const clientJson = JSON.stringify(toClientMap(map, tiles));
const clientHash = createHash('sha256').update(clientJson).digest('hex').slice(0, 12);
const clientFile = `client-map.${clientHash}.json`;
writeFileSync(join(tmp, clientFile), clientJson);
log({ stage: 'maps', mapId, staticBytes: staticJson.length, clientFile, clientBytes: clientJson.length });

// ---- 3. tiles, in parallel worker threads
const jobs: { level: number; tx: number; ty: number }[] = [];
for (let level = 0; level <= maxLevel; level++) {
  const { nx, ny } = TerrainRenderer.tilesAt(level, { W: map.width, H: map.height });
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) jobs.push({ level, tx, ty });
}
log({ stage: 'tiles', total: jobs.length, threads });
const data = buildTerrainData(map);
let done = 0, bytes = 0, lastPct = -1;
await new Promise<void>((resolve, reject) => {
  let next = 0, alive = threads;
  const BATCH = 8;
  for (let i = 0; i < threads; i++) {
    // built CLI (build/cli/*.js) on servers; the .ts file only when run through tsx
    const w = new Worker(new URL(import.meta.url.endsWith('.ts') ? './bake-worker.ts' : './bake-worker.js', import.meta.url), {
      workerData: { data, outDir: join(tmp, 'tiles'), quality },
    });
    const feed = () => {
      if (next >= jobs.length) { w.postMessage(null); return; }
      w.postMessage(jobs.slice(next, next + BATCH));
      next += BATCH;
    };
    w.on('message', (m: { done: number; bytes: number }) => {
      done += m.done; bytes += m.bytes;
      const pct = Math.floor((100 * done) / jobs.length);
      if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; log({ stage: 'tiles', done, total: jobs.length, pct }); }
      feed();
    });
    w.on('error', reject);
    w.on('exit', () => { if (--alive === 0) resolve(); });
    feed();
  }
});

// ---- 4. manifest, then swap into place
const manifest = {
  format: 'ex-aequo/map-bundle',
  formatVersion: 1,
  mapId,
  generator: GENERATOR_VERSION,
  createdAt: new Date().toISOString(),
  seed,
  params,
  files: { static: 'static-map.json', client: clientFile },
  tiles: { ...tiles, count: jobs.length, bytes },
  stats: map.stats,
  fairness: map.fairness,
  issues: map.issues,
  seconds: Math.round((performance.now() - t0) / 100) / 10,
};
writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
rmSync(out, { recursive: true, force: true });
renameSync(tmp, out);
log({ stage: 'done', mapId, out, tiles: jobs.length, tileMB: Math.round(bytes / 1e5) / 10, seconds: manifest.seconds });
