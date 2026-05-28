"""
ingest.py — loads NFL data into DuckDB and builds player_game_stats.
Run with: python ingest.py --seasons 2024
          python ingest.py --seasons 2023 2024
"""

import argparse
import pandas as pd
import nfl_data_py
from collections import namedtuple
from database import get_connection


# ---------------------------------------------------------------------------
# Slot definitions
# ---------------------------------------------------------------------------

PlayerSlot = namedtuple("PlayerSlot", ["id_col", "name_col", "team_col", "stat", "weight"])

DEFENSIVE_SLOTS = [
    PlayerSlot("solo_tackle_1_player_id",          "solo_tackle_1_player_name",          "defteam",                "solo_tackles",      1.0),
    PlayerSlot("solo_tackle_2_player_id",          "solo_tackle_2_player_name",          "defteam",                "solo_tackles",      1.0),
    PlayerSlot("assist_tackle_1_player_id",        "assist_tackle_1_player_name",        "defteam",                "assist_tackles",    1.0),
    PlayerSlot("assist_tackle_2_player_id",        "assist_tackle_2_player_name",        "defteam",                "assist_tackles",    1.0),
    PlayerSlot("assist_tackle_3_player_id",        "assist_tackle_3_player_name",        "defteam",                "assist_tackles",    1.0),
    PlayerSlot("assist_tackle_4_player_id",        "assist_tackle_4_player_name",        "defteam",                "assist_tackles",    1.0),
    PlayerSlot("tackle_for_loss_1_player_id",      "tackle_for_loss_1_player_name",      "defteam",                "tackles_for_loss",  1.0),
    PlayerSlot("tackle_for_loss_2_player_id",      "tackle_for_loss_2_player_name",      "defteam",                "tackles_for_loss",  1.0),
    PlayerSlot("qb_hit_1_player_id",               "qb_hit_1_player_name",               "defteam",                "qb_hits",           1.0),
    PlayerSlot("qb_hit_2_player_id",               "qb_hit_2_player_name",               "defteam",                "qb_hits",           1.0),
    PlayerSlot("sack_player_id",                   "sack_player_name",                   "defteam",                "sacks",             1.0),
    PlayerSlot("half_sack_1_player_id",            "half_sack_1_player_name",            "defteam",                "sacks",             0.5),
    PlayerSlot("half_sack_2_player_id",            "half_sack_2_player_name",            "defteam",                "sacks",             0.5),
    PlayerSlot("interception_player_id",           "interception_player_name",           "defteam",                "def_interceptions", 1.0),
    PlayerSlot("pass_defense_1_player_id",         "pass_defense_1_player_name",         "defteam",                "pass_breakups",     1.0),
    PlayerSlot("pass_defense_2_player_id",         "pass_defense_2_player_name",         "defteam",                "pass_breakups",     1.0),
    PlayerSlot("forced_fumble_player_1_player_id", "forced_fumble_player_1_player_name", "defteam",                "forced_fumbles",    1.0),
    PlayerSlot("forced_fumble_player_2_player_id", "forced_fumble_player_2_player_name", "defteam",                "forced_fumbles",    1.0),
    PlayerSlot("fumble_recovery_1_player_id",      "fumble_recovery_1_player_name",      "fumble_recovery_1_team", "fumble_recoveries", 1.0),
    PlayerSlot("fumble_recovery_2_player_id",      "fumble_recovery_2_player_name",      "fumble_recovery_2_team", "fumble_recoveries", 1.0),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sql_sum(col, alias, available):
    if col in available:
        return f"SUM({col}) AS {alias}"
    return f"CAST(0 AS DOUBLE) AS {alias}"


def _upsert_by_season(conn, table: str, df: pd.DataFrame, seasons: list[int], log=print):
    """Create table if needed, replace data for the given seasons, then insert.

    Inserts only columns common to both the existing table and the new dataframe
    so season-to-season schema differences in nfl_data_py never wipe other seasons.
    """
    conn.register(f"{table}_df", df)

    try:
        existing_cols = [r[0] for r in conn.execute(f"DESCRIBE {table}").fetchall()]
    except Exception:
        existing_cols = None

    if existing_cols is None:
        conn.execute(f"CREATE TABLE {table} AS SELECT * FROM {table}_df")
    else:
        placeholders = ", ".join("?" * len(seasons))
        try:
            conn.execute(f"DELETE FROM {table} WHERE season IN ({placeholders})", seasons)
        except Exception:
            pass  # no season column in very old tables — safe to skip

        col_types = {r[0]: r[1] for r in conn.execute(f"DESCRIBE {table}").fetchall()}
        common = [c for c in existing_cols if c in set(df.columns)]
        if common:
            select_exprs = ", ".join(f'TRY_CAST("{c}" AS {col_types[c]}) AS "{c}"' for c in common)
            col_list = ", ".join(f'"{c}"' for c in common)
            conn.execute(f"INSERT INTO {table} ({col_list}) SELECT {select_exprs} FROM {table}_df")
        else:
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"CREATE TABLE {table} AS SELECT * FROM {table}_df")

    count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    log(f"  {table}: {count:,} rows total")


