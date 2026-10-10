// Headless generation: `npm run gen -- <seed> [outDir] [mode] [--debug]`
// Writes <seed>.json (static map), <seed>-<mode>.svg and .png for quick inspection.
// mode = terrain | political | praga | resources | starts | terrainType | landmass | elevation
// env: PROGRESS (0–1), PRAGA (0–1), VIEWER (country id, e.g. c3; default observer), LANG (pt|en)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Resvg } from '@resvg/resvg-js';
import { toExportJson } from '../src/gen/export';
import { generateMap } from '../src/gen/generate';
import { DEFAULT_PARAMS } from '../src/gen/types';
import { renderAdjacency, renderSeam, renderStandalone, type ViewMode } from '../src/render/svg';
import { buildTerrainData, TerrainRenderer, TILE, type MakeCtx } from '../src/render/terrain';
import { filterForViewer } from '../src/game/state';
import { makeTestState } from '../src/game/testState';
import { LABEL_CSS, renderPolitical } from '../src/render/political';
import { ECONOMY_CSS, renderResources, renderStarts } from '../src/render/economy';

const seed = process.argv[2] ?? DEFAULT_PARAMS.seed;
const out = process.argv[3] ?? 'out';
const mode = (process.argv[4] ?? 'terrain') as ViewMode;
const debug = process.argv.includes('--debug');
const pngWidth = Number(process.env.PNG_WIDTH ?? 2400);
const level = Number(process.env.TERRAIN_LEVEL ?? 0);
mkdirSync(out, { recursive: true });

const map = generateMap({ ...DEFAULT_PARAMS, seed });
console.log(JSON.stringify(map.stats));
for (const i of map.issues) console.log(`[${i.level}] ${i.message}`);

let terrainImage: string | undefined;
if (['terrain', 'political', 'praga', 'resources', 'starts'].includes(mode)) {
  const t0 = performance.now();
  const makeCtx: MakeCtx = (w, h) => createCanvas(w, h).getContext('2d') as unknown as ReturnType<MakeCtx>;
  const renderer = new TerrainRenderer(buildTerrainData(map), makeCtx);
  const { nx, ny } = TerrainRenderer.tilesAt(level, { W: map.width, H: map.height });
  const full = createCanvas(nx * TILE, ny * TILE);
  const fctx = full.getContext('2d');
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const px = renderer.renderTile(level, tx, ty);
    const img = fctx.createImageData(TILE, TILE);
    img.data.set(px);
    fctx.putImageData(img, tx * TILE, ty * TILE);
  }
  // the last row of tiles overhangs the world; crop to exactly [0,W]x[0,H]
  const hPx = Math.round(map.height / (map.width / (nx * TILE)));
  const crop = createCanvas(nx * TILE, hPx);
  crop.getContext('2d').drawImage(full, 0, 0);
  const png = crop.toBuffer('image/png');
  terrainImage = `data:image/png;base64,${png.toString('base64')}`;
  console.log(`terrain raster ${nx}x${ny} tiles in ${Math.round(performance.now() - t0)} ms`);
}

let content: string | undefined;
if (mode === 'political' || mode === 'praga') {
  const state = makeTestState(map, { seed, progress: Number(process.env.PROGRESS ?? 0.4), praga: Number(process.env.PRAGA ?? 0.35), countries: 25 });
  const vs = filterForViewer(map, state, process.env.VIEWER ?? null);
  content = renderPolitical(map, vs, { lang: (process.env.LANG_MAP as 'pt' | 'en') ?? 'pt', mode });
  console.log(`test state: ${state.countries.length} countries, viewer ${vs.viewer ?? 'observer'}, ${vs.visible.length} visible regions`);
}
if (mode === 'resources') content = renderResources(map);
if (mode === 'starts') content = renderStarts(map, 'pt');
if (map.fairness) console.log('fairness', JSON.stringify(map.fairness));
const svg = renderStandalone(map, { mode }, debug ? renderAdjacency(map) + renderSeam(map) : '', terrainImage, content, LABEL_CSS + ECONOMY_CSS);
writeFileSync(join(out, `${seed}.json`), JSON.stringify(toExportJson(map)));
writeFileSync(join(out, `${seed}-${mode}.svg`), svg);
const png = new Resvg(svg, { fitTo: { mode: 'width', value: pngWidth } }).render().asPng();
writeFileSync(join(out, `${seed}-${mode}.png`), png);
console.log(`wrote ${out}/${seed}-${mode}.{svg,png} and ${seed}.json`);
