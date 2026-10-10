import { createCanvas } from '@napi-rs/canvas';
import { generateMap } from '../../src/gen/generate';
import { DEFAULT_PARAMS } from '../../src/gen/types';
import { buildTerrainData, TerrainRenderer, TILE } from '../../src/render/terrain';
const map = generateMap({ ...DEFAULT_PARAMS, seed: 'ex-aequo' });
const r = new TerrainRenderer(buildTerrainData(map), (w, h) => createCanvas(w, h).getContext('2d') as any);
for (const level of [0, 2]) {
  const { nx } = TerrainRenderer.tilesAt(level, { W: map.width, H: map.height });
  const ty = level === 0 ? 0 : 3;
  const a = r.renderTile(level, nx - 1, ty), b = r.renderTile(level, 0, ty);
  let diff = 0, inner = 0;
  for (let y = 0; y < TILE; y++) {
    const ia = (y * TILE + TILE - 1) * 4, ib = (y * TILE) * 4, ib2 = (y * TILE + 1) * 4;
    for (let c = 0; c < 3; c++) { diff += Math.abs(a[ia + c] - b[ib + c]); inner += Math.abs(b[ib + c] - b[ib2 + c]); }
  }
  console.log(`level ${level}: mean |Δ| across seam ${(diff / TILE / 3).toFixed(2)} vs between adjacent pixels inside ${(inner / TILE / 3).toFixed(2)}`);
}
