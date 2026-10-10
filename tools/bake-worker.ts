// Worker thread for `mapgen create`: paints a share of the terrain tiles and writes
// them as WebP files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { TerrainRenderer, TILE, type MakeCtx, type TerrainData } from '../src/render/terrain';

interface Job { level: number; tx: number; ty: number }
const { data, outDir, quality } = workerData as { data: TerrainData; outDir: string; quality: number };

const makeCtx: MakeCtx = (w, h) => createCanvas(w, h).getContext('2d') as unknown as ReturnType<MakeCtx>;
const renderer = new TerrainRenderer(data, makeCtx);
const canvas = createCanvas(TILE, TILE);
const ctx = canvas.getContext('2d');

parentPort!.on('message', (jobs: Job[] | null) => {
  if (!jobs) { process.exit(0); }
  let bytes = 0;
  for (const j of jobs) {
    const px = renderer.renderTile(j.level, j.tx, j.ty);
    const img = ctx.createImageData(TILE, TILE);
    img.data.set(px);
    ctx.putImageData(img, 0, 0);
    const buf = canvas.toBuffer('image/webp', quality);
    const file = join(outDir, String(j.level), String(j.tx), `${j.ty}.webp`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
    bytes += buf.length;
  }
  parentPort!.postMessage({ done: jobs.length, bytes });
});
