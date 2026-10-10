-- Province Forge — PostgreSQL schema (metadata only; map files live on disk in
-- <maps_dir>/<map_id>/, see server/python/exaequo_map/bundle.py).

CREATE TABLE IF NOT EXISTS maps (
    map_id           text PRIMARY KEY,           -- sha256(static-map.json)[:16], content address
    seed             text NOT NULL,
    client_file      text NOT NULL,              -- client-map.<hash>.json
    tiles_max_level  smallint NOT NULL,
    manifest         jsonb NOT NULL,             -- stats, fairness, generator version, params
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
    game_id     text PRIMARY KEY,
    gm_user     text NOT NULL,                   -- the only user who gets the GM view
    map_id      text REFERENCES maps(map_id),    -- NULL until the map job finishes
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_players (
    game_id     text NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    user_id     text NOT NULL,
    country_id  text NOT NULL,
    start_slot  smallint,                        -- start position used (incl. late joiners)
    joined_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, user_id),
    UNIQUE (game_id, country_id)
);

-- Full, UNFILTERED turn state (TurnState in src/game/state.ts). Never send it as is:
-- always through filter_for_viewer().
CREATE TABLE IF NOT EXISTS turn_states (
    game_id     text NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    turn        integer NOT NULL,
    state       jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, turn)
);
