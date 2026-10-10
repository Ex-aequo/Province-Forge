"""Stands in for `node build/cli/mapgen.js` in API tests: writes a tiny bundle built
from vectors.json and prints the same JSON progress lines."""
import json, sys
from pathlib import Path

args = sys.argv[1:]
out = Path(args[args.index("--out") + 1]); seed = args[args.index("--seed") + 1]
if seed == "fail":
    print(json.dumps({"stage": "failed", "reason": "validation"})); sys.exit(1)
static = json.loads((Path(__file__).parent / "vectors.json").read_text())["staticMap"]
out.mkdir(parents=True)
(out / "static-map.json").write_text(json.dumps(static))
(out / "client-map.abc.json").write_text(json.dumps(json.loads((Path(__file__).parent / "client_vectors.json").read_text())["clientMap"]))
map_id = "f" * 16
print(json.dumps({"stage": "generate", "seed": seed}))
print(json.dumps({"stage": "maps", "mapId": map_id}))
for pct in (0, 50, 100):
    print(json.dumps({"stage": "tiles", "pct": pct}))
(out / "manifest.json").write_text(json.dumps({
    "format": "ex-aequo/map-bundle", "formatVersion": 1, "mapId": map_id, "seed": seed,
    "files": {"static": "static-map.json", "client": "client-map.abc.json"},
    "tiles": {"maxLevel": 2},
}))
print(json.dumps({"stage": "done", "mapId": map_id}))
