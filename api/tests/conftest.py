"""Test fixtures: in-memory DuckDB seeded with a mini-league.

The seed is intentionally small but exercises every interesting case:

  - Multiple weeks (records walked over time)
  - Tied games (T column non-zero)
  - Divisional games (div_w / div_l counted separately)
  - Home-underdog upset (spread_line > 0 means home favored; if home wins,
    not an upset; if away wins, the upset detector should fire)
  - Blowout (margin >= 28)
  - Unfinished games (NULL scores)
  - Mid-season state (some teams have more completed games than others)

The fixture replaces database._conn with this in-memory connection, so the
real FastAPI app sees test data without any code change in routers.
"""
import os

# Pin the test DB path before importing the app so the lifespan auto-ingest
# doesn't try to talk to the real on-disk DuckDB file. The app reads DB_PATH
# at first connect, but we'll monkey-patch the connection directly anyway.
os.environ.setdefault("NFL_TEST_MODE", "1")

import duckdb
import pytest
from fastapi.testclient import TestClient


# ── Seed data ────────────────────────────────────────────────────────────────

SEASON = 2024

# (week, away, home, away_score, home_score, spread_line, div_game, game_type)
# spread_line convention (nflfastR): POSITIVE = home favored.
GAMES = [
    (1, "BUF", "MIA", 17,   24,   -3.5, 1, "REG"),  # MIA home underdog wins → upset
    (1, "DEN", "KC",  14,   42,   10.0, 1, "REG"),  # KC home favored by 10, wins by 28 → blowout
    (2, "KC",  "BUF", 21,   21,    1.5, 0, "REG"),  # tied thriller (BUF home, slightly favored)
    (2, "MIA", "DEN", 28,   27,   -2.0, 0, "REG"),  # MIA away wins by 1 → closest non-tie
    (3, "BUF", "DEN", 30,   24,   -4.0, 0, "REG"),  # BUF away favored wins
    (3, "KC",  "MIA", None, None,  1.0, 0, "REG"),  # unfinished
]

# Roster: one QB per team, plus one WR per team to give /leaders more rows.
ROSTER = [
    # player_id,    name,                position, team, jersey, height, weight
    ("00-BUF-QB1",  "Josh Allen",        "QB",     "BUF", 17, 77, 237),
    ("00-MIA-QB1",  "Tua Tagovailoa",    "QB",     "MIA",  1, 73, 217),
    ("00-KC-QB1",   "Patrick Mahomes",   "QB",     "KC",  15, 74, 230),
    ("00-DEN-QB1",  "Bo Nix",            "QB",     "DEN", 10, 74, 217),
    ("00-BUF-WR1",  "Stefon Diggs",      "WR",     "BUF", 14, 72, 191),
    ("00-MIA-WR1",  "Tyreek Hill",       "WR",     "MIA", 10, 70, 191),
    ("00-KC-DE1",   "Edge Dude",         "DE",     "KC",  95, 76, 260),
    ("00-KC-S1",    "Quiet Safety",      "S",      "KC",  26, 72, 205),
    ("00-KC-K1",    "Kicker Person",     "K",      "KC",   7, 72, 190),
]

for _team in ("KC", "DEN"):
    for _i, _pos in enumerate(["QB", "RB", "WR", "WR", "TE", "LT", "LG", "C", "RG", "RT", "FB"], start=1):
        _pid = f"00-{_team}-OFF{_i}"
        if _pos == "QB" and _team == "KC":
            _pid = "00-KC-QB1"
        elif _pos == "QB" and _team == "DEN":
            _pid = "00-DEN-QB1"
        elif _pid not in {r[0] for r in ROSTER}:
            ROSTER.append((_pid, f"{_team} {_pos} Starter {_i}", _pos, _team, 10 + _i, 74, 220))
    for _i, _pos in enumerate(["DE", "DT", "DT", "DE", "OLB", "MLB", "CB", "CB", "FS", "SS", "NB"], start=1):
        _pid = f"00-{_team}-DEF{_i}"
        if _team == "KC" and _i == 1:
            _pid = "00-KC-DE1"
        elif _pid not in {r[0] for r in ROSTER}:
            ROSTER.append((_pid, f"{_team} {_pos} Starter {_i}", _pos, _team, 50 + _i, 74, 240))
    for _i, _pos in enumerate(["WR", "RB", "TE", "CB"], start=1):
        _pid = f"00-{_team}-ROT{_i}"
        ROSTER.append((_pid, f"{_team} {_pos} Rotation {_i}", _pos, _team, 70 + _i, 73, 215))

