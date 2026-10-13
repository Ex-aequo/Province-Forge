// MapView — the map component used by the game client AND the preview tool.
// Framework-agnostic (plain DOM); see MapViewReact.tsx for the React wrapper.
//
//   const view = new MapView(container, { map: clientMap, tiles, view: viewerState, lang: 'pt' });
//   view.setView(nextTurnViewerState);
//
// It never sees more than it is given: the client map has no secrets, and the
// viewer state must already be filtered by the server.
import '../assets/fonts/fonts.css';
import type { ViewerState } from '../game/state';
import type { ClientMap } from '../map/clientMap';
import { RenderMap, type Lod } from '../map/renderMap';
import { renderBase } from '../render/base';
import { ECONOMY_CSS, renderResources, renderStarts } from '../render/economy';
import { LABEL_CSS, renderFog, renderPolitical, type Lang } from '../render/political';
import { PALETTE, fmt } from '../render/svg';
import { TileLayer } from './tileLayer';
import type { TileSource } from './tileSources';
import { Viewport } from './viewport';

export type MapMode = 'political' | 'praga' | 'terrain' | 'terrainType' | 'resources' | 'starts';
const RASTER: MapMode[] = ['political', 'praga', 'terrain', 'resources', 'starts'];

export interface MapViewOptions {
  map: ClientMap | RenderMap;
  tiles?: TileSource | null;
  view?: ViewerState | null;
  lang?: Lang;
  mode?: MapMode;
  /** Region under the pointer changed (mouse only). */
  onHover?: (regionId: number | null, screenX: number, screenY: number) => void;
  /** Region tapped / clicked (null = empty space). */
  onSelect?: (regionId: number | null) => void;
  /** After every pan / zoom. */
  onViewChange?: (v: { cx: number; cy: number; zoom: number; w: number; h: number }) => void;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

export class MapView {
  readonly svg: SVGSVGElement;
  readonly viewport: Viewport;
  private rm!: RenderMap;
  private tiles: TileLayer;
  private vs: ViewerState | null = null;
  private lang: Lang;
  private mode: MapMode;
  private custom: string | null = null;
  private overlay = '';
  private selected = -1;
  private uses: SVGUseElement[][] = []; // per layer: copies at −W, 0, +W
  private gWorld: SVGGElement;
  private gOverlay: SVGGElement;
  private gSel: SVGGElement;
  private bg: SVGRectElement;
  private lastLod: Lod = 1;
  private lastLabelLod = '';

  constructor(container: HTMLElement, private opt: MapViewOptions) {
    this.lang = opt.lang ?? 'pt';
    this.mode = opt.mode ?? 'political';
    this.vs = opt.view ?? null;
    const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    svg.setAttribute('class', 'pf-map');
    svg.setAttribute('role', 'img');
    svg.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab';
    container.appendChild(svg);
    this.svg = svg;

    const style = document.createElementNS(SVGNS, 'style');
    style.textContent = LABEL_CSS + ECONOMY_CSS;
    this.bg = document.createElementNS(SVGNS, 'rect') as SVGRectElement;
    this.bg.setAttribute('fill', PALETTE.sea);
    const defs = document.createElementNS(SVGNS, 'defs');
    const g = (id: string) => { const e = document.createElementNS(SVGNS, 'g') as SVGGElement; e.id = id; return e; };
    const uid = `pf${Math.floor(Math.random() * 1e9).toString(36)}`;
    const gTileBase = g(`${uid}-tb`);
    this.gWorld = g(`${uid}-w`);
    this.gOverlay = g(`${uid}-o`);
    this.gSel = g(`${uid}-s`);
    defs.append(gTileBase, this.gWorld, this.gOverlay, this.gSel);
    svg.append(style, this.bg, defs);
    const gTileDetail = document.createElementNS(SVGNS, 'g') as SVGGElement;
    for (const layer of [gTileBase, this.gWorld, this.gOverlay, this.gSel]) {
      const row: SVGUseElement[] = [];
      for (let k = -1; k <= 1; k++) {
        const u = document.createElementNS(SVGNS, 'use') as SVGUseElement;
        u.setAttribute('href', `#${layer.id}`);
        u.setAttributeNS(XLINK, 'xlink:href', `#${layer.id}`);
        row.push(u);
        svg.append(u);
      }
      this.uses.push(row);
      if (layer === gTileBase) svg.append(gTileDetail); // detail tiles above the base, below vectors
    }
    this.tiles = new TileLayer(gTileBase, gTileDetail);

    this.viewport = new Viewport(svg, {
      onHover: (wx, wy, sx, sy) => {
        const id = this.rm.pick(wx, wy);
        this.opt.onHover?.(id >= 0 ? id : null, sx, sy);
      },
      onLeave: () => this.opt.onHover?.(null, 0, 0),
      onClick: (wx, wy) => {
        const id = this.rm.pick(wx, wy);
        this.opt.onSelect?.(id >= 0 ? id : null);
      },
      onView: (v) => this.onView(v),
    });
    this.setMap(opt.map, opt.tiles ?? null, false);
  }

  get renderMap() { return this.rm; }

