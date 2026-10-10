"""Example FastAPI router. Copy and adapt — the auth dependency is YOURS to provide.

Rules enforced here (the security of the fog of war depends on them):
  * players only ever receive ``filter_for_viewer(..., viewer=<their country>)``;
  * the GM view (``viewer=None, gm=True``) is built only for the game's GM user;
  * ``static-map.json`` is never served — only the client map and tiles, via nginx;
  * moves into reserved start territories are refused (``can_enter``).
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from ..bundle import load_bundle
from ..visibility import can_enter, filter_for_viewer
from .jobs import Job, MapJobRunner
from .store import MapRow, Store


@dataclass
class Settings:
    maps_dir: Path                      # where bundles live: <maps_dir>/<mapId>/
    maps_url: str = "/maps"             # public URL prefix served by nginx (client map + tiles)
    mapgen: tuple[str, ...] = ("node", "build/cli/mapgen.js")
    max_level: int = 4
    threads: Optional[int] = None


@dataclass
class User:
    id: str
    is_admin: bool = False


class CreateMap(BaseModel):
    seed: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    params: Optional[dict[str, Any]] = None


class MoveCheck(BaseModel):
    province: int


def make_router(settings: Settings, store: Store, current_user: Callable[..., User],
                runner: Optional[MapJobRunner] = None) -> APIRouter:
    r = APIRouter()

    def on_done(job: Job, bundle_dir: Path) -> None:
        b = load_bundle(bundle_dir)
        m = b.manifest
        store.save_map(MapRow(map_id=b.map_id, seed=m["seed"], client_file=b.client_file,
                              tiles_max_level=m["tiles"]["maxLevel"], manifest=m))
        store.set_game_map(job.game_id, b.map_id)

    runner = runner or MapJobRunner(list(settings.mapgen), settings.maps_dir, max_level=settings.max_level,
                                    threads=settings.threads, on_done=on_done)
    if runner.on_done is None:
        runner.on_done = on_done

    @lru_cache(maxsize=8)
    def static_map(map_id: str) -> dict[str, Any]:
        return load_bundle(settings.maps_dir / map_id).static

    def game_or_404(game_id: str):
        g = store.get_game(game_id)
        if not g:
            raise HTTPException(404, "game not found")
        return g

    def require_gm(game_id: str, user: User):
        g = game_or_404(game_id)
        if user.id != g.gm_user and not user.is_admin:
            raise HTTPException(403, "game master only")
        return g

    # ---- map creation (GM) ---------------------------------------------------------
    @r.post("/games/{game_id}/map", status_code=202)
    def create_map(game_id: str, body: CreateMap, user: User = Depends(current_user)):
        require_gm(game_id, user)
        return runner.submit(game_id, body.seed, body.params).public()

    @r.get("/games/{game_id}/map/jobs/{job_id}")
    def job_status(game_id: str, job_id: str, user: User = Depends(current_user)):
        require_gm(game_id, user)
        job = runner.get(job_id)
        if not job or job.game_id != game_id:
            raise HTTPException(404, "job not found")
        return job.public()

    # ---- map info (any player of the game) ----------------------------------------
    @r.get("/games/{game_id}/map")
    def map_info(game_id: str, user: User = Depends(current_user)):
        g = game_or_404(game_id)
        if user.id not in g.players and user.id != g.gm_user:
            raise HTTPException(403, "not in this game")
        if not g.map_id:
            raise HTTPException(409, "map not created yet")
        m = store.get_map(g.map_id)
        base = f"{settings.maps_url}/{g.map_id}"
        return {"mapId": g.map_id, "clientMap": f"{base}/{m.client_file}", "tilesBase": f"{base}/"}

    # ---- the turn, as this user may see it ----------------------------------------
    @r.get("/games/{game_id}/turns/{turn}/view")
    def turn_view(game_id: str, turn: int, user: User = Depends(current_user)):
        g = game_or_404(game_id)
        state = store.get_turn(game_id, turn)
        if state is None or not g.map_id:
            raise HTTPException(404, "turn not found")
        if user.id == g.gm_user:
            return filter_for_viewer(static_map(g.map_id), state, None, gm=True)
        country = g.players.get(user.id)
        if not country:
            raise HTTPException(403, "not in this game")
        return filter_for_viewer(static_map(g.map_id), state, country)

    @r.post("/games/{game_id}/turns/{turn}/can-enter")
    def check_move(game_id: str, turn: int, body: MoveCheck, user: User = Depends(current_user)):
        g = game_or_404(game_id)
        if user.id not in g.players and user.id != g.gm_user:
            raise HTTPException(403, "not in this game")
        state = store.get_turn(game_id, turn)
        if state is None or not g.map_id:
            raise HTTPException(404, "turn not found")
        return {"province": body.province, "allowed": can_enter(static_map(g.map_id), state, body.province)}

    return r


def debug_user_header(x_debug_user: str = Header(default="")) -> User:  # pragma: no cover — example only
    """DO NOT USE IN PRODUCTION: trusts a header. Replace with your session/JWT check."""
    if not x_debug_user:
        raise HTTPException(401, "login required")
    return User(id=x_debug_user)


__all__ = ["Settings", "User", "make_router", "debug_user_header"]