# (game_id, player_id, week, team, pass_yds, pass_tds, ints, cmp, att, rec_yds, rec_tds, rec, tgts)
# Build per-finished-game stats. Each QB's stats reflect that game's score loosely.
PGS = [
    # week 1: BUF @ MIA, 17-24 (MIA wins)
    ("2024_01_BUF_MIA", "00-BUF-QB1", 1, "BUF", 240,  1, 2, 22, 35,   0,   0,  0,  0),
    ("2024_01_BUF_MIA", "00-MIA-QB1", 1, "MIA", 285,  2, 0, 25, 32,   0,   0,  0,  0),
    ("2024_01_BUF_MIA", "00-BUF-WR1", 1, "BUF",   0,  0, 0,  0,  0,  98,   0,  7, 10),
    ("2024_01_BUF_MIA", "00-MIA-WR1", 1, "MIA",   0,  0, 0,  0,  0, 142,   2, 10, 12),
    # week 1: DEN @ KC, 14-42 (KC blowout)
    ("2024_01_DEN_KC",  "00-DEN-QB1", 1, "DEN", 160,  1, 3, 14, 28,   0,   0,  0,  0),
    ("2024_01_DEN_KC",  "00-KC-QB1",  1, "KC",  380,  5, 0, 30, 38,   0,   0,  0,  0),
    # week 2: KC @ BUF, 21-21 (tie)
    ("2024_02_KC_BUF",  "00-KC-QB1",  2, "KC",  295,  2, 1, 24, 36,   0,   0,  0,  0),
    ("2024_02_KC_BUF",  "00-BUF-QB1", 2, "BUF", 310,  2, 1, 26, 35,   0,   0,  0,  0),
    ("2024_02_KC_BUF",  "00-BUF-WR1", 2, "BUF",   0,  0, 0,  0,  0, 115,   1,  8, 11),
    # week 2: MIA @ DEN, 28-27 (close)
    ("2024_02_MIA_DEN", "00-MIA-QB1", 2, "MIA", 320,  3, 1, 27, 33,   0,   0,  0,  0),
    ("2024_02_MIA_DEN", "00-DEN-QB1", 2, "DEN", 290,  3, 0, 26, 38,   0,   0,  0,  0),
    ("2024_02_MIA_DEN", "00-MIA-WR1", 2, "MIA",   0,  0, 0,  0,  0, 130,   1,  9, 11),
    # week 3: BUF @ DEN, 30-24
    ("2024_03_BUF_DEN", "00-BUF-QB1", 3, "BUF", 330,  3, 0, 28, 39,   0,   0,  0,  0),
    ("2024_03_BUF_DEN", "00-DEN-QB1", 3, "DEN", 250,  2, 2, 22, 34,   0,   0,  0,  0),
    ("2024_03_BUF_DEN", "00-BUF-WR1", 3, "BUF",   0,  0, 0,  0,  0, 105,   1,  7,  9),
]

DEF_PGS = [
    {
        "game_id": "2024_01_DEN_KC",
        "player_id": "00-KC-DE1",
        "team": "KC",
        "week": 1,
        "solo_tackles": 3,
        "assist_tackles": 2,
        "tackles_for_loss": 1,
        "qb_hits": 2,
        "sacks": 2,
        "def_interceptions": 1,
        "pass_breakups": 1,
        "forced_fumbles": 1,
        "fumble_recoveries": 1,
    },
    {
        "game_id": "2024_01_DEN_KC",
        "player_id": "00-KC-DE1",
        "team": "KC",
        "week": 1,
        "solo_tackles": 1,
        "assist_tackles": 0,
        "tackles_for_loss": 1,
        "qb_hits": 1,
        "sacks": 1,
        "def_interceptions": 0,
        "pass_breakups": 0,
        "forced_fumbles": 0,
        "fumble_recoveries": 0,
    },
    {
        "game_id": "2024_01_DEN_KC",
        "player_id": "00-KC-S1",
        "team": "KC",
        "week": 1,
        "solo_tackles": 0,
        "assist_tackles": 0,
        "tackles_for_loss": 0,
        "qb_hits": 0,
        "sacks": 0,
        "def_interceptions": 0,
        "pass_breakups": 0,
        "forced_fumbles": 0,
        "fumble_recoveries": 0,
    },
]


