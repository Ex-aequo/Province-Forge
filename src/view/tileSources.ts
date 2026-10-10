// Where terrain tiles come from. The game client loads pre-baked tiles from the server
// by URL; the preview tool paints them on the fly in a Web Worker.
import type { GeneratedMap } from '../gen/types';
import type { TileSpec } from '../map/clientMap';
import { BASE_PX, MAX_LEVEL, TILE, TerrainRenderer, buildTerrainData, type MakeCtx, type TerrainData } from '../render/terrain';
import TerrainWorker from '../ui/terrain.worker?worker&inline';

export interface TileSource {
  readonly tile: number;
  readonly basePx: number;
  readonly maxLevel: number;
  /** Resolve a tile to something an <image href> can show, or null if unavailable. */
  request(level: number, tx: number, ty: number): Promise<string | null>;
  /** Called when a tile leaves the cache (revoke blob URLs, etc.). */
  release?(url: string): void;
  /** True when requests are expensive and should be throttled (painting vs downloading). */
  readonly expensive: boolean;
  dispose?(): void;
}

/** Pre-baked tiles served over HTTP (the game). */
export class UrlTileSource implements TileSource {
  readonly tile: number;
  readonly basePx: number;
  readonly maxLevel: number;
  readonly expensive = false;
  constructor(private baseUrl: string, private spec: TileSpec) {
    this.tile = spec.tile; this.basePx = spec.basePx; this.maxLevel = spec.maxLevel;
    if (!this.baseUrl.endsWith('/')) this.baseUrl += '/';
  }
  async request(level: number, tx: number, ty: number) {
    return this.baseUrl + this.spec.path.replace('{z}', String(level)).replace('{x}', String(tx)).replace('{y}', String(ty));
  }
}

/** Tiles painted in a Web Worker from a freshly generated map (preview tool). */
export class WorkerTileSource implements TileSource {
  readonly tile = TILE;
  readonly basePx = BASE_PX;
  readonly maxLevel = MAX_LEVEL;
  readonly expensive = true;
  private worker: Worker | null = null;
  private ready: Promise<boolean>;
  private fallback: TerrainRenderer | null = null;
  private pending = new Map<string, (url: string | null) => void>();
  private gen = 0;
  private data: TerrainData;

  constructor(map: GeneratedMap) {
    this.data = buildTerrainData(map);
    this.gen = Math.floor(Math.random() * 1e9);
    try {
      this.worker = new TerrainWorker();
      const w = this.worker;
      this.ready = new Promise((res) => {
        const t = setTimeout(() => res(false), 3000);
        const h = (e: MessageEvent) => { if (e.data?.type === 'probe') { clearTimeout(t); w.removeEventListener('message', h); res(!!e.data.ok); } };
        w.addEventListener('message', h);
        w.postMessage({ type: 'probe' });
      });
      w.addEventListener('message', (e) => {
        const m = e.data;
        if (m?.type !== 'tile' || m.gen !== this.gen) return;
        const done = this.pending.get(m.key);
        this.pending.delete(m.key);
        done?.(m.blob ? URL.createObjectURL(m.blob) : null);
      });
    } catch {
      this.ready = Promise.resolve(false);
    }
    void this.ready.then((ok) => {
      if (ok) this.worker!.postMessage({ type: 'data', gen: this.gen, data: this.data });
      else {
        this.worker?.terminate(); this.worker = null;
        const makeCtx: MakeCtx = (w, h) => {
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          return c.getContext('2d', { willReadFrequently: true }) as unknown as ReturnType<MakeCtx>;
        };
        this.fallback = new TerrainRenderer(this.data, makeCtx);
      }
    });
  }

  async request(level: number, tx: number, ty: number): Promise<string | null> {
    const ok = await this.ready;
    const key = `${level}/${tx}/${ty}`;
    if (ok && this.worker) {
      return new Promise((res) => {
        this.pending.set(key, res);
        this.worker!.postMessage({ type: 'tile', gen: this.gen, key, level, tx, ty });
      });
    }
    if (!this.fallback) return null;
    const px = this.fallback.renderTile(level, tx, ty);
    const c = document.createElement('canvas'); c.width = TILE; c.height = TILE;
    c.getContext('2d')!.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), 0, 0);
    return new Promise((res) => c.toBlob((b) => res(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.9));
  }

  release(url: string) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.pending.values()) done(null);
    this.pending.clear();
  }
}
