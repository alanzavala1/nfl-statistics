"""Diagnostic: measure how fast ESPN actually publishes live game state.

Not production code and not on any request path. It exists to settle one
question with data instead of inference: how long after a play happens does the
feed report it, and how often is it worth asking?

The naive approach — poll and watch the game clock — does not work. A football
clock stops constantly, so identical readings are ambiguous between "the feed
is stale" and "the clock is legitimately stopped", and that ambiguity is what
made an earlier hand-sample unreadable (three identical clocks, then a
41-second jump, over 61 seconds of wall time).

This measures the thing directly instead. Two properties make it possible:

  * `situation.lastPlay` changes identity when, and only when, a new play
    lands. Keying on that removes the clock from the question entirely.
  * each play resource carries `wallclock` — ESPN's own timestamp of when the
    play happened. So publish latency is simply our receipt time minus that,
    with no clock arithmetic anywhere.

It polls `sports.core.api` rather than the heavy `site.api` summary: status and
situation together are well under a kilobyte, so running this for a whole game
is roughly the load of the production poller, not an abusive burst.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"

# Identify honestly. A spoofed browser User-Agent is reported to get
# server-side callers refused on these endpoints, and pretending to be a
# browser is the wrong thing to do anyway.
UA = "nfldb-cadence-diagnostic/1.0 (+https://github.com/alanzavala1/NFLDB)"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def fetch(url: str) -> tuple[dict, dict, int, float]:
    """GET as JSON, returning (body, headers, wire_bytes, elapsed_seconds).

    gzip is requested explicitly: these endpoints compress ~11-13x when asked
    and serve uncompressed when not, and they do not support brotli.
    """
    req = urllib.request.Request(
        url, headers={"Accept-Encoding": "gzip", "User-Agent": UA, "Accept": "application/json"}
    )
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
        elapsed = time.monotonic() - started
        # Case-insensitive lookup on the message object, then the gzip magic
        # bytes as a backstop: `dict(resp.headers)` preserves the server's
        # casing, so a lowercase `content-encoding` silently defeats a
        # case-sensitive check and we try to parse compressed bytes as JSON.
        wire = len(raw)
        encoded = (resp.headers.get("Content-Encoding") or "").lower() == "gzip"
        if encoded or raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return json.loads(raw), dict(resp.headers), wire, elapsed


def secure(url: str) -> str:
    """Force https. ESPN hands back its own `$ref` links as plain http, which
    would send every one of these requests unencrypted and leave them open to
    interception or transparent rewriting. The https origin serves them fine."""
    return url.replace("http://", "https://", 1) if url.startswith("http://") else url


def resolve_event(event_id: str) -> tuple[str, str, str]:
    """Find the status and situation resource URLs for an event.

    They hang off the competition as `$ref`s and are stable for the life of the
    event, so this runs once rather than per sample.
    """
    event, _, _, _ = fetch(f"{CORE}/events/{event_id}")
    comp = event["competitions"][0]
    return secure(comp["status"]["$ref"]), secure(comp["situation"]["$ref"]), event.get("name", event_id)


def pick_event(event_id: str | None) -> str:
    """Use the given event, else the game most worth watching right now."""
    if event_id:
        return event_id
    board, _, _, _ = fetch(SCOREBOARD)
    events = board.get("events", [])
    for state in ("in", "pre"):          # a live game first, else the next one
        matching = [e for e in events if e["competitions"][0]["status"]["type"]["state"] == state]
        if matching:
            chosen = min(matching, key=lambda e: e["date"])
            print(f"selected {chosen['shortName']} ({chosen['id']}), state={state}, {chosen['date']}")
            return chosen["id"]
    raise SystemExit("no upcoming or live game on the scoreboard")


def play_id(situation: dict) -> str | None:
    ref = (situation.get("lastPlay") or {}).get("$ref")
    return ref.split("/")[-1].split("?")[0] if ref else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--event", help="ESPN event id (default: next live/upcoming game)")
    ap.add_argument("--out", required=True, help="JSONL output path")
    ap.add_argument("--interval", type=float, default=6.0, help="seconds between polls once live")
    ap.add_argument("--pre-interval", type=float, default=60.0, help="seconds between polls before kickoff")
    ap.add_argument("--max-hours", type=float, default=7.0, help="hard stop, so a bug can't run forever")
    args = ap.parse_args()

    event_id = pick_event(args.event)
    status_url, situation_url, name = resolve_event(event_id)
    print(f"watching {name} ({event_id})\n  status:    {status_url}\n  situation: {situation_url}")
    print(f"  writing:   {args.out}\n")

    deadline = time.monotonic() + args.max_hours * 3600
    last_play = None
    samples = 0
    plays_seen = 0
    ended_at = None

    with open(args.out, "a", encoding="utf-8") as fh:

        def emit(record: dict) -> None:
            fh.write(json.dumps(record) + "\n")
            fh.flush()          # a diagnostic that loses its data on a crash is useless

        while time.monotonic() < deadline:
            received = now_utc()
            row: dict = {"received_at": received.isoformat(), "kind": "sample"}

            try:
                status, s_head, s_bytes, s_ms = fetch(status_url)
                situation, s2_head, s2_bytes, s2_ms = fetch(situation_url)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as e:
                # Record failures too — an outage or a 429 is a finding, not noise.
                emit({**row, "kind": "error", "error": f"{type(e).__name__}: {e}"})
                print(f"  {received:%H:%M:%S}  ERROR {type(e).__name__}: {e}")
                time.sleep(args.interval)
                continue

            state = (status.get("type") or {}).get("state")
            pid = play_id(situation)

            row.update(
                state=state,
                clock=status.get("clock"),
                display_clock=status.get("displayClock"),
                period=status.get("period"),
                down=situation.get("down"),
                distance=situation.get("distance"),
                yard_line=situation.get("yardLine"),
                red_zone=situation.get("isRedZone"),
                away_timeouts=situation.get("awayTimeouts"),
                home_timeouts=situation.get("homeTimeouts"),
                last_play_id=pid,
                # Live cache-control is the open question these numbers answer;
                # everything measured so far came from a finished game.
                status_cache=s_head.get("Cache-Control"),
                situation_cache=s2_head.get("Cache-Control"),
                bytes=s_bytes + s2_bytes,
                fetch_seconds=round(s_ms + s2_ms, 3),
            )

            # A new play landed. Fetch it once for its own timestamp — this is
            # the measurement the whole script exists for.
            if pid and pid != last_play:
                try:
                    play, p_head, p_bytes, _ = fetch(secure((situation["lastPlay"])["$ref"]))
                    wallclock = play.get("wallclock")
                    latency = None
                    if wallclock:
                        published = datetime.fromisoformat(wallclock.replace("Z", "+00:00"))
                        latency = round((received - published).total_seconds(), 2)
                    row.update(
                        new_play=True,
                        play_wallclock=wallclock,
                        # If `modified` ever differs from `wallclock`, ESPN
                        # revises plays after publishing them — worth knowing
                        # before trusting lastPlay for anything but display.
                        play_modified=play.get("modified"),
                        play_text=(play.get("text") or "")[:200],
                        play_scoring=play.get("scoringPlay"),
                        publish_latency_seconds=latency,
                        play_cache=p_head.get("Cache-Control"),
                        play_bytes=p_bytes,
                    )
                    plays_seen += 1
                    print(
                        f"  {received:%H:%M:%S}  PLAY +{latency if latency is not None else '?'}s"
                        f"  Q{row['period']} {row['display_clock']}  {row['play_text'][:60]}"
                    )
                except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as e:
                    row.update(new_play=True, play_error=f"{type(e).__name__}: {e}")
                last_play = pid

            emit(row)
            samples += 1

            if state == "pre":
                if samples % 5 == 1:
                    print(f"  {received:%H:%M:%S}  pre-kickoff, waiting")
                time.sleep(args.pre_interval)
                continue

            if state == "post":
                # Keep sampling briefly: the feed often keeps revising just
                # after the whistle, which is itself worth capturing.
                ended_at = ended_at or time.monotonic()
                if time.monotonic() - ended_at > 300:
                    print(f"\ngame final. {samples} samples, {plays_seen} plays -> {args.out}")
                    return 0

            time.sleep(args.interval)

    print(f"\nhit the {args.max_hours}h ceiling. {samples} samples, {plays_seen} plays -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
