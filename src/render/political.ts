// EU4-style political map: country colours over the painted relief, a border hierarchy
// derived from ownership, occupation stripes, Praga overlay, curved country names and
// zoom-dependent place labels. Drawn from  static map + viewer-filtered turn state.
// Pure string building: runs in the game client, the preview tool and Node.
import type { ViewerState } from '../game/state';
import type { RenderBorder, RenderMap, RenderRegion } from '../map/renderMap';
import { PALETTE, chainPath, fmt, renderRivers, ringPath } from './svg';

export type Lang = 'pt' | 'en';

/** Label styles. Font sizes are in map units, so labels scale with zoom; the root <svg>
 *  carries data-lod (0 far · 1 mid · 2 close) to decide which kinds are shown. */
export const LABEL_CSS = `
.lbl-country{font-family:'Spectral SC',Georgia,serif;font-weight:600;fill:rgba(28,20,12,.86);stroke:rgba(250,244,230,.5);paint-order:stroke;stroke-linejoin:round}
.lbl-prov{font:500 8.5px 'IBM Plex Sans',system-ui,sans-serif;fill:rgba(25,18,12,.88);text-anchor:middle;dominant-baseline:central;paint-order:stroke;stroke:rgba(255,250,240,.6);stroke-width:1.6px;stroke-linejoin:round}
.lbl-sea{font:italic 500 9px 'Spectral SC',Georgia,serif;fill:rgba(228,238,247,.92);text-anchor:middle;dominant-baseline:central;letter-spacing:1px}
.lbl-lake{font-size:7px;fill:rgba(20,48,70,.9)}
.lbl-ocean{font:italic 600 20px 'Spectral SC',Georgia,serif;fill:rgba(228,238,247,.7);text-anchor:middle;dominant-baseline:central;letter-spacing:3px}
.lbl-reserved{font:600 8px 'IBM Plex Sans',system-ui,sans-serif;letter-spacing:2px;fill:#7a5512;text-anchor:middle;dominant-baseline:central;paint-order:stroke;stroke:rgba(255,248,226,.8);stroke-width:2px}
.lbl-river{font:italic 500 5.5px 'Spectral SC',Georgia,serif;fill:#21496a;letter-spacing:.6px}
svg[data-lod="0"] .lbl-prov,svg[data-lod="0"] .lbl-sea,svg[data-lod="0"] .lbl-ocean,svg[data-lod="0"] .lbl-river{display:none}
svg[data-lod="0"] .lbl-small,svg[data-lod="0"] .lbl-close,svg[data-lod="1"] .lbl-close{display:none}
svg[data-lod="1"] .lbl-river{display:none}
svg[data-lod="1"] .lbl-countries{opacity:.5}
svg[data-lod="2"] .lbl-countries{opacity:.2}
svg[data-lod="2"] .lbl-ocean{opacity:.45}
`;

export interface PoliticalOptions {
  lang: Lang;
  /** 'political' = countries; 'praga' = Praga intensity heat map. */
  mode: 'political' | 'praga';
  labels?: boolean;
}