# Depth chart snapshots (new nflverse format): a current snapshot (Nov 2024 →
# NFL season 2024) plus one older snapshot that queries must ignore. Mahomes
# holds two slots (QB starter + Holder) to exercise the non-ST preference.
DEPTH = [
    # dt, team, player_name, gsis_id, pos_grp, pos_name, pos_abb, pos_slot, pos_rank
    ("2024-11-05T07:00:00Z", "KC", "Patrick Mahomes", "00-KC-QB1", "3WR 1TE",       "Quarterback",        "QB",  9, 1),
    ("2024-11-05T07:00:00Z", "KC", "Backup Guy",      "00-KC-QB2", "3WR 1TE",       "Quarterback",        "QB",  9, 2),
    ("2024-11-05T07:00:00Z", "KC", "Edge Dude",       "00-KC-DE1", "Base 4-3 D",    "Left Defensive End", "LDE", 1, 1),
    ("2024-11-05T07:00:00Z", "KC", "Kicker Person",   "00-KC-K1",  "Special Teams", "Place Kicker",       "PK",  1, 1),
    ("2024-11-05T07:00:00Z", "KC", "Patrick Mahomes", "00-KC-QB1", "Special Teams", "Holder",             "H",   4, 1),
    # stale snapshot: must never surface (Mahomes was "QB2" the day before)
    ("2024-11-04T07:00:00Z", "KC", "Patrick Mahomes", "00-KC-QB1", "3WR 1TE",       "Quarterback",        "QB",  9, 2),
]


# ── DB build helpers ─────────────────────────────────────────────────────────