def extract_slot(plays, slot, available):
    if slot.id_col not in available:
        return None

    mask = plays[slot.id_col].notna()
    if not mask.any():
        return None

    sub = plays[mask]

    if slot.team_col in available:
        team = sub[slot.team_col]
    else:
        team = sub["posteam"] if "posteam" in available else pd.Series(["UNKNOWN"] * len(sub), index=sub.index)

    name   = sub[slot.name_col] if slot.name_col in available else pd.Series([None] * len(sub), index=sub.index)
    week   = sub["week"]        if "week"        in available else pd.Series([None] * len(sub), index=sub.index)
    season = sub["season"]      if "season"      in available else pd.Series([None] * len(sub), index=sub.index)

    return pd.DataFrame({
        "game_id":     sub["game_id"],
        "season":      season,
        "week":        week,
        "team":        team,
        "player_id":   sub[slot.id_col],
        "player_name": name,
        slot.stat:     slot.weight,
    })


def merge_all_stats(*stat_frames):
    frames = [f for f in stat_frames if f is not None and not f.empty]
    if not frames:
        return pd.DataFrame()

    # Exclude 'team' from merge keys: different stat sources use posteam vs defteam,
    # which creates duplicate rows for the same player+game with different team values.
    # Instead we coalesce team from the primary (leftmost) source after each join.
    keys = ["game_id", "player_id", "season", "week"]
    merged = frames[0]

    for frame in frames[1:]:
        merged = merged.merge(frame, on=keys, how="outer", suffixes=("", "_r"))
        if "team_r" in merged.columns:
            merged["team"] = merged["team"].combine_first(merged["team_r"])
            merged.drop(columns=["team_r"], inplace=True)
        if "player_name_r" in merged.columns:
            merged["player_name"] = merged["player_name"].combine_first(merged["player_name_r"])
            merged.drop(columns=["player_name_r"], inplace=True)

    non_stat = keys + ["team", "player_name"]
    stat_cols = [c for c in merged.columns if c not in non_stat]
    merged[stat_cols] = merged[stat_cols].fillna(0)

    return merged


# ---------------------------------------------------------------------------
# Stat builders
# ---------------------------------------------------------------------------

def _season_filter(available: set, seasons: list[int]) -> str:
    if "season" not in available or not seasons:
        return ""
    return f"AND season IN ({', '.join(str(s) for s in seasons)})"


