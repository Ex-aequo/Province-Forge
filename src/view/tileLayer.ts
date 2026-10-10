// Terrain tile layer: level 0 (whole world) is always loaded as the base; detail tiles
// for the current zoom are requested nearest-first and kept in a small LRU cache.
import type { TileSource } from './tileSources';

const SVGNS = 'http://www.w3.org/2000/svg';

export interface ViewRect { cx: number; cy: number; zoom: number; w: number; h: number }

export class TileLayer {
  private src: TileSource | null = null;
  private gen = 0;
  private W = 1;
  private H = 1;
  private cache = new Map<string, string>(); // key → url, insertion order = LRU
  private pending = new Set<string>();
  private queue: { key: string; level: number; tx: number; ty: number; prio: number }[] = [];
  private inflight = 0;
  private visible = true;
  private lastView: ViewRect | null = null;
  /** Cap on cached detail tiles (memory on iPad). */
  maxCache = 160;
  onProgress?: (pending: number) => void;

  constructor(private baseGroup: SVGGElement, private detailGroup: SVGGElement) {}

  setSource(src: TileSource | null, W: number, H: number) {
    // same tiles (e.g. a new turn's map for the same world): keep everything loaded
    if (src && src === this.src && W === this.W && H === this.H) return;
    this.gen++;
    for (const url of this.cache.values()) this.src?.release?.(url);
    this.src?.dispose?.();
    this.src = src;
    this.W = W; this.H = H;
    this.cache.clear(); this.pending.clear(); this.queue = []; this.inflight = 0;
    this.baseGroup.replaceChildren(); this.detailGroup.replaceChildren();
    if (!src) return;
    const { nx, ny } = this.grid(0);
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) this.want(0, tx, ty, -1000 + ty * nx + tx);
    this.pump();
    if (this.lastView) this.update(this.lastView);
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.detailGroup.style.display = v ? '' : 'none';
    this.baseGroup.style.display = v ? '' : 'none';
    if (v && this.lastView) this.update(this.lastView);
  }

  private grid(level: number) {
    const s = this.src!;
    const px = s.basePx * 2 ** level;
    const upx = this.W / px;
    return { nx: Math.ceil(px / s.tile), ny: Math.ceil(this.H / upx / s.tile), tileW: s.tile * upx };
  }

  /** Call on every view change. zoom = screen px per world unit. */
  update(view: ViewRect) {
    this.lastView = view;
    if (!this.visible || !this.src) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const ratio = (view.zoom * dpr * this.W) / this.src.basePx;
    const level = Math.max(0, Math.min(this.src.maxLevel, Math.ceil(Math.log2(Math.max(1e-6, ratio)) - 0.35)));
    if (level === 0) { this.detailGroup.replaceChildren(); return; }
    const { nx, ny, tileW } = this.grid(level);
    const vx0 = view.cx - view.w / 2 / view.zoom, vx1 = view.cx + view.w / 2 / view.zoom;
    const vy0 = view.cy - view.h / 2 / view.zoom, vy1 = view.cy + view.h / 2 / view.zoom;
    const tx0 = Math.floor(vx0 / tileW), tx1 = Math.floor(vx1 / tileW);
    const ty0 = Math.max(0, Math.floor(vy0 / tileW)), ty1 = Math.min(ny - 1, Math.floor(vy1 / tileW));
    const els: SVGElement[] = [];
    this.queue = this.queue.filter((q) => q.level === 0);
    for (let ty = ty0; ty <= ty1; ty++) for (let txr = tx0; txr <= tx1; txr++) {
      const tx = ((txr % nx) + nx) % nx;
      const key = `${level}/${tx}/${ty}`;
      const url = this.cache.get(key);
      if (url) { this.touch(key); els.push(this.image(url, txr * tileW, ty * tileW, tileW)); }
      else this.want(level, tx, ty, Math.hypot((txr + 0.5) * tileW - view.cx, (ty + 0.5) * tileW - view.cy));
    }
    this.detailGroup.replaceChildren(...els);
    this.pump();
  }

  private image(url: string, x: number, y: number, size: number) {
    const img = document.createElementNS(SVGNS, 'image');
    const pad = size * 0.002; // hides antialiasing seams between neighbouring tiles
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
    const src = this.src;
    if (!src) return;
    const limit = src.expensive ? 2 : 8;
    this.queue.sort((a, b) => a.prio - b.prio);
    while (this.inflight < limit && this.queue.length) {
      const r = this.queue.shift()!;
      this.pending.add(r.key);
      this.inflight++;
      const gen = this.gen;
      src.request(r.level, r.tx, r.ty).then((url) => this.done(gen, r.key, url), () => this.done(gen, r.key, null));
    }
    this.onProgress?.(this.queue.length + this.inflight);
  }

  private done(gen: number, key: string, url: string | null) {
    if (gen !== this.gen) { if (url) this.src?.release?.(url); return; }
    this.inflight = Math.max(0, this.inflight - 1);
    this.pending.delete(key);
    if (url) {
      this.cache.set(key, url);
      this.evict();
      const [level, tx, ty] = key.split('/').map(Number);
      if (level === 0) {
        const { tileW } = this.grid(0);
        this.baseGroup.appendChild(this.image(url, tx * tileW, ty * tileW, tileW));
      } else if (this.lastView) { this.update(this.lastView); return; }
    }
    this.pump();
  }

  private touch(key: string) { const v = this.cache.get(key)!; this.cache.delete(key); this.cache.set(key, v); }

  private evict() {
    let detail = 0;
    for (const k of this.cache.keys()) if (!k.startsWith('0/')) detail++;
    for (const [k, url] of this.cache) {
      if (detail <= this.maxCache) break;
      if (k.startsWith('0/')) continue; // the base layer stays
      this.src?.release?.(url);
      this.cache.delete(k);
      detail--;
    }
  }

  /** The level-0 world as one image (data URL) — for SVG export. Null until loaded. */
  async baseImageDataUrl(): Promise<string | null> {
    if (!this.src) return null;
    const { nx, ny, tileW } = this.grid(0);
    const urls: string[] = [];
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const u = this.cache.get(`0/${tx}/${ty}`);
      if (!u) return null;
      urls.push(u);
    }
    const T = this.src.tile;
    const c = document.createElement('canvas');
    c.width = nx * T; c.height = Math.round((this.H / tileW) * T);
    const ctx = c.getContext('2d')!;
    await Promise.all(urls.map((u, i) => new Promise<void>((res) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => { ctx.drawImage(im, (i % nx) * T, Math.floor(i / nx) * T); res(); };
      im.onerror = () => res();
      im.src = u;
    })));
    return c.toDataURL('image/jpeg', 0.88);
  }
}
