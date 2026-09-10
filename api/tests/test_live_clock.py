"""Game-clock tests: frozen instants, injected fixtures, no network, no database.

The clock decides whether the live tier talks to an upstream source at all, so
it has to be provable without one. Every case here pins a real instant and a
real kickoff rather than anything relative to `now`.
"""
from datetime import datetime, timedelta, timezone

from live import clock

# The 2026 opener. nflverse publishes 20:20 Eastern; ESPN independently reports
# the same kickoff as 2026-09-10T00:20Z, which is what makes this a good anchor.
OPENER = {
    "game_id": "2026_01_NE_SEA",
    "season": 2026,
    "week": 1,
    "gameday": "2026-09-09",
    "gametime": "20:20",
    "away_team": "NE",
    "home_team": "SEA",
}
KICKOFF = datetime(2026, 9, 10, 0, 20, tzinfo=timezone.utc)

# Super Bowl LX — played in EST, so it catches a fixed-offset conversion.
SUPER_BOWL = {
    "game_id": "2025_22_SEA_NE",
    "season": 2025,
    "week": 22,
    "gameday": "2026-02-08",
    "gametime": "18:30",
    "away_team": "SEA",
    "home_team": "NE",
}


class TestKickoffConversion:
    def test_eastern_daylight_kickoff_matches_espn(self):
        assert clock.kickoff_utc("2026-09-09", "20:20") == KICKOFF

    def test_eastern_standard_kickoff_uses_the_winter_offset(self):
        # 18:30 EST is 23:30Z, an hour later than the same wall time in summer.
        assert clock.kickoff_utc("2026-02-08", "18:30") == datetime(
            2026, 2, 8, 23, 30, tzinfo=timezone.utc
        )

    def test_missing_or_malformed_time_is_not_an_error(self):
        # Flex scheduling leaves fixtures without a kickoff for weeks.
        assert clock.kickoff_utc("2026-09-09", None) is None
        assert clock.kickoff_utc(None, "20:20") is None
        assert clock.kickoff_utc("2026-09-09", "") is None
        assert clock.kickoff_utc("not-a-date", "20:20") is None
        assert clock.kickoff_utc("2026-09-09", "TBD") is None


class TestWindow:
    def test_quiet_wednesday_in_june_has_no_window(self):
        june = datetime(2026, 6, 17, 15, 0, tzinfo=timezone.utc)
        assert clock.live_window(june, games=[OPENER, SUPER_BOWL]) == []
        assert clock.is_game_window(june, games=[OPENER, SUPER_BOWL]) is False

    def test_window_opens_before_kickoff(self):
        assert clock.live_window(KICKOFF - timedelta(minutes=10), games=[OPENER])
        assert not clock.live_window(KICKOFF - timedelta(minutes=30), games=[OPENER])

    def test_window_covers_a_normal_game(self):
        assert clock.live_window(KICKOFF + timedelta(hours=2), games=[OPENER])

    def test_window_closes_after_the_nominal_length(self):
        assert not clock.live_window(KICKOFF + timedelta(hours=5), games=[OPENER])

    def test_window_carries_the_kickoff_through(self):
        [game] = clock.live_window(KICKOFF, games=[OPENER])
        assert game["kickoff"] == KICKOFF
        assert game["game_id"] == "2026_01_NE_SEA"


class TestPollInterval:
    def test_nothing_scheduled_means_no_polling_at_all(self):
        june = datetime(2026, 6, 17, 15, 0, tzinfo=timezone.utc)
        assert clock.poll_interval(june, games=[OPENER]) is clock.IDLE

    def test_waiting_for_kickoff_polls_slowly(self):
        before = KICKOFF - timedelta(minutes=10)
        assert clock.poll_interval(before, games=[OPENER]) == clock.PRE
        assert clock.poll_interval(before, states=["pre"], games=[OPENER]) == clock.PRE

    def test_a_game_in_progress_polls_fast(self):
        during = KICKOFF + timedelta(hours=1)
        assert clock.poll_interval(during, states=["in"], games=[OPENER]) == clock.LIVE

    def test_one_live_game_among_finished_ones_still_polls_fast(self):
        during = KICKOFF + timedelta(hours=1)
        states = ["post", "post", "in"]
        assert clock.poll_interval(during, states=states, games=[OPENER]) == clock.LIVE

    def test_all_finished_winds_down(self):
        after = KICKOFF + timedelta(hours=3, minutes=30)
        assert clock.poll_interval(after, states=["post"], games=[OPENER]) == clock.POST

    def test_overtime_outranks_the_schedule(self):
        # The whole point of the two levels: the schedule says this game should
        # have ended an hour ago, the source says it is still being played.
        # Cutting the scoreboard off mid-game is the failure to avoid.
        overtime = KICKOFF + timedelta(hours=5)
        assert clock.live_window(overtime, games=[OPENER]) == []
        assert clock.poll_interval(overtime, states=["in"], games=[OPENER]) == clock.LIVE

    def test_a_long_delay_does_not_strand_the_poller(self):
        # Weather can push a game hours past its window; same rule covers it.
        delayed = KICKOFF + timedelta(hours=8)
        assert clock.poll_interval(delayed, states=["in"], games=[OPENER]) == clock.LIVE

    def test_stale_live_state_stops_once_the_game_is_reported_over(self):
        after = KICKOFF + timedelta(hours=8)
        assert clock.poll_interval(after, states=["post"], games=[OPENER]) is clock.IDLE