def build_passing_stats(conn, available, seasons):
    week_expr   = "week"   if "week"   in available else "NULL::INTEGER"
    season_expr = "season" if "season" in available else "NULL::INTEGER"
    sf = _season_filter(available, seasons)
    # Exclude 2-pt conversion plays (they inflate attempts/completions/yards and have no TD credit to the passer)
    two_pt = "AND COALESCE(two_point_attempt, 0) = 0" if "two_point_attempt" in available else ""
    sql = f"""
        SELECT
            game_id,
            passer_player_id                                                                             AS player_id,
            passer_player_name                                                                           AS player_name,
            posteam                                                                                      AS team,
            {season_expr}                                                                                AS season,
            {week_expr}                                                                                  AS week,
            COUNT(*) FILTER (WHERE pass_attempt = 1 AND COALESCE(sack, 0) = 0)                          AS attempts,
            SUM(complete_pass) FILTER (WHERE COALESCE(sack, 0) = 0)                                     AS completions,
            {sql_sum('passing_yards', 'pass_yards', available)},
            COUNT(*) FILTER (WHERE touchdown = 1 AND pass_attempt = 1 AND COALESCE(interception, 0) = 0) AS pass_tds,
            COUNT(*) FILTER (WHERE interception = 1)                                                    AS interceptions_thrown,
            COUNT(*) FILTER (WHERE sack = 1)                                                            AS sacks_taken,
            SUM(CASE WHEN pass_attempt = 1 OR COALESCE(sack, 0) = 1 THEN epa ELSE 0 END)               AS pass_epa
        FROM plays
        WHERE passer_player_id IS NOT NULL {two_pt} {sf}
        GROUP BY game_id, passer_player_id, passer_player_name, posteam, {season_expr}, {week_expr}
    """
    return conn.execute(sql).df()


def build_receiving_stats(conn, available, seasons):
    week_expr   = "week"   if "week"   in available else "NULL::INTEGER"
    season_expr = "season" if "season" in available else "NULL::INTEGER"
    sf = _season_filter(available, seasons)
    two_pt = "AND COALESCE(two_point_attempt, 0) = 0" if "two_point_attempt" in available else ""
    sql = f"""
        SELECT
            game_id,
            receiver_player_id                                            AS player_id,
            receiver_player_name                                          AS player_name,
            posteam                                                       AS team,
            {season_expr}                                                 AS season,
            {week_expr}                                                   AS week,
            COUNT(*) FILTER (WHERE pass_attempt = 1)                     AS targets,
            SUM(complete_pass)                                            AS receptions,
            {sql_sum('receiving_yards',  'rec_yards',  available)},
            COUNT(*) FILTER (WHERE touchdown = 1 AND pass_attempt = 1 AND COALESCE(interception, 0) = 0) AS rec_tds,
            {sql_sum('air_yards',        'air_yards',  available)},
            {sql_sum('yards_after_catch','yac',        available)},
            SUM(CASE WHEN pass_attempt = 1 THEN epa ELSE 0 END)          AS rec_epa
        FROM plays
        WHERE receiver_player_id IS NOT NULL {two_pt} {sf}
        GROUP BY game_id, receiver_player_id, receiver_player_name, posteam, {season_expr}, {week_expr}
    """
    return conn.execute(sql).df()


def build_rushing_stats(conn, available, seasons):
    week_expr   = "week"   if "week"   in available else "NULL::INTEGER"
    season_expr = "season" if "season" in available else "NULL::INTEGER"
    sf = _season_filter(available, seasons)
    two_pt = "AND COALESCE(two_point_attempt, 0) = 0" if "two_point_attempt" in available else ""
    sql = f"""
        SELECT
            game_id,
            rusher_player_id                                             AS player_id,
            rusher_player_name                                           AS player_name,
            posteam                                                      AS team,
            {season_expr}                                                AS season,
            {week_expr}                                                  AS week,
            COUNT(*)                                                     AS carries,
            {sql_sum('rushing_yards', 'rush_yards', available)},
            COUNT(*) FILTER (WHERE touchdown = 1 AND rush_attempt = 1)  AS rush_tds,
            SUM(CASE WHEN rush_attempt = 1 THEN epa ELSE 0 END)         AS rush_epa
        FROM plays
        WHERE rusher_player_id IS NOT NULL AND rush_attempt = 1 {two_pt} {sf}
        GROUP BY game_id, rusher_player_id, rusher_player_name, posteam, {season_expr}, {week_expr}
    """
    return conn.execute(sql).df()