def _create_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """Create the tables the routers actually read from.

    Columns mirror nfl_data_py / nflfastR output; only the columns referenced
    by the SQL in routers/ are included. Everything else can be added when
    a new endpoint reaches for it.
    """
    conn.execute("""
        CREATE TABLE schedules (
            game_id       VARCHAR PRIMARY KEY,
            season        INTEGER NOT NULL,
            game_type     VARCHAR NOT NULL,
            week          INTEGER NOT NULL,
            gameday       VARCHAR,
            gametime      VARCHAR,
            away_team     VARCHAR NOT NULL,
            home_team     VARCHAR NOT NULL,
            away_score    INTEGER,
            home_score    INTEGER,
            away_qb_name  VARCHAR,
            home_qb_name  VARCHAR,
            spread_line   DOUBLE,
            total_line    DOUBLE,
            roof          VARCHAR,
            surface       VARCHAR,
            temp          INTEGER,
            wind          INTEGER,
            stadium       VARCHAR,
            away_coach    VARCHAR,
            home_coach    VARCHAR,
            overtime      INTEGER,
            div_game      INTEGER
        )
    """)

    conn.execute("""
        CREATE TABLE rosters (
            player_id      VARCHAR NOT NULL,
            season         INTEGER NOT NULL,
            week           INTEGER,
            team           VARCHAR,
            position       VARCHAR,
            jersey_number  INTEGER,
            player_name    VARCHAR,
            headshot_url   VARCHAR,
            height         INTEGER,
            weight         INTEGER,
            age            INTEGER,
            college        VARCHAR,
            years_exp      INTEGER,
            entry_year     INTEGER,
            rookie_year    INTEGER,
            draft_club     VARCHAR,
            draft_number   INTEGER,
            football_name  VARCHAR,
            pfr_id         VARCHAR
        )
    """)

    conn.execute("""
        CREATE TABLE snap_counts (
            game_id        VARCHAR,
            pfr_game_id    VARCHAR,
            season         INTEGER,
            game_type      VARCHAR,
            week           INTEGER,
            player         VARCHAR,
            pfr_player_id  VARCHAR,
            position       VARCHAR,
            team           VARCHAR,
            opponent       VARCHAR,
            offense_snaps  DOUBLE,
            offense_pct    DOUBLE,
            defense_snaps  DOUBLE,
            defense_pct    DOUBLE,
            st_snaps       DOUBLE,
            st_pct         DOUBLE
        )
    """)

    conn.execute("""
        CREATE TABLE id_map (
            pfr_id    VARCHAR,
            gsis_id   VARCHAR,
            name      VARCHAR,
            position  VARCHAR,
            team      VARCHAR,
            db_season INTEGER
        )
    """)

    # New-format nflverse depth charts: dt-stamped daily snapshots.
    conn.execute("""
        CREATE TABLE depth_charts (
            dt          VARCHAR,
            team        VARCHAR,
            player_name VARCHAR,
            espn_id     VARCHAR,
            gsis_id     VARCHAR,
            pos_grp_id  VARCHAR,
            pos_grp     VARCHAR,
            pos_id      VARCHAR,
            pos_name    VARCHAR,
            pos_abb     VARCHAR,
            pos_slot    INTEGER,
            pos_rank    INTEGER
        )
    """)

    # All STAT_COLS from sql_helpers, defined as DOUBLE so SUM() works cleanly.
    from sql_helpers import STAT_COLS  # noqa: E402
    stat_col_ddl = ", ".join(f"{c} DOUBLE DEFAULT 0" for c in STAT_COLS)
    conn.execute(f"""
        CREATE TABLE player_game_stats (
            game_id      VARCHAR NOT NULL,
            player_id    VARCHAR NOT NULL,
            player_name  VARCHAR,
            season       INTEGER NOT NULL,
            week         INTEGER NOT NULL,
            team         VARCHAR,
            {stat_col_ddl}
        )
    """)

    conn.execute("""
        CREATE TABLE plays (
            play_id               DOUBLE,
            game_id               VARCHAR,
            season                INTEGER,
            season_type           VARCHAR,
            week                  INTEGER,
            posteam               VARCHAR,
            defteam               VARCHAR,
            play_type             VARCHAR,
            drive                 INTEGER,
            yardline_100          DOUBLE,
            game_seconds_remaining DOUBLE,
            qtr                   INTEGER,
            "time"                VARCHAR,
            "desc"                VARCHAR,
            pass_location         VARCHAR,
            air_yards             DOUBLE,
            run_location          VARCHAR,
            run_gap               VARCHAR,
            yards_gained          DOUBLE,
            epa                   DOUBLE,
            qb_epa                DOUBLE,
            success               DOUBLE,
            pass_oe               DOUBLE,
            pass_attempt          INTEGER,
            rush_attempt          INTEGER,
            sack                  INTEGER,
            qb_kneel              INTEGER,
            qb_spike              INTEGER,
            two_point_attempt     INTEGER,
            touchdown             INTEGER,
            td_team               VARCHAR,
            td_player_id          VARCHAR,
            interception          INTEGER,
            fumble_lost           INTEGER,
            complete_pass         INTEGER,
            passer_player_id      VARCHAR,
            passer_player_name    VARCHAR,
            passing_yards         DOUBLE,
            receiver_player_id    VARCHAR,
            receiver_player_name  VARCHAR,
            receiving_yards       DOUBLE,
            rusher_player_id      VARCHAR,
            rusher_player_name    VARCHAR,
            rushing_yards         DOUBLE,
            field_goal_attempt    INTEGER,
            field_goal_result     VARCHAR,
            kick_distance         DOUBLE,
            extra_point_attempt   INTEGER,
            extra_point_result    VARCHAR,
            kicker_player_name    VARCHAR,
            kicker_player_id      VARCHAR,
            third_down_converted  INTEGER,
            third_down_failed     INTEGER
        )
    """)


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
    for week, away, home, a_sc, h_sc, spread, div, gtype in GAMES:
        game_id = f"{SEASON}_{week:02d}_{away}_{home}"
        conn.execute(
            """INSERT INTO schedules (
                game_id, season, game_type, week, gameday, gametime,
                away_team, home_team, away_score, home_score,
                spread_line, total_line, div_game, overtime, away_coach, home_coach
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [game_id, SEASON, gtype, week, f"2024-09-{week*7:02d}", "13:00",
             away, home, a_sc, h_sc, spread, 45.0, div, 0,
             f"{away} Coach", f"{home} Coach"],
        )

    for pid, name, pos, team, jersey, height, weight in ROSTER:
        conn.execute(
            """INSERT INTO rosters (
                player_id, season, team, position, jersey_number, player_name,
                height, weight, years_exp, entry_year, pfr_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [pid, SEASON, team, pos, jersey, name, height, weight, 4, 2020, pid.replace("00-", "PFR-")],
        )

    for pid, name, pos, team, *_ in ROSTER:
        if team not in {"KC", "DEN"}:
            continue
        is_off = pos in {"QB", "RB", "FB", "WR", "TE", "LT", "LG", "C", "RG", "RT"}
        is_def = pos in {"DE", "DT", "NT", "DL", "EDGE", "OLB", "ILB", "MLB", "LB", "CB", "DB", "FS", "SS", "S", "NB"}
        is_rot = "Rotation" in name
        conn.execute(
            """INSERT INTO snap_counts (
                game_id, pfr_game_id, season, game_type, week, player,
                pfr_player_id, position, team, opponent,
                offense_snaps, offense_pct, defense_snaps, defense_pct, st_snaps, st_pct
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                "2024_01_DEN_KC", "202409010kan", SEASON, "REG", 1, name,
                pid.replace("00-", "PFR-"), pos, team, "DEN" if team == "KC" else "KC",
                48 if is_off and not is_rot else 12 if is_rot and pos in {"WR", "RB", "TE"} else 0,
                1.0 if is_off and not is_rot else 0.25 if is_rot and pos in {"WR", "RB", "TE"} else 0,
                54 if is_def and not is_rot else 10 if is_rot and pos == "CB" else 0,
                1.0 if is_def and not is_rot else 0.18 if is_rot and pos == "CB" else 0,
                8 if pos in {"K", "CB", "WR"} else 0,
                0.3 if pos in {"K", "CB", "WR"} else 0,
            ],
        )

    for dt, team, name, gsis, grp, pos_name, abb, slot, rank in DEPTH:
        conn.execute(
            """INSERT INTO depth_charts (
                dt, team, player_name, gsis_id, pos_grp, pos_name,
                pos_abb, pos_slot, pos_rank
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [dt, team, name, gsis, grp, pos_name, abb, slot, rank],
        )

    for row in PGS:
        game_id, pid, week, team, pass_yds, pass_tds, ints, cmp, att, rec_yds, rec_tds, rec, tgts = row
        player_name = next(r[1] for r in ROSTER if r[0] == pid)
        conn.execute(
            """INSERT INTO player_game_stats (
                game_id, player_id, player_name, season, week, team,
                pass_yards, pass_tds, interceptions_thrown,
                completions, attempts,
                rec_yards, rec_tds, receptions, targets
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [game_id, pid, player_name, SEASON, week, team,
             pass_yds, pass_tds, ints, cmp, att,
             rec_yds, rec_tds, rec, tgts],
        )

    for row in DEF_PGS:
        player_name = next(r[1] for r in ROSTER if r[0] == row["player_id"])
        conn.execute(
            """INSERT INTO player_game_stats (
                game_id, player_id, player_name, season, week, team,
                solo_tackles, assist_tackles, tackles_for_loss, qb_hits,
                sacks, def_interceptions, pass_breakups, forced_fumbles,
                fumble_recoveries
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                row["game_id"], row["player_id"], player_name, SEASON, row["week"], row["team"],
                row["solo_tackles"], row["assist_tackles"], row["tackles_for_loss"],
                row["qb_hits"], row["sacks"], row["def_interceptions"],
                row["pass_breakups"], row["forced_fumbles"], row["fumble_recoveries"],
            ],
        )

    play_id = 1

    def insert_play(
        game_id: str,
        week: int,
        posteam: str,
        defteam: str,
        epa: float,
        *,
        passer: str | None = None,
        receiver: str | None = None,
        rusher: str | None = None,
        sack: int = 0,
        interception: int = 0,
        fumble_lost: int = 0,
        fg_result: str | None = None,
        kick_distance: float | None = None,
        xp_result: str | None = None,
        kicker: str | None = None,
        touchdown: int = 0,
        td_team: str | None = None,
        td_player: str | None = None,
    ) -> None:
        nonlocal play_id
        names = {r[0]: r[1] for r in ROSTER}
        is_fg = 1 if fg_result is not None else 0
        is_xp = 1 if xp_result is not None else 0
        pass_attempt = 1 if passer is not None and not is_fg and not is_xp and rusher is None else 0
        rush_attempt = 1 if rusher is not None else 0
        play_type = "field_goal" if is_fg else "extra_point" if is_xp else "pass" if pass_attempt or sack else "run"
        yards = 5.0 if epa > 0 else -1.0
        scoring_player = td_player or ((receiver or rusher or passer) if touchdown else None)
        scoring_team = td_team or (posteam if touchdown else None)
        conn.execute(
            """INSERT INTO plays (
                play_id, game_id, season, season_type, week, posteam, defteam,
                play_type, drive, yardline_100, game_seconds_remaining, qtr,
                "time", "desc", pass_location, air_yards, run_location, run_gap,
                yards_gained, epa, qb_epa,
                success, pass_oe, pass_attempt, rush_attempt, sack, qb_kneel,
                qb_spike, two_point_attempt, touchdown, td_team, td_player_id,
                interception, fumble_lost, complete_pass,
                passer_player_id, passer_player_name, passing_yards,
                receiver_player_id, receiver_player_name, receiving_yards,
                rusher_player_id, rusher_player_name, rushing_yards,
                field_goal_attempt, field_goal_result,
                kick_distance, extra_point_attempt, extra_point_result,
                kicker_player_name, kicker_player_id, third_down_converted, third_down_failed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                play_id, game_id, SEASON, "REG", week, posteam, defteam, play_type,
                play_id // 6 + 1, 50.0, 3600 - play_id * 20, ((play_id - 1) // 25) + 1,
                "12:34", f"{posteam} test play {play_id}", "middle", 6.0 if pass_attempt else None, "middle", "guard",
                yards,
                epa, epa, 1.0 if epa > 0 else 0.0, 0.0,
                pass_attempt, rush_attempt, sack, 0, 0, 0, touchdown, scoring_team, scoring_player,
                interception, fumble_lost,
                1 if pass_attempt and not interception else 0,
                passer, names.get(passer), yards if passer else None,
                receiver, names.get(receiver), yards if receiver else None,
                rusher, names.get(rusher), yards if rusher else None,
                is_fg, fg_result, kick_distance,
                is_xp, xp_result, names.get(kicker), kicker,
                0, 0,
            ],
        )
        play_id += 1

    # Week 1: Mahomes posts a great EPA game, Denver's QB has a disaster,
    # and Diggs has two targets to exercise the WR involvement floor.
    for i in range(12):
        insert_play("2024_01_DEN_KC", 1, "KC", "DEN", 1.0, passer="00-KC-QB1",
                    receiver="00-KC-OFF3" if i == 0 else None, touchdown=1 if i == 0 else 0)
    for i in range(12):
        insert_play("2024_01_DEN_KC", 1, "DEN", "KC", -1.0, passer="00-DEN-QB1", interception=1 if i < 2 else 0)
    insert_play(
        "2024_01_DEN_KC", 1, "DEN", "KC", -4.0,
        passer="00-DEN-QB1", receiver="00-DEN-OFF3",
        interception=1, touchdown=1, td_team="KC", td_player="00-KC-DE1",
    )
    for _ in range(2):
        insert_play("2024_01_BUF_MIA", 1, "BUF", "MIA", 1.0, passer="00-BUF-QB1", receiver="00-BUF-WR1")
    for _ in range(8):
        insert_play("2024_01_BUF_MIA", 1, "BUF", "MIA", 0.2, passer="00-BUF-QB1")
    for i in range(10):
        insert_play("2024_01_BUF_MIA", 1, "MIA", "BUF", 0.5, passer="00-MIA-QB1", receiver="00-MIA-WR1", touchdown=1 if i == 0 else 0)
    insert_play("2024_01_DEN_KC", 1, "KC", "DEN", 0.0, fg_result="made", kick_distance=45, kicker="00-KC-K1")
    insert_play("2024_01_DEN_KC", 1, "KC", "DEN", 0.0, xp_result="good", kicker="00-KC-K1")

    # Week 2 gives BUF enough EPA to climb relative to Week 1.
    for _ in range(12):
        insert_play("2024_02_KC_BUF", 2, "BUF", "KC", 2.0, passer="00-BUF-QB1")
    for _ in range(12):
        insert_play("2024_02_KC_BUF", 2, "KC", "BUF", -0.5, passer="00-KC-QB1")
    for _ in range(10):
        insert_play("2024_02_MIA_DEN", 2, "MIA", "DEN", 0.4, passer="00-MIA-QB1")
    for _ in range(10):
        insert_play("2024_02_MIA_DEN", 2, "DEN", "MIA", -0.2, passer="00-DEN-QB1")

    # Week 3 keeps the season grid populated for endpoint/default-week tests.
    for _ in range(10):
        insert_play("2024_03_BUF_DEN", 3, "BUF", "DEN", 0.3, passer="00-BUF-QB1")
    for _ in range(10):
        insert_play("2024_03_BUF_DEN", 3, "DEN", "BUF", -0.1, passer="00-DEN-QB1")


# ── Pytest fixtures ──────────────────────────────────────────────────────────

# Work around a DuckDB segfault during interpreter finalization on Linux.
# DuckDB's C-extension (and its Arrow/numpy interop) can crash while the Python
# interpreter tears down at process exit — *after* every test has passed and
# the summary has printed — failing CI with exit 139 (SIGSEGV). Closing
# connections doesn't reliably prevent it; the crash is in module finalization,
# not our objects. We capture pytest's real exit status, then in
# pytest_unconfigure (which runs after the terminal summary is printed but
# before interpreter teardown) exit immediately with that status via os._exit,
# skipping the crash-prone C-extension teardown. Correct semantics are kept: a
# genuine test failure still produces a non-zero exit.
_real_exit_status = 0


def pytest_sessionfinish(session, exitstatus):
    global _real_exit_status
    _real_exit_status = int(exitstatus)


@pytest.hookimpl(trylast=True)
def pytest_unconfigure(config):
    import sys
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(_real_exit_status)


@pytest.fixture(scope="session")
def seeded_conn() -> duckdb.DuckDBPyConnection:
    """A fresh in-memory DuckDB with mini-league data. Shared across the session."""
    conn = duckdb.connect(":memory:")
    _create_schema(conn)
    _seed(conn)
    yield conn
    conn.close()


@pytest.fixture
def client(seeded_conn, monkeypatch) -> TestClient:
    """FastAPI TestClient wired to the seeded in-memory DB.

    We bypass the lifespan (which would try to auto-ingest seasons over the
    network) by patching ingest_queue.queue_season into a no-op, and we
    point database._conn at the seeded connection so every cursor reads
    from it.
    """
    import database
    import ingest_queue
    import main
    import routers.meta

    monkeypatch.setattr(database, "_conn", seeded_conn)
    # Startup no longer ingests, so the lifespan itself is inert. What remains
    # to defend is the admin load endpoint: queue_season is imported by name
    # into routers.meta, so patching ingest_queue alone does NOT reach it. Patch
    # both, and stub run_ingest so nothing already queued can hit the network.
    stub = lambda year, force=False: "loaded"  # noqa: E731
    monkeypatch.setattr(ingest_queue, "queue_season", stub)
    monkeypatch.setattr(routers.meta, "queue_season", stub)
    monkeypatch.setattr(ingest_queue, "run_ingest", lambda years, log=print: None)

    # TestClient runs lifespan; it reads only, so no network calls happen.
    with TestClient(main.app) as c:
        yield c