const GREY = '#8c8f8b';
const PRAGA_HEAT = ['rgba(236, 229, 211, 0.55)', '#c99a8e', '#94455a', '#3f1430'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function renderPolitical(map: RenderMap, vs: ViewerState, opt: PoliticalOptions): string {
  const out: string[] = [];
  const nss = 'vector-effect="non-scaling-stroke"';
  const regions = map.regions;
  const colors = new Map(vs.countries.map((c) => [c.id, c.color]));

  // lakes and ice are not in the movement graph: show them if they touch a visible region
  const visible = new Set(vs.visible);
  for (const b of map.borders) {
    if (b.b < 0) continue;
    const ka = map.region(b.a)?.kind, kb = map.region(b.b)?.kind;
    if ((ka === 'lake' || ka === 'ice') && visible.has(b.b)) visible.add(b.a);
    if ((kb === 'lake' || kb === 'ice') && visible.has(b.a)) visible.add(b.b);
  }
  const prov = (id: number) => vs.provinces[id];

  // ---- defs: occupation stripes per controller, Praga patterns
  const defs: string[] = [];
  const occupiers = new Set<string>();
  for (const p of Object.values(vs.provinces)) if (p.controller && p.controller !== p.owner) occupiers.add(p.controller);
  for (const c of occupiers) {
    defs.push(`<pattern id="occ-${c}" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)"><rect width="3.2" height="7" fill="${colors.get(c) ?? '#666'}"/></pattern>`);
  }
  defs.push(
    `<pattern id="praga-1" patternUnits="userSpaceOnUse" width="9" height="9"><circle cx="2" cy="2" r="1.1" fill="rgba(58,10,40,0.55)"/><circle cx="6.5" cy="6.5" r="0.9" fill="rgba(58,10,40,0.45)"/></pattern>`,
    `<pattern id="praga-2" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(30)"><rect width="6" height="6" fill="rgba(70,12,45,0.18)"/><path d="M0 0L6 6M6 0L0 6" stroke="rgba(58,10,40,0.6)" stroke-width="0.9"/></pattern>`,
    `<pattern id="praga-3" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(30)"><rect width="5" height="5" fill="rgba(45,6,30,0.5)"/><path d="M0 0L5 5M5 0L0 5" stroke="rgba(25,2,15,0.75)" stroke-width="1"/></pattern>`,
  );
  defs.push(`<pattern id="reserved-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)"><rect width="8" height="8" fill="rgba(255,248,226,0.28)"/><rect width="1.6" height="8" fill="rgba(150,112,40,0.55)"/></pattern>`);
  out.push(`<defs>${defs.join('')}</defs>`);
  // reserved start positions (for late joiners) that nobody holds yet
  const reservedStarts = (vs.reserved ?? []).filter((st) => st.provinces.every((id) => !vs.provinces[id]?.owner));
  const reservedSlotOf = new Map<number, number>();
  for (const st of reservedStarts) for (const id of st.provinces) reservedSlotOf.set(id, st.slot);

  // ---- fills
  const fills: string[] = ['<g class="pol-fills">'];
  if (opt.mode === 'political') {
    // one path per country (fewer DOM nodes than one per province)
    const byOwner = new Map<string, number[]>();
    for (const r of regions) {
      if (r.kind !== 'land' || !visible.has(r.id)) continue;
      const o = prov(r.id)?.owner;
      if (o) (byOwner.get(o) ?? byOwner.set(o, []).get(o)!).push(r.id);
    }
    for (const [o, ids] of byOwner) {
      fills.push(`<path fill="${colors.get(o) ?? '#777'}" fill-opacity="0.74" fill-rule="evenodd" d="${ids.map((i) => ringPath(map.rings(i))).join('')}"/>`);
    }
    // occupation stripes
    const occ = new Map<string, number[]>();
    for (const r of regions) {
      const p = prov(r.id);
      if (!p || !visible.has(r.id) || !p.controller || p.controller === p.owner) continue;
      (occ.get(p.controller) ?? occ.set(p.controller, []).get(p.controller)!).push(r.id);
    }
    for (const [c, ids] of occ) fills.push(`<path fill="url(#occ-${c})" fill-opacity="0.95" d="${ids.map((i) => ringPath(map.rings(i))).join('')}"/>`);
    // reserved territories: light hatching (drawn under Praga and borders)
    for (const st of reservedStarts) {
      const ids = st.provinces.filter((id) => visible.has(id));
      if (ids.length) fills.push(`<path fill="url(#reserved-hatch)" d="${ids.map((i) => ringPath(map.rings(i))).join('')}"/>`);
    }
    // Praga as a hatched overlay
    for (const lvl of [1, 2, 3]) {
      const ids = regions.filter((r) => visible.has(r.id) && prov(r.id)?.praga === lvl).map((r) => r.id);
      if (ids.length) fills.push(`<path fill="url(#praga-${lvl})" d="${ids.map((i) => ringPath(map.rings(i))).join('')}"/>`);
    }
  } else {
    for (const lvl of [0, 1, 2, 3]) {
      const ids = regions.filter((r) => r.kind === 'land' && visible.has(r.id) && (prov(r.id)?.praga ?? 0) === lvl).map((r) => r.id);
      if (ids.length) fills.push(`<path fill="${PRAGA_HEAT[lvl]}" fill-opacity="${lvl ? 0.86 : 1}" d="${ids.map((i) => ringPath(map.rings(i))).join('')}"/>`);
    }
  }
  fills.push('</g>');
  out.push(fills.join(''));

  // ---- rivers, then borders by hierarchy
  out.push(renderRivers(map.rivers, 0.9));
  const ownerOf = (id: number) => (map.region(id)?.kind === 'land' ? prov(id)?.owner ?? null : null);
  const countryB: RenderBorder[] = [], provB: RenderBorder[] = [];
  for (const b of map.borders) {
    if (b.kind !== 'land') continue;
    if (ownerOf(b.a) !== ownerOf(b.b)) countryB.push(b); else provB.push(b);
  }
  const by = (k: string) => map.borders.filter((b) => b.kind === k);
  out.push(`<path fill="none" stroke="${PALETTE.seaBorder}" stroke-width="0.8" stroke-dasharray="3 3" ${nss} d="${chainPath(by('sea'))}"/>`);
  out.push(`<path fill="none" stroke="rgba(30, 22, 14, 0.3)" stroke-width="0.6" stroke-linejoin="round" ${nss} d="${chainPath(provB)}"/>`);
  out.push(`<path fill="none" stroke="${PALETTE.iceEdge}" stroke-width="1" ${nss} d="${chainPath(by('ice'))}"/>`);
  out.push(`<path fill="none" stroke="rgba(29,42,51,0.75)" stroke-width="1.1" stroke-linejoin="round" ${nss} d="${chainPath(by('lakeshore'))}"/>`);
  out.push(`<path fill="none" stroke="rgba(29,42,51,0.8)" stroke-width="1.3" stroke-linejoin="round" ${nss} d="${chainPath(by('coast'))}"/>`);
  out.push(`<path fill="none" stroke="rgba(22, 15, 10, 0.88)" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" ${nss} d="${chainPath(countryB)}"/>`);

  // reserved outline: dashed gold around each reserved territory
  if (reservedStarts.length) {
    const edges = map.borders.filter((b) => {
      const sa = reservedSlotOf.get(b.a), sb = b.b >= 0 ? reservedSlotOf.get(b.b) : undefined;
      return sa !== sb;
    });
    out.push(`<path fill="none" stroke="#a8781e" stroke-width="1.6" stroke-dasharray="5 3" ${nss} d="${chainPath(edges)}"/>`);
  }

  // ---- known only from an earlier sighting: a pale veil (the borders stay readable)
  const stale = (vs.stale ?? []).filter((id) => visible.has(id) && map.region(id));
  if (stale.length) {
    out.push(`<path class="stale" fill="rgba(236, 231, 218, 0.55)" d="${stale.map((i) => ringPath(map.rings(i))).join('')}"/>`);
  }

  // ---- terra incognita on top of everything it hides
  out.push(renderFog(map, visible));

  if (opt.labels !== false) out.push(renderLabels(map, vs, visible, opt.lang));
  return out.join('');
}

/**
 * Terra incognita. On a filtered (player) map the hidden regions have no shape, so the
 * fog is the whole world minus the visible regions; on a full map (preview tool) it is
 * simply the hidden regions. Either way it is opaque: no terrain shows through.
 */
export function renderFog(map: RenderMap, visible: Set<number>): string {
  const nss = 'vector-effect="non-scaling-stroke"';
  const W = map.width, H = map.height;
  const edge = map.borders.filter((b) => b.b >= 0 && visible.has(b.a) !== visible.has(b.b));
  const edgePath = edge.length ? `<path fill="none" stroke="rgba(70, 72, 68, 0.7)" stroke-width="1.2" ${nss} d="${chainPath(edge)}"/>` : '';
  if (!map.partial) {
    const hidden = map.regions.filter((r) => !visible.has(r.id)).map((r) => r.id);
    if (!hidden.length) return '';
    return `<path class="fog" fill="${GREY}" stroke="${GREY}" stroke-width="0.8" d="${hidden.map((i) => ringPath(map.rings(i))).join('')}"/>` + edgePath;
  }
  // world rectangle with a hole per visible region; rings that cross the seam also get
  // a copy shifted by ±W so the hole shows on both sides, and the fog is clipped to the
  // world so it never spills over the neighbouring wrap copy
  const holes: string[] = [];
  for (const r of map.regions) {
    if (!visible.has(r.id)) continue;
    for (const ring of map.rings(r.id)) {
      let x0 = Infinity, x1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { if (ring[i] < x0) x0 = ring[i]; if (ring[i] > x1) x1 = ring[i]; }
      holes.push(ringPath([ring]));
      if (x0 < 0) holes.push(ringPath([ring.map((v, i) => (i % 2 ? v : v + W))]));
      if (x1 > W) holes.push(ringPath([ring.map((v, i) => (i % 2 ? v : v - W))]));
    }
  }
  const cid = `fog-clip-${W}`;
  return `<clipPath id="${cid}"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>` +
    `<path class="fog" clip-path="url(#${cid})" fill="${GREY}" fill-rule="evenodd" d="M0,0H${W}V${H}H0Z${holes.join('')}"/>` + edgePath;
}

// ------------------------------------------------------------------------------ labels

function renderLabels(map: RenderMap, vs: ViewerState, visible: Set<number>, lang: Lang): string {
  const out: string[] = [];
  const regions = map.regions;
  const W = map.width;

  // place names (shown by zoom level through CSS: .lbl-prov, .lbl-sea, .lbl-ocean, .lbl-river)
  const place: string[] = [];
  for (const r of regions) {
    if (!visible.has(r.id) || !r.name) continue;
    const [x, y] = r.label;
    const n = esc(r.name[lang]);
    if (r.kind === 'land') {
      // fit the name to the province: width ≈ 1.1·√area, ~0.56 em per character
      const fs = Math.min(8.5, (Math.sqrt(r.area) * 1.1) / (r.name[lang].length * 0.56));
      const cls = fs < 4.2 ? 'lbl-prov lbl-close' : 'lbl-prov';
      place.push(`<text class="${cls}" x="${fmt(x)}" y="${fmt(y)}" style="font-size:${fmt(Math.max(3.4, fs))}px">${n}</text>`);
    }
    else if (r.kind === 'sea') place.push(`<text class="${r.seaKind === 'ocean' ? 'lbl-ocean' : 'lbl-sea'}" x="${fmt(x)}" y="${fmt(y)}">${n}</text>`);
    else if (r.kind === 'lake') place.push(`<text class="lbl-sea lbl-lake" x="${fmt(x)}" y="${fmt(y)}">${n}</text>`);
  }
  // rivers: label the longest visible piece of each river along its course
  const best = new Map<number, { len: number; pts: number[] }>();
  for (const rv of map.rivers) {
    let len = 0;
    for (let i = 2; i < rv.pts.length; i += 2) len += Math.hypot(rv.pts[i] - rv.pts[i - 2], rv.pts[i + 1] - rv.pts[i - 1]);
    const mid = Math.floor(rv.pts.length / 4) * 2;
    if (!visible.has(map.pick(rv.pts[mid], rv.pts[mid + 1]))) continue;
    const cur = best.get(rv.id);
    if (len > 140 && (!cur || len > cur.len)) best.set(rv.id, { len, pts: rv.pts });
  }
  const riverDefs: string[] = [];
  let k = 0;
  for (const [id, { pts }] of best) {
    const rv = map.rivers.find((r) => r.id === id)!;
    let p = pts;
    if (p[p.length - 2] < p[0]) p = reverse(p); // read left to right
    const pid = `rv-${k++}`;
    riverDefs.push(`<path id="${pid}" d="M${p.map((v, i) => (i % 2 ? fmt(v) + ' ' : fmt(v) + ',')).join('').trim()}" fill="none"/>`);
    place.push(`<text class="lbl-river" dy="-1.6"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(rv.name?.[lang] ?? '')}</textPath></text>`);
  }
  out.push(`<defs>${riverDefs.join('')}</defs>`);
  out.push(`<g class="lbl-places">${place.join('')}</g>`);

  // country names, curved along the country's main axis. Larger countries are placed
  // first; a label that would overlap one already placed is dropped.
  const country: string[] = [], cdefs: string[] = [];
  const placed: { x0: number; y0: number; x1: number; y1: number; pts: number[]; h: number }[] = [];
  const cands = vs.countries.map((c, ci) => ({ c, ci, lab: countryLabel(map, vs, c.id, visible, W) }))
    .filter((o) => o.lab)
    .sort((a, b) => b.lab!.area - a.lab!.area);
  for (const { c, ci, lab } of cands) {
    const L = lab!;
    const text = c.name[lang].toUpperCase();
    const n = text.length;
    // size from territory: never larger than its thickness nor ~ √(area) / 4
    let fs = Math.min(L.thickness * 0.5, (L.length * 0.95) / (n * 0.72), Math.sqrt(L.area) / 3.2);
    if (fs < 3.5) continue;
    const natural = n * fs * 0.72;
    const used = Math.min(L.length, natural + Math.max(0, (L.length * 0.85 - natural)) * 0.6);
    const spacing = Math.max(0, Math.min(fs * 1.2, (used - natural) / Math.max(1, n - 1)));
    // collision footprint: points along the used middle part of the path, ±fs/2
    const mid = L.pts.length / 2;
    const keep = Math.max(2, Math.round((used / L.length) * mid));
    const from = Math.floor((mid - keep) / 2);
    const fp = L.pts.slice(from * 2, (from + keep) * 2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < fp.length; i += 2) { x0 = Math.min(x0, fp[i]); x1 = Math.max(x1, fp[i]); y0 = Math.min(y0, fp[i + 1]); y1 = Math.max(y1, fp[i + 1]); }
    const h = fs * 0.6;
    const box = { x0: x0 - h, y0: y0 - h, x1: x1 + h, y1: y1 + h, pts: fp, h };
    const hits = placed.some((q) => {
      for (const sh of [-W, 0, W]) {
        if (box.x1 < q.x0 + sh || box.x0 > q.x1 + sh || box.y1 < q.y0 || box.y0 > q.y1) continue;
        for (let i = 0; i < box.pts.length; i += 2) for (let j = 0; j < q.pts.length; j += 2) {
          if (Math.hypot(box.pts[i] - q.pts[j] - sh, box.pts[i + 1] - q.pts[j + 1]) < box.h + q.h) return true;
        }
      }
      return false;
    });
    if (hits) continue;
    placed.push(box);
    const pid = `cl-${ci}`;
    // small countries only appear once the player zooms in a little
    const cls = fs < 9 ? 'lbl-country lbl-small' : 'lbl-country';
    cdefs.push(`<path id="${pid}" d="${L.d}" fill="none"/>`);
    country.push(`<text class="${cls}" font-size="${fmt(fs)}" letter-spacing="${fmt(spacing)}" stroke-width="${fmt(fs * 0.09)}"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(text)}</textPath></text>`);
  }
  out.push(`<defs>${cdefs.join('')}</defs><g class="lbl-countries">${country.join('')}</g>`);
  const res: string[] = [];
  for (const st of vs.reserved ?? []) {
    if (!st.provinces.length || st.provinces.some((id) => vs.provinces[id]?.owner)) continue;
    const r0 = map.region(st.provinces[0]);
    if (!r0) continue;
    const [x, y] = r0.label;
    res.push(`<text class="lbl-reserved" x="${fmt(x)}" y="${fmt(y)}">${lang === 'pt' ? 'RESERVADO' : 'RESERVED'}</text>`);
  }
  out.push(`<g class="lbl-countries">${res.join('')}</g>`);
  return out.join('');
}

function reverse(p: number[]) {
  const o: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) o.push(p[i], p[i + 1]);
  return o;
}

