// Dev helper: render one terrain tile to PNG. Usage: tsx tools/dev/tile.ts seed level tx ty out.png
import { writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { generateMap } from '../../src/gen/generate';
import { DEFAULT_PARAMS } from '../../src/gen/types';
import { buildTerrainData, TerrainRenderer, TILE, type MakeCtx } from '../../src/render/terrain';
const [seed, level, tx, ty, out] = process.argv.slice(2);
const map = generateMap({ ...DEFAULT_PARAMS, seed });
const makeCtx: MakeCtx = (w, h) => createCanvas(w, h).getContext('2d') as unknown as ReturnType<MakeCtx>;
const r = new TerrainRenderer(buildTerrainData(map), makeCtx);
const t0 = performance.now();
const px = r.renderTile(+level, +tx, +ty);
console.log('tile ms', Math.round(performance.now() - t0), TerrainRenderer.tilesAt(+level, { W: map.width, H: map.height }));
const c = createCanvas(TILE, TILE); const ctx = c.getContext('2d');
const img = ctx.createImageData(TILE, TILE); img.data.set(px); ctx.putImageData(img, 0, 0);
writeFileSync(out, c.toBuffer('image/png'));
