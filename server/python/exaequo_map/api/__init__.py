"""FastAPI example integration. Install with ``pip install exaequo-map[api]``.

    from exaequo_map.api import Settings, MemoryStore, make_router
    app.include_router(make_router(Settings(...), store, current_user))
"""
from .jobs import MapJobRunner
from .router import Settings, User, make_router
from .store import GameRow, MapRow, MemoryStore, Store

__all__ = ["Settings", "User", "make_router", "MapJobRunner", "Store", "MemoryStore", "MapRow", "GameRow"]