def build_slot_stats(plays, slots):
    available = set(plays.columns)
    all_stat_names = {slot.stat for slot in slots}

    frames = [extract_slot(plays, slot, available) for slot in slots]
    frames = [f for f in frames if f is not None]
    if not frames:
        return pd.DataFrame()

    long = pd.concat(frames, ignore_index=True)

    for stat in all_stat_names:
        if stat not in long.columns:
            long[stat] = 0.0
        else:
            long[stat] = long[stat].fillna(0.0)

    agg_rules = {stat: "sum" for stat in all_stat_names}
    agg_rules["player_name"] = "first"

    return (
        long
        .groupby(["game_id", "player_id", "team", "season", "week"])
        .agg(agg_rules)
        .reset_index()
    )


def build_kicker_stats(plays):
    available = set(plays.columns)
    if "kicker_player_id" not in available:
        return pd.DataFrame()

    sub = plays[plays["kicker_player_id"].notna()].copy()
    if sub.empty:
        return pd.DataFrame()

    def flag(col, condition):
        if col in available:
            return condition.astype(float)
        return pd.Series(0.0, index=sub.index)

    frame = pd.DataFrame({
        "game_id":     sub["game_id"],
        "season":      sub["season"]           if "season"           in available else None,
        "week":        sub["week"]             if "week"             in available else None,
        "team":        sub["posteam"],
        "player_id":   sub["kicker_player_id"],
        "player_name": sub["kicker_player_name"] if "kicker_player_name" in available else None,
        "fg_att":      flag("field_goal_attempt", sub["field_goal_attempt"] == 1),
        "fg_made":     flag("field_goal_result",  sub["field_goal_result"]  == "made"),
        "xp_att":      flag("extra_point_attempt", sub["extra_point_attempt"] == 1),
        "xp_made":     flag("extra_point_result",  sub["extra_point_result"]  == "good"),
    })

    agg_rules = {"player_name": "first", "fg_att": "sum", "fg_made": "sum", "xp_att": "sum", "xp_made": "sum"}
    return frame.groupby(["game_id", "player_id", "team", "season", "week"]).agg(agg_rules).reset_index()


def build_punter_stats(plays):
    available = set(plays.columns)
    if "punter_player_id" not in available:
        return pd.DataFrame()

    sub = plays[plays["punter_player_id"].notna()].copy()
    if sub.empty:
        return pd.DataFrame()

    frame = pd.DataFrame({
        "game_id":     sub["game_id"],
        "season":      sub["season"]            if "season"            in available else None,
        "week":        sub["week"]              if "week"              in available else None,
        "team":        sub["posteam"],
        "player_id":   sub["punter_player_id"],
        "player_name": sub["punter_player_name"] if "punter_player_name" in available else None,
        "punts":       1.0,
        "punt_yards":  sub["kick_distance"]     if "kick_distance"     in available else 0.0,
    })

    agg_rules = {"player_name": "first", "punts": "sum", "punt_yards": "sum"}
    return frame.groupby(["game_id", "player_id", "team", "season", "week"]).agg(agg_rules).reset_index()