  setMap(map: ClientMap | RenderMap, tiles: TileSource | null, keepView = true) {
    this.rm = map instanceof RenderMap ? map : new RenderMap(map);
    this.rm.lod = this.lastLod;
    const W = this.rm.width, H = this.rm.height;
    this.bg.setAttribute('x', String(-W)); this.bg.setAttribute('y', '0');
    this.bg.setAttribute('width', String(3 * W)); this.bg.setAttribute('height', String(H));
    for (const row of this.uses) row.forEach((u, i) => u.setAttribute('x', String((i - 1) * W)));
    this.tiles.setSource(tiles, W, H);
    this.tiles.setVisible(RASTER.includes(this.mode) && !this.custom);
    this.selected = -1;
    this.viewport.setWorld(W, H, keepView);
    this.render();
  }

  setView(vs: ViewerState | null) { this.vs = vs; this.render(); }
  setLang(lang: Lang) { this.lang = lang; this.render(); }
  setMode(mode: MapMode) {
    this.mode = mode;
    this.tiles.setVisible(RASTER.includes(mode) && !this.custom);
    this.render();
  }
  /** Replace the vector world with custom SVG (preview tool debug modes). `raster` keeps tiles. */
  setCustomWorld(svg: string | null, raster = false) {
    this.custom = svg;
    this.tiles.setVisible(svg ? raster : RASTER.includes(this.mode));
    this.render();
  }
  setOverlay(svg: string) { this.overlay = svg; this.gOverlay.innerHTML = svg; }

  /** Highlight a region and outline its neighbours. */
  select(id: number | null, center = false) {
    this.selected = id ?? -1;
    this.renderSelection();
    if (center && id !== null && id >= 0) {
      const rg = this.rm.region(id);
      if (!rg) return;
      const [x, y] = rg.label;
      const W = this.rm.width, cx = this.viewport.state.cx;
      this.viewport.centerOn(x + Math.round((cx - x) / W) * W, y);
    }
  }

  fit() { this.viewport.fit(); }
  zoomBy(f: number) { this.viewport.zoomBy(f); }

  baseImageDataUrl() { return this.tiles.baseImageDataUrl(); }

  /** The world as it is currently drawn (for SVG export). */
  worldSvg() { return this.gWorld.innerHTML; }

  destroy() {
    this.tiles.setSource(null, 1, 1);
    this.svg.remove();
  }

  // ----------------------------------------------------------------------------------

  private render() {
    const rm = this.rm;
    if (this.custom !== null) { this.gWorld.innerHTML = this.custom; }
    else {
      const vs = this.vs ?? emptyView();
      switch (this.mode) {
        case 'political': case 'praga':
          this.gWorld.innerHTML = renderPolitical(rm, vs, { lang: this.lang, mode: this.mode }); break;
        case 'resources': this.gWorld.innerHTML = renderResources(rm, vs); break;
        case 'starts': this.gWorld.innerHTML = renderStarts(rm, vs, this.lang); break;
        default: this.gWorld.innerHTML = renderBase(rm, this.mode);
      }
      // a player's (filtered) map: everything it does not contain is terra incognita,
      // in every map mode — the terrain tiles underneath must not show through
      if (rm.partial && this.mode !== 'political' && this.mode !== 'praga') {
        this.gWorld.insertAdjacentHTML('beforeend', renderFog(rm, new Set(rm.regions.map((r) => r.id))));
      }
    }
    this.gOverlay.innerHTML = this.overlay;
    this.renderSelection();
  }

  private renderSelection() {
    const id = this.selected;
    const r = this.rm.region(id);
    if (!r) { this.gSel.innerHTML = ''; return; }
    const path = (ids: number[]) => ids.map((i) => this.rm.rings(i).map((ring) => 'M' + ring.map((v, k) => fmt(v) + (k % 2 ? ' ' : ',')).join('').trim() + 'Z').join('')).join('');
    const nss = 'vector-effect="non-scaling-stroke"';
    this.gSel.innerHTML =
      `<path fill="none" stroke="#ffd166" stroke-width="1.4" stroke-linejoin="round" ${nss} d="${path(r.neighbors)}"/>` +
      `<path fill="rgba(255,255,255,0.18)" fill-rule="evenodd" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" ${nss} d="${path([id])}"/>`;
  }

  private onView(v: { cx: number; cy: number; zoom: number; w: number; h: number }) {
    const W = this.rm.width;
    this.tiles.update(v);
    // only draw the wrap copies that are on screen (each <use> costs a full repaint)
    const x0 = v.cx - v.w / 2 / v.zoom, x1 = v.cx + v.w / 2 / v.zoom;
    for (const row of this.uses) row.forEach((u, i) => {
      const k = i - 1;
      u.style.display = x1 < k * W || x0 > (k + 1) * W ? 'none' : '';
    });
    // level of detail: simplified geometry when the world is small on screen
    const rel = v.zoom / (v.w / W);
    const lod: Lod = rel < 2.2 ? 0 : 1;
    const labelLod = rel < 2.2 ? '0' : rel < 4.5 ? '1' : '2';
    if (labelLod !== this.lastLabelLod) { this.svg.setAttribute('data-lod', labelLod); this.lastLabelLod = labelLod; }
    if (lod !== this.lastLod) { this.lastLod = lod; this.rm.lod = lod; this.render(); }
    this.opt.onViewChange?.(v);
  }
}

function emptyView(): ViewerState {
  return { turn: 0, countries: [], provinces: {}, known: {}, viewer: null, visible: [], details: {}, reserved: [] };
}
