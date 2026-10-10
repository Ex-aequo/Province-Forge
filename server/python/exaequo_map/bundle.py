"""Map bundles on disk, as written by ``node build/cli/mapgen.js create --out <dir>``::

    <dir>/manifest.json            ids, hashes, fairness (server reads this)
    <dir>/static-map.json          FULL map — never served to players
    <dir>/client-map.<hash>.json   public, cacheable forever
    <dir>/tiles/{z}/{x}/{y}.webp   public, cacheable forever

Only ``client-map.*.json`` and ``tiles/`` may be exposed by the web server.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

BUNDLE_FORMAT = "ex-aequo/map-bundle"


@dataclass
class MapBundle:
    root: Path
    manifest: dict[str, Any]
    _static: dict[str, Any] | None = field(default=None, repr=False)

    @property
    def map_id(self) -> str:
        return self.manifest["mapId"]

    @property
    def client_file(self) -> str:
        return self.manifest["files"]["client"]

    @cached_property
    def static(self) -> dict[str, Any]:
        """The full static map (lazy; ~5–10 MB for 650 provinces)."""
        if self._static is None:
            self._static = json.loads((self.root / self.manifest["files"]["static"]).read_text("utf-8"))
        return self._static

    def neighbors(self, region_id: int) -> list[int]:
        return self.static["regions"][region_id]["neighbors"]

    def is_land(self, region_id: int) -> bool:
        return self.static["regions"][region_id]["kind"] == "land"


def load_bundle(root: str | Path) -> MapBundle:
    root = Path(root)
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    if manifest.get("format") != BUNDLE_FORMAT:
        raise ValueError(f"{root}: not a map bundle ({manifest.get('format')!r})")
    if manifest.get("formatVersion") != 1:
        raise ValueError(f"{root}: unsupported bundle version {manifest.get('formatVersion')}")
    return MapBundle(root=root, manifest=manifest)
