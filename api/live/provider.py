"""Where live scores come from.

The upstream is deliberately behind a narrow interface. ESPN's scoreboard is
undocumented and unofficial — it has no SLA, and a `.web` host workaround is
already circulating for people it broke — so the useful question isn't whether
it will change but what it costs when it does. Behind this protocol the answer
is a config change and roughly $10/month on a paid provider, rather than a
rewrite. That is what makes the free option the safe one.

A provider's job is narrow: report what is happening, in its own vocabulary,
for games identified the way anyone would identify them — the two teams and the
date. Translating that to our `game_id` is not its problem, because every
provider would have to solve it identically. See `resolve_game_ids`.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, replace
from typing import Protocol

import httpx

ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"

# ESPN's abbreviations agree with nflverse for 30 of 32 clubs. These are the two
# that don't; the other names that differ between the two sets are franchises
# that have since moved (OAK, SD, STL, JAC) and cannot appear in a live game.
ESPN_TEAM_FIXUPS = {"LAR": "LA", "WSH": "WAS"}


@dataclass(frozen=True)
class LiveLeader:
    """A game's statistical leader, as the source phrases it.

    `detail` is passed through verbatim ("16/22, 187 YDS, 1 TD") rather than
    parsed into fields. Mid-game these are a glance, not a stat table — and the
    charted numbers that arrive later are the ones worth modelling properly.
    """
    category: str                # "passing" | "rushing" | "receiving"
    player: str
    team: str | None
    detail: str


@dataclass(frozen=True)
class LiveGame:
    """One game as the live source sees it.

    `game_id` is None until `resolve_game_ids` matches it against the schedule.
    Scores are None before kickoff rather than 0, so the UI can tell "hasn't
    started" from "0-0 in the first quarter".
    """
    away_team: str
    home_team: str
    gameday: str                 # ET calendar date, matching schedules.gameday
    state: str                   # "pre" | "in" | "post"
    away_score: int | None = None
    home_score: int | None = None
    period: int | None = None
    clock: str | None = None
    possession: str | None = None
    detail: str | None = None    # e.g. "Q3 - 4:12", "Final/OT"
    game_id: str | None = None

    # Everything below exists so the game page has something true to show while
    # a game is being played — none of it is charted until after the whistle,
    # and all of it arrives in the same request as the score.
    away_periods: tuple[int, ...] = ()
    home_periods: tuple[int, ...] = ()
    down_distance: str | None = None
    red_zone: bool = False
    last_play: str | None = None
    away_timeouts: int | None = None
    home_timeouts: int | None = None
    leaders: tuple[LiveLeader, ...] = ()


class LiveScoreProvider(Protocol):
    """Anything that can report today's games."""

    name: str

    def scoreboard(self) -> list[LiveGame]:
        ...