def build_returner_stats(plays):
    available = set(plays.columns)
    yards_col = next((c for c in ["return_yards", "yards_gained"] if c in available), None)

    result_frames = []

    configs = [
        ("kick_returner_player_id", "kick_returner_player_name", "kickoff",
         "kick_returns", "kick_return_yards", "kick_return_tds"),
        ("punt_returner_player_id", "punt_returner_player_name", "punt",
         "punt_returns", "punt_return_yards", "punt_return_tds"),
    ]

    for id_col, name_col, play_type_val, ret_stat, yds_stat, td_stat in configs:
        if id_col not in available:
            continue

        mask = plays[id_col].notna()
        if "play_type" in available:
            mask = mask & (plays["play_type"] == play_type_val)

        sub = plays[mask]
        if sub.empty:
            continue

        frame = pd.DataFrame({
            "game_id":     sub["game_id"],
            "season":      sub["season"] if "season" in available else None,
            "week":        sub["week"]   if "week"   in available else None,
            "team":        sub["posteam"],
            "player_id":   sub[id_col],
            "player_name": sub[name_col] if name_col in available else None,
            ret_stat:      1.0,
            yds_stat:      sub[yards_col].fillna(0) if yards_col else 0.0,
            td_stat:       (sub["touchdown"] == 1).astype(float) if "touchdown" in available else 0.0,
        })

        agg_rules = {"player_name": "first", ret_stat: "sum", yds_stat: "sum", td_stat: "sum"}
        result_frames.append(
            frame.groupby(["game_id", "player_id", "team", "season", "week"]).agg(agg_rules).reset_index()
        )

    return merge_all_stats(*result_frames) if result_frames else pd.DataFrame()


# ---------------------------------------------------------------------------
# Raw data loading
# ---------------------------------------------------------------------------

def load_and_store_raw(conn, seasons: list[int], log=print):
    log(f"Loading play-by-play for {seasons}...")
    plays = nfl_data_py.import_pbp_data(seasons)
    _upsert_by_season(conn, "plays", plays, seasons, log=log)

    log(f"Loading schedules...")
    schedules = nfl_data_py.import_schedules(seasons)
    _upsert_by_season(conn, "schedules", schedules, seasons, log=log)

    log(f"Loading rosters...")
    rosters = nfl_data_py.import_seasonal_rosters(seasons)
    _upsert_by_season(conn, "rosters", rosters, seasons, log=log)

    log(f"Loading weekly player stats...")
    try:
        weekly = nfl_data_py.import_weekly_data(seasons)
        _upsert_by_season(conn, "weekly_player_stats", weekly, seasons, log=log)
    except Exception as e:
        log(f"  weekly player stats unavailable: {e}")

    return plays


def load_advanced_stats(conn, seasons: list[int], log=print):
    """Pull PFR advanced stats, NGS, and snap counts into their own tables."""

    # PFR advanced stats — season-level, ~2018+
    for stat_type in ['pass', 'rush', 'rec', 'def']:
        log(f"  PFR advanced ({stat_type})...")
        try:
            df = nfl_data_py.import_pfr_advstats(years=seasons, stat_type=stat_type)
            if df is not None and not df.empty:
                _upsert_by_season(conn, f"pfr_{stat_type}", df, seasons, log=log)
                log(f"    columns: {sorted(df.columns.tolist())}")
        except Exception as e:
            log(f"    skipped: {e}")

    # Next Gen Stats — weekly, ~2016+
    for stat_type in ['passing', 'rushing', 'receiving']:
        log(f"  NGS ({stat_type})...")
        try:
            df = nfl_data_py.import_ngs_data(years=seasons, stat_type=stat_type)
            if df is not None and not df.empty:
                _upsert_by_season(conn, f"ngs_{stat_type}", df, seasons, log=log)
                log(f"    columns: {sorted(df.columns.tolist())}")
        except Exception as e:
            log(f"    skipped: {e}")

    # Snap counts — per game, ~2012+
    log("  Snap counts...")
    try:
        df = nfl_data_py.import_snap_counts(years=seasons)
        if df is not None and not df.empty:
            _upsert_by_season(conn, "snap_counts", df, seasons, log=log)
            log(f"    columns: {sorted(df.columns.tolist())}")
    except Exception as e:
        log(f"    skipped: {e}")


