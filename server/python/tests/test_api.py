import json
import sys
import time
from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI, Header, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from exaequo_map.api import GameRow, MemoryStore, Settings, User, make_router  # noqa: E402

HERE = Path(__file__).parent
DATA = json.loads((HERE / "vectors.json").read_text("utf-8"))
STATE = next(c["state"] for c in DATA["cases"] if c.get("viewer") is None and c["progress"] == 0.5)
COUNTRY = STATE["countries"][0]["id"]


def user(x_user: str = Header(default="")) -> User:
    if not x_user:
        raise HTTPException(401)
    return User(id=x_user)


@pytest.fixture
def client(tmp_path):
    store = MemoryStore()
    store.games["g1"] = GameRow(game_id="g1", gm_user="gm", players={"alice": COUNTRY})
    settings = Settings(maps_dir=tmp_path, mapgen=(sys.executable, str(HERE / "fake_mapgen.py")))
    app = FastAPI()
    app.include_router(make_router(settings, store, user))
    c = TestClient(app)
    c.store = store
    return c


def wait(c, job_id, who="gm"):
    for _ in range(100):
        j = c.get(f"/games/g1/map/jobs/{job_id}", headers={"x-user": who}).json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(0.05)
    raise AssertionError("job timed out")


def test_full_flow(client):
    assert client.post("/games/g1/map", json={"seed": "s1"}, headers={"x-user": "alice"}).status_code == 403
    r = client.post("/games/g1/map", json={"seed": "s1"}, headers={"x-user": "gm"})
    assert r.status_code == 202
    job = wait(client, r.json()["job_id"])
    assert job["status"] == "done" and job["map_id"] == "f" * 16

    info = client.get("/games/g1/map", headers={"x-user": "alice"}).json()
    assert info["tilesBase"] == f"/maps/{'f' * 16}/"
    assert "clientMap" not in info  # the full client map is never handed out
    assert client.get("/games/g1/map", headers={"x-user": "mallory"}).status_code == 403

    client.store.save_turn("g1", 1, STATE)
    v = client.get("/games/g1/turns/1/view", headers={"x-user": "alice"}).json()
    assert v["viewer"] == COUNTRY and "gm" not in v
    assert len(v["visible"]) < len(DATA["staticMap"]["regions"])
    g = client.get("/games/g1/turns/1/view", headers={"x-user": "gm"}).json()
    assert g["viewer"] is None and "gm" in g
    assert client.get("/games/g1/turns/1/view", headers={"x-user": "mallory"}).status_code == 403

    # geometry: filtered per player, full for the GM, with ETag
    r = client.get("/games/g1/turns/1/map", headers={"x-user": "alice"})
    assert r.status_code == 200
    cm = r.json()
    assert cm["partial"] is True
    shown = {x["id"] for x in cm["regions"] if x}
    assert shown and shown <= set(v["visible"]) | {x["id"] for x in cm["regions"] if x and x["kind"] in ("lake", "ice")}
    assert len(shown) < len(cm["regions"])
    again = client.get("/games/g1/turns/1/map", headers={"x-user": "alice", "if-none-match": r.headers["etag"]})
    assert again.status_code == 304
    full = client.get("/games/g1/turns/1/map", headers={"x-user": "gm"}).json()
    assert not full.get("partial") and all(full["regions"])
    assert client.get("/games/g1/turns/1/map", headers={"x-user": "mallory"}).status_code == 403

    reserved = [p for s in DATA["staticMap"]["starts"] if s["slot"] in STATE["reservedSlots"] for p in s["provinces"]]
    r = client.post("/games/g1/turns/1/can-enter", json={"province": reserved[0]}, headers={"x-user": "alice"})
    assert r.json()["allowed"] is False
    sea = next(x["id"] for x in DATA["staticMap"]["regions"] if x["kind"] == "sea")
    r = client.post("/games/g1/turns/1/can-enter", json={"province": sea}, headers={"x-user": "alice"})
    assert r.json() == {"province": sea, "allowed": True, "ownable": False}


def test_failed_job(client):
    r = client.post("/games/g1/map", json={"seed": "fail"}, headers={"x-user": "gm"})
    job = wait(client, r.json()["job_id"])
    assert job["status"] == "failed"
    assert client.get("/games/g1/map", headers={"x-user": "alice"}).status_code == 409


def test_seed_is_validated(client):
    r = client.post("/games/g1/map", json={"seed": "../../etc"}, headers={"x-user": "gm"})
    assert r.status_code == 422
