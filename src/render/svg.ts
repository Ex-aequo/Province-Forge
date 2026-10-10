// SVG rendering of a generated map. Pure string building, so it runs in the browser
// and headless (for tests / server-side export) alike.
import { createRng } from '../gen/rng';
import type { BorderChain, GeneratedMap, Region, River, Terrain } from '../gen/types';

export type ViewMode = 'terrain' | 'political' | 'praga' | 'resources' | 'starts' | 'terrainType' | 'landmass' | 'elevation';

/** Flat, high-contrast colours for the gameplay terrain map mode. */
export const TERRAIN_COLORS: Record<Terrain, string> = {
  plains: '#c8c27c', forest: '#4f7d3f', hills: '#a98d5d', mountains: '#7c6f66',
  desert: '#e3cb8c', marsh: '#6d8f78', jungle: '#2f6b3c', tundra: '#b8c4c2',
};

export const PALETTE = {
  sea: '#4a7193',
  seaCoastal: '#5079a0',
  lake: '#5b8fae',
  ice: '#e6edf1',
  iceEdge: '#9db3c2',
  river: '#3e6d90',
  seaBorder: 'rgba(225, 238, 248, 0.32)',
  coast: '#1d2a33',
  landBorder: 'rgba(28, 22, 16, 0.6)',
  landmass: ['#c9a66b', '#8fb07a', '#c98f7a', '#a39ac4'],
  island: '#b9b4a6',
};

export const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

export function ringPath(rings: number[][]): string {
  let d = '';
  for (const r of rings) {
    if (r.length < 6) continue;
    d += 'M' + fmt(r[0]) + ' ' + fmt(r[1]) + 'L';
    for (let i = 2; i < r.length; i += 2) d += fmt(r[i]) + ' ' + fmt(r[i + 1]) + ' ';
    d += 'Z';
  }
  return d;
}

export function chainPath(chains: BorderChain[]): string {
  let d = '';
  for (const c of chains) {
    d += 'M' + fmt(c.pts[0]) + ' ' + fmt(c.pts[1]) + 'L';
    for (let i = 2; i < c.pts.length; i += 2) d += fmt(c.pts[i]) + ' ' + fmt(c.pts[i + 1]) + ' ';
  }
  return d;
}

/** EU4-like random country colours: mid saturation, mid lightness. Deterministic per id. */
export function politicalColor(id: number, seed: string): string {
  const rng = createRng(`${seed}::color::${id}`);
  const h = Math.floor(rng() * 360);
  const s = 28 + Math.floor(rng() * 26);
  const l = 46 + Math.floor(rng() * 16);
  return `hsl(${h} ${s}% ${l}%)`;
}

function elevationColor(e: number): string {
  if (e < 0) {
    const t = Math.min(1, -e);
    const l = 52 - t * 26;
    return `hsl(208 42% ${l}%)`;
  }
  // hypsometric tint: green lowlands → ochre hills → brown → snow
  const stops: [number, number, number, number][] = [
    [0, 95, 38, 52], [0.35, 70, 35, 50], [0.6, 38, 38, 48], [0.82, 25, 25, 40], [1, 0, 0, 92],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (e <= stops[i][0]) {
      const [e0, h0, s0, l0] = stops[i - 1], [e1, h1, s1, l1] = stops[i];
      const t = (e - e0) / (e1 - e0);
      return `hsl(${Math.round(h0 + (h1 - h0) * t)} ${Math.round(s0 + (s1 - s0) * t)}% ${Math.round(l0 + (l1 - l0) * t)}%)`;
    }
  }
  return 'hsl(0 0% 92%)';
}

export interface RenderOptions {
  mode: ViewMode;
  /** Draw province borders (land) and sea-zone borders. */
  borders?: boolean;
}

export function regionFill(map: GeneratedMap, r: Region, mode: ViewMode): string {
  if (r.kind === 'sea') return r.seaKind === 'coastal' ? PALETTE.seaCoastal : PALETTE.sea;
  if (r.kind === 'lake') return PALETTE.lake;
  if (r.kind === 'ice') return PALETTE.ice;
  if (mode === 'terrainType') return TERRAIN_COLORS[r.terrain ?? 'plains'];
  if (mode === 'landmass') {
    const lm = map.landmasses[r.landmass];
    return lm?.isContinent ? PALETTE.landmass[r.landmass % 4] : PALETTE.island;
  }
  return politicalColor(r.id, map.params.seed);
}

