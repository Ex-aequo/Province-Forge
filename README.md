# Province Forge — Vector Map Generator (M5)

Procedural province maps for Ex-Aequo asynchronous strategy games.

**Test build:** https://ex-aequo.github.io/Province-Forge/ (GM preview tool) and https://ex-aequo.github.io/Province-Forge/demo.html (demo game client) — rebuilt automatically on every push to `main` (`.github/workflows/pages.yml`). Public URL: test data only, never real game data.
M1: geometry (cells, landmass, provinces, sea zones, adjacency, borders).
M2: hydrology (rivers, lakes, polar ice), climate, biomes, gameplay terrain, painted terrain raster tiles.
M3: bilingual names (PT/EN), turn-state contract, EU4-style political renderer (colours over relief, border hierarchy, occupation, Praga, terra incognita, curved country names).
M4: 650 provinces, resources and province value, fair start positions (25 players + 5 reserved), Praga seeds, fairness score.
M5: backend integration — production CLI with tile baking, slim client map (no secrets, 2 LODs), `MapView` + React wrapper, Python package (`exaequo_map`) with the server-side fog-of-war filter verified against shared TS test vectors, FastAPI example, PostgreSQL schema, nginx config, demo client.

## Run

```bash
npm install
npm run dev              # preview tool at http://localhost:5173
npm run gen -- <seed> out terrain [--debug]     # headless: JSON + SVG + PNG (modes: terrain|political|terrainType|landmass|elevation)
npm run build:single     # one self-contained HTML (dist-single/)
npm run typecheck
npm run mapgen -- create --seed <seed> --out maps/<dir> [--max-level 4] [--threads N]   # production bundle
npm run demo             # demo client data into dist/demo-map (after npm run build)
npm run vectors          # regenerate server/python/tests/vectors.json after changing src/game/state.ts
cd server/python && pip install -e '.[test]' && pytest
```

## Server integration (M5)

```
mapgen create ──► <maps_dir>/<mapId>/ manifest.json          server only
                                      static-map.json        server only — NEVER served
                                      client-map.<hash>.json public, immutable
                                      tiles/{z}/{x}/{y}.webp public, immutable
```

1. **Build the CLI once** on the server: `npm ci && npm run build:cli` → `build/cli/mapgen.js` (plain Node 20+, needs `@napi-rs/canvas`). Creating a map takes minutes (level 4: ~6 min on 2 cores, ~2,700 tiles, ~24 MB), so it always runs as a background job; progress comes as JSON lines on stdout.
2. **Python** (`server/python`): `exaequo_map.filter_for_viewer(static, state, viewer)` for players, `viewer=None, gm=True` only for the game's GM; `can_enter()` refuses lakes/ice and reserved start territories; `assign_reserved_slot()` for late joiners; `load_bundle()` reads a bundle. The Python filter must give byte-identical results to `src/game/state.ts` — `tests/test_vectors.py` checks it in CI.
3. **FastAPI example** (`exaequo_map.api`): `POST /games/{id}/map` (GM, starts the job), `GET /games/{id}/map/jobs/{job}`, `GET /games/{id}/map` (client map URL + tiles base), `GET /games/{id}/turns/{n}/view` (filtered for the caller; GM view for the GM), `POST …/can-enter`. Bring your own `current_user` dependency — the included `debug_user_header` trusts a header and is for local tests only.
4. **PostgreSQL**: `server/sql/schema.sql` — `maps` (metadata + manifest), `games`, `game_players`, `turn_states` (full unfiltered state as JSONB). Map files stay on disk.
5. **nginx**: `server/nginx/maps.conf` — serves only the client map and tiles with `immutable` caching; everything else under `/maps/` is 404.
6. **Client** (React + Vite): `<ProvinceMap map={clientMap} tiles={new UrlTileSource(tilesBase, clientMap.tiles)} view={viewerState} lang="pt" />` (`src/view/MapViewReact.tsx`); `src/demo/main.tsx` is a complete example. Framework-free: `new MapView(container, {...})`.

`mapId` is a content hash (generator output without timestamps/timings), so the same generator + params gives the same id.

## Pipeline (`src/gen`)

