// Pan / zoom / pinch for a world that wraps east–west.
// The world group is drawn three times (x − W, x, x + W); the view centre is kept in
// [0, W) so panning past the seam is seamless and never runs out of map.

export interface ViewState { cx: number; cy: number; zoom: number } // zoom = screen px per world unit

export interface ViewportCallbacks {
  onClick?: (wx: number, wy: number) => void;
  onHover?: (wx: number, wy: number, sx: number, sy: number) => void;
  onLeave?: () => void;
  /** After every view change (pan, zoom, resize). */
  onView?: (view: { cx: number; cy: number; zoom: number; w: number; h: number }) => void;
}

export class Viewport {
  W = 1;
  H = 1;
  state: ViewState = { cx: 0, cy: 0, zoom: 1 };
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; cx: number; cy: number } | null = null;
  private pinch: { dist: number; zoom: number; wx: number; wy: number } | null = null;
  private moved = 0;
  private raf = 0;

  constructor(private svg: SVGSVGElement, private cb: ViewportCallbacks) {
    svg.addEventListener('pointerdown', this.down);
    svg.addEventListener('pointermove', this.move);
    svg.addEventListener('pointerup', this.up);
    svg.addEventListener('pointercancel', this.up);
    svg.addEventListener('pointerleave', () => { if (!this.pointers.size) cb.onLeave?.(); });
    svg.addEventListener('wheel', this.wheel, { passive: false });
    new ResizeObserver(() => { this.clamp(); this.apply(); }).observe(svg);
  }

  setWorld(W: number, H: number, keepView: boolean) {
    const changed = W !== this.W || H !== this.H;
    this.W = W; this.H = H;
    if (!keepView || changed) this.fit(); else { this.clamp(); this.apply(); }
  }

  private size() {
    const r = this.svg.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height), left: r.left, top: r.top };
  }
  minZoom() {
    const { w, h } = this.size();
    // never show more than one world width (the wrap copies cover the rest)
    void h;
    return w / this.W;
  }
  /** Typical province side in map units (0 = unknown): bigger worlds keep the same close-up. */
  provinceSide = 0;
  setProvinceSide(u: number) { this.provinceSide = u; this.clamp(); this.apply(); }
  maxZoom() {
    const { w, h } = this.size();
    const byWorld = Math.max(w / this.W, h / this.H) * 8;
    // a province can always fill about a third of the smaller screen side
    const byProvince = this.provinceSide > 0 ? Math.min(w, h) / 3 / this.provinceSide : 0;
    return Math.max(byWorld, byProvince);
  }

  fit() {
    const { w, h } = this.size();
    this.state.zoom = w / this.W; void h; // whole world width; sea fills any letterbox
    this.state.cx = this.W / 2;
    this.state.cy = this.H / 2;
    this.clamp();
    this.apply();
  }

  zoomBy(f: number, sx?: number, sy?: number) {
    const { w, h } = this.size();
    const px = sx ?? w / 2, py = sy ?? h / 2;
    const before = this.screenToWorld(px, py);
    this.state.zoom = Math.min(this.maxZoom(), Math.max(this.minZoom(), this.state.zoom * f));
    // keep the point under the cursor fixed
    this.state.cx = before.x - (px - w / 2) / this.state.zoom;
    this.state.cy = before.y - (py - h / 2) / this.state.zoom;
    this.clamp();
    this.schedule();
  }

  centerOn(x: number, y: number) {
    this.state.cx = x; this.state.cy = y;
    this.clamp();
    this.apply();
  }

  /** Screen (relative to the svg element) → world. x is NOT wrapped. */
  screenToWorld(sx: number, sy: number) {
    const { w, h } = this.size();
    return { x: this.state.cx + (sx - w / 2) / this.state.zoom, y: this.state.cy + (sy - h / 2) / this.state.zoom };
  }

  private clamp() {
    const { h } = this.size();
    this.state.zoom = Math.min(this.maxZoom(), Math.max(this.minZoom(), this.state.zoom));
    this.state.cx = ((this.state.cx % this.W) + this.W) % this.W;
    const halfH = h / 2 / this.state.zoom;
    if (halfH * 2 >= this.H) this.state.cy = this.H / 2;
    else this.state.cy = Math.min(this.H - halfH, Math.max(halfH, this.state.cy));
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.apply(); });
  }

  apply() {
    const { w, h } = this.size();
    const vw = w / this.state.zoom, vh = h / this.state.zoom;
    this.svg.setAttribute('viewBox', `${this.state.cx - vw / 2} ${this.state.cy - vh / 2} ${vw} ${vh}`);
    this.cb.onView?.({ ...this.state, w, h });
  }

  private local(e: PointerEvent | WheelEvent) {
    const { left, top } = this.size();
    return { x: e.clientX - left, y: e.clientY - top };
  }

  private down = (e: PointerEvent) => {
    this.svg.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.moved = 0;
    if (this.pointers.size === 1) {
      this.dragStart = { x: p.x, y: p.y, cx: this.state.cx, cy: this.state.cy };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = this.screenToWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.state.zoom, wx: mid.x, wy: mid.y };
      this.dragStart = null;
    }
  };

  private move = (e: PointerEvent) => {
    const p = this.local(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') {
        const wpt = this.screenToWorld(p.x, p.y);
        this.cb.onHover?.(wpt.x, wpt.y, p.x, p.y);
      }
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const { w, h } = this.size();
      this.state.zoom = Math.min(this.maxZoom(), Math.max(this.minZoom(), this.pinch.zoom * (dist / Math.max(1, this.pinch.dist))));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.state.cx = this.pinch.wx - (mx - w / 2) / this.state.zoom;
      this.state.cy = this.pinch.wy - (my - h / 2) / this.state.zoom;
      this.moved += 10;
      this.clamp();
      this.schedule();
    } else if (this.dragStart) {
      const dx = p.x - this.dragStart.x, dy = p.y - this.dragStart.y;
      this.moved = Math.max(this.moved, Math.hypot(dx, dy));
      if (this.moved > 3) this.svg.classList.add('dragging');
      this.state.cx = this.dragStart.cx - dx / this.state.zoom;
      this.state.cy = this.dragStart.cy - dy / this.state.zoom;
      this.clamp();
      this.schedule();
    }
  };

  private up = (e: PointerEvent) => {
    const wasSingle = this.pointers.size === 1 && !this.pinch;
    this.pointers.delete(e.pointerId);
    this.svg.classList.remove('dragging');
    if (wasSingle && this.moved <= 4 && e.type === 'pointerup') {
      const p = this.local(e);
      const wpt = this.screenToWorld(p.x, p.y);
      this.cb.onClick?.(wpt.x, wpt.y);
    }
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 1) {
      const [q] = [...this.pointers.values()];
      this.dragStart = { x: q.x, y: q.y, cx: this.state.cx, cy: this.state.cy };
    } else if (!this.pointers.size) this.dragStart = null;
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomBy(Math.exp(-delta * 0.0018), p.x, p.y);
  };
}
