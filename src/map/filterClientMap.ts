// Cut a client map down to what one player can see. Reference implementation — the
// server runs the Python twin (exaequo_map.filter_client_map); shared test vectors keep
// them identical. The browser only ever gets the result.
//
// Kept: visible regions (plus lakes/ice bordering them — drawn, never entered), every
// border chain that touches a kept region, river pieces over kept regions, landmasses
// with a kept region. Everything else becomes null or disappears: hidden provinces have
// no shape, name, terrain or even kind in the player's copy.
import type { ClientChain, ClientMap, ClientRegion, ClientRiver } from './clientMap';

export function filterClientMap(cm: ClientMap, visible: Iterable<number>): ClientMap {
  const keep = new Set<number>();
  for (const id of visible) if (cm.regions[id]) keep.add(id);
  // lakes and ice are not in the movement graph: keep them when they border a kept region
  for (const c of cm.chains) {
    if (!c || c.b < 0) continue;
    const ka = cm.regions[c.a]?.kind, kb = cm.regions[c.b]?.kind;
    if ((ka === 'lake' || ka === 'ice') && keep.has(c.b) && !keep.has(c.a)) keep.add(c.a);
    if ((kb === 'lake' || kb === 'ice') && keep.has(c.a) && !keep.has(c.b)) keep.add(c.b);
  }

  const regions = cm.regions.map((r): ClientRegion | null => {
    if (!r || !keep.has(r.id)) return null;
    return {
      ...r,
      neighbors: r.neighbors.filter((o) => keep.has(o)),
      riverNeighbors: r.riverNeighbors.filter((o) => keep.has(o)),
    };
  });
  const chains = cm.chains.map((c): ClientChain | null =>
    c && (keep.has(c.a) || (c.b >= 0 && keep.has(c.b))) ? c : null);

  const rivers: ClientRiver[] = [];
  for (const rv of cm.rivers) {
    if (!rv.regs) continue; // already filtered pieces carry no tags: drop rather than leak
    // runs of kept points, per level of detail; pieces are paired by order
    const runs = [0, 1].map((l) => keptRuns(rv.regs![l], keep));
    const n = Math.max(runs[0].length, runs[1].length);
    for (let k = 0; k < n; k++) {
      const r0 = runs[0][k], r1 = runs[1][k];
      const cut = (l: 0 | 1, r: [number, number] | undefined) =>
        r ? { pts: rv.lod[l].slice(2 * r[0], 2 * r[1] + 2), w: rv.widths[l].slice(r[0], r[1] + 1) } : { pts: [], w: [] };
      const a = cut(0, r0), b = cut(1, r1);
      if (a.pts.length < 4 && b.pts.length < 4) continue;
      rivers.push({ id: rv.id, name: rv.name, lod: [a.pts, b.pts], widths: [a.w, b.w] });
    }
  }

  const lmKept = new Set<number>();
  for (const r of regions) if (r) lmKept.add(r.landmass);
  return {
    ...cm,
    landmasses: cm.landmasses.filter((l) => lmKept.has(l.id)),
    regions,
    chains,
    rivers,
    partial: true,
  };
}

/** [first, last] index ranges of consecutive kept points. A point over no region (-1,
 *  e.g. exactly on a coast) is kept when a neighbouring point is kept. */
function keptRuns(regs: number[], keep: Set<number>): [number, number][] {
  const n = regs.length;
  const inK = regs.map((r) => r >= 0 && keep.has(r));
  const ok = inK.map((v, i) => v || (regs[i] < 0 && ((i > 0 && inK[i - 1]) || (i < n - 1 && inK[i + 1]))));
  const out: [number, number][] = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && ok[i]) { if (s < 0) s = i; }
    else if (s >= 0) { if (i - 1 > s) out.push([s, i - 1]); s = -1; }
  }
  return out;
}
