// Map modes for M4: resources and start positions. Drawn over the terrain raster.
// Resources come from the filtered view (only visible provinces); start positions
// only exist in a game-master view.
import type { ViewerState } from '../game/state';
import type { Resource } from '../gen/types';
import type { RenderMap } from '../map/renderMap';
import { PALETTE, chainPath, fmt, ringPath } from './svg';

export const RESOURCE_COLORS: Record<Resource, string> = {
  grain: '#e2c044', wood: '#3f7a3a', stone: '#9a968e', iron: '#5b6470',
  horses: '#a0673a', salt: '#f2f0ea', gold: '#ffcf33', spices: '#c2410c',
};
export const RESOURCE_PT: Record<Resource, string> = {
  grain: 'Cereais', wood: 'Madeira', stone: 'Pedra', iron: 'Ferro', horses: 'Cavalos', salt: 'Sal', gold: 'Ouro', spices: 'Especiarias',
};
export const RESOURCE_EN: Record<Resource, string> = {
  grain: 'Grain', wood: 'Wood', stone: 'Stone', iron: 'Iron', horses: 'Horses', salt: 'Salt', gold: 'Gold', spices: 'Spices',
};

const nss = 'vector-effect="non-scaling-stroke"';

function baseLines(map: RenderMap): string {
  const by = (k: string) => map.borders.filter((b) => b.kind === k);
  return `<path fill="none" stroke="rgba(30,22,14,0.35)" stroke-width="0.6" ${nss} d="${chainPath(by('land'))}"/>` +
    `<path fill="none" stroke="rgba(29,42,51,0.75)" stroke-width="1.1" ${nss} d="${chainPath(by('lakeshore'))}"/>` +
    `<path fill="none" stroke="rgba(29,42,51,0.8)" stroke-width="1.3" ${nss} d="${chainPath(by('coast'))}"/>` +
    `<path fill="none" stroke="${PALETTE.iceEdge}" stroke-width="1" ${nss} d="${chainPath(by('ice'))}"/>`;
}

/** Resource map: land dimmed, one disc per province (size = amount, rares ringed). */
export function renderResources(map: RenderMap, vs: ViewerState): string {
  const out: string[] = [];
  const land = map.regions.filter((r) => r.kind === 'land');
  out.push(`<path fill="rgba(245,240,228,0.42)" d="${land.map((r) => ringPath(map.rings(r.id))).join('')}"/>`);
  out.push(baseLines(map));
  const discs: string[] = [];
  for (const r of land) {
    const d = vs.details[r.id];
    if (!d) continue;
    const [x, y] = r.label;
    const rad = 4 + d.amount * 2;
    const rare = d.resource === 'gold' || d.resource === 'spices';
    discs.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(rad)}" fill="${RESOURCE_COLORS[d.resource]}" stroke="${rare ? '#2a1a05' : 'rgba(20,16,10,0.7)'}" stroke-width="${rare ? 1.8 : 0.9}"/>`);
    if (rare) discs.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(rad + 2.6)}" fill="none" stroke="#ffcf33" stroke-width="1.1"/>`);
  }
  out.push(`<g class="res-discs">${discs.join('')}</g>`);
  return out.join('');
}

const SLOT_COLORS = ['#c0392b', '#2471a3', '#239b56', '#b9770e', '#7d3c98', '#17a589', '#cb4335', '#2e86c1', '#28b463', '#d68910'];

/** Start positions: player territories coloured, reserves hatched, capitals starred,
 *  Praga seeds marked. Value of each start printed at its capital. */
export function renderStarts(map: RenderMap, vs: ViewerState, lang: 'pt' | 'en'): string {
  const starts = vs.gm?.starts ?? [];
  const slotOf = new Map<number, number>();
  for (const st of starts) for (const id of st.provinces) slotOf.set(id, st.slot);
  const out: string[] = [];
  out.push(`<defs><pattern id="st-res" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)"><rect width="8" height="8" fill="rgba(255,248,226,0.55)"/><rect width="2" height="8" fill="#a8781e"/></pattern></defs>`);
  for (const st of starts) {
    const d = st.provinces.map((id) => ringPath(map.rings(id))).join('');
    const fill = st.reserved ? 'url(#st-res)' : SLOT_COLORS[st.slot % SLOT_COLORS.length];
    out.push(`<path fill="${fill}" fill-opacity="${st.reserved ? 1 : 0.62}" d="${d}"/>`);
  }
  out.push(baseLines(map));
  const edges = map.borders.filter((b) => {
    const sa = slotOf.get(b.a), sb = b.b >= 0 ? slotOf.get(b.b) : undefined;
    return sa !== sb && (sa !== undefined || sb !== undefined) && b.kind !== 'sea';
  });
  out.push(`<path fill="none" stroke="rgba(15,10,6,0.9)" stroke-width="1.8" ${nss} d="${chainPath(edges)}"/>`);
  const marks: string[] = [];
  for (const st of starts) {
    const cap = map.region(st.capital);
    if (!cap) continue;
    const [x, y] = cap.label;
    marks.push(star(x, y, 6.5, st.reserved ? '#a8781e' : '#fff8e6'));
    const label = st.reserved ? (lang === 'pt' ? `Reserva · ${fmt(st.value)}` : `Reserve · ${fmt(st.value)}`) : `${st.slot + 1} · ${fmt(st.value)}`;
    marks.push(`<text class="lbl-start" x="${fmt(x)}" y="${fmt(y + 13)}">${label}</text>`);
  }
  for (const id of vs.gm?.pragaSeeds ?? []) {
    const seed = map.region(id);
    if (!seed) continue;
    const [x, y] = seed.label;
    marks.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="7" fill="#3f1430" stroke="#f4d6e4" stroke-width="1.2"/><path d="M${fmt(x - 3.5)} ${fmt(y - 3.5)}L${fmt(x + 3.5)} ${fmt(y + 3.5)}M${fmt(x + 3.5)} ${fmt(y - 3.5)}L${fmt(x - 3.5)} ${fmt(y + 3.5)}" stroke="#f4d6e4" stroke-width="1.6"/>`);
  }
  out.push(`<g>${marks.join('')}</g>`);
  return out.join('');
}

function star(cx: number, cy: number, r: number, fill: string) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(`${fmt(cx + Math.cos(a) * rr)},${fmt(cy + Math.sin(a) * rr)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="#1a120a" stroke-width="1.1" stroke-linejoin="round"/>`;
}

export const ECONOMY_CSS = `.lbl-start{font:600 8px 'IBM Plex Mono',ui-monospace,monospace;fill:#1a120a;text-anchor:middle;dominant-baseline:central;paint-order:stroke;stroke:rgba(255,250,240,.85);stroke-width:2.2px;stroke-linejoin:round}`;