def _replace_table(conn, table: str, df: pd.DataFrame, log=print) -> None:
    """Full-replace a table. For historical sources (draft picks, combine,
    id mapping) where the dataset is small and not partitioned by season."""
    if df is None or df.empty:
        log(f"    {table}: empty payload, leaving table unchanged")
        return
    conn.register(f"{table}_df", df)
    conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.execute(f"CREATE TABLE {table} AS SELECT * FROM {table}_df")
    count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    log(f"    {table}: {count:,} rows")


def load_supplemental_data(conn, seasons: list[int], log=print) -> None:
    """Vendor data that augments the core stats: injuries, depth charts,
    draft picks, combine results, cross-source ID mapping, QBR.

    Season-partitioned sources (injuries, depth_charts) upsert by season so
    re-ingesting one year doesn't disturb others.

    Historical sources (draft_picks, combine_data, ids) are small and don't
    partition by season — we full-replace them on every ingest to pick up
    any vendor-side updates.

    QBR is fetched for the requested seasons but the upstream feed is often
    a year behind for the current season; nfl_data_py just returns 0 rows
    when that happens. ESPN-direct fallback is a separate concern.
    """
    # ── Per-season sources ──────────────────────────────────────────────────
    log("  Injuries...")
    try:
        df = nfl_data_py.import_injuries(seasons)
        if df is not None and not df.empty:
            _upsert_by_season(conn, "injuries", df, seasons, log=log)
    except Exception as e:
        log(f"    skipped: {e}")

    log("  Depth charts...")
    try:
        df = nfl_data_py.import_depth_charts(seasons)
        if df is not None and not df.empty:
            _upsert_by_season(conn, "depth_charts", df, seasons, log=log)
    except Exception as e:
        log(f"    skipped: {e}")

    log("  QBR (season)...")
    try:
        df = nfl_data_py.import_qbr(years=seasons, frequency="season")
        if df is not None and not df.empty:
            _upsert_by_season(conn, "qbr_season", df, seasons, log=log)
        else:
            log("    nothing returned (upstream feed not yet updated for these seasons)")
    except Exception as e:
        log(f"    skipped: {e}")

    log("  QBR (weekly)...")
    try:
        df = nfl_data_py.import_qbr(years=seasons, frequency="weekly")
        if df is not None and not df.empty:
            _upsert_by_season(conn, "qbr_weekly", df, seasons, log=log)
        else:
            log("    nothing returned")
    except Exception as e:
        log(f"    skipped: {e}")

    # ── Historical sources (full replace) ──────────────────────────────────
    # Draft picks: pull a generous historical window so PlayerPage works for
    # players drafted in any era we have rosters for.
    draft_years = list(range(1999, max(seasons) + 1))
    log(f"  Draft picks (years {draft_years[0]}-{draft_years[-1]})...")
    try:
        df = nfl_data_py.import_draft_picks(draft_years)
        _replace_table(conn, "draft_picks", df, log=log)
    except Exception as e:
        log(f"    skipped: {e}")

    log(f"  Combine data (years {draft_years[0]}-{draft_years[-1]})...")
    try:
        df = nfl_data_py.import_combine_data(draft_years)
        _replace_table(conn, "combine_data", df, log=log)
    except Exception as e:
        log(f"    skipped: {e}")

    log("  Cross-source ID mapping...")
    try:
        df = nfl_data_py.import_ids()
        _replace_table(conn, "id_map", df, log=log)
    except Exception as e:
        log(f"    skipped: {e}")


# ---------------------------------------------------------------------------
# Official weekly offensive stats (replaces PBP-derived passing/rushing/receiving)
# ---------------------------------------------------------------------------