/** The world content (no wrapper <svg>). Coordinates may extend past [0, width]. */
export function renderWorld(map: GeneratedMap, opt: RenderOptions): string {
  const out: string[] = [];
  const nss = 'vector-effect="non-scaling-stroke"';

  if (opt.mode === 'elevation') {
    // bucket cells by colour → one path per bucket (keeps the DOM small)
    const buckets = new Map<string, string[]>();
    for (let i = 0; i < map.cellPolys.length; i++) {
      const e = map.elevation[i];
      const q = Math.round(e * 24) / 24;
      const col = elevationColor(q);
      const p = map.cellPolys[i];
      let d = 'M' + fmt(p[0]) + ' ' + fmt(p[1]) + 'L';
      for (let k = 2; k < p.length; k += 2) d += fmt(p[k]) + ' ' + fmt(p[k + 1]) + ' ';
      (buckets.get(col) ?? buckets.set(col, []).get(col)!).push(d + 'Z');
    }
    out.push('<g class="cells-elev">');
    for (const [col, ds] of buckets) out.push(`<path fill="${col}" stroke="${col}" stroke-width="0.6" d="${ds.join('')}"/>`);
    out.push('</g>');
  } else if (opt.mode !== 'terrain') {
    out.push('<g class="fills">');
    for (const r of map.regions) {
      if (!r.rings.length) continue;
      const fill = regionFill(map, r, opt.mode);
      out.push(`<path data-r="${r.id}" fill="${fill}" fill-rule="evenodd" d="${ringPath(r.rings)}"/>`);
    }
    out.push('</g>');
  }

  const by = (k: BorderChain['kind']) => map.borders.filter((b) => b.kind === k);
  const terrain = opt.mode === 'terrain';
  if (opt.mode !== 'elevation') out.push(renderRivers(map.rivers, terrain ? 0.92 : 0.85));
  if (opt.borders !== false) {
    out.push(`<path class="b-sea" fill="none" stroke="${PALETTE.seaBorder}" stroke-width="1" stroke-dasharray="3 3" ${nss} d="${chainPath(by('sea'))}"/>`);
    if (opt.mode !== 'elevation') {
      const landStroke = terrain ? 'rgba(40, 30, 22, 0.42)' : PALETTE.landBorder;
      out.push(`<path class="b-land" fill="none" stroke="${landStroke}" stroke-width="${terrain ? 0.7 : 0.9}" stroke-linejoin="round" ${nss} d="${chainPath(by('land'))}"/>`);
    }
  }
  out.push(`<path class="b-ice" fill="none" stroke="${PALETTE.iceEdge}" stroke-width="1" stroke-linejoin="round" ${nss} d="${chainPath(by('ice'))}"/>`);
  out.push(`<path class="b-lake" fill="none" stroke="${terrain ? 'rgba(29,42,51,0.7)' : PALETTE.coast}" stroke-width="1.1" stroke-linejoin="round" ${nss} d="${chainPath(by('lakeshore'))}"/>`);
  out.push(`<path class="b-coast" fill="none" stroke="${terrain ? 'rgba(29,42,51,0.75)' : PALETTE.coast}" stroke-width="${terrain ? 1.2 : 1.6}" stroke-linejoin="round" ${nss} d="${chainPath(by('coast'))}"/>`);
  return out.join('');
}

/** Rivers as tapered strokes: segments bucketed by width, one path per bucket. */
export function renderRivers(rivers: River[], opacity = 0.9): string {
  const buckets = new Map<number, string[]>();
  for (const r of rivers) {
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      if (Math.abs(r.pts[i + 2] - r.pts[i]) + Math.abs(r.pts[i + 3] - r.pts[i + 1]) < 0.05) continue; // zero-length
      const w = Math.round(((r.widths[i / 2] + r.widths[i / 2 + 1]) / 2) * 4) / 4;
      const d = `M${fmt(r.pts[i])} ${fmt(r.pts[i + 1])}L${fmt(r.pts[i + 2])} ${fmt(r.pts[i + 3])}`;
      (buckets.get(w) ?? buckets.set(w, []).get(w)!).push(d);
    }
  }
  const out: string[] = [`<g class="rivers" fill="none" stroke="${PALETTE.river}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${opacity}">`];
  for (const [w, ds] of [...buckets].sort((a, b) => a[0] - b[0])) out.push(`<path stroke-width="${w}" d="${ds.join('')}"/>`);
  out.push('</g>');
  return out.join('');
}

