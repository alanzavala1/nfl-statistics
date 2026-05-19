"""Team-level endpoints: profile, roster, and league-wide analytics."""
from fastapi import APIRouter, HTTPException, Query

from config import CURRENT_SEASON
from database import get_cursor, query_to_dict
from routers.schedule import attach_records

router = APIRouter()


_LEADER_COLS = """
        COUNT(DISTINCT pgs.game_id)   AS games_played,
        SUM(pgs.attempts)             AS attempts,
        SUM(pgs.completions)          AS completions,
        SUM(pgs.pass_yards)           AS pass_yards,
        SUM(pgs.pass_tds)             AS pass_tds,
        SUM(pgs.interceptions_thrown) AS interceptions_thrown,
        SUM(pgs.sacks_taken)          AS sacks_taken,
        SUM(pgs.pass_epa)             AS pass_epa,
        SUM(pgs.carries)              AS carries,
        SUM(pgs.rush_yards)           AS rush_yards,
        SUM(pgs.rush_tds)             AS rush_tds,
        SUM(pgs.rush_epa)             AS rush_epa,
        SUM(pgs.targets)              AS targets,
        SUM(pgs.receptions)           AS receptions,
        SUM(pgs.rec_yards)            AS rec_yards,
        SUM(pgs.rec_tds)              AS rec_tds,
        SUM(pgs.air_yards)            AS air_yards,
        SUM(pgs.yac)                  AS yac,
        SUM(pgs.rec_epa)              AS rec_epa,
        SUM(pgs.solo_tackles)         AS solo_tackles,
        SUM(pgs.assist_tackles)       AS assist_tackles,
        SUM(pgs.sacks)                AS sacks,
        SUM(pgs.tackles_for_loss)     AS tackles_for_loss,
        SUM(pgs.qb_hits)              AS qb_hits,
        SUM(pgs.def_interceptions)    AS def_interceptions,
        SUM(pgs.pass_breakups)        AS pass_breakups,
        SUM(pgs.forced_fumbles)       AS forced_fumbles,
        SUM(pgs.fumble_recoveries)    AS fumble_recoveries
"""


@router.get("/teams/{team}")
def get_team(team: str, season: int = Query(2025)):
    games = query_to_dict(
        """
        SELECT
            game_id, season, week, gameday, gametime,
            away_team, home_team, away_score, home_score,
            stadium, roof, surface, temp, wind
        FROM schedules
        WHERE season = ? AND (away_team = ? OR home_team = ?)
        ORDER BY week
        """,
        [season, team, team],
    )
    if not games:
        raise HTTPException(status_code=404, detail=f"No games found for {team} in {season}")

    attach_records(games)

    leaders = query_to_dict(
        f"""
        SELECT
            pgs.player_id,
            pgs.player_name,
            r.position,
            r.headshot_url,
            r.jersey_number,
            {_LEADER_COLS}
        FROM player_game_stats pgs
        LEFT JOIN rosters r ON pgs.player_id = r.player_id AND r.season = pgs.season
        JOIN schedules sch ON pgs.game_id = sch.game_id AND sch.game_type = 'REG'
        WHERE pgs.season = ? AND pgs.team = ?
        GROUP BY pgs.player_id, pgs.player_name, r.position, r.headshot_url, r.jersey_number
        """,
        [season, team],
    )

    playoff_leaders = query_to_dict(
        f"""
        SELECT
            pgs.player_id,
            pgs.player_name,
            r.position,
            r.headshot_url,
            r.jersey_number,
            {_LEADER_COLS}
        FROM player_game_stats pgs
        LEFT JOIN rosters r ON pgs.player_id = r.player_id AND r.season = pgs.season
        JOIN schedules sch ON pgs.game_id = sch.game_id AND sch.game_type != 'REG'
        WHERE pgs.season = ? AND pgs.team = ?
        GROUP BY pgs.player_id, pgs.player_name, r.position, r.headshot_url, r.jersey_number
        """,
        [season, team],
    )

    return {"team": team, "season": season, "games": games, "leaders": leaders, "playoff_leaders": playoff_leaders}


@router.get("/teams/{team}/roster")
def get_team_roster(team: str, season: int = Query(default=None)):
    if season is None:
        season = CURRENT_SEASON
    rows = query_to_dict(
        """
        SELECT
            player_id,
            player_name,
            position,
            jersey_number,
            headshot_url
        FROM rosters
        WHERE team = ? AND season = ?
        QUALIFY ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY season DESC) = 1
        ORDER BY position, player_name
        """,
        [team, season],
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"No roster found for {team} in {season}")
    return rows


# ── Team analytics: 22 ranked metrics per season ──────────────────────────────

