/**
 * HTTP client + type re-exports.
 *
 * Every type below is derived from the Pydantic models in api/schemas/*.py
 * via the OpenAPI codegen pipeline:
 *
 *   api/schemas/*.py  →  emit_openapi.py  →  frontend/openapi.json
 *                                                  ↓ npm run gen-types
 *                                          src/types/api.d.ts
 *                                                  ↓
 *                                          src/types/index.ts (aliases)
 *
 * Backward-compatible aliases (SeasonEntry, WeekGroup, PlayerStats,
 * StandingsTeam, TeamAnalyticsTeam) are re-exported under the historical
 * names that the pages were already importing.
 */
import type {
  CombineData, DepthChartEntry, DivisionStandings, DraftInfo, Game,
  GameDetail, GamePlayerStats, InjuryStatus, KickingStats, LeagueLeader, NgsStats,
  PlayerAdvStats, PlayerAward, PlayerComparable, PlayerGame, PlayerProfile, PlayerSplit, DefensiveSplit, PlayerWpa,
  RosterPlayer, ScheduleWeek, SearchResult, SeasonStatus, SituationalStats,
  SnapTotals, StandingsRow, TeamAnalyticsResponse, TeamAnalyticsRow,
  TeamGame, TeamLeader, TeamProfile, TeamSplit, TeamGameStats, ScoringPlay, WinProbPlay, WpaLeader, WpaLeaders,
  GameLineup, LineupPlayer, LineupTeam, LineupScoringEvent, PlayerChart, PlayerChartEvent,
  AskHistoryMessage, AskRequest, AskResponse, ToolCall,
  Scoreboard,
} from './types'

const BASE = '/api'

// NFL season year = calendar year the season starts (Sep onward = this year, Jan–Aug = last year)
export const CURRENT_NFL_SEASON = ((): number => {
  const now = new Date()
  return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1
})()

// ── Generated types, re-exported under both their current names and the
//     historical aliases so pages don't have to be touched on every rename ───
export type {
  CombineData, DepthChartEntry, DivisionStandings, DraftInfo, Game,
  GameDetail, InjuryStatus, KickingStats, LeagueLeader, NgsStats, PlayerAdvStats,
  PlayerAward, PlayerComparable, PlayerGame, PlayerProfile, PlayerSplit, DefensiveSplit, PlayerWpa,
  RosterPlayer, SearchResult, SituationalStats, SnapTotals, TeamGame,
  TeamLeader, TeamProfile, TeamSplit, TeamGameStats, ScoringPlay, WinProbPlay, WpaLeader, WpaLeaders,
  GameLineup, LineupPlayer, LineupTeam, LineupScoringEvent, PlayerChart, PlayerChartEvent,
  AskHistoryMessage, AskRequest, AskResponse,
}

export type SeasonEntry        = SeasonStatus
export type WeekGroup          = ScheduleWeek
export type PlayerStats        = GamePlayerStats
export type StandingsTeam      = StandingsRow
export type TeamAnalyticsTeam  = TeamAnalyticsRow

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export const api = {
  seasons:       ()                            => get<SeasonStatus[]>('/seasons'),
  loadSeason:    (year: number)                => fetch(`${BASE}/seasons/${year}/load?force=false`, { method: 'POST' }).then(r => r.json()),
  schedule:      (season: number)              => get<ScheduleWeek[]>(`/schedule?season=${season}`),
  liveScoreboard: ()                           => get<Scoreboard>('/live/scoreboard'),
  game:          (gameId: string)              => get<GameDetail>(`/games/${gameId}`),
  gameLineup:    (gameId: string)              => get<GameLineup>(`/games/${gameId}/lineup`),
  playerChart:   (gameId: string, playerId: string) => get<PlayerChart>(`/games/${gameId}/players/${playerId}/chart`),
  player:        (playerId: string)            => get<PlayerProfile>(`/players/${playerId}`),
  team:          (abbrev: string, season: number) => get<TeamProfile>(`/teams/${abbrev}?season=${season}`),
  teamRoster:    (team: string, season: number) => get<RosterPlayer[]>(`/teams/${team}/roster?season=${season}`),
  teamDepthChart: (team: string, season: number, week?: number) =>
    get<DepthChartEntry[]>(`/teams/${team}/depth-chart?season=${season}${week != null ? `&week=${week}` : ''}`),
  teamInjuries:  (team: string, season: number, week?: number) =>
    get<InjuryStatus[]>(`/teams/${team}/injuries?season=${season}${week != null ? `&week=${week}` : ''}`),
  teamAnalytics: (season: number)              => get<TeamAnalyticsResponse>(`/team-analytics?season=${season}`),
  teamSplits:    (team: string, season: number) => get<TeamSplit[]>(`/teams/${team}/splits?season=${season}`),
  standings:     (season: number)              => get<DivisionStandings[]>(`/standings?season=${season}`),
  leaders:       (season: number)              => get<LeagueLeader[]>(`/leaders?season=${season}`),
  wpaLeaders:    (season: number)              => get<WpaLeaders>(`/wpa-leaders?season=${season}`),
  comparables:   (playerId: string)            => get<PlayerComparable[]>(`/players/${playerId}/comparables`),
  splits:        (playerId: string)            => get<PlayerSplit[]>(`/players/${playerId}/splits`),
  defSplits:     (playerId: string)            => get<DefensiveSplit[]>(`/players/${playerId}/def-splits`),
  search:        (q: string)                   => get<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),
  ask:           (question: string, history: AskHistoryMessage[] = []) =>
    post<AskResponse>('/ask', { question, history } satisfies AskRequest),
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // Surface the backend's human-readable detail (rate limit, bad input, etc.)
    let detail = `${res.status} ${res.statusText}`
    try { const j = await res.json(); if (j?.detail) detail = j.detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  return res.json()
}

// ── /ask streaming (Server-Sent Events) ─────────────────────────────────────
// Mirrors the backend events from run_ask_stream: a `tool` event per tool call,
// `delta` events for answer tokens, a final `done`, or an `error`.
export type AskEvent =
  | { type: 'tool'; tool: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; data: Record<string, unknown>[]; tools_used: ToolCall[] }
  | { type: 'error'; detail: string }

export async function askStream(
  question: string,
  history: AskHistoryMessage[],
  onEvent: (e: AskEvent) => void,
): Promise<void> {
  const res = await fetch(`${BASE}/ask/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history } satisfies AskRequest),
  })
  if (!res.ok || !res.body) {
    // Pre-stream rejection (rate limit, bad input) comes back as normal JSON.
    let detail = `${res.status} ${res.statusText}`
    try { const j = await res.json(); if (j?.detail) detail = j.detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? '' // keep the trailing partial frame
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try { onEvent(JSON.parse(line.slice(5).trim()) as AskEvent) } catch { /* ignore malformed frame */ }
    }
  }
}
