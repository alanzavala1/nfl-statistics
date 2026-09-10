"""App-wide constants and configuration."""
import os
from datetime import datetime

FIRST_SEASON = 1999


def _calendar_season_guess() -> int:
    """Best guess at the current season when the schedule can't be read.

    The NFL opens the Thursday after Labor Day, so a season is never under way
    before ~Sept 4 and always is by mid-month. The old rule (month >= 9) claimed
    the new season on Sept 1 — up to ten days before a single game was played,
    and well before nflverse publishes anything for it.
    """
    now = datetime.now()
    if now.month > 9 or (now.month == 9 and now.day >= 15):
        return now.year
    return now.year - 1


def _latest_scheduled_season() -> int | None:
    """Newest season the schedule actually covers, or None if unreadable.

    `database` is imported lazily so this module stays importable without a
    database — tests seed their own connection, and tooling imports config
    without ever serving a request.
    """
    if os.environ.get("NFL_TEST_MODE"):
        return None
    try:
        from database import query_to_dict
        rows = query_to_dict("SELECT MAX(season) AS season FROM schedules")
        if rows and rows[0]["season"] is not None:
            return int(rows[0]["season"])
    except Exception:
        pass
    return None


# Data first: a season is current once the schedule covers it, not once the
# calendar says so. Schedules are published months ahead, so this flips as soon
# as the new season is ingested — and never claims a season we hold no data for.
CURRENT_SEASON = _latest_scheduled_season() or _calendar_season_guess()


TEAM_NAMES: dict[str, str] = {
    'ARI': 'Arizona Cardinals',    'ATL': 'Atlanta Falcons',
    'BAL': 'Baltimore Ravens',     'BUF': 'Buffalo Bills',
    'CAR': 'Carolina Panthers',    'CHI': 'Chicago Bears',
    'CIN': 'Cincinnati Bengals',   'CLE': 'Cleveland Browns',
    'DAL': 'Dallas Cowboys',       'DEN': 'Denver Broncos',
    'DET': 'Detroit Lions',        'GB':  'Green Bay Packers',
    'HOU': 'Houston Texans',       'IND': 'Indianapolis Colts',
    'JAX': 'Jacksonville Jaguars', 'KC':  'Kansas City Chiefs',
    'LAC': 'Los Angeles Chargers', 'LA':  'Los Angeles Rams',
    'LV':  'Las Vegas Raiders',    'MIA': 'Miami Dolphins',
    'MIN': 'Minnesota Vikings',    'NE':  'New England Patriots',
    'NO':  'New Orleans Saints',   'NYG': 'New York Giants',
    'NYJ': 'New York Jets',        'PHI': 'Philadelphia Eagles',
    'PIT': 'Pittsburgh Steelers',  'SEA': 'Seattle Seahawks',
    'SF':  'San Francisco 49ers',  'TB':  'Tampa Bay Buccaneers',
    'TEN': 'Tennessee Titans',     'WAS': 'Washington Commanders',
    'OAK': 'Oakland Raiders',      'SD':  'San Diego Chargers',
    'STL': 'St. Louis Rams',       'JAC': 'Jacksonville Jaguars',
}

# nflverse play-by-play and weekly stats label every season with the
# franchise's CURRENT abbreviation (a 2005 Raiders play says 'LV'), while
# schedules and rosters keep the abbreviation the team actually used that
# year. The platform is era-keyed — game ids, team pages, and rosters all say
# 'OAK' for 2005 — so anything derived from plays/weekly must map back.
# (modern, era, last season in the old city)
RELOCATIONS: tuple[tuple[str, str, int], ...] = (
    ('LV',  'OAK', 2019),
    ('LAC', 'SD',  2016),
    ('LA',  'STL', 2015),
)


def era_team_case(team_expr: str, season_expr: str) -> str:
    """SQL CASE that maps a modern franchise abbreviation to the era one."""
    whens = " ".join(
        f"WHEN {team_expr} = '{modern}' AND {season_expr} <= {last} THEN '{era}'"
        for modern, era, last in RELOCATIONS
    )
    return f"CASE {whens} ELSE {team_expr} END"


DIVISIONS: dict[str, str] = {
    'BUF': 'AFC East',  'MIA': 'AFC East',  'NE':  'AFC East',  'NYJ': 'AFC East',
    'BAL': 'AFC North', 'CIN': 'AFC North', 'CLE': 'AFC North', 'PIT': 'AFC North',
    'HOU': 'AFC South', 'IND': 'AFC South', 'JAX': 'AFC South', 'TEN': 'AFC South',
    'DEN': 'AFC West',  'KC':  'AFC West',  'LAC': 'AFC West',  'LV':  'AFC West',
    'DAL': 'NFC East',  'NYG': 'NFC East',  'PHI': 'NFC East',  'WAS': 'NFC East',
    'CHI': 'NFC North', 'DET': 'NFC North', 'GB':  'NFC North', 'MIN': 'NFC North',
    'ATL': 'NFC South', 'CAR': 'NFC South', 'NO':  'NFC South', 'TB':  'NFC South',
    'ARI': 'NFC West',  'LA':  'NFC West',  'SEA': 'NFC West',  'SF':  'NFC West',
    'OAK': 'AFC West',  'SD':  'AFC West',  'STL': 'NFC West',  'JAC': 'AFC South',
}
