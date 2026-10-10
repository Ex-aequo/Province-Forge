import copy
import json
from pathlib import Path

from exaequo_map import assign_reserved_slot, can_enter, reserved_provinces

DATA = json.loads((Path(__file__).parent / "vectors.json").read_text("utf-8"))
STATIC = DATA["staticMap"]


def test_late_joiner_takes_a_reserved_slot():
    state = copy.deepcopy(next(c["state"] for c in DATA["cases"] if "canEnter" in c))
    slots = list(state["reservedSlots"])
    assert slots, "vector map should have reserves"
    protected = reserved_provinces(STATIC, state)
    assert protected and not any(can_enter(STATIC, state, p) for p in protected)

    slot = assign_reserved_slot(STATIC, state, "late")
    assert slot == min(slots) and slot not in state["reservedSlots"]
    start = next(s for s in STATIC["starts"] if s["slot"] == slot)
    for pid in start["provinces"]:
        assert state["provinces"][str(pid)]["owner"] == "late"
        assert can_enter(STATIC, state, pid)
    for _ in state["reservedSlots"][:]:
        assign_reserved_slot(STATIC, state, "x")
    assert assign_reserved_slot(STATIC, state, "y") is None
