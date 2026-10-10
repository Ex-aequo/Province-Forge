"""Server-side helpers for Province Forge maps (Ex-Aequo Games).

- :mod:`exaequo_map.visibility` — per-player filtering of turn states (fog of war),
  movement rules for reserved start positions.
- :mod:`exaequo_map.clientmap`  — per-player client map (no geometry of hidden land).
- :mod:`exaequo_map.bundle`     — loading map bundles written by ``mapgen create``.
"""
from .bundle import MapBundle, load_bundle
from .clientmap import filter_client_map
from .visibility import (
    assign_reserved_slot,
    can_enter,
    can_own,
    filter_for_viewer,
    reserved_provinces,
    visible_for,
)

__all__ = [
    "MapBundle", "load_bundle",
    "visible_for", "filter_for_viewer", "can_enter", "can_own", "filter_client_map", "reserved_provinces", "assign_reserved_slot",
]
__version__ = "0.1.0"
