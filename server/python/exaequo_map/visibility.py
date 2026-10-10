"""Per-player view of a turn — the server-side twin of ``src/game/state.ts``.

Every player request MUST go through :func:`filter_for_viewer` before anything is sent:
the client greys out unknown land, but greying is presentation, not security.

The Python and TypeScript implementations are kept identical by shared test vectors
(``tests/vectors.json``, regenerated with ``npm run vectors``).
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

StaticMap = Mapping[str, Any]  # static-map.json (or the subset: regions, starts, pragaSeeds, fairness)
TurnState = Mapping[str, Any]  # see TurnState in src/game/state.ts


def _neighbors(static_map: StaticMap, region_id: int) -> list[int]:
    regions = static_map["regions"]
    if 0 <= region_id < len(regions):
        return regions[region_id]["neighbors"]
    return []


def visible_for(static_map: StaticMap, state: TurnState, viewer: Optional[str]) -> set[int]:
    """Regions shown in colour: owned, controlled or known by the viewer, plus their
    neighbours. ``viewer=None`` (game master) sees everything."""
    if viewer is None:
        return {r["id"] for r in static_map["regions"]}
    base: set[int] = set(state.get("known", {}).get(viewer, []))
    for pid, p in state.get("provinces", {}).items():
        if p.get("owner") == viewer or p.get("controller") == viewer:
            base.add(int(pid))
    out = set(base)
    for rid in base:
        out.update(_neighbors(static_map, rid))
    return out


def filter_for_viewer(static_map: StaticMap, state: TurnState, viewer: Optional[str], *, gm: bool = False) -> dict:
    """Strip everything ``viewer`` may not see.

    ``viewer=None`` is only allowed with ``gm=True`` — only grant it after checking the
    user's game-master role.
    """
    if viewer is None and not gm:
        raise PermissionError("filter_for_viewer: viewer None requires gm=True")
    vis = visible_for(static_map, state, viewer)
    provinces = {pid: p for pid, p in state.get("provinces", {}).items() if int(pid) in vis}

    seen: set[str] = set()
    for p in provinces.values():
        if p.get("owner"):
            seen.add(p["owner"])
        if p.get("controller"):
            seen.add(p["controller"])
    if viewer:
        seen.add(viewer)

    details: dict[str, dict] = {}
    regions = static_map["regions"]
    for rid in sorted(vis):
        if not (0 <= rid < len(regions)):
            continue
        r = regions[rid]
        if r.get("kind") == "land" and r.get("resource"):
            d = {"resource": r["resource"], "amount": r.get("amount") or 1}
            if gm:
                d["value"] = r.get("value") or 0
            details[str(rid)] = d

    reserved_slots = set(state.get("reservedSlots") or [])
    reserved = [
        {"slot": st["slot"], "provinces": [pid for pid in st["provinces"] if pid in vis]}
        for st in static_map.get("starts") or []
        if st["slot"] in reserved_slots and any(pid in vis for pid in st["provinces"])
    ]

    view: dict[str, Any] = {
        "turn": state["turn"],
        "countries": [c for c in state.get("countries", []) if viewer is None or c["id"] in seen],
        "provinces": provinces,
        "known": {viewer: state.get("known", {}).get(viewer, [])} if viewer else state.get("known", {}),
        "reservedSlots": state.get("reservedSlots"),
        "viewer": viewer,
        "visible": sorted(vis),
        "details": details,
        "reserved": reserved,
    }
    if view["reservedSlots"] is None:
        del view["reservedSlots"]
    if gm:
        view["gm"] = {
            "starts": static_map.get("starts") or [],
            "pragaSeeds": static_map.get("pragaSeeds") or [],
            "fairness": static_map.get("fairness"),
        }
    return view


def can_enter(static_map: StaticMap, state: TurnState, province: int) -> bool:
    """Server rule: a unit may move into / claim ``province`` this turn.

    Refuses impassable regions (lakes, ice) and the territories of start positions that
    are still reserved for late joiners (``state["reservedSlots"]``).
    """
    regions = static_map["regions"]
    if not (0 <= province < len(regions)) or regions[province]["kind"] not in ("land", "sea"):
        return False
    reserved = set(state.get("reservedSlots") or [])
    return not any(st["slot"] in reserved and province in st["provinces"] for st in static_map.get("starts") or [])


def reserved_provinces(static_map: StaticMap, state: TurnState) -> set[int]:
    """All provinces currently protected for late joiners."""
    reserved = set(state.get("reservedSlots") or [])
    out: set[int] = set()
    for st in static_map.get("starts") or []:
        if st["slot"] in reserved:
            out.update(st["provinces"])
    return out


def assign_reserved_slot(static_map: StaticMap, state: dict, country_id: str) -> Optional[int]:
    """Give a late-joining country the first still-reserved start: removes the slot from
    ``reservedSlots`` and makes the country owner/controller of its provinces.
    Returns the slot, or None if no reserve is left. Mutates ``state``."""
    remaining: list[int] = list(state.get("reservedSlots") or [])
    if not remaining:
        return None
    slot = min(remaining)
    start = next(st for st in static_map["starts"] if st["slot"] == slot)
    state["reservedSlots"] = [s for s in remaining if s != slot]
    provinces = state.setdefault("provinces", {})
    for pid in start["provinces"]:
        p = provinces.setdefault(str(pid), {"owner": None, "controller": None, "praga": 0})
        p["owner"] = country_id
        p["controller"] = country_id
    known = state.setdefault("known", {})
    known[country_id] = sorted(set(known.get(country_id, [])) | set(start["provinces"]))
    return slot


def ids(values: Iterable[Any]) -> list[int]:
    return sorted(int(v) for v in values)
