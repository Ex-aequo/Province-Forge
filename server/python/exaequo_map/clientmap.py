"""Cut a client map down to what one player can see — twin of
``src/map/filterClientMap.ts`` (kept identical by ``tests/client_vectors.json``).

Players must only ever receive the filtered map: hidden provinces then have no shape,
name, terrain or even kind in the browser. The full ``client-map.*.json`` stays on the
server (it is no longer served by nginx).
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

ClientMap = Mapping[str, Any]


def filter_client_map(cm: ClientMap, visible: Iterable[int]) -> dict:
    regions = cm["regions"]
    chains = cm["chains"]
    keep: set[int] = {i for i in visible if 0 <= i < len(regions) and regions[i]}
    # lakes and ice are not in the movement graph: keep them when they border a kept region
    for c in chains:
        if not c or c["b"] < 0:
            continue
        ka = (regions[c["a"]] or {}).get("kind")
        kb = (regions[c["b"]] or {}).get("kind")
        if ka in ("lake", "ice") and c["b"] in keep and c["a"] not in keep:
            keep.add(c["a"])
        if kb in ("lake", "ice") and c["a"] in keep and c["b"] not in keep:
            keep.add(c["b"])

    out_regions: list[Any] = []
    for r in regions:
        if not r or r["id"] not in keep:
            out_regions.append(None)
            continue
        r2 = dict(r)
        r2["neighbors"] = [o for o in r["neighbors"] if o in keep]
        r2["riverNeighbors"] = [o for o in r["riverNeighbors"] if o in keep]
        out_regions.append(r2)

    out_chains = [c if c and (c["a"] in keep or (c["b"] >= 0 and c["b"] in keep)) else None for c in chains]

    rivers: list[dict] = []
    for rv in cm["rivers"]:
        regs = rv.get("regs")
        if not regs:
            continue  # already-filtered pieces carry no tags: drop rather than leak
        runs = [_kept_runs(regs[l], keep) for l in (0, 1)]
        for k in range(max(len(runs[0]), len(runs[1]))):
            pieces = []
            for l in (0, 1):
                r = runs[l][k] if k < len(runs[l]) else None
                if r is None:
                    pieces.append(([], []))
                else:
                    pieces.append((rv["lod"][l][2 * r[0]: 2 * r[1] + 2], rv["widths"][l][r[0]: r[1] + 1]))
            if len(pieces[0][0]) < 4 and len(pieces[1][0]) < 4:
                continue
            piece: dict[str, Any] = {"id": rv["id"]}
            if rv.get("name") is not None:
                piece["name"] = rv["name"]
            piece["lod"] = [pieces[0][0], pieces[1][0]]
            piece["widths"] = [pieces[0][1], pieces[1][1]]
            rivers.append(piece)

    lm_kept = {r["landmass"] for r in out_regions if r}
    out = dict(cm)
    out["landmasses"] = [l for l in cm["landmasses"] if l["id"] in lm_kept]
    out["regions"] = out_regions
    out["chains"] = out_chains
    out["rivers"] = rivers
    out["partial"] = True
    return out


def _kept_runs(regs: list[int], keep: set[int]) -> list[tuple[int, int]]:
    """[first, last] ranges of consecutive kept points; a point over no region (-1) is
    kept when a neighbouring point is kept."""
    n = len(regs)
    in_k = [r >= 0 and r in keep for r in regs]
    ok = [in_k[i] or (regs[i] < 0 and ((i > 0 and in_k[i - 1]) or (i < n - 1 and in_k[i + 1]))) for i in range(n)]
    out: list[tuple[int, int]] = []
    s = -1
    for i in range(n + 1):
        if i < n and ok[i]:
            if s < 0:
                s = i
        elif s >= 0:
            if i - 1 > s:
                out.append((s, i - 1))
            s = -1
    return out