def _int_or_none(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class ESPNProvider:
    """ESPN's public scoreboard. No key, no documentation, no guarantees."""

    name = "espn"

    def __init__(self, url: str = ESPN_SCOREBOARD, timeout: float = 8.0):
        self._url = url
        self._timeout = timeout

    def scoreboard(self) -> list[LiveGame]:
        r = httpx.get(self._url, timeout=self._timeout, follow_redirects=True)
        r.raise_for_status()
        return [g for g in (self._game(e) for e in r.json().get("events", [])) if g]

    def _game(self, event: dict) -> LiveGame | None:
        try:
            comp = event["competitions"][0]
            status = comp.get("status", {})
            stype = status.get("type", {})

            sides = {}
            for c in comp.get("competitors", []):
                abbr = c.get("team", {}).get("abbreviation")
                if not abbr:
                    return None
                sides[c.get("homeAway")] = (
                    ESPN_TEAM_FIXUPS.get(abbr, abbr),
                    _int_or_none(c.get("score")),
                    tuple(
                        n for n in (
                            _int_or_none(q.get("value")) for q in c.get("linescores") or []
                        ) if n is not None
                    ),
                )
            if "home" not in sides or "away" not in sides:
                return None

            away_team, away_score, away_periods = sides["away"]
            home_team, home_score, home_periods = sides["home"]
            state = stype.get("state") or "pre"
            started = state != "pre"
            situation = comp.get("situation") or {}

            return LiveGame(
                away_team=away_team,
                home_team=home_team,
                # ESPN stamps kickoff in UTC; the schedule keys games by their
                # Eastern calendar date, and a 20:20 ET kickoff is already the
                # next day in UTC. Converting is what makes them line up.
                gameday=self._eastern_date(event.get("date")),
                state=state,
                away_score=away_score if started else None,
                home_score=home_score if started else None,
                period=status.get("period") or None,
                clock=status.get("displayClock") if state == "in" else None,
                possession=self._possession(comp),
                detail=stype.get("shortDetail") or stype.get("detail"),
                away_periods=away_periods,
                home_periods=home_periods,
                down_distance=self._down_distance(situation) if state == "in" else None,
                red_zone=bool(situation.get("isRedZone")) if state == "in" else False,
                last_play=((situation.get("lastPlay") or {}).get("text")
                           if state == "in" else None),
                away_timeouts=_int_or_none(situation.get("awayTimeouts")),
                home_timeouts=_int_or_none(situation.get("homeTimeouts")),
                leaders=self._leaders(comp),
            )
        except (KeyError, IndexError, TypeError):
            # One malformed event must not blank the whole scoreboard.
            return None

    @staticmethod
    def _eastern_date(iso: str | None) -> str:
        from datetime import datetime

        from live.clock import KICKOFF_TZ

        if not iso:
            return ""
        try:
            utc = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return utc.astimezone(KICKOFF_TZ).date().isoformat()
        except ValueError:
            return ""

    # ESPN names these in camelCase and by full stat; the UI wants the phase of
    # play. Anything outside this map is skipped rather than shown raw.
    _LEADER_CATEGORIES = {
        "passingYards": "passing",
        "rushingYards": "rushing",
        "receivingYards": "receiving",
    }

    @staticmethod
    def _down_distance(situation: dict) -> str | None:
        """Down and distance, preferring the source's own phrasing.

        `downDistanceText` is normally present but goes missing during
        stoppages, so it falls back to composing the parts — which is better
        than the panel emptying out every time there's a timeout.
        """
        text = situation.get("downDistanceText")
        if text:
            return text
        down, distance = situation.get("down"), situation.get("distance")
        if not down:
            return None
        ordinal = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th"}.get(down, f"{down}th")
        return f"{ordinal} & {distance}" if distance is not None else ordinal

    def _leaders(self, comp: dict) -> tuple[LiveLeader, ...]:
        by_espn_id = {
            str(c.get("id")): ESPN_TEAM_FIXUPS.get(
                c.get("team", {}).get("abbreviation"), c.get("team", {}).get("abbreviation")
            )
            for c in comp.get("competitors", [])
        }

        out = []
        for block in comp.get("leaders") or []:
            category = self._LEADER_CATEGORIES.get(block.get("name"))
            entries = block.get("leaders") or []
            if not category or not entries:
                continue
            entry = entries[0]
            player = (entry.get("athlete") or {}).get("shortName")
            if not player:
                continue
            out.append(
                LiveLeader(
                    category=category,
                    player=player,
                    team=by_espn_id.get(str((entry.get("team") or {}).get("id"))),
                    detail=entry.get("displayValue") or "",
                )
            )
        return tuple(out)

    @staticmethod
    def _possession(comp: dict) -> str | None:
        team_id = (comp.get("situation") or {}).get("possession")
        if not team_id:
            return None
        for c in comp.get("competitors", []):
            if str(c.get("id")) == str(team_id):
                abbr = c.get("team", {}).get("abbreviation")
                return ESPN_TEAM_FIXUPS.get(abbr, abbr)
        return None


def resolve_game_ids(games: list[LiveGame]) -> list[LiveGame]:
    """Attach our `game_id` by matching each game against the schedule.

    Matching on (date, away, home) rather than deriving an id from season and
    week: nflverse numbers postseason weeks straight on from the regular season
    while providers restart them, and reconstructing that mapping is a standing
    invitation to be subtly wrong every January. The schedule already knows.

    Games we can't match are returned unresolved rather than dropped — that is
    a preseason or exhibition fixture we hold no row for, not a failure.
    """
    from database import query_to_dict

    dates = sorted({g.gameday for g in games if g.gameday})
    if not dates:
        return games

    rows = query_to_dict(
        "SELECT game_id, gameday, away_team, home_team FROM schedules "
        f"WHERE gameday IN ({', '.join('?' * len(dates))})",
        list(dates),
    )
    index = {(r["gameday"], r["away_team"], r["home_team"]): r["game_id"] for r in rows}

    return [
        replace(g, game_id=index.get((g.gameday, g.away_team, g.home_team)))
        for g in games
    ]


# Swapping the upstream is meant to be a deployment decision, not a code change.
PROVIDERS: dict[str, type] = {"espn": ESPNProvider}


def get_provider() -> LiveScoreProvider:
    name = os.environ.get("LIVE_PROVIDER", "espn").lower()
    try:
        return PROVIDERS[name]()
    except KeyError:
        raise ValueError(
            f"Unknown LIVE_PROVIDER {name!r}. Available: {', '.join(sorted(PROVIDERS))}"
        ) from None