/**
 * Curved label path for a country: principal axis of its largest contiguous territory,
 * with a quadratic fitted through the middle of the territory along that axis.
 */
export function countryLabel(map: RenderMap, vs: ViewerState, cid: string, visible: Set<number>, W: number):
  { d: string; pts: number[]; length: number; thickness: number; area: number } | null {
  const owned = new Set<number>();
  for (const [id, p] of Object.entries(vs.provinces)) if (p.owner === cid && visible.has(Number(id)) && map.region(Number(id))) owned.add(Number(id));
  if (!owned.size) return null;
  // largest contiguous part (land adjacency)
  let bestPart: number[] = [], bestArea = 0;
  const seen = new Set<number>();
  for (const s of owned) {
    if (seen.has(s)) continue;
    const part = [s]; seen.add(s);
    for (let h = 0; h < part.length; h++) for (const o of map.region(part[h])!.neighbors) if (owned.has(o) && !seen.has(o)) { seen.add(o); part.push(o); }
    const area = part.reduce((a, id) => a + map.region(id)!.area, 0);
    if (area > bestArea) { bestArea = area; bestPart = part; }
  }
  // sample points: each province's outline (LOD 0) plus its label point weighted by
  // area, unwrapped around the first province
  const xs: number[] = [], ys: number[] = [];
  const x0 = map.region(bestPart[0])!.label[0];
  const add = (x: number, y: number) => { xs.push(x + Math.round((x0 - x) / W) * W); ys.push(y); };
  for (const id of bestPart) {
    for (const ring of map.rings(id, 0)) for (let i = 0; i < ring.length; i += 2) add(ring[i], ring[i + 1]);
    const rg = map.region(id)!;
    const w = Math.max(1, Math.round(rg.area / (map.spacing * map.spacing * 4)));
    for (let k = 0; k < w; k++) add(rg.label[0], rg.label[1]);
  }
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // keep text readable: never steeper than ~60°, prefer horizontal-ish reading
  ang = Math.max(-1.05, Math.min(1.05, ang));
  let ux = Math.cos(ang), uy = Math.sin(ang);
  if (ux < 0) { ux = -ux; uy = -uy; }
  const vx = -uy, vy = ux;
  const s: number[] = [], t: number[] = [];
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; s.push(dx * ux + dy * uy); t.push(dx * vx + dy * vy); }
  const sorted = [...s].sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.04)], hi = sorted[Math.floor(n * 0.96)];
  const span = hi - lo;
  if (span <= 0) return null;
  // bins along the axis: middle and thickness of the territory
  const K = 8;
  const binMin = new Array(K).fill(Infinity), binMax = new Array(K).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const b = Math.min(K - 1, Math.max(0, Math.floor(((s[i] - lo) / span) * K)));
    if (t[i] < binMin[b]) binMin[b] = t[i];
    if (t[i] > binMax[b]) binMax[b] = t[i];
  }
  const spacing = map.spacing;
  const bs: number[] = [], bt: number[] = [], th: number[] = [];
  for (let b = 0; b < K; b++) {
    if (!Number.isFinite(binMin[b])) continue;
    bs.push(lo + ((b + 0.5) / K) * span);
    bt.push((binMin[b] + binMax[b]) / 2);
    th.push(binMax[b] - binMin[b] + spacing);
  }
  // least-squares quadratic t(s) = a + b s + c s²
  const [a, b1, c0] = fitQuadratic(bs, bt);
  const partSet = new Set(bestPart);
  const STEPS = 14;
  const centre = (lo + hi) / 2;
  let half = span * 0.42;
  let c = 0, raw: number[] = [];
  // shrink the path until at least 85% of it lies inside the country's territory
  for (let attempt = 0; attempt < 6; attempt++) {
    c = Math.max(-0.6 / half, Math.min(0.6 / half, c0)); // limit bend
    raw = [];
    let inside = 0;
    for (let i = 0; i <= STEPS; i++) {
      const ss = -half + (2 * half * i) / STEPS + centre;
      const tt = a + b1 * ss + c * ss * ss;
      const px = mx + ss * ux + tt * vx, py = my + ss * uy + tt * vy;
      raw.push(px, py);
      if (partSet.has(map.pick(px, py))) inside++;
    }
    if (inside / (STEPS + 1) >= 0.85) break;
    half *= 0.82;
  }
  const thSorted = [...th].sort((p, q) => p - q);
  const thickness = thSorted[Math.floor(thSorted.length / 2)] ?? spacing;
  const d = 'M' + Array.from({ length: raw.length / 2 }, (_, i) => `${fmt(raw[2 * i])},${fmt(raw[2 * i + 1])}`).join(' L');
  return { d, pts: raw, length: 2 * half, thickness, area: bestArea };
}

function fitQuadratic(x: number[], y: number[]): [number, number, number] {
  const n = x.length;
  if (n < 3) {
    const my = y.reduce((p, q) => p + q, 0) / Math.max(1, n);
    return [my, 0, 0];
  }
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i], x2 = xi * xi;
    s0 += 1; s1 += xi; s2 += x2; s3 += x2 * xi; s4 += x2 * x2;
    t0 += yi; t1 += xi * yi; t2 += x2 * yi;
  }
  // solve 3×3 normal equations (Cramer)
  const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const D = det3(M);
  if (Math.abs(D) < 1e-9) return [t0 / s0, 0, 0];
  const col = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? [t0, t1, t2][i] : v)));
  return [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D];
}

/** Province / sea display name in the chosen language, with fallback. */
export function regionTitle(r: RenderRegion, lang: Lang): string {
  return r.name?.[lang] ?? `#${r.id}`;
}