| Stage | File | What it does |
|---|---|---|
| Mesh | `mesh.ts` | Poisson-disc sites on a cylinder, Voronoi with ghost points across the east–west seam, Lloyd relaxation, wrapped neighbour lists |
| Elevation | `elevation.ts` | 3 continents (main body + lobes, domain-warped) auto-scaled to their share sliders, islands, fBm detail, sea level by area quantile, guaranteed minimum strait between continents, specks/lakes cleaned |
| Hydrology | `hydrology.ts` | Polar ice band, inland lakes (never split a landmass), Voronoi corner graph, priority-flood drainage, flux accumulation, rivers on cell EDGES (so they can be borders), tapered smoothed polylines |
| Climate | `climate.ts` | Temperature (latitude, altitude), moisture (noise, sea distance, rivers, wet tropics, dry subtropics), 10 biomes, 8 gameplay terrains per cell and per province |
| Regions | `regions.ts`, `cluster.ts` | Provinces per landmass (continents split by share sliders, islands by size), weighted Dijkstra growth with re-centring + size weights, merge/split to enforce min size; coastal sea band + open-ocean zones |
| Borders | `borders.ts` | Topological chains between junctions, noisy-edge displacement + Chaikin smoothing applied ONCE per chain, region rings assembled from the shared chains (no gaps/overlaps) |
| Validation | `generate.ts` | Contiguity, orphans, coastal→sea adjacency, global connectivity, continent count, min size, ring closure, seam adjacency |
| Resources | `resources.ts` | One main resource per province (amount 1–3) by terrain; rares (gold, spices) placed sparsely; province value = terrain + river + coast + resource × amount (tables at the top of the file are the tuning knobs) |
| Starts | `starts.ts` | Slots per continent by size; capitals spread with weighted graph-Voronoi relaxation; equal zones by balanced flood; territories grown round-robin; no rares inside, the 4 basics guaranteed; values equalised by border swaps then resource amounts; rares topped up on contested free land; Praga seeds as far as possible from every start; 10 attempts, best fairness score kept |
| Export | `export.ts` | `ex-aequo/static-map` JSON **v4** (resources, value, startSlot, `starts`, `fairness`, `pragaSeeds`) — regions (terrain, passable, river neighbours), typed movement `links` with river crossings, rivers, per-cell type/biome/terrain |
| Terrain raster | `render/terrain.ts` | 512 px tiles, levels 0–4, Delaunay-interpolated biome colours + blurred heights, ridged mountain detail, hillshade, water depth, ice; coast mask from the same vector polygons as the SVG. Runs in a Web Worker (`ui/terrain.worker.ts`), on the main thread, or in Node |

Each stage uses its own random sub-stream (`subRng(seed, stage)`).

## Rules that must not be broken

1. **Store the exported JSON, never just the seed.** Generator code will change; the same seed will produce a different world.
2. **Geometry is frozen at game start.** Ownership, Praga, terrain modifiers are per-turn *state* keyed by region id.
3. Coordinates may extend past `[0, width]`; render with wrap copies (see `renderStandalone`).

## Turn state (`src/game/state.ts`) — contract with the server

Static map (never changes) + **turn state** (every turn) + **viewer** → rendered map.

- `TurnState`: `countries[]` (id, name/fullName in PT+EN, colour), `provinces[regionId]` → `{ owner, controller, praga: 0–3 }`, `known[countryId]` → explored region ids.
- Visibility rule: a region is shown if owned/controlled or known by the viewer, **or adjacent to such a region**; everything else is terra incognita (grey).
- `filterForViewer()` must run **on the server**: it strips owner/controller/Praga of hidden provinces. Greying in the client is not security.
- `src/game/testState.ts` makes FAKE states for previewing only.

## Start positions

- `starts[]` in the static map: `slot`, `reserved`, `landmass`, `capital`, `provinces` (capital first), `value`, `freeNearby`, `rareDistance`. Player slots come first, then reserves.
- Guarantees: same province count; value within `valueTolerance` (max−min over mean); grain, wood, stone and iron in every start; no gold/spices inside or adjacent to a start; equal-size zones (room to grow).
- **Reserved slots are only marked by the generator.** The server must keep them untouchable (`TurnState.reservedSlots`) until a late joiner is assigned.

## Names

Three phonetic cultures (Iberian, Nordic, desert), one per continent; islands take the nearest continent's. Invented proper nouns are the same in both languages; generic words are translated (`Mar de X` / `Sea of X`, `Golfo de X` / `Gulf of X`, `Estreito de X` / `X Strait`, `Lago X` / `Lake X`, `Rio X` / `X River`, `Ilhas X` / `X Isles`). Stored as `{ pt, en }` in the static map.

## Gameplay terrains

`plains, forest, hills, mountains, desert, marsh, jungle, tundra` — lakes and polar ice are impassable and are not in the movement graph.

## Known limits

- Fairness is measured on land steps only; sea access to rares is not scored.
- **The fog of war hides state, not geography.** The client map and terrain tiles contain the whole world's shape (coasts, provinces, names); a player who inspects the downloads sees the geography of unexplored land, but never owners, armies, Praga, resources or start positions. Hiding geography too would need per-player tile masking — not done.
- iPad was tested in Chromium with iPad Pro 11 emulation (touch pinch/pan/tap). No real Safari/WebKit test yet — please try the demo on a real iPad.
- The client map is ~1.35 MB (~370 KB gzipped).
- Generation runs on the main thread in the preview tool (~1.5–3 s).
