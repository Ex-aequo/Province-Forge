// Renders terrain tiles off the main thread. Tiles come back as JPEG blobs.
import { TerrainRenderer, TILE, type MakeCtx, type TerrainData } from '../render/terrain';

let renderer: TerrainRenderer | null = null;
let gen = -1;

const makeCtx: MakeCtx = (w, h) =>
  new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }) as unknown as ReturnType<MakeCtx>;

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'probe') {
    let ok = false;
    try { ok = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(4, 4).getContext('2d'); } catch { ok = false; }
    (self as unknown as Worker).postMessage({ type: 'probe', ok });
    return;
  }
  if (m.type === 'data') {
    renderer = new TerrainRenderer(m.data as TerrainData, makeCtx);
    gen = m.gen;
    return;
  }
  if (m.type === 'tile') {
    if (!renderer || m.gen !== gen) { (self as unknown as Worker).postMessage({ type: 'tile', gen: m.gen, key: m.key, blob: null }); return; }
    try {
      const px = renderer.renderTile(m.level, m.tx, m.ty);
      const c = new OffscreenCanvas(TILE, TILE);
      c.getContext('2d')!.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), 0, 0);
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      (self as unknown as Worker).postMessage({ type: 'tile', gen: m.gen, key: m.key, blob });
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: 'tile', gen: m.gen, key: m.key, blob: null, error: String(err) });
    }
  }
};
