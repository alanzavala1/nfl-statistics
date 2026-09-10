"""The live scoreboard: cached, clock-paced, and never load-bearing.

Three properties matter here, in this order.

**It must not fall over.** The upstream is unofficial and can vanish without
notice. Every failure path ends at the schedule we already hold, which knows
the fixtures and the final scores of anything completed. A live-source outage
should cost people the clock, not the page.

**Upstream calls must not scale with viewers.** One cached answer serves
everyone for the length of a TTL, so a hundred people watching a game cost the
same as one.

**It must be quiet when there is no football.** The clock decides that, and on a
Wednesday in June the answer is that we make no calls at all.
"""
from __future__ import annotations

import threading
import time
from dataclasses import asdict
from datetime import datetime, timezone

from live import clock
from live.provider import LiveGame, get_provider, resolve_game_ids

# Serve from the schedule for this long when nothing is scheduled — there is no
# upstream to be stale against, so the only cost of a longer TTL is that a
# fixture correction takes a while to show.
IDLE_TTL = 900


class _Cache:
    """One entry, guarded, because a single instance serves every viewer.

    The lock is held only around the dictionary swap, never across the network
    call: a slow upstream must not serialize readers behind it. Two concurrent
    misses can both fetch, which costs one redundant call and is much cheaper
    than making every reader wait on whoever got there first.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._value: dict | None = None
        self._at: float = 0.0

    def get(self, ttl: float) -> dict | None:
        with self._lock:
            if self._value is not None and time.monotonic() - self._at < ttl:
                return self._value
            return None

    def stale(self) -> dict | None:
        with self._lock:
            return self._value

    def put(self, value: dict) -> None:
        with self._lock:
            self._value = value
            self._at = time.monotonic()


_cache = _Cache()


def _from_schedule(now: datetime) -> list[LiveGame]:
    """Last-known state from our own database.

    Used before kickoff, when the upstream fails, and whenever there is nothing
    live to report. Scores are whatever the last ingest stored, so a completed
    game reads correctly and an in-progress one simply reads as not started.
    """
    from database import query_to_dict

    from datetime import timedelta
    lo = (now - timedelta(days=clock.BACKFILL_DAYS)).date().isoformat()
    hi = (now + timedelta(days=1)).date().isoformat()
    rows = query_to_dict(
        """
        SELECT game_id, gameday, away_team, home_team, away_score, home_score
        FROM schedules WHERE gameday BETWEEN ? AND ?
        ORDER BY gameday, gametime
        """,
        [lo, hi],
    )
    out = []
    for r in rows:
        done = r["away_score"] is not None and r["home_score"] is not None
        out.append(
            LiveGame(
                away_team=r["away_team"],
                home_team=r["home_team"],
                gameday=r["gameday"],
                state="post" if done else "pre",
                away_score=r["away_score"],
                home_score=r["home_score"],
                detail="Final" if done else None,
                game_id=r["game_id"],
            )
        )
    return out


def _payload(games: list[LiveGame], source: str, interval: int | None) -> dict:
    return {
        "games": [asdict(g) for g in games],
        "source": source,
        "poll_after": interval,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def scoreboard(now: datetime | None = None) -> dict:
    """Today's games, live where possible and from the schedule otherwise.

    `poll_after` tells the caller when to come back — or null, meaning don't.
    """
    now = now or datetime.now(timezone.utc)

    # Whether to talk to the upstream at all. This call is deliberately
    # state-blind — it only has to distinguish "no football, don't ask" from
    # "something is happening, ask".
    interval = clock.poll_interval(now)

    if interval is clock.IDLE:
        cached = _cache.get(IDLE_TTL)
        if cached and cached.get("source") == "schedule":
            return cached
        payload = _payload(_from_schedule(now), "schedule", None)
        _cache.put(payload)
        return payload

    # Reuse the TTL the cached answer was built with, NOT a fresh state-blind
    # estimate. `poll_interval` can only return LIVE (20s) when it is told a
    # game is in progress, and it cannot be told that before the fetch — so
    # the value above is PRE (60s) during a live game. Using it as the cache
    # TTL meant the server replayed one snapshot for a minute while telling
    # clients to come back in twenty seconds, and the scoreboard updated a
    # third as often as designed.
    stale = _cache.stale()
    ttl = stale.get("poll_after") if stale else None
    cached = _cache.get(ttl if isinstance(ttl, int) else interval)
    if cached is not None:
        return cached

    try:
        games = resolve_game_ids(get_provider().scoreboard())
        source = "live"
    except Exception as e:
        # Never surface an upstream failure as an error. The schedule still
        # knows who is playing and how anything finished; only the clock is lost.
        print(f"live scoreboard unavailable, serving from schedule: {type(e).__name__}: {e}")
        stale = _cache.stale()
        if stale is not None:
            return {**stale, "source": "stale"}
        games, source = _from_schedule(now), "schedule"

    # Now that the real states are known, re-ask the clock: a game in progress
    # tightens the interval, and one in overtime keeps it tight past the window.
    interval = clock.poll_interval(now, states=[g.state for g in games])

    payload = _payload(games, source, interval)
    _cache.put(payload)
    return payload