def _get_team_analytics(season: int) -> list[dict]:
    """Per-team season metrics with league rank 1-32 on each metric.

    Returns one row per team. Rank direction is "1 = best for the team":
    higher-is-better metrics use DESC, lower-is-better use ASC.
    """
    try:
        available = {r[0] for r in get_cursor().execute("DESCRIBE plays").fetchall()}
    except Exception:
        return []

    has_success   = "success"          in available
    has_pass_oe   = "pass_oe"          in available
    has_td_team   = "td_team"          in available
    has_qb_kneel  = "qb_kneel"         in available
    has_qb_spike  = "qb_spike"         in available
    has_two_pt    = "two_point_attempt" in available

    play_filter = "play_type IN ('pass', 'run')"
    if has_qb_kneel: play_filter += " AND COALESCE(qb_kneel, 0) = 0"
    if has_qb_spike: play_filter += " AND COALESCE(qb_spike, 0) = 0"
    if has_two_pt:   play_filter += " AND COALESCE(two_point_attempt, 0) = 0"

    success_expr = "AVG(success)" if has_success else "AVG(CASE WHEN epa > 0 THEN 1.0 ELSE 0.0 END)"
    # pass_oe is already 100 * (pass - xpass), i.e. percentage points. Do not multiply by 100.
    proe_expr    = "AVG(pass_oe)" if has_pass_oe else "CAST(NULL AS DOUBLE)"

    # Offensive TD on a drive: the offense scored (excludes def TDs on turnovers)
    if has_td_team:
        off_td_expr = "MAX(CASE WHEN touchdown = 1 AND td_team = posteam THEN 1 ELSE 0 END)"
    else:
        off_td_expr = """MAX(CASE
            WHEN touchdown = 1
              AND COALESCE(interception, 0) = 0
              AND COALESCE(fumble_lost,   0) = 0
              AND (rush_attempt = 1 OR complete_pass = 1)
            THEN 1 ELSE 0 END)"""

    s = int(season)

    sql = f"""
    WITH
    off_plays AS (
        SELECT posteam AS team, game_id, drive, epa,
               pass_attempt, rush_attempt, sack, yards_gained,
               third_down_converted, third_down_failed
               {', success' if has_success else ''}
               {', pass_oe' if has_pass_oe else ''}
        FROM plays
        WHERE season = {s} AND season_type = 'REG'
          AND posteam IS NOT NULL
          AND {play_filter}
    ),
    def_plays AS (
        SELECT defteam AS team, game_id, epa,
               pass_attempt, rush_attempt, sack, yards_gained,
               third_down_converted, third_down_failed
               {', success' if has_success else ''}
        FROM plays
        WHERE season = {s} AND season_type = 'REG'
          AND defteam IS NOT NULL
          AND {play_filter}
    ),
    team_record AS (
        SELECT team,
               SUM(pf) AS pf_total, SUM(pa) AS pa_total,
               SUM(w) AS wins, SUM(l) AS losses, SUM(t) AS ties,
               COUNT(*) AS games
        FROM (
            SELECT away_team AS team, away_score AS pf, home_score AS pa,
                   CASE WHEN away_score > home_score THEN 1 ELSE 0 END AS w,
                   CASE WHEN away_score < home_score THEN 1 ELSE 0 END AS l,
                   CASE WHEN away_score = home_score THEN 1 ELSE 0 END AS t
            FROM schedules
            WHERE season = {s} AND game_type = 'REG' AND away_score IS NOT NULL
            UNION ALL
            SELECT home_team AS team, home_score AS pf, away_score AS pa,
                   CASE WHEN home_score > away_score THEN 1 ELSE 0 END AS w,
                   CASE WHEN home_score < away_score THEN 1 ELSE 0 END AS l,
                   CASE WHEN home_score = away_score THEN 1 ELSE 0 END AS t
            FROM schedules
            WHERE season = {s} AND game_type = 'REG' AND home_score IS NOT NULL
        )
        GROUP BY team
    ),
    off_drives AS (
        SELECT posteam AS team, game_id, drive,
               MAX(CASE WHEN COALESCE(yardline_100, 999) <= 20 THEN 1 ELSE 0 END) AS reached_rz,
               {off_td_expr} AS scored_td,
               SUM(CASE WHEN play_type IN ('pass', 'run') THEN 1 ELSE 0 END) AS scrimmage_plays
        FROM plays
        WHERE season = {s} AND season_type = 'REG'
          AND posteam IS NOT NULL AND drive IS NOT NULL
        GROUP BY posteam, game_id, drive
        HAVING SUM(CASE WHEN play_type IN ('pass', 'run') THEN 1 ELSE 0 END) >= 1
    ),
    def_drives AS (
        SELECT defteam AS team, game_id, drive,
               MAX(CASE WHEN COALESCE(yardline_100, 999) <= 20 THEN 1 ELSE 0 END) AS allowed_rz,
               {off_td_expr} AS allowed_td
        FROM plays
        WHERE season = {s} AND season_type = 'REG'
          AND defteam IS NOT NULL AND drive IS NOT NULL
        GROUP BY defteam, game_id, drive
        HAVING SUM(CASE WHEN play_type IN ('pass', 'run') THEN 1 ELSE 0 END) >= 1
    ),
    off_drive_agg AS (
        SELECT team,
               COUNT(*) AS total_drives,
               SUM(reached_rz) AS rz_trips,
               SUM(CASE WHEN reached_rz = 1 AND scored_td = 1 THEN 1 ELSE 0 END) AS rz_tds
        FROM off_drives GROUP BY team
    ),
    def_drive_agg AS (
        SELECT team,
               COUNT(*) AS total_drives_allowed,
               SUM(allowed_rz) AS rz_trips_allowed,
               SUM(CASE WHEN allowed_rz = 1 AND allowed_td = 1 THEN 1 ELSE 0 END) AS rz_tds_allowed
        FROM def_drives GROUP BY team
    ),
    off_turnovers AS (
        SELECT posteam AS team,
               SUM(CASE WHEN COALESCE(interception, 0) = 1 OR COALESCE(fumble_lost, 0) = 1 THEN 1 ELSE 0 END) AS turnovers
        FROM plays
        WHERE season = {s} AND season_type = 'REG'
          AND posteam IS NOT NULL
          AND play_type IN ('pass', 'run')
        GROUP BY posteam
    ),
    def_takeaways AS (
        SELECT defteam AS team,
               SUM(CASE WHEN COALESCE(interception, 0) = 1 OR COALESCE(fumble_lost, 0) = 1 THEN 1 ELSE 0 END) AS takeaways
        FROM plays
        WHERE season = {s} AND season_type = 'REG'
          AND defteam IS NOT NULL
          AND play_type IN ('pass', 'run')
        GROUP BY defteam
    ),
    off_agg AS (
        SELECT team,
            COUNT(*) AS off_plays_count,
            AVG(epa)                                                  AS off_epa_play,
            AVG(epa) FILTER (WHERE pass_attempt = 1 OR sack = 1)      AS off_pass_epa,
            AVG(epa) FILTER (WHERE rush_attempt = 1)                  AS off_rush_epa,
            100.0 * {success_expr}                                    AS off_success_pct,
            100.0 * AVG(CASE
                WHEN (pass_attempt = 1 AND yards_gained >= 20)
                  OR (rush_attempt = 1 AND yards_gained >= 10)
                THEN 1.0 ELSE 0.0 END)                                AS off_explosive_pct,
            {proe_expr}                                               AS proe,
            100.0 * SUM(third_down_converted)
                  / NULLIF(SUM(third_down_converted) + SUM(third_down_failed), 0) AS third_down_pct
        FROM off_plays GROUP BY team
    ),
    def_agg AS (
        SELECT team,
            AVG(epa)                                                  AS def_epa_play,
            AVG(epa) FILTER (WHERE pass_attempt = 1 OR sack = 1)      AS def_pass_epa,
            AVG(epa) FILTER (WHERE rush_attempt = 1)                  AS def_rush_epa,
            100.0 * {success_expr}                                    AS def_success_pct,
            100.0 * AVG(CASE
                WHEN (pass_attempt = 1 AND yards_gained >= 20)
                  OR (rush_attempt = 1 AND yards_gained >= 10)
                THEN 1.0 ELSE 0.0 END)                                AS def_explosive_pct,
            100.0 * SUM(CASE WHEN sack = 1 THEN 1 ELSE 0 END)
                  / NULLIF(SUM(CASE WHEN pass_attempt = 1 OR sack = 1 THEN 1 ELSE 0 END), 0) AS def_sack_pct,
            100.0 * SUM(third_down_failed)
                  / NULLIF(SUM(third_down_converted) + SUM(third_down_failed), 0) AS third_down_stop_pct
        FROM def_plays GROUP BY team
    ),
    combined AS (
        SELECT
            tr.team, tr.games, tr.wins, tr.losses, tr.ties,
            tr.pf_total, tr.pa_total,
            tr.pf_total::DOUBLE / NULLIF(tr.games, 0)                     AS ppg,
            tr.pa_total::DOUBLE / NULLIF(tr.games, 0)                     AS papg,
            (tr.pf_total - tr.pa_total)::DOUBLE / NULLIF(tr.games, 0)     AS pt_diff_per_game,
            tr.pf_total::DOUBLE / NULLIF(od.total_drives, 0)              AS pts_per_drive,
            tr.pa_total::DOUBLE / NULLIF(dd.total_drives_allowed, 0)      AS pts_per_drive_allowed,
            100.0 * od.rz_tds       / NULLIF(od.rz_trips, 0)              AS rz_td_pct,
            100.0 * dd.rz_tds_allowed / NULLIF(dd.rz_trips_allowed, 0)    AS rz_td_pct_allowed,
            (COALESCE(dt.takeaways, 0) - COALESCE(ot.turnovers, 0))::DOUBLE
                  / NULLIF(tr.games, 0)                                   AS turnover_diff_per_game,
            COALESCE(ot.turnovers, 0)  AS off_turnovers_total,
            COALESCE(dt.takeaways, 0)  AS def_takeaways_total,
            od.total_drives, dd.total_drives_allowed,
            oa.off_plays_count,
            oa.off_epa_play, oa.off_pass_epa, oa.off_rush_epa,
            oa.off_success_pct, oa.off_explosive_pct, oa.proe,
            oa.third_down_pct,
            da.def_epa_play, da.def_pass_epa, da.def_rush_epa,
            da.def_success_pct, da.def_explosive_pct, da.def_sack_pct,
            da.third_down_stop_pct
        FROM team_record tr
        LEFT JOIN off_agg       oa USING (team)
        LEFT JOIN def_agg       da USING (team)
        LEFT JOIN off_drive_agg od USING (team)
        LEFT JOIN def_drive_agg dd USING (team)
        LEFT JOIN off_turnovers ot USING (team)
        LEFT JOIN def_takeaways dt USING (team)
    )
    SELECT
        c.*,
        -- Offense ranks (higher = better → DESC)
        RANK() OVER (ORDER BY ppg                  DESC NULLS LAST) AS ppg_rank,
        RANK() OVER (ORDER BY pts_per_drive        DESC NULLS LAST) AS pts_per_drive_rank,
        RANK() OVER (ORDER BY off_epa_play         DESC NULLS LAST) AS off_epa_play_rank,
        RANK() OVER (ORDER BY off_pass_epa         DESC NULLS LAST) AS off_pass_epa_rank,
        RANK() OVER (ORDER BY off_rush_epa         DESC NULLS LAST) AS off_rush_epa_rank,
        RANK() OVER (ORDER BY off_success_pct      DESC NULLS LAST) AS off_success_rank,
        RANK() OVER (ORDER BY off_explosive_pct    DESC NULLS LAST) AS off_explosive_rank,
        RANK() OVER (ORDER BY third_down_pct       DESC NULLS LAST) AS third_down_rank,
        RANK() OVER (ORDER BY rz_td_pct            DESC NULLS LAST) AS rz_td_rank,
        RANK() OVER (ORDER BY proe                 DESC NULLS LAST) AS proe_rank,
        -- Defense ranks (lower = better → ASC, so rank 1 = best defense)
        RANK() OVER (ORDER BY papg                 ASC  NULLS LAST) AS papg_rank,
        RANK() OVER (ORDER BY pts_per_drive_allowed ASC NULLS LAST) AS pts_per_drive_allowed_rank,
        RANK() OVER (ORDER BY def_epa_play         ASC  NULLS LAST) AS def_epa_play_rank,
        RANK() OVER (ORDER BY def_pass_epa         ASC  NULLS LAST) AS def_pass_epa_rank,
        RANK() OVER (ORDER BY def_rush_epa         ASC  NULLS LAST) AS def_rush_epa_rank,
        RANK() OVER (ORDER BY def_success_pct      ASC  NULLS LAST) AS def_success_rank,
        RANK() OVER (ORDER BY def_explosive_pct    ASC  NULLS LAST) AS def_explosive_rank,
        RANK() OVER (ORDER BY third_down_stop_pct  DESC NULLS LAST) AS third_down_stop_rank,
        RANK() OVER (ORDER BY rz_td_pct_allowed    ASC  NULLS LAST) AS rz_td_allowed_rank,
        RANK() OVER (ORDER BY def_sack_pct         DESC NULLS LAST) AS def_sack_rank,
        -- Overall
        RANK() OVER (ORDER BY pt_diff_per_game     DESC NULLS LAST) AS pt_diff_rank,
        RANK() OVER (ORDER BY turnover_diff_per_game DESC NULLS LAST) AS to_diff_rank
    FROM combined c
    WHERE team IS NOT NULL
    ORDER BY team
    """

    try:
        return query_to_dict(sql)
    except Exception as e:
        print(f"team-analytics failed for season {s}: {e}")
        return []


@router.get("/team-analytics")
def get_team_analytics(season: int = Query(default=None)):
    if season is None:
        season = CURRENT_SEASON
    return {"season": season, "league": _get_team_analytics(season)}
