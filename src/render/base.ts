// Base map modes drawn from a RenderMap over the terrain raster: plain terrain
// (rivers + borders) and the flat gameplay-terrain colours.
import type { RenderMap } from '../map/renderMap';
import { PALETTE, TERRAIN_COLORS, chainPath, renderRivers, ringPath } from './svg';

const nss = 'vector-effect="non-scaling-stroke"';

export function renderBase(map: RenderMap, mode: 'terrain' | 'terrainType'): string {
  const out: string[] = [];
  if (mode === 'terrainType') {
    const byT = new Map<string, number[]>();
    for (const r of map.regions) {
      const key = r.kind === 'land' ? TERRAIN_COLORS[r.terrain ?? 'plains'] : r.kind === 'lake' ? PALETTE.lake : r.kind === 'ice' ? PALETTE.ice : '';
      if (key) (byT.get(key) ?? byT.set(key, []).get(key)!).push(r.id);
    }
    for (const [col, ids] of byT) out.push(`<path fill="${col}" d="${ids.map((i) => ringPath(map.rings(i))).join('')}"/>`);
  }
  const by = (k: string) => map.borders.filter((b) => b.kind === k);
  out.push(renderRivers(map.rivers, 0.92));
  out.push(`<path fill="none" stroke="${PALETTE.seaBorder}" stroke-width="0.8" stroke-dasharray="3 3" ${nss} d="${chainPath(by('sea'))}"/>`);
  out.push(`<path fill="none" stroke="rgba(40,30,22,${mode === 'terrain' ? 0.42 : 0.6})" stroke-width="0.7" stroke-linejoin="round" ${nss} d="${chainPath(by('land'))}"/>`);
  out.push(`<path fill="none" stroke="${PALETTE.iceEdge}" stroke-width="1" ${nss} d="${chainPath(by('ice'))}"/>`);
  out.push(`<path fill="none" stroke="rgba(29,42,51,0.7)" stroke-width="1.1" stroke-linejoin="round" ${nss} d="${chainPath(by('lakeshore'))}"/>`);
  out.push(`<path fill="none" stroke="rgba(29,42,51,0.75)" stroke-width="1.2" stroke-linejoin="round" ${nss} d="${chainPath(by('coast'))}"/>`);
  return out.join('');
}
