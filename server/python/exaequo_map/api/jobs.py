"""Runs ``mapgen create`` as a background subprocess and follows its JSON progress lines.

Map creation takes minutes (≈5–8 min for tiles up to level 4 on a 4-core server), so it
can never run inside a request. One job at a time per runner: baking already uses every
core.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional


@dataclass
class Job:
    job_id: str
    game_id: str
    seed: str
    status: str = "queued"  # queued | running | done | failed
    stage: str = ""
    pct: int = 0
    map_id: Optional[str] = None
    error: Optional[str] = None
    log: list[dict[str, Any]] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in ("job_id", "game_id", "seed", "status", "stage", "pct", "map_id", "error")}


class MapJobRunner:
    """
    ``command`` is the CLI prefix, e.g. ``["node", "/srv/province-forge/build/cli/mapgen.js"]``.
    ``on_done(job, bundle_dir)`` is called from the worker thread on success.
    """

    def __init__(self, command: list[str], maps_dir: Path, *, max_level: int = 4, threads: Optional[int] = None,
                 on_done: Optional[Callable[[Job, Path], None]] = None) -> None:
        self.command = command
        self.maps_dir = Path(maps_dir)
        self.max_level = max_level
        self.threads = threads
        self.on_done = on_done
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._busy = threading.Semaphore(1)

    def submit(self, game_id: str, seed: str, params: Optional[dict[str, Any]] = None) -> Job:
        job = Job(job_id=uuid.uuid4().hex[:12], game_id=game_id, seed=seed)
        with self._lock:
            self.jobs[job.job_id] = job
        threading.Thread(target=self._run, args=(job, params), daemon=True).start()
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self.jobs.get(job_id)

    def _run(self, job: Job, params: Optional[dict[str, Any]]) -> None:
        with self._busy:
            work = self.maps_dir / f".job-{job.job_id}"
            work.mkdir(parents=True, exist_ok=True)
            out = work / "bundle"
            args = [*self.command, "create", "--seed", job.seed, "--out", str(out), "--max-level", str(self.max_level)]
            if self.threads:
                args += ["--threads", str(self.threads)]
            if params:
                pfile = work / "params.json"
                pfile.write_text(json.dumps(params))
                args += ["--params", str(pfile)]
            job.status = "running"
            try:
                proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                assert proc.stdout is not None
                for line in proc.stdout:
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    job.log.append(msg)
                    job.stage = msg.get("stage", job.stage)
                    if "pct" in msg:
                        job.pct = int(msg["pct"])
                    if msg.get("mapId"):
                        job.map_id = msg["mapId"]
                stderr = proc.stderr.read() if proc.stderr else ""
                if proc.wait() != 0:
                    raise RuntimeError(f"mapgen exited {proc.returncode}: {stderr[-500:] or job.log[-1:]}")
                # bundles are content-addressed: maps_dir/<mapId>/
                final = self.maps_dir / str(job.map_id)
                if final.exists():
                    shutil.rmtree(out)
                else:
                    out.rename(final)
                if self.on_done:
                    self.on_done(job, final)
                job.status, job.pct = "done", 100
            except Exception as e:  # noqa: BLE001 — job status is the error channel
                job.status, job.error = "failed", str(e)
            finally:
                shutil.rmtree(work, ignore_errors=True)
