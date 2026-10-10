// Terrain tile layer: a level-0 base (whole world, always loaded) plus detail tiles for
// the current zoom, requested from a Web Worker nearest-first, two at a time.
import type { GeneratedMap } from '../gen/types';
import { BASE_PX, MAX_LEVEL, TerrainRenderer, TILE, buildTerrainData, type MakeCtx, type TerrainData } from '../render/terrain';
import TerrainWorker from './terrain.worker?worker&inline';

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_CACHE = 220;

interface Req { key: string; level: number; tx: number; ty: number; prio: number }

export class TileLayer {
  private worker: Worker | null = null;
  private workerOk: Promise<boolean>;
  private fallback: TerrainRenderer | null = null;
  private data: TerrainData | null = null;
  private gen = 0;
  private W = 1;
  private H = 1;
  private cache = new Map<string, string>(); // key → object URL (insertion order = LRU)
  private pending = new Set<string>();
  private queue: Req[] = [];
  private inflight = 0;
  private visible = true;
  private lastView: { cx: number; cy: number; zoom: number; w: number; h: number } | null = null;
  onProgress?: (pending: number) => void;

  constructor(private baseGroup: SVGGElement, private detailGroup: SVGGElement) {
    try {
      this.worker = new TerrainWorker();
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.workerOk = new Promise((res) => {
        const t = setTimeout(() => res(false), 3000);
        const w = this.worker!;
        const h = (e: MessageEvent) => { if (e.data?.type === 'probe') { clearTimeout(t); w.removeEventListener('message', h); res(!!e.data.ok); } };
        w.addEventListener('message', h);
        w.postMessage({ type: 'probe' });
      });
    } catch {
      this.workerOk = Promise.resolve(false);
    }
  }