// ---------------------------------------------------------------- debug overlays

export function renderCells(map: GeneratedMap): string {
  let d = '';
  for (const p of map.cellPolys) {
    if (p.length < 6) continue;
    d += 'M' + fmt(p[0]) + ' ' + fmt(p[1]) + 'L';
    for (let k = 2; k < p.length; k += 2) d += fmt(p[k]) + ' ' + fmt(p[k + 1]) + ' ';
    d += 'Z';
  }
  return `<path fill="none" stroke="rgba(0,0,0,0.22)" stroke-width="0.5" vector-effect="non-scaling-stroke" d="${d}"/>`;
}

export function renderIds(map: GeneratedMap): string {
  const out: string[] = ['<g class="ids" font-family="ui-monospace, monospace" text-anchor="middle" dominant-baseline="central">'];
  for (const r of map.regions) {
    const size = r.kind === 'land' ? 9 : 8;
    const fill = r.kind === 'land' ? '#111' : '#e8f1f8';
    out.push(`<text x="${fmt(r.label[0])}" y="${fmt(r.label[1])}" font-size="${size}" fill="${fill}" paint-order="stroke" stroke="${r.kind === 'land' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.35)'}" stroke-width="2" stroke-linejoin="round">${r.id}</text>`);
  }
  out.push('</g>');
  return out.join('');
}

export function renderAdjacency(map: GeneratedMap): string {
  const W = map.width;
  let land = '', mixed = '', sea = '';
  for (const r of map.regions) {
    for (const o of r.neighbors) {
      if (o < r.id) continue;
      const q = map.regions[o];
      let [x1, y1] = r.label;
      let [x2, y2] = q.label;
      // draw the short way round; seam-crossing links are drawn twice (one per side)
      let dx = x2 - x1;
      const segs: [number, number, number, number][] = [];
      if (Math.abs(dx) > W / 2) {
        dx = dx > 0 ? dx - W : dx + W;
        segs.push([x1, y1, x1 + dx, y2], [x2, y2, x2 - dx, y1]);
      } else segs.push([x1, y1, x2, y2]);
      const s = segs.map(([a, b, c, d]) => `M${fmt(a)} ${fmt(b)}L${fmt(c)} ${fmt(d)}`).join('');
      if (r.kind === 'land' && q.kind === 'land') land += s;
      else if (r.kind === 'sea' && q.kind === 'sea') sea += s;
      else mixed += s;
    }
  }
  const st = 'fill="none" stroke-width="1" vector-effect="non-scaling-stroke"';
  return `<path ${st} stroke="#c0392b" d="${land}"/><path ${st} stroke="#f1c40f" d="${mixed}"/><path ${st} stroke="#ecf0f1" d="${sea}"/>`;
}

export function renderSeam(map: GeneratedMap): string {
  const W = map.width, H = map.height;
  return `<g stroke="#ff2d55" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"><line x1="0" y1="0" x2="0" y2="${H}"/><line x1="${W}" y1="0" x2="${W}" y2="${H}"/></g>`;
}

/** Outline of a set of regions (selection / neighbour highlight). */
export function renderOutline(map: GeneratedMap, ids: number[], stroke: string, width: number, fill = 'none'): string {
  const d = ids.map((id) => ringPath(map.regions[id].rings)).join('');
  return `<path fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" vector-effect="non-scaling-stroke" d="${d}"/>`;
}

/** Standalone SVG document with three wrap copies, clipped to the world rect.
 *  `terrainImage` (a data URL covering exactly [0,W]×[0,H]) is placed under raster modes.
 *  `content` replaces the default world rendering (e.g. the political renderer). */
export function renderStandalone(map: GeneratedMap, opt: RenderOptions, extra = '', terrainImage?: string, content?: string, css = ''): string {
  const W = map.width, H = map.height;
  const world = (content ?? renderWorld(map, opt)) + extra;
  const raster = opt.mode === 'terrain' || opt.mode === 'political' || opt.mode === 'praga' || opt.mode === 'resources' || opt.mode === 'starts';
  const img = raster && terrainImage
    ? `<image href="${terrainImage}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-lod="0">` +
    (css ? `<style>${css}</style>` : '') +
    `<rect width="${W}" height="${H}" fill="${PALETTE.sea}"/>${img}` +
    `<defs><g id="w">${world}</g></defs>` +
    `<use href="#w" x="${-W}"/><use href="#w"/><use href="#w" x="${W}"/></svg>`;
}
