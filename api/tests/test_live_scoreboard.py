"""Live scoreboard: the three properties worth guaranteeing.

No network here. The provider is a stub, so these test our behaviour around an
upstream rather than the upstream itself.
"""
from datetime import datetime, timezone

import pytest

from live import clock, scoreboard as sb
from live.provider import LiveGame

NOW = datetime(2026, 9, 10, 1, 30, tzinfo=timezone.utc)

LIVE_GAME = LiveGame(
    away_team="NE", home_team="SEA", gameday="2026-09-09", state="in",
    away_score=10, home_score=3, period=4, clock="14:12",
    possession="SEA", detail="14:12 - 4th", game_id="2026_01_NE_SEA",
)
SCHEDULE_GAME = LiveGame(
    away_team="NE", home_team="SEA", gameday="2026-09-09", state="pre",
    game_id="2026_01_NE_SEA",
)


class StubProvider:
    """Counts calls, so we can prove viewers don't multiply them."""

    name = "stub"

    def __init__(self, games=None, fail=False):
        self.games, self.fail, self.calls = games or [LIVE_GAME], fail, 0

    def scoreboard(self):
        self.calls += 1
        if self.fail:
            raise RuntimeError("upstream is down")
        return self.games


@pytest.fixture(autouse=True)
def _clean_cache():
    sb._cache = sb._Cache()
    yield
    sb._cache = sb._Cache()


@pytest.fixture
def wired(monkeypatch):
    """Point the service at a stub provider and a stub schedule."""
    def _wire(provider, interval=clock.LIVE):
        monkeypatch.setattr(sb, "get_provider", lambda: provider)
        monkeypatch.setattr(sb, "_from_schedule", lambda now: [SCHEDULE_GAME])
        monkeypatch.setattr(sb.clock, "poll_interval", lambda *a, **k: interval)
        monkeypatch.setattr(sb, "resolve_game_ids", lambda games: games)
        return provider
    return _wire


class TestDoesNotFallOver:
    def test_upstream_failure_serves_the_schedule_instead_of_erroring(self, wired):
        wired(StubProvider(fail=True))
        out = sb.scoreboard(NOW)
        assert out["source"] == "schedule"
        assert out["games"][0]["game_id"] == "2026_01_NE_SEA"

    def test_upstream_failure_prefers_the_last_good_answer(self, wired):
        provider = wired(StubProvider())
        assert sb.scoreboard(NOW)["source"] == "live"

        provider.fail = True
        sb._cache._at = 0          # force the TTL to have expired
        out = sb.scoreboard(NOW)
        # A score from a minute ago beats a schedule row that knows no score.
        assert out["source"] == "stale"
        assert out["games"][0]["away_score"] == 10

    def test_a_malformed_upstream_event_does_not_blank_the_board(self):
        from live.provider import ESPNProvider
        p = ESPNProvider()
        assert p._game({"competitions": [{}]}) is None
        assert p._game({}) is None


class TestUpstreamCallsDoNotScaleWithViewers:
    def test_many_readers_inside_one_ttl_cost_one_call(self, wired):
        provider = wired(StubProvider())
        for _ in range(25):
            sb.scoreboard(NOW)
        assert provider.calls == 1

    def test_an_expired_ttl_refetches(self, wired):
        provider = wired(StubProvider())
        sb.scoreboard(NOW)
        sb._cache._at = 0
        sb.scoreboard(NOW)
        assert provider.calls == 2


class TestQuietWhenThereIsNoFootball:
    def test_no_window_means_no_upstream_call_at_all(self, wired):
        provider = wired(StubProvider(), interval=clock.IDLE)
        out = sb.scoreboard(NOW)
        assert provider.calls == 0
        assert out["source"] == "schedule"
        assert out["poll_after"] is None

    def test_idle_answers_are_reused(self, wired):
        wired(StubProvider(), interval=clock.IDLE)
        first = sb.scoreboard(NOW)
        assert sb.scoreboard(NOW) is first


class TestPayload:
    def test_poll_after_comes_from_the_clock(self, wired):
        wired(StubProvider(), interval=clock.LIVE)
        assert sb.scoreboard(NOW)["poll_after"] == clock.LIVE

    def test_game_carries_the_fields_a_scoreboard_needs(self, wired):
        wired(StubProvider())
        game = sb.scoreboard(NOW)["games"][0]
        for field in ("game_id", "state", "away_score", "home_score",
                      "period", "clock", "possession", "detail"):
            assert field in game
        assert game["possession"] == "SEA"
