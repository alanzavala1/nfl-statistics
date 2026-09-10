"""Offline season refresh — the only place that ingests.

Runs in GitHub Actions on a schedule, against the database pulled from GCS.
Never inside the container serving traffic: ingest is a heavy single-writer job
that once held `write_lock` against every reader and crash-looped the service
(see the Phase 0 commit).

Two subcommands, because the split is what keeps a frequent schedule cheap:

  check   compares nflverse's published play-by-play stamp against ours and
          reports whether there is anything to do. Reads a few bytes.
  ingest  pulls the season in and rewrites the stamp. Only runs when `check`
          says something moved.

The watermark deliberately lives in its own small GCS object rather than inside
the database. Putting it in the database would mean downloading 477 MB on every
run just to discover there was nothing to do — and most runs have nothing to do,
since nflverse republishes a season only as its games are charted.

Exit status is always 0 on a clean run: "no new data" is a normal outcome, not
a failure.
"""
from __future__ import annotations

import json
import os
import sys

import httpx
import pandas as pd

PBP_RELEASE_API = "https://api.github.com/repos/nflverse/nflverse-data/releases/tags/pbp"
SCHEDULE_CSV = "http://www.habitatring.com/games.csv"

# Recorded when a season is ingested before its play-by-play exists, so a
# schedules-only load isn't repeated every run while we wait for kickoff.
SCHEDULES_ONLY = "schedules-only"


def _log(msg: str) -> None:
    print(msg, flush=True)


def upstream_latest_season() -> int:
    """The newest season the NFL has scheduled, per the nflverse schedule feed.

    Deliberately not `config.CURRENT_SEASON`, which reports the newest season
    already in our database. Asking the database what to fetch next can never
    discover a new season — it would answer with the one it already has. The
    schedule feed is published months ahead, so it is the thing that knows a
    new season exists at all.
    """
    games = pd.read_csv(SCHEDULE_CSV, usecols=["season"])
    return int(games["season"].max())


def remote_pbp_watermark(season: int) -> str | None:
    """`updated_at` for the season's play-by-play asset, or None if unpublished.

    nflverse creates the asset only once a season's first games are played and
    charted, so None means "no football yet", not an error.
    """
    r = httpx.get(PBP_RELEASE_API, timeout=30, follow_redirects=True)
    r.raise_for_status()
    target = f"play_by_play_{season}.parquet"
    for asset in r.json().get("assets", []):
        if asset.get("name") == target:
            return asset.get("updated_at")
    return None


def read_watermarks(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        # Absent or unreadable is the first-run case, not an error.
        return {}


def write_watermarks(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")


def _emit(**outputs) -> None:
    """Report to the workflow and to whoever reads the log."""
    for k, v in outputs.items():
        _log(f"  {k}={v}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            for k, v in outputs.items():
                fh.write(f"{k}={v}\n")


def _resolve_season() -> int:
    override = os.environ.get("REFRESH_SEASON")
    return int(override) if override else upstream_latest_season()


def cmd_check(watermarks_path: str) -> int:
    season = _resolve_season()
    force = os.environ.get("REFRESH_FORCE") == "1"
    marks = read_watermarks(watermarks_path)
    local = marks.get(f"pbp:{season}")
    remote = remote_pbp_watermark(season)

    _log(f"Season {season}" + (" (forced)" if force else ""))
    _log(f"  ours    : {local or '(never ingested)'}")
    _log(f"  upstream: {remote or '(play-by-play not published yet)'}")

    if force:
        reason = "forced"
        changed = True
    elif remote is None:
        # No plays upstream. Worth one pass to pick up schedules and rosters,
        # which are published months ahead — but only once.
        changed = local != SCHEDULES_ONLY
        reason = "schedules not yet loaded" if changed else "no plays upstream, schedules already loaded"
    elif remote == local:
        changed = False
        reason = "play-by-play unchanged since last ingest"
    else:
        changed = True
        reason = "play-by-play republished upstream"

    _log(f"\n{'CHANGED' if changed else 'NO CHANGE'}: {reason}")
    _emit(changed="true" if changed else "false", season=season)
    return 0


def cmd_ingest(watermarks_path: str) -> int:
    # Imported here, not at module scope: `check` must not need a database.
    from database import get_connection, write_lock
    from ingest import run_ingest

    season = _resolve_season()
    remote = remote_pbp_watermark(season)

    _log(f"Ingesting season {season}...")
    get_connection()
    # Hold the write lock for the whole run, matching the app's single-writer
    # contract. Nothing else is running here, but it keeps the invariant true
    # wherever run_ingest is called from.
    with write_lock:
        run_ingest([season], log=_log)

    marks = read_watermarks(watermarks_path)
    marks[f"pbp:{season}"] = remote if remote is not None else SCHEDULES_ONLY
    write_watermarks(watermarks_path, marks)
    _log(f"\nIngested {season}; watermark now {marks[f'pbp:{season}']}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in ("check", "ingest"):
        print(__doc__)
        print("usage: python -m jobs.refresh {check|ingest} [watermarks.json]")
        return 2
    path = argv[2] if len(argv) > 2 else "watermarks.json"
    return cmd_check(path) if argv[1] == "check" else cmd_ingest(path)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
