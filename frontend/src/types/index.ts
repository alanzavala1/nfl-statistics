/**
 * Friendly aliases for backend Pydantic models.
 *
 * Source of truth: api/schemas/*.py -> generated into ./api.d.ts via
 * `npm run gen-types`. Do not hand-edit api.d.ts.
 */
import type { components } from './api'

type Schemas = components['schemas']

// Meta
export type HealthResponse      = Schemas['HealthResponse']
export type SeasonStatus        = Schemas['SeasonStatus']
export type LoadSeasonResponse  = Schemas['LoadSeasonResponse']

// Live scoreboard
export type LiveGameOut      = Schemas['LiveGameOut']
export type Scoreboard       = Schemas['Scoreboard']

// Schedule / games
export type Game             = Schemas['Game']
export type ScheduleWeek     = Schemas['ScheduleWeek']
export type GamePlayerStats  = Schemas['GamePlayerStats']
export type GameDetail       = Schemas['GameDetail']
export type QuarterScore     = Schemas['QuarterScore']
export type WinProbPlay      = Schemas['WinProbPlay']
export type TeamGameStats    = Schemas['TeamGameStats']
export type ScoringPlay      = Schemas['ScoringPlay']
export type GameLineup       = Schemas['GameLineup']
export type LineupPlayer     = Schemas['LineupPlayer']
export type LineupTeam       = Schemas['LineupTeam']
export type LineupScoringEvent = Schemas['LineupScoringEvent']
export type PlayerChart      = Schemas['PlayerChart']
export type PlayerChartEvent = Schemas['PlayerChartEvent']

// Search
export type SearchResult     = Schemas['SearchResult']

// Teams
export type RosterPlayer     = Schemas['RosterPlayer']
export type TeamGame         = Schemas['TeamGame']
export type TeamLeader       = Schemas['TeamLeader']
export type TeamProfile      = Schemas['TeamProfile']

// Standings
export type StandingsRow         = Schemas['StandingsRow']
export type DivisionStandings    = Schemas['DivisionStandings']

// Leaders
export type LeagueLeader     = Schemas['LeagueLeader']
export type WpaLeader        = Schemas['WpaLeader']
export type WpaLeaders       = Schemas['WpaLeaders']
export type PlayerComparable = Schemas['PlayerComparable']

// Player profile
export type PlayerProfile    = Schemas['PlayerProfile']
export type PlayerGame       = Schemas['PlayerGame']
export type NgsStats         = Schemas['NgsStats']
export type SnapTotals       = Schemas['SnapTotals']
export type SituationalStats = Schemas['SituationalStats']
export type KickingStats     = Schemas['KickingStats']
export type PlayerWpa        = Schemas['PlayerWpa']
export type PlayerAdvStats   = Schemas['PlayerAdvStats']
export type PlayerSplit      = Schemas['PlayerSplit']
export type DefensiveSplit   = Schemas['DefensiveSplit']

// Team analytics
export type TeamAnalyticsRow      = Schemas['TeamAnalyticsRow']
export type TeamAnalyticsResponse = Schemas['TeamAnalyticsResponse']
export type TeamSplit             = Schemas['TeamSplit']

// Supplemental vendor data (Wave 1)
export type DraftInfo       = Schemas['DraftInfo']
export type CombineData     = Schemas['CombineData']
export type InjuryStatus    = Schemas['InjuryStatus']
export type DepthChartEntry = Schemas['DepthChartEntry']
export type PlayerAward     = Schemas['PlayerAward']

// Natural-language ask assistant
export type AskHistoryMessage = Schemas['AskHistoryMessage']
export type AskRequest        = Schemas['AskRequest']
export type AskResponse       = Schemas['AskResponse']
export type ToolCall          = Schemas['ToolCall']