  async setMap(map: GeneratedMap) {
    this.gen++;
    this.W = map.width; this.H = map.height;
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear(); this.pending.clear(); this.queue = []; this.inflight = 0;
    this.baseGroup.replaceChildren(); this.detailGroup.replaceChildren();
    this.data = buildTerrainData(map);
    if (await this.workerOk) {
      this.worker!.postMessage({ type: 'data', gen: this.gen, data: this.data });
    } else {
      const makeCtx: MakeCtx = (w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        return c.getContext('2d', { willReadFrequently: true }) as unknown as ReturnType<MakeCtx>;
      };
      this.fallback = new TerrainRenderer(this.data, makeCtx);
    }
    // level 0 covers the whole world
    const { nx, ny } = TerrainRenderer.tilesAt(0, { W: this.W, H: this.H });
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) this.want(0, tx, ty, -1000 + ty * nx + tx);
    this.pump();
    if (this.lastView) this.update(this.lastView);
  }

  setVisible(v: boolean) {
    this.visible = v;
    const disp = v ? '' : 'none';
    this.detailGroup.style.display = disp;
    // base group is shown through <use> copies; hide those via the parent
    (this.baseGroup.ownerSVGElement?.querySelectorAll('use.tile-base') ?? []).forEach((u) => ((u as SVGElement).style.display = disp));
    if (v && this.lastView) this.update(this.lastView);
  }

  /** Call whenever the view changes. zoom = screen px per world unit. */
  update(view: { cx: number; cy: number; zoom: number; w: number; h: number }) {
    this.lastView = view;
    if (!this.visible || !this.data) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const ratio = (view.zoom * dpr * this.W) / BASE_PX;
    const level = Math.max(0, Math.min(MAX_LEVEL, Math.ceil(Math.log2(Math.max(1e-6, ratio)) - 0.35)));
    if (level === 0) { this.detailGroup.replaceChildren(); return; }
    const { nx, ny, tileW } = TerrainRenderer.tilesAt(level, { W: this.W, H: this.H });
    const vx0 = view.cx - view.w / 2 / view.zoom, vx1 = view.cx + view.w / 2 / view.zoom;
    const vy0 = view.cy - view.h / 2 / view.zoom, vy1 = view.cy + view.h / 2 / view.zoom;
    const tx0 = Math.floor(vx0 / tileW), tx1 = Math.floor(vx1 / tileW);
    const ty0 = Math.max(0, Math.floor(vy0 / tileW)), ty1 = Math.min(ny - 1, Math.floor(vy1 / tileW));
    const frag: SVGElement[] = [];
    // drop queued requests for other views
    this.queue = this.queue.filter((q) => q.level === 0);
    for (let ty = ty0; ty <= ty1; ty++) for (let txr = tx0; txr <= tx1; txr++) {
      const tx = ((txr % nx) + nx) % nx;
      const key = `${level}/${tx}/${ty}`;
      const url = this.cache.get(key);
      if (url) {
        this.touch(key);
        frag.push(this.image(url, txr * tileW, ty * tileW, tileW));
      } else {
        const cxT = (txr + 0.5) * tileW, cyT = (ty + 0.5) * tileW;
        this.want(level, tx, ty, Math.hypot(cxT - view.cx, cyT - view.cy));
      }
    }
    this.detailGroup.replaceChildren(...frag);
    this.pump();
  }

  private image(url: string, x: number, y: number, size: number) {
    const img = document.createElementNS(SVGNS, 'image');
    // a hair of overlap hides antialiasing seams between neighbouring tiles
    const pad = size * 0.002;
    img.setAttribute('href', url);
    img.setAttribute('x', String(x - pad)); img.setAttribute('y', String(y - pad));
    img.setAttribute('width', String(size + 2 * pad)); img.setAttribute('height', String(size + 2 * pad));
    img.setAttribute('preserveAspectRatio', 'none');
    return img;
  }

  private want(level: number, tx: number, ty: number, prio: number) {
    const key = `${level}/${tx}/${ty}`;
    if (this.cache.has(key) || this.pending.has(key) || this.queue.some((q) => q.key === key)) return;
    this.queue.push({ key, level, tx, ty, prio });
  }

  private pump() {
    this.queue.sort((a, b) => a.prio - b.prio);
    while (this.inflight < 2 && this.queue.length) {
      const r = this.queue.shift()!;
      this.pending.add(r.key);
      this.inflight++;
      if (this.worker && !this.fallback) {
        this.worker.postMessage({ type: 'tile', gen: this.gen, key: r.key, level: r.level, tx: r.tx, ty: r.ty });
      } else {
        const gen = this.gen;
        setTimeout(() => this.renderLocal(r, gen), 0);
      }
    }
    this.onProgress?.(this.queue.length + this.inflight);
  }

  private renderLocal(r: Req, gen: number) {
    if (!this.fallback || gen !== this.gen) return;
    const px = this.fallback.renderTile(r.level, r.tx, r.ty);
    const c = document.createElement('canvas'); c.width = TILE; c.height = TILE;
    c.getContext('2d')!.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), 0, 0);
    c.toBlob((blob) => this.onMessage({ type: 'tile', gen, key: r.key, blob }), 'image/jpeg', 0.9);
  }

  private onMessage(m: { type: string; gen: number; key: string; blob: Blob | null }) {
    if (m.type !== 'tile') return;
    if (m.gen !== this.gen) return;
    this.inflight = Math.max(0, this.inflight - 1);
    this.pending.delete(m.key);
    if (m.blob) {
      const url = URL.createObjectURL(m.blob);
      this.cache.set(m.key, url);
      this.evict();
      const [level, tx, ty] = m.key.split('/').map(Number);
      if (level === 0) {
        const { tileW } = TerrainRenderer.tilesAt(0, { W: this.W, H: this.H });
        this.baseGroup.appendChild(this.image(url, tx * tileW, ty * tileW, tileW));
      } else if (this.lastView) {
        this.update(this.lastView);
        return;
      }
    }
    this.pump();
  }

  private touch(key: string) {
    const v = this.cache.get(key)!;
    this.cache.delete(key); this.cache.set(key, v);
  }

  private evict() {
    for (const [k, url] of this.cache) {
      if (this.cache.size <= MAX_CACHE) break;
      if (k.startsWith('0/')) continue; // never evict the base layer
      URL.revokeObjectURL(url);
      this.cache.delete(k);
    }
  }

  /** Level-0 world image as a data URL (for SVG export). Null until the base is ready. */
  async baseImageDataUrl(): Promise<string | null> {
    const { nx, ny, tileW } = TerrainRenderer.tilesAt(0, { W: this.W, H: this.H });
    const urls: string[] = [];
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const u = this.cache.get(`0/${tx}/${ty}`);
      if (!u) return null;
      urls.push(u);
    }
    const c = document.createElement('canvas');
    c.width = nx * TILE; c.height = Math.round((this.H / tileW) * TILE);
    const ctx = c.getContext('2d')!;
    await Promise.all(urls.map((u, i) => new Promise<void>((res) => {
      const im = new Image();
      im.onload = () => { ctx.drawImage(im, (i % nx) * TILE, Math.floor(i / nx) * TILE); res(); };
      im.onerror = () => res();
      im.src = u;
    })));
    return c.toDataURL('image/jpeg', 0.88);
  }
}
