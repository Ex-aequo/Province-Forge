"""Persistence interface. Map *files* live on disk (``maps_dir/<mapId>/``); PostgreSQL
keeps only metadata, games and turn states (see ``server/sql/schema.sql``)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol


@dataclass
class MapRow:
    map_id: str
    seed: str
    client_file: str
    tiles_max_level: int
    manifest: dict[str, Any]


@dataclass
class GameRow:
    game_id: str
    gm_user: str
    map_id: Optional[str] = None
    # country id per player (user id → country id)
    players: dict[str, str] = field(default_factory=dict)


class Store(Protocol):
    def get_game(self, game_id: str) -> Optional[GameRow]: ...
    def set_game_map(self, game_id: str, map_id: str) -> None: ...
    def save_map(self, row: MapRow) -> None: ...
    def get_map(self, map_id: str) -> Optional[MapRow]: ...
    def get_turn(self, game_id: str, turn: int) -> Optional[dict[str, Any]]: ...
    def save_turn(self, game_id: str, turn: int, state: dict[str, Any]) -> None: ...


class MemoryStore:
    """In-memory store for tests and local development."""

    def __init__(self) -> None:
        self.games: dict[str, GameRow] = {}
        self.maps: dict[str, MapRow] = {}
        self.turns: dict[tuple[str, int], dict[str, Any]] = {}

    def get_game(self, game_id):
        return self.games.get(game_id)

    def set_game_map(self, game_id, map_id):
        self.games[game_id].map_id = map_id

    def save_map(self, row):
        self.maps[row.map_id] = row

    def get_map(self, map_id):
        return self.maps.get(map_id)

    def get_turn(self, game_id, turn):
        return self.turns.get((game_id, turn))

    def save_turn(self, game_id, turn, state):
        self.turns[(game_id, turn)] = state


class PostgresStore:
    """psycopg 3 implementation of :class:`Store` (``pip install exaequo-map[postgres]``).

    ``pool`` is a ``psycopg_pool.ConnectionPool``. Synchronous on purpose: FastAPI runs
    sync endpoints in a thread pool.
    """

    def __init__(self, pool) -> None:
        self.pool = pool

    def _one(self, sql: str, args: tuple):
        with self.pool.connection() as c:
            return c.execute(sql, args).fetchone()

    def _exec(self, sql: str, args: tuple) -> None:
        with self.pool.connection() as c:
            c.execute(sql, args)

    def get_game(self, game_id):
        row = self._one("SELECT game_id, gm_user, map_id FROM games WHERE game_id = %s", (game_id,))
        if not row:
            return None
        with self.pool.connection() as c:
            players = dict(c.execute("SELECT user_id, country_id FROM game_players WHERE game_id = %s", (game_id,)).fetchall())
        return GameRow(game_id=row[0], gm_user=row[1], map_id=row[2], players=players)

    def set_game_map(self, game_id, map_id):
        self._exec("UPDATE games SET map_id = %s WHERE game_id = %s", (map_id, game_id))

    def save_map(self, row):
        self._exec(
            """INSERT INTO maps (map_id, seed, client_file, tiles_max_level, manifest)
               VALUES (%s, %s, %s, %s, %s::jsonb)
               ON CONFLICT (map_id) DO NOTHING""",
            (row.map_id, row.seed, row.client_file, row.tiles_max_level, json.dumps(row.manifest)),
        )

    def get_map(self, map_id):
        r = self._one("SELECT map_id, seed, client_file, tiles_max_level, manifest FROM maps WHERE map_id = %s", (map_id,))
        return MapRow(*r) if r else None

    def get_turn(self, game_id, turn):
        r = self._one("SELECT state FROM turn_states WHERE game_id = %s AND turn = %s", (game_id, turn))
        return r[0] if r else None

    def save_turn(self, game_id, turn, state):
        self._exec(
            """INSERT INTO turn_states (game_id, turn, state) VALUES (%s, %s, %s::jsonb)
               ON CONFLICT (game_id, turn) DO UPDATE SET state = EXCLUDED.state""",
            (game_id, turn, json.dumps(state)),
        )