def build_offensive_stats_from_weekly(conn, seasons: list[int], log=print) -> pd.DataFrame:
    """
    Passing/rushing/receiving stats from nflverse official weekly player data.

    nflverse derives these from the same official NFL source PFR uses, so play
    classification edge cases (sack encoding, 2-pt conversions, pick-sixes) are
    handled correctly without any manual filtering on our end.
    """
    try:
        cols = {r[0] for r in conn.execute("DESCRIBE weekly_player_stats").fetchall()}
    except Exception:
        return pd.DataFrame()

    season_clause = ', '.join(str(s) for s in seasons)

    def col(name, alias, default='0'):
        return (f'COALESCE(w.{name}, {default}) AS {alias}' if name in cols
                else f'CAST({default} AS DOUBLE) AS {alias}')

    # game_id is present in modern nflverse weekly data; fall back to schedule join if absent
    if 'game_id' in cols:
        game_id_expr = 'w.game_id'
        join_clause  = ''
    else:
        game_id_expr = 'sch.game_id'
        join_clause  = """
            LEFT JOIN schedules sch
                ON  sch.season = w.season AND sch.week = w.week
                AND (sch.home_team = w.recent_team OR sch.away_team = w.recent_team)
        """

    name_col = 'player_display_name' if 'player_display_name' in cols else 'player_name'

    sql = f"""
        SELECT
            {game_id_expr}                                              AS game_id,
            w.player_id,
            w.{name_col}                                                AS player_name,
            w.recent_team                                               AS team,
            w.season,
            w.week,
            {col('completions',                 'completions')},
            {col('attempts',                    'attempts')},
            {col('passing_yards',               'pass_yards')},
            {col('passing_tds',                 'pass_tds')},
            {col('interceptions',               'interceptions_thrown')},
            {col('sacks',                       'sacks_taken')},
            {col('passing_epa',                 'pass_epa')},
            {col('targets',                     'targets')},
            {col('receptions',                  'receptions')},
            {col('receiving_yards',             'rec_yards')},
            {col('receiving_tds',               'rec_tds')},
            {col('receiving_air_yards',         'air_yards')},
            {col('receiving_yards_after_catch', 'yac')},
            {col('receiving_epa',               'rec_epa')},
            {col('carries',                     'carries')},
            {col('rushing_yards',               'rush_yards')},
            {col('rushing_tds',                 'rush_tds')},
            {col('rushing_epa',                 'rush_epa')}
        FROM weekly_player_stats w
        {join_clause}
        WHERE w.season IN ({season_clause})
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY w.player_id, w.season, w.week
            ORDER BY COALESCE(w.attempts, 0) + COALESCE(w.carries, 0) + COALESCE(w.targets, 0) DESC
        ) = 1
    """

    df = conn.execute(sql).df()
    # Drop rows where the schedule join failed to resolve a game_id (old seasons without game_id column)
    df = df[df["game_id"].notna()]
    log(f"  offensive (weekly): {len(df):,} player-game rows")
    return df


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def run_ingest(seasons: list[int], log=print):
    """Full ingest pipeline for the given seasons. Safe to call from the API."""
    conn = get_connection()
    plays = load_and_store_raw(conn, seasons, log=log)
    available = set(plays.columns)

    # Build stats only for the seasons being ingested — never touch other seasons.
    log(f"\nBuilding player_game_stats for {seasons}...")

    # Offensive stats: prefer official nflverse weekly data (same source as PFR).
    # Falls back to play-by-play derivation if weekly data isn't available.
    offensive = build_offensive_stats_from_weekly(conn, seasons, log=log)
    if offensive.empty:
        log("  weekly_player_stats unavailable — falling back to play-by-play")
        offensive = merge_all_stats(
            build_passing_stats(conn, available, seasons),
            build_receiving_stats(conn, available, seasons),
            build_rushing_stats(conn, available, seasons),
        )

    defensive = build_slot_stats(plays, DEFENSIVE_SLOTS)
    kicker    = build_kicker_stats(plays)
    punter    = build_punter_stats(plays)
    returner  = build_returner_stats(plays)

    player_game_stats = merge_all_stats(offensive, defensive, kicker, punter, returner)

    # Drop any rows with no game_id (orphaned rows from failed joins)
    player_game_stats = player_game_stats[player_game_stats["game_id"].notna()]

    # Deduplicate on (game_id, player_id) — keep the row with the most total activity
    stat_cols = [c for c in player_game_stats.columns if c not in ("game_id", "player_id", "season", "week", "team", "player_name")]
    if stat_cols:
        player_game_stats["_total"] = player_game_stats[stat_cols].fillna(0).sum(axis=1)
        player_game_stats = (
            player_game_stats
            .sort_values("_total", ascending=False)
            .drop_duplicates(subset=["game_id", "player_id"])
            .drop(columns=["_total"])
        )

    conn.register("pgs_df", player_game_stats)
    try:
        conn.execute("SELECT 1 FROM player_game_stats LIMIT 1")
        placeholders = ", ".join("?" * len(seasons))
        conn.execute(f"DELETE FROM player_game_stats WHERE season IN ({placeholders})", seasons)
        existing_cols = [r[0] for r in conn.execute("DESCRIBE player_game_stats").fetchall()]
        common = [c for c in existing_cols if c in set(player_game_stats.columns)]
        cols = ", ".join(f'"{c}"' for c in common)
        conn.execute(f"INSERT INTO player_game_stats ({cols}) SELECT {cols} FROM pgs_df")
    except Exception:
        conn.execute("CREATE TABLE player_game_stats AS SELECT * FROM pgs_df")

    count = conn.execute("SELECT COUNT(*) FROM player_game_stats").fetchone()[0]
    log(f"  player_game_stats: {count:,} rows total")

    log(f"\nLoading advanced stats for {seasons}...")
    load_advanced_stats(conn, seasons, log=log)

    log(f"\nLoading supplemental vendor data for {seasons}...")
    load_supplemental_data(conn, seasons, log=log)

    # Materialize team-analytics so /team-analytics serves a precomputed
    # SELECT instead of running a 150-line CTE per request.
    log("\nMaterializing team analytics...")
    import team_analytics_builder
    for season in seasons:
        n = team_analytics_builder.materialize(season)
        log(f"  team_season_analytics[{season}]: {n} rows")

    # Rebuild player comparables — career stats shifted with the new ingest,
    # so z-scores and neighbor rankings need to be recomputed across all
    # players. Done once per ingest batch (not per season) to amortize cost.
    log("\nRebuilding player comparables...")
    import comparables_builder
    summary_n, pairs_n = comparables_builder.materialize()
    log(f"  player_career_summary: {summary_n} players")
    log(f"  player_comparables:    {pairs_n} rows")

    log("\nDone.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    import json
    import urllib.request
    import urllib.error

    parser = argparse.ArgumentParser(description="Ingest NFL data into DuckDB.")
    parser.add_argument("--seasons", type=int, nargs="+", default=[2025],
                        help="Season year(s) to load, e.g. --seasons 2024 2025")
    parser.add_argument("--api", default="http://localhost:8000",
                        help="API base URL to route through when server is running")
    args = parser.parse_args()

    # If the API server is running, route through it to avoid the DB file lock.
    via_api = []
    for season in args.seasons:
        try:
            req = urllib.request.Request(
                f"{args.api}/seasons/{season}/load?force=true", method="POST"
            )
            resp = urllib.request.urlopen(req, timeout=3)
            data = json.loads(resp.read())
            print(f"Season {season}: triggered via API (status: {data.get('status')})")
            via_api.append(season)
        except urllib.error.URLError:
            break  # API not running — fall through to direct ingest

    direct = [s for s in args.seasons if s not in via_api]
    if direct:
        run_ingest(direct)
    else:
        print("\nIngest running inside the API server. Poll GET /seasons for status.")


if __name__ == "__main__":
    main()
