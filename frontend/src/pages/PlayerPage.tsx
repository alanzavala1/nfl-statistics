import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api, CURRENT_NFL_SEASON } from '../api'
import type { PlayerProfile, PlayerGame, NgsStats, SnapTotals, SituationalStats, PlayerWpa, PlayerAdvStats, PlayerComparable, LeagueLeader, CombineData, DepthChartEntry, InjuryStatus } from '../api'
import { useLeaders, usePlayer, usePlayerComparables, useSeasons } from '../queries'
import Nav, { backBtnCls } from '../components/Nav'
import type { Crumb } from '../components/Nav'
import { teamLogoUrl, teamName } from '../utils/teams'
import { PAST_AWARDS, AWARD_LABEL, type AwardKey } from '../utils/awards'

// — helpers —
function passerRating(cmp: number, att: number, yds: number, td: number, int_: number): string | null {
  if (att === 0) return null
  const clamp = (x: number) => Math.min(2.375, Math.max(0, x))
  const a = clamp((cmp / att - 0.3) / 0.2)
  const b = clamp((yds / att - 3) / 4)
  const c = clamp((td / att) / 0.05)
  const d = clamp(2.375 - (int_ / att) / 0.04)
  return (((a + b + c + d) / 6) * 100).toFixed(1)
}
function pct(a: number, b: number, dec = 1): string | null { return b > 0 ? (a / b * 100).toFixed(dec) : null }
function ratio(y: number, a: number, dec = 1): string | null { return a > 0 ? (y / a).toFixed(dec) : null }
function sfmt(x: number | null | undefined, dec = 1): string | null { if (x == null) return null; return `${x >= 0 ? '+' : ''}${x.toFixed(dec)}` }
function dfmt(x: number | null | undefined, dec = 1): string | null { if (x == null) return null; return x.toFixed(dec) }

// — aggregation —
function sumGames(games: PlayerGame[]) {
  const s = {
    attempts: 0, completions: 0, pass_yards: 0, pass_tds: 0,
    interceptions_thrown: 0, sacks_taken: 0, pass_epa: 0,
    carries: 0, rush_yards: 0, rush_tds: 0, rush_epa: 0,
    targets: 0, receptions: 0, rec_yards: 0, rec_tds: 0, yac: 0, air_yards: 0, rec_epa: 0,
    solo_tackles: 0, assist_tackles: 0, tackles_for_loss: 0,
    sacks: 0, qb_hits: 0, def_interceptions: 0, pass_breakups: 0,
    fg_att: 0, fg_made: 0, xp_att: 0, xp_made: 0,
    punts: 0, punt_yards: 0,
  }
  for (const g of games) {
    for (const k of Object.keys(s) as (keyof typeof s)[]) {
      s[k] += g[k] ?? 0
    }
  }
  return s
}
type Totals = ReturnType<typeof sumGames>

// — awards lookup —
function getPlayerAwards(playerName: string): Array<{ season: number; award: AwardKey }> {
  const won: Array<{ season: number; award: AwardKey }> = []
  for (const [season, list] of Object.entries(PAST_AWARDS)) {
    for (const a of list) {
      if (a.player === playerName) won.push({ season: Number(season), award: a.award })
    }
  }
  return won.sort((a, b) => b.season - a.season)
}

function AwardBadge({ season, award }: { season: number; award: AwardKey }) {
  const isMvp = award === 'MVP'
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border whitespace-nowrap ${
      isMvp
        ? 'border-yellow-500/50 bg-yellow-500/15 text-yellow-300'
        : 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200'
    }`}>
      {isMvp ? '★ ' : ''}{AWARD_LABEL[award]} {season}
    </span>
  )
}

// — career trajectory chart —
function getPrimaryStat(t: Totals, pos: string): { value: number; label: string } {
  if (pos === 'QB') return { value: t.pass_yards, label: 'Pass YDS' }
  if (pos === 'RB') return { value: t.rush_yards + t.rec_yards, label: 'Scrim YDS' }
  if (pos === 'WR') return { value: t.rec_yards, label: 'Rec YDS' }
  if (pos === 'K')  return { value: t.fg_made * 3 + t.xp_made, label: 'Points' }
  if (pos === 'P')  return { value: t.punt_yards, label: 'Punt YDS' }
  return { value: t.solo_tackles + t.assist_tackles, label: 'Tackles' }
}

function CareerTrajectory({ seasons, bySeason, pos }: {
  seasons: number[]
  bySeason: Record<number, PlayerGame[]>
  pos: string
}) {
  if (seasons.length < 2) return null
  const data = [...seasons]
    .sort((a, b) => a - b)
    .map(s => {
      const totals = sumGames(bySeason[s])
      const games = bySeason[s].length
      const { value, label } = getPrimaryStat(totals, pos)
      return { season: s, value, games, label }
    })
  const max = Math.max(...data.map(d => d.value), 1)
  const peakSeason = data.reduce((p, c) => c.value > p.value ? c : p, data[0]).season
  const statLabel = data[0]?.label ?? ''
  const BAR_MAX_H = 96  // px

  return (
    <section className="mb-8">
      <div className="flex items-end justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-widest">Career Trajectory</h2>
          <span className="text-[10px] text-gray-700">{statLabel} by season</span>
        </div>
        <span className="text-[10px] text-gray-700">{data[0].season}–{data[data.length - 1].season}</span>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-end gap-2 overflow-x-auto" style={{ minHeight: BAR_MAX_H + 28 }}>
          {data.map(d => {
            const isPeak = d.season === peakSeason
            const barH = d.value > 0 ? Math.max(2, Math.round((d.value / max) * BAR_MAX_H)) : 0
            return (
              <div key={d.season} className="flex flex-col items-center shrink-0 w-12">
                <div className="text-[10px] tabular-nums text-gray-400 mb-1 font-semibold leading-none h-3">
                  {d.value > 0 ? d.value.toLocaleString() : ''}
                </div>
                <div
                  className={`w-full rounded-t transition-colors ${isPeak ? 'bg-indigo-400' : 'bg-indigo-500/60 hover:bg-indigo-500'}`}
                  style={{ height: `${barH}px` }}
                  title={`${d.season}: ${d.value.toLocaleString()} ${d.label} · ${d.games}G`}
                />
                <div className={`text-[10px] tabular-nums mt-1 leading-none ${isPeak ? 'text-indigo-300 font-bold' : 'text-gray-600'}`}>
                  {String(d.season).slice(-2)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// — league rank lookup —
function computeRank(leaders: LeagueLeader[], playerId: string, value: (p: LeagueLeader) => number, filter: (p: LeagueLeader) => boolean): number | null {
  const filtered = leaders.filter(filter)
  // Player must qualify themselves
  if (!filtered.some(p => p.player_id === playerId)) return null
  const sorted = [...filtered].sort((a, b) => value(b) - value(a))
  const idx = sorted.findIndex(p => p.player_id === playerId)
  return idx >= 0 ? idx + 1 : null
}

function rankSuffix(rank: number | null, season: number): string | null {
  if (rank == null) return null
  const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'
  return `${rank}${suffix} in NFL · ${season}`
}

function passerRatingNum(cmp: number, att: number, yds: number, td: number, int_: number): number | null {
  if (att === 0) return null
  const clamp = (x: number) => Math.min(2.375, Math.max(0, x))
  const a = clamp((cmp / att - 0.3) / 0.2)
  const b = clamp((yds / att - 3) / 4)
  const c = clamp((td / att) / 0.05)
  const d = clamp(2.375 - (int_ / att) / 0.04)
  return ((a + b + c + d) / 6) * 100
}

function computeHighlightRanks(pos: string, playerId: string, leaders: LeagueLeader[], season: number): Record<string, string | null> {
  const r = (val: (p: LeagueLeader) => number, filter: (p: LeagueLeader) => boolean) =>
    rankSuffix(computeRank(leaders, playerId, val, filter), season)
  if (pos === 'QB') {
    const qbFilter = (p: LeagueLeader) => p.attempts >= 100
    return {
      'Passer Rating': r(p => passerRatingNum(p.completions, p.attempts, p.pass_yards, p.pass_tds, p.interceptions_thrown) ?? 0, qbFilter),
      'AY/A':          r(p => p.attempts > 0 ? (p.pass_yards + 20 * p.pass_tds - 45 * p.interceptions_thrown) / p.attempts : 0, qbFilter),
      'EPA / Att':     r(p => p.attempts > 0 && p.pass_epa != null ? p.pass_epa / p.attempts : 0, qbFilter),
    }
  }
  if (pos === 'RB') {
    const rbFilter = (p: LeagueLeader) => p.carries >= 50
    return {
      'Rush Yards':  r(p => p.rush_yards, rbFilter),
      'Y / Carry':   r(p => p.carries > 0 ? p.rush_yards / p.carries : 0, rbFilter),
      'EPA / Carry': r(p => p.carries > 0 && p.rush_epa != null ? p.rush_epa / p.carries : 0, rbFilter),
      'SCR YDS / G': r(p => p.games_played > 0 ? (p.rush_yards + p.rec_yards) / p.games_played : 0, rbFilter),
    }
  }
  if (pos === 'WR') {
    const wrFilter = (p: LeagueLeader) => p.targets >= 20
    return {
      'Rec Yards':    r(p => p.rec_yards, wrFilter),
      'Catch %':      r(p => p.targets > 0 ? p.receptions / p.targets : 0, wrFilter),
      'EPA / Target': r(p => p.targets > 0 && p.rec_epa != null ? p.rec_epa / p.targets : 0, wrFilter),
      'Y / Target':   r(p => p.targets > 0 ? p.rec_yards / p.targets : 0, wrFilter),
    }
  }
  if (pos === 'DEF') {
    return {
      'Tackles': r(p => p.solo_tackles + p.assist_tackles, p => p.solo_tackles + p.assist_tackles >= 10),
      'Sacks':   r(p => p.sacks, p => p.sacks > 0),
      'INT':     r(p => p.def_interceptions, p => p.def_interceptions > 0),
      'PBU':     r(p => p.pass_breakups, p => p.pass_breakups > 0),
    }
  }
  if (pos === 'K') {
    return { 'Points': r(p => p.fg_made * 3 + p.xp_made, p => p.fg_att + p.xp_att > 0) }
  }
  if (pos === 'P') {
    return { 'Punts': r(p => (p as any).punts ?? 0, p => ((p as any).punts ?? 0) > 0) }
  }
  return {}
}

type ColKind = 'trad' | 'adv' | 'ngs' | 'snap' | 'sit'
type Col = {
  key: string; label: string; kind: ColKind; group?: string; wpaOnly?: boolean; signed?: boolean; highlight?: boolean
  cell: (t: Totals, games: number, n?: NgsStats, sn?: SnapTotals, sit?: SituationalStats, w?: PlayerWpa, a?: PlayerAdvStats) => string | number | null
}

// — column definitions —
const QB_COLS: Col[] = [
  { key: 'g',    label: 'G',       kind: 'trad',                        cell: (_, g) => g },
  { key: 'snp',  label: 'SNP',     kind: 'snap',                        cell: (_, __, _n, sn) => sn ? sn.offense_snaps : null },
  { key: 'spct', label: 'SNP%',    kind: 'snap',                        cell: (_, __, _n, sn) => sn ? `${(sn.avg_offense_pct ?? 0).toFixed(0)}%` : null },
  // Passing
  { key: 'cmp',  label: 'CMP',     kind: 'trad', group: 'Passing',      cell: t => t.completions },
  { key: 'att',  label: 'ATT',     kind: 'trad', group: 'Passing',      cell: t => t.attempts },
  { key: 'cpct', label: 'CMP%',    kind: 'trad', group: 'Passing',      cell: t => pct(t.completions, t.attempts) },
  { key: 'yds',  label: 'YDS',     kind: 'trad', group: 'Passing', highlight: true, cell: t => t.pass_yards },
  { key: 'td',   label: 'TD',      kind: 'trad', group: 'Passing',      cell: t => t.pass_tds },
  { key: 'int',  label: 'INT',     kind: 'trad', group: 'Passing',      cell: t => t.interceptions_thrown },
  { key: 'ya',   label: 'Y/A',     kind: 'trad', group: 'Passing',      cell: t => ratio(t.pass_yards, t.attempts) },
  { key: 'sck',  label: 'SACK',    kind: 'trad', group: 'Passing',      cell: t => t.sacks_taken },
  { key: 'rate', label: 'RATE',    kind: 'trad', group: 'Passing',      cell: t => passerRating(t.completions, t.attempts, t.pass_yards, t.pass_tds, t.interceptions_thrown) },
  // Rushing
  { key: 'car',  label: 'CAR',     kind: 'trad', group: 'Rushing',      cell: t => t.carries > 0 ? t.carries : null },
  { key: 'ryds', label: 'YDS',     kind: 'trad', group: 'Rushing',      cell: t => t.carries > 0 ? t.rush_yards : null },
  { key: 'rtd',  label: 'TD',      kind: 'trad', group: 'Rushing',      cell: t => t.carries > 0 && t.rush_tds > 0 ? t.rush_tds : null },
  { key: 'rypc', label: 'Y/C',     kind: 'trad', group: 'Rushing',      cell: t => t.carries > 0 ? ratio(t.rush_yards, t.carries) : null },
  // Advanced / NGS / Situational / WPA
  { key: 'aya',  label: 'AY/A',    kind: 'adv',                         cell: t => t.attempts > 0 ? ((t.pass_yards + 20 * t.pass_tds - 45 * t.interceptions_thrown) / t.attempts).toFixed(1) : null },
  { key: 'epaa', label: 'EPA/Att', kind: 'adv',  signed: true,          cell: t => t.attempts > 0 ? sfmt(t.pass_epa / t.attempts, 3) : null },
  { key: 'qbfl', label: 'FUM',     kind: 'adv',                         cell: (_, __, _n, _sn, _sit, _w, a) => a?.fumbles_lost != null ? a.fumbles_lost : null },
  { key: 'pwpa', label: 'WPA',     kind: 'adv',  wpaOnly: true, signed: true, cell: (_, __, _n, _sn, _sit, w) => w?.pass_wpa != null ? sfmt(w.pass_wpa, 3) : null },
  { key: 'cpoe', label: 'CPOE',    kind: 'ngs',  signed: true,          cell: (_, __, n) => sfmt(n?.cpoe) },
  { key: 'ttt',  label: 'TTT',     kind: 'ngs',                         cell: (_, __, n) => n?.avg_time_to_throw != null ? `${n.avg_time_to_throw.toFixed(2)}s` : null },
  { key: 'adot', label: 'aDOT',    kind: 'ngs',                         cell: (_, __, n) => dfmt(n?.adot) },
  { key: 'agg',  label: 'AGG%',    kind: 'ngs',                         cell: (_, __, n) => n?.aggressiveness != null ? `${n.aggressiveness.toFixed(1)}%` : null },
  { key: 'xcmp', label: 'xCMP%',   kind: 'ngs',                         cell: (_, __, n) => n?.expected_cmp_pct != null ? `${n.expected_cmp_pct.toFixed(1)}%` : null },
  { key: 'rzd',  label: 'RZ TD',   kind: 'sit',                         cell: (_, __, _n, _sn, sit) => sit?.rz_pass_tds ?? null },
  { key: 'rzp',  label: 'RZ%',     kind: 'sit',                         cell: (_, __, _n, _sn, sit) => sit?.rz_pass_att ? pct(sit.rz_pass_tds ?? 0, sit.rz_pass_att) + '%' : null },
  { key: 'tdp',  label: '3D%',     kind: 'sit',                         cell: (_, __, _n, _sn, sit) => sit?.third_pass_att ? pct(sit.third_pass_fd ?? 0, sit.third_pass_att) + '%' : null },
  { key: 'lng',  label: 'LNG',     kind: 'sit',                         cell: (_, __, _n, _sn, sit) => sit?.lng_pass ?? null },
]

const RB_COLS: Col[] = [
  { key: 'g',    label: 'G',       kind: 'trad',                        cell: (_, g) => g },
  { key: 'snp',  label: 'SNP',     kind: 'snap',                        cell: (_, __, _n, sn) => sn ? sn.offense_snaps : null },
  { key: 'spct', label: 'SNP%',    kind: 'snap',                        cell: (_, __, _n, sn) => sn ? `${(sn.avg_offense_pct ?? 0).toFixed(0)}%` : null },
  // Rushing
  { key: 'car',  label: 'CAR',     kind: 'trad', group: 'Rushing',      cell: t => t.carries },
  { key: 'ryds', label: 'YDS',     kind: 'trad', group: 'Rushing', highlight: true, cell: t => t.rush_yards },
  { key: 'ypc',  label: 'Y/C',     kind: 'trad', group: 'Rushing',      cell: t => ratio(t.rush_yards, t.carries) },
  { key: 'rtd',  label: 'TD',      kind: 'trad', group: 'Rushing',      cell: t => t.rush_tds },
  { key: 'ryg',  label: 'Y/G',     kind: 'trad', group: 'Rushing',      cell: (t, g) => ratio(t.rush_yards, g) },
  // Receiving
  { key: 'tgt',  label: 'TGT',     kind: 'trad', group: 'Receiving',    cell: t => t.targets > 0 ? t.targets : null },
  { key: 'rec',  label: 'REC',     kind: 'trad', group: 'Receiving',    cell: t => t.targets > 0 ? t.receptions : null },
  { key: 'rcy',  label: 'YDS',     kind: 'trad', group: 'Receiving',    cell: t => t.targets > 0 ? t.rec_yards : null },
  { key: 'scr',  label: 'SCR YDS', kind: 'trad', group: 'Receiving',    cell: t => t.rush_yards + t.rec_yards > 0 ? t.rush_yards + t.rec_yards : null },
  // Passing (trick plays / pass-catchers who throw)
  { key: 'patt', label: 'ATT',     kind: 'trad', group: 'Passing',      cell: t => t.attempts > 0 ? t.attempts : null },
  { key: 'pyds', label: 'YDS',     kind: 'trad', group: 'Passing',      cell: t => t.attempts > 0 ? t.pass_yards : null },
  { key: 'ptd',  label: 'TD',      kind: 'trad', group: 'Passing',      cell: t => t.attempts > 0 ? t.pass_tds : null },
  // Advanced / NGS / Situational / WPA
  { key: 'epac',   label: 'EPA/Car', kind: 'adv', signed: true,         cell: t => t.carries > 0 ? sfmt(t.rush_epa / t.carries, 3) : null },
  { key: 'rbstuf', label: 'STF%',    kind: 'adv',                       cell: (_, __, _n, _sn, _sit, _w, a) => a?.stuff_rate != null ? `${a.stuff_rate.toFixed(1)}%` : null },
  { key: 'rbfl',   label: 'FUM',     kind: 'adv',                       cell: (_, __, _n, _sn, _sit, _w, a) => a?.fumbles_lost != null ? a.fumbles_lost : null },
  { key: 'rwpa',   label: 'WPA',     kind: 'adv', wpaOnly: true, signed: true, cell: (_, __, _n, _sn, _sit, w) => w ? sfmt((w.rush_wpa ?? 0) + (w.rec_wpa ?? 0), 3) : null },
  { key: 'ryoe',   label: 'RYOE',    kind: 'ngs', signed: true,         cell: (_, __, n) => sfmt(n?.rush_yoe) },
  { key: 'ryoa',   label: 'RYOE/A',  kind: 'ngs', signed: true,         cell: (_, __, n) => sfmt(n?.rush_yoe_per_att, 2) },
  { key: 'eff',    label: 'EFF%',    kind: 'ngs',                       cell: (_, __, n) => n?.rush_efficiency != null ? `${n.rush_efficiency.toFixed(1)}%` : null },
  { key: 'rzd',    label: 'RZ TD',   kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.rz_rush_tds ?? null },
  { key: 'rzp',    label: 'RZ%',     kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.rz_carries ? pct(sit.rz_rush_tds ?? 0, sit.rz_carries) + '%' : null },
  { key: 'tdp',    label: '3D%',     kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.third_carries ? pct(sit.third_rush_fd ?? 0, sit.third_carries) + '%' : null },
  { key: 'lng',    label: 'LNG',     kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.lng_rush ?? null },
]

const WR_COLS: Col[] = [
  { key: 'g',    label: 'G',         kind: 'trad',                      cell: (_, g) => g },
  { key: 'snp',  label: 'SNP',       kind: 'snap',                      cell: (_, __, _n, sn) => sn ? sn.offense_snaps : null },
  { key: 'spct', label: 'SNP%',      kind: 'snap',                      cell: (_, __, _n, sn) => sn ? `${(sn.avg_offense_pct ?? 0).toFixed(0)}%` : null },
  // Receiving
  { key: 'tgt',  label: 'TGT',       kind: 'trad', group: 'Receiving',  cell: t => t.targets },
  { key: 'rec',  label: 'REC',       kind: 'trad', group: 'Receiving',  cell: t => t.receptions },
  { key: 'yds',  label: 'YDS',       kind: 'trad', group: 'Receiving', highlight: true, cell: t => t.rec_yards },
  { key: 'ypr',  label: 'Y/R',       kind: 'trad', group: 'Receiving',  cell: t => ratio(t.rec_yards, t.receptions) },
  { key: 'td',   label: 'TD',        kind: 'trad', group: 'Receiving',  cell: t => t.rec_tds },
  { key: 'cpct', label: 'CTH%',      kind: 'trad', group: 'Receiving',  cell: t => pct(t.receptions, t.targets) },
  { key: 'ytgt', label: 'Y/TGT',     kind: 'trad', group: 'Receiving',  cell: t => ratio(t.rec_yards, t.targets) },
  { key: 'yg',   label: 'Y/G',       kind: 'trad', group: 'Receiving',  cell: (t, g) => ratio(t.rec_yards, g) },
  // Rushing
  { key: 'car',  label: 'CAR',       kind: 'trad', group: 'Rushing',    cell: t => t.carries > 0 ? t.carries : null },
  { key: 'ryd',  label: 'YDS',       kind: 'trad', group: 'Rushing',    cell: t => t.carries > 0 ? t.rush_yards : null },
  // Passing
  { key: 'patt', label: 'ATT',       kind: 'trad', group: 'Passing',    cell: t => t.attempts > 0 ? t.attempts : null },
  { key: 'pyds', label: 'YDS',       kind: 'trad', group: 'Passing',    cell: t => t.attempts > 0 ? t.pass_yards : null },
  { key: 'ptd',  label: 'TD',        kind: 'trad', group: 'Passing',    cell: t => t.attempts > 0 ? t.pass_tds : null },
  // Advanced / NGS / Situational / WPA
  { key: 'epat',   label: 'EPA/Tgt', kind: 'adv',  signed: true,        cell: t => t.targets > 0 ? sfmt(t.rec_epa / t.targets, 3) : null },
  { key: 'ayt',    label: 'AY/TGT',  kind: 'adv',                       cell: t => t.targets > 0 ? ratio(t.air_yards, t.targets) : null },
  { key: 'yacr',   label: 'YAC/R',   kind: 'adv',                       cell: t => t.receptions > 0 ? ratio(t.yac, t.receptions) : null },
  { key: 'racr',   label: 'RACR',    kind: 'adv',                       cell: t => t.air_yards > 0 ? (t.rec_yards / t.air_yards).toFixed(2) : null },
  { key: 'tgtsh',  label: 'TGT%',    kind: 'adv',                       cell: (_, __, _n, _sn, _sit, _w, a) => a?.target_share != null ? `${a.target_share.toFixed(1)}%` : null },
  { key: 'aysh',   label: 'AY%',     kind: 'adv',                       cell: (_, __, _n, _sn, _sit, _w, a) => a?.air_yards_share != null ? `${a.air_yards_share.toFixed(1)}%` : null },
  { key: 'wrfl',   label: 'FUM',     kind: 'adv',                       cell: (_, __, _n, _sn, _sit, _w, a) => a?.fumbles_lost != null ? a.fumbles_lost : null },
  { key: 'recwpa', label: 'WPA',     kind: 'adv',  wpaOnly: true, signed: true, cell: (_, __, _n, _sn, _sit, w) => w?.rec_wpa != null ? sfmt(w.rec_wpa, 3) : null },
  { key: 'sep',    label: 'SEP',     kind: 'ngs',                       cell: (_, __, n) => dfmt(n?.avg_separation) },
  { key: 'cush',   label: 'CUSH',    kind: 'ngs',                       cell: (_, __, n) => dfmt(n?.avg_cushion) },
  { key: 'tgd',    label: 'TGT DEP', kind: 'ngs',                       cell: (_, __, n) => dfmt(n?.avg_target_depth) },
  { key: 'yacx',   label: 'YAC+',    kind: 'ngs',  signed: true,        cell: (_, __, n) => sfmt(n?.avg_yac_above_exp) },
  { key: 'ngsaysh',label: 'AY SH%',  kind: 'ngs',                       cell: (_, __, n) => n?.air_yards_share != null ? `${n.air_yards_share.toFixed(1)}%` : null },
  { key: 'rzd',    label: 'RZ TD',   kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.rz_rec_tds ?? null },
  { key: 'rzp',    label: 'RZ%',     kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.rz_targets ? pct(sit.rz_rec_tds ?? 0, sit.rz_targets) + '%' : null },
  { key: 'tdp',    label: '3D%',     kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.third_targets ? pct(sit.third_rec_fd ?? 0, sit.third_targets) + '%' : null },
  { key: 'lng',    label: 'LNG',     kind: 'sit',                       cell: (_, __, _n, _sn, sit) => sit?.lng_rec ?? null },
]

const DEF_COLS: Col[] = [
  { key: 'g',    label: 'G',    kind: 'trad', cell: (_, g) => g },
  { key: 'snp',  label: 'SNP',  kind: 'snap', cell: (_, __, _n, sn) => sn ? ((sn.defense_snaps ?? 0) > 0 ? sn.defense_snaps : sn.st_snaps) : null },
  { key: 'spct', label: 'SNP%', kind: 'snap', cell: (_, __, _n, sn) => sn ? ((sn.defense_snaps ?? 0) > 0 ? `${(sn.avg_defense_pct ?? 0).toFixed(0)}%` : `${(sn.avg_st_pct ?? 0).toFixed(0)}%`) : null },
  { key: 'tot',  label: 'TOT',  kind: 'trad', highlight: true, cell: t => t.solo_tackles + t.assist_tackles },
  { key: 'solo', label: 'SOLO', kind: 'trad', cell: t => t.solo_tackles },
  { key: 'ast',  label: 'AST',  kind: 'trad', cell: t => t.assist_tackles },
  { key: 'tfl',  label: 'TFL',  kind: 'trad', cell: t => t.tackles_for_loss > 0 ? t.tackles_for_loss : null },
  { key: 'sck',  label: 'SACK', kind: 'trad', cell: t => t.sacks > 0 ? t.sacks : null },
  { key: 'int',  label: 'INT',  kind: 'trad', cell: t => t.def_interceptions > 0 ? t.def_interceptions : null },
  { key: 'pbu',  label: 'PBU',  kind: 'trad', cell: t => t.pass_breakups > 0 ? t.pass_breakups : null },
  { key: 'qbh',  label: 'QBH',  kind: 'trad', cell: t => t.qb_hits > 0 ? t.qb_hits : null },
]

const K_COLS: Col[] = [
  { key: 'g',     label: 'G',    kind: 'trad',                   cell: (_, g) => g },
  { key: 'snp',   label: 'SNP',  kind: 'snap',                   cell: (_, __, _n, sn) => sn?.st_snaps ?? null },
  { key: 'spct',  label: 'SNP%', kind: 'snap',                   cell: (_, __, _n, sn) => sn ? `${(sn.avg_st_pct ?? 0).toFixed(0)}%` : null },
  { key: 'fgm',   label: 'FG',   kind: 'trad', highlight: true,  cell: t => t.fg_att > 0 ? `${t.fg_made}/${t.fg_att}` : null },
  { key: 'fgpct', label: 'FG%',  kind: 'trad',                   cell: t => t.fg_att > 0 ? pct(t.fg_made, t.fg_att) : null },
  { key: 'xpm',   label: 'XP',   kind: 'trad',                   cell: t => t.xp_att > 0 ? `${t.xp_made}/${t.xp_att}` : null },
  { key: 'xppct', label: 'XP%',  kind: 'trad',                   cell: t => t.xp_att > 0 ? pct(t.xp_made, t.xp_att) : null },
  { key: 'pts',   label: 'PTS',  kind: 'trad',                   cell: t => (t.fg_made * 3 + t.xp_made) > 0 ? t.fg_made * 3 + t.xp_made : null },
]

const P_COLS: Col[] = [
  { key: 'g',    label: 'G',     kind: 'trad',                   cell: (_, g) => g },
  { key: 'snp',  label: 'SNP',   kind: 'snap',                   cell: (_, __, _n, sn) => sn?.st_snaps ?? null },
  { key: 'spct', label: 'SNP%',  kind: 'snap',                   cell: (_, __, _n, sn) => sn ? `${(sn.avg_st_pct ?? 0).toFixed(0)}%` : null },
  { key: 'pnt',  label: 'PUNTS', kind: 'trad', highlight: true,  cell: t => t.punts > 0 ? t.punts : null },
  { key: 'pyds', label: 'YDS',   kind: 'trad',                   cell: t => t.punts > 0 ? t.punt_yards : null },
  { key: 'pavg', label: 'AVG',   kind: 'trad',                   cell: t => t.punts > 0 ? ratio(t.punt_yards, t.punts) : null },
  { key: 'pypg', label: 'YDS/G', kind: 'trad',                   cell: (t, g) => t.punts > 0 ? ratio(t.punt_yards, g) : null },
]

const OL_COLS: Col[] = [
  { key: 'g',    label: 'G',    kind: 'trad', cell: (_, g) => g },
  { key: 'snp',  label: 'SNP',  kind: 'snap', cell: (_, __, _n, sn) => sn ? sn.offense_snaps : null },
  { key: 'spct', label: 'SNP%', kind: 'snap', cell: (_, __, _n, sn) => sn ? `${(sn.avg_offense_pct ?? 0).toFixed(0)}%` : null },
]

const OL_POSITIONS = new Set(['C', 'G', 'T', 'OT', 'OG', 'OL', 'LS', 'OC'])

function detectPos(t: Totals, position?: string | null): string {
  if (position === 'QB' || t.attempts > 10) return 'QB'
  if (position === 'RB' || (t.carries > 20 && t.targets < t.carries * 0.7)) return 'RB'
  if (position === 'WR' || position === 'TE' || t.targets > 20) return 'WR'
  if (position === 'K'  || t.fg_att > 0) return 'K'
  if (position === 'P'  || t.punts  > 0) return 'P'
  if (OL_POSITIONS.has(position ?? '')) return 'OL'
  return 'DEF'
}

// — highlights bar —
function HighlightsBar({ pos, totals, games, ngs, ranks }: {
  pos: string; totals: Totals; games: number; ngs: Record<number, NgsStats>
  ranks?: Record<string, string | null>  // map of stat label -> rank suffix
}) {
  const ngsEntries = Object.entries(ngs).sort(([a], [b]) => Number(b) - Number(a))
  const cpoeVals = ngsEntries.map(([, n]) => n.cpoe).filter((v): v is number => v != null)
  const avgCpoe = cpoeVals.length > 0 ? cpoeVals.reduce((a, b) => a + b, 0) / cpoeVals.length : null

  type Stat = { label: string; value: string | null; note?: string; green?: boolean; red?: boolean }
  let stats: Stat[] = []

  if (pos === 'QB') {
    const rate = passerRating(totals.completions, totals.attempts, totals.pass_yards, totals.pass_tds, totals.interceptions_thrown)
    const aya = totals.attempts > 0 ? (totals.pass_yards + 20 * totals.pass_tds - 45 * totals.interceptions_thrown) / totals.attempts : null
    const epaa = totals.attempts > 0 ? totals.pass_epa / totals.attempts : null
    stats = [
      { label: 'Passer Rating', value: rate },
      { label: 'AY/A', value: aya != null ? aya.toFixed(1) : null, note: 'Adj. Net Yds/Att' },
      { label: 'EPA / Att', value: epaa != null ? `${epaa >= 0 ? '+' : ''}${epaa.toFixed(3)}` : null, note: 'Exp. Points Added', green: epaa != null && epaa >= 0, red: epaa != null && epaa < 0 },
      { label: 'CPOE', value: avgCpoe != null ? `${avgCpoe >= 0 ? '+' : ''}${avgCpoe.toFixed(1)}%` : null, note: 'Cmp% Over Expected', green: avgCpoe != null && avgCpoe >= 0, red: avgCpoe != null && avgCpoe < 0 },
    ]
  } else if (pos === 'RB') {
    const epac = totals.carries > 0 ? totals.rush_epa / totals.carries : null
    const scryg = games > 0 ? (totals.rush_yards + totals.rec_yards) / games : null
    stats = [
      { label: 'Rush Yards', value: totals.rush_yards.toLocaleString() },
      { label: 'Y / Carry', value: totals.carries > 0 ? (totals.rush_yards / totals.carries).toFixed(1) : null },
      { label: 'EPA / Carry', value: epac != null ? `${epac >= 0 ? '+' : ''}${epac.toFixed(3)}` : null, note: 'Exp. Points Added', green: epac != null && epac >= 0, red: epac != null && epac < 0 },
      { label: 'SCR YDS / G', value: scryg != null ? scryg.toFixed(1) : null, note: 'Scrimmage per game' },
    ]
  } else if (pos === 'WR') {
    const epat = totals.targets > 0 ? totals.rec_epa / totals.targets : null
    stats = [
      { label: 'Rec Yards', value: totals.rec_yards.toLocaleString() },
      { label: 'Catch %', value: totals.targets > 0 ? pct(totals.receptions, totals.targets) + '%' : null },
      { label: 'EPA / Target', value: epat != null ? `${epat >= 0 ? '+' : ''}${epat.toFixed(3)}` : null, note: 'Exp. Points Added', green: epat != null && epat >= 0, red: epat != null && epat < 0 },
      { label: 'Y / Target', value: totals.targets > 0 ? (totals.rec_yards / totals.targets).toFixed(1) : null },
    ]
  } else if (pos === 'K') {
    const fgPct = totals.fg_att > 0 ? (totals.fg_made / totals.fg_att * 100).toFixed(1) : null
    const xpPct = totals.xp_att > 0 ? (totals.xp_made / totals.xp_att * 100).toFixed(1) : null
    const pts = totals.fg_made * 3 + totals.xp_made
    stats = [
      { label: 'FG Made', value: totals.fg_att > 0 ? `${totals.fg_made}/${totals.fg_att}` : null },
      { label: 'FG%', value: fgPct != null ? `${fgPct}%` : null },
      { label: 'XP Made', value: totals.xp_att > 0 ? `${totals.xp_made}/${totals.xp_att}` : null, note: xpPct != null ? `${xpPct}%` : undefined },
      { label: 'Points', value: pts > 0 ? pts.toLocaleString() : null },
    ]
  } else if (pos === 'P') {
    const avg = totals.punts > 0 ? (totals.punt_yards / totals.punts).toFixed(1) : null
    stats = [
      { label: 'Punts', value: totals.punts > 0 ? totals.punts.toString() : null },
      { label: 'Yards', value: totals.punt_yards > 0 ? totals.punt_yards.toLocaleString() : null },
      { label: 'Avg', value: avg != null ? `${avg} yds` : null, note: 'Yards per punt' },
      { label: 'Yds / G', value: games > 0 && totals.punts > 0 ? (totals.punt_yards / games).toFixed(1) : null },
    ]
  } else if (pos === 'OL') {
    stats = [
      { label: 'Games', value: games > 0 ? games.toLocaleString() : null, note: 'Career games played' },
    ]
  } else {
    const tot = totals.solo_tackles + totals.assist_tackles
    stats = [
      { label: 'Tackles', value: tot > 0 ? tot.toLocaleString() : null },
      { label: 'Sacks', value: totals.sacks > 0 ? totals.sacks.toString() : null },
      { label: 'INT', value: totals.def_interceptions > 0 ? totals.def_interceptions.toString() : null },
      { label: 'PBU', value: totals.pass_breakups > 0 ? totals.pass_breakups.toString() : null },
    ]
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
      {stats.map(s => {
        const rank = ranks?.[s.label]
        return (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className={`text-2xl font-black tabular-nums leading-none mb-1.5
              ${s.value == null ? 'text-gray-700' : s.green ? 'text-emerald-400' : s.red ? 'text-red-400' : 'text-white'}`}>
              {s.value ?? '—'}
            </div>
            <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">{s.label}</div>
            {s.note && <div className="text-xs text-gray-700 mt-0.5">{s.note}</div>}
            {rank && (
              <div className="text-[10px] text-indigo-400 mt-1 font-semibold uppercase tracking-wider">{rank}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// — situational stats cards —
function aggregateSituational(situational: Record<number, SituationalStats>): SituationalStats {
  const agg: Record<string, number> = {}
  const sumKeys: (keyof SituationalStats)[] = [
    'rz_pass_att','rz_cmp','rz_pass_tds','rz_targets','rz_rec_tds','rz_carries','rz_rush_tds',
    'third_pass_att','third_pass_fd','third_targets','third_rec_fd','third_carries','third_rush_fd',
    'fd_pass','fd_rec','fd_rush',
  ]
  for (const s of Object.values(situational)) {
    agg.lng_pass = Math.max(agg.lng_pass ?? 0, s.lng_pass ?? 0)
    agg.lng_rush = Math.max(agg.lng_rush ?? 0, s.lng_rush ?? 0)
    agg.lng_rec  = Math.max(agg.lng_rec  ?? 0, s.lng_rec  ?? 0)
    for (const k of sumKeys) agg[k] = (agg[k] ?? 0) + (s[k] ?? 0)
  }
  return agg as SituationalStats
}

// — career stats table —
function CareerTable({ seasons, bySeason, ngs, snapTotals, situational, wpa, advStats, position, onlyKinds, showGroupHeaders = true }: {
  seasons: number[]
  bySeason: Record<number, PlayerGame[]>
  ngs: Record<number, NgsStats>
  snapTotals: Record<number, SnapTotals>
  situational: Record<number, SituationalStats>
  wpa?: Record<number, PlayerWpa>
  advStats?: Record<number, PlayerAdvStats>
  position?: string | null
  onlyKinds?: ColKind[]
  showGroupHeaders?: boolean
}) {
  const allTotals = sumGames(seasons.flatMap(s => bySeason[s]))
  const pos = detectPos(allTotals, position)
  const allCols = pos === 'QB' ? QB_COLS : pos === 'RB' ? RB_COLS : pos === 'WR' ? WR_COLS : pos === 'K' ? K_COLS : pos === 'P' ? P_COLS : pos === 'OL' ? OL_COLS : DEF_COLS

  const hasNgs  = Object.keys(ngs).length > 0
  const hasSnaps = Object.keys(snapTotals).length > 0
  const hasSit  = Object.keys(situational).length > 0 && pos !== 'DEF'
  const hasWpa  = wpa != null && Object.keys(wpa).length > 0
  const cols = allCols.filter(c =>
    !(onlyKinds && !onlyKinds.includes(c.kind)) &&
    !(c.kind === 'ngs'  && !hasNgs) &&
    !(c.kind === 'snap' && !hasSnaps) &&
    !(c.kind === 'sit'  && !hasSit) &&
    !(c.wpaOnly && !hasWpa)
  )

  // Build consecutive sections for the group header row
  type Sec = { label: string; count: number; kind: ColKind; group?: string }
  const sections: Sec[] = []
  for (const c of cols) {
    const lbl = c.kind === 'trad' ? (c.group ?? '') : c.kind === 'adv' ? 'Advanced' : c.kind === 'ngs' ? 'Next Gen' : c.kind === 'snap' ? 'Snaps' : c.kind === 'sit' ? 'Situational' : ''
    const last = sections[sections.length - 1]
    if (last && last.label === lbl && last.kind === c.kind) last.count++
    else sections.push({ label: lbl, count: 1, kind: c.kind, group: c.group })
  }

  const hasAdv  = advStats != null && Object.keys(advStats).length > 0

  const careerAdvTotals: PlayerAdvStats | undefined = hasAdv ? (() => {
    const vals = seasons.map(s => advStats![s]).filter(Boolean)
    const totalFL = vals.reduce((acc, v) => acc + (v.fumbles_lost ?? 0), 0)
    const totalStuffed = vals.reduce((acc, v) => acc + (v.stuffed ?? 0), 0)
    const totalCarries = vals.reduce((acc, v) => acc + (v.carries_total ?? 0), 0)
    const tshVals = vals.map(v => v.target_share).filter((v): v is number => v != null)
    const ayshVals = vals.map(v => v.air_yards_share).filter((v): v is number => v != null)
    return {
      fumbles_lost: totalFL,
      stuffed: totalStuffed,
      carries_total: totalCarries,
      stuff_rate: totalCarries > 0 ? parseFloat((100 * totalStuffed / totalCarries).toFixed(1)) : undefined,
      target_share: tshVals.length > 0 ? parseFloat((tshVals.reduce((a, b) => a + b, 0) / tshVals.length).toFixed(1)) : undefined,
      air_yards_share: ayshVals.length > 0 ? parseFloat((ayshVals.reduce((a, b) => a + b, 0) / ayshVals.length).toFixed(1)) : undefined,
    }
  })() : undefined

  const careerWpaTotals: PlayerWpa | undefined = hasWpa ? {
    pass_wpa: seasons.reduce((acc, s) => acc + (wpa![s]?.pass_wpa ?? 0), 0),
    rush_wpa: seasons.reduce((acc, s) => acc + (wpa![s]?.rush_wpa ?? 0), 0),
    rec_wpa:  seasons.reduce((acc, s) => acc + (wpa![s]?.rec_wpa  ?? 0), 0),
  } : undefined

  const careerSit = hasSit ? aggregateSituational(situational) : undefined

  const careerT = sumGames(seasons.flatMap(s => bySeason[s]))
  const careerGames = seasons.reduce((acc, s) => acc + bySeason[s].length, 0)

  const thBase = 'py-2 px-3 text-xs font-medium whitespace-nowrap text-left'

  if (cols.length === 0) return null

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            {showGroupHeaders && (
              <tr className="border-b border-gray-800/50">
                <th colSpan={2} />
                {sections.map((s, i) => {
                  if (s.kind === 'trad' && !s.group) return <th key={i} colSpan={s.count} />
                  const cls =
                    s.kind === 'trad' && s.group === 'Passing'   ? 'text-sky-400/80 bg-sky-950/25 border-l border-sky-900/40' :
                    s.kind === 'trad' && s.group === 'Rushing'   ? 'text-orange-400/80 bg-orange-950/25 border-l border-orange-900/40' :
                    s.kind === 'trad' && s.group === 'Receiving' ? 'text-emerald-400/80 bg-emerald-950/25 border-l border-emerald-900/40' :
                    s.kind === 'adv'  ? 'text-amber-500/60 bg-amber-950/20 border-l border-gray-800/40' :
                    s.kind === 'ngs'  ? 'text-indigo-400 bg-indigo-950/25 border-l border-gray-800/40' :
                    s.kind === 'snap' ? 'text-gray-700 border-l border-gray-800/40' :
                    s.kind === 'sit'  ? 'text-teal-500/60 bg-teal-950/20 border-l border-gray-800/40' : 'text-gray-600'
                  return (
                    <th key={i} colSpan={s.count} className={`py-1 text-center text-[10px] font-semibold uppercase tracking-widest ${cls}`}>
                      {s.label}
                    </th>
                  )
                })}
              </tr>
            )}
            <tr className="border-b border-gray-800">
              <th className={`${thBase} text-gray-500 pl-4`}>Season</th>
              <th className={`${thBase} text-gray-500`}>Team</th>
              {cols.map((c, i) => {
                const sep = i > 0 && (cols[i - 1].kind !== c.kind || cols[i - 1].group !== c.group)
                const isPass = c.kind === 'trad' && c.group === 'Passing'
                const isRush = c.kind === 'trad' && c.group === 'Rushing'
                const isRec  = c.kind === 'trad' && c.group === 'Receiving'
                return (
                  <th key={c.key} className={`${thBase} ${sep ? 'border-l border-gray-800/40' : ''}
                    ${isPass ? 'text-sky-400/50 bg-sky-950/10' :
                      isRush ? 'text-orange-400/50 bg-orange-950/10' :
                      isRec  ? 'text-emerald-400/50 bg-emerald-950/10' :
                      c.kind === 'adv'  ? 'text-amber-300/50 bg-amber-950/10' :
                      c.kind === 'ngs'  ? 'text-indigo-300/50 bg-indigo-950/10' :
                      c.kind === 'snap' ? 'text-gray-700' :
                      c.kind === 'sit'  ? 'text-teal-400/50 bg-teal-950/10' : 'text-gray-500'}`}>
                    {c.label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {seasons.map(s => {
              const games = bySeason[s]
              const t = sumGames(games)
              const n = ngs[s] as NgsStats | undefined
              const sn = snapTotals[s] as SnapTotals | undefined
              const sit = situational[s] as SituationalStats | undefined
              const w = wpa?.[s] as PlayerWpa | undefined
              const a = advStats?.[s] as PlayerAdvStats | undefined
              const teams = [...new Set(games.map(g => g.team))]
              return (
                <tr key={s} className="border-t border-gray-800/60 hover:bg-gray-800/30">
                  <td className="py-2.5 pl-4 pr-3 font-bold text-white whitespace-nowrap">{s}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-1.5">
                      <div className="flex -space-x-1">
                        {teams.map(tm => (
                          <img key={tm} src={teamLogoUrl(tm)} alt={tm} className="w-5 h-5 object-contain ring-1 ring-gray-900 rounded-full bg-gray-900" />
                        ))}
                      </div>
                      <span className="text-gray-400 text-xs">{teams.join('/')}</span>
                    </div>
                  </td>
                  {cols.map((c, i) => {
                    const sep = i > 0 && (cols[i - 1].kind !== c.kind || cols[i - 1].group !== c.group)
                    const raw = c.cell(t, games.length, n, sn, sit, w, a)
                    const isNull = raw === null || raw === undefined
                    const strVal = isNull ? null : String(raw)
                    const isPos = c.signed && !isNull && strVal!.startsWith('+')
                    const isNeg = c.signed && !isNull && strVal!.startsWith('-')
                    const bgClass =
                      c.kind === 'trad' && c.group === 'Passing'   ? 'bg-sky-950/10' :
                      c.kind === 'trad' && c.group === 'Rushing'   ? 'bg-orange-950/10' :
                      c.kind === 'trad' && c.group === 'Receiving' ? 'bg-emerald-950/10' :
                      c.kind === 'adv'  ? 'bg-amber-950/10'  :
                      c.kind === 'ngs'  ? 'bg-indigo-950/10' :
                      c.kind === 'sit'  ? 'bg-teal-950/10'   :
                      ''
                    return (
                      <td key={c.key} className={`py-2.5 px-3 whitespace-nowrap tabular-nums ${bgClass}
                        ${sep ? 'border-l border-gray-800/30' : ''}
                        ${isNull   ? 'text-gray-700' :
                          isPos    ? 'text-emerald-400 font-semibold' :
                          isNeg    ? 'text-red-400 font-semibold' :
                          c.highlight ? 'text-white font-bold' :
                          c.kind === 'ngs'  ? 'text-gray-200' :
                          c.kind === 'adv'  ? 'text-amber-200/80' :
                          c.kind === 'sit'  ? 'text-teal-200/80' :
                          'text-gray-300'}`}>
                        {isNull ? '—' : strVal}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {seasons.length > 1 && (
              <tr className="border-t-2 border-gray-700 bg-gray-800/40">
                <td className="py-2.5 pl-4 pr-3 text-xs font-bold text-gray-400 uppercase tracking-wider whitespace-nowrap">Career</td>
                <td className="py-2.5 px-3 text-gray-600 text-xs">{careerGames}G</td>
                {cols.map((c, i) => {
                  const sep = i > 0 && (cols[i - 1].kind !== c.kind || cols[i - 1].group !== c.group)
                  const raw = (c.kind === 'trad' || c.kind === 'adv' || c.kind === 'sit')
                    ? c.cell(careerT, careerGames, undefined, undefined, careerSit, careerWpaTotals, careerAdvTotals)
                    : null
                  const isNull = raw === null || raw === undefined
                  const strVal = isNull ? null : String(raw)
                  const isPos = c.signed && !isNull && strVal!.startsWith('+')
                  const isNeg = c.signed && !isNull && strVal!.startsWith('-')
                  const bgClass =
                    c.kind === 'trad' && c.group === 'Passing'   ? 'bg-sky-950/10' :
                    c.kind === 'trad' && c.group === 'Rushing'   ? 'bg-orange-950/10' :
                    c.kind === 'trad' && c.group === 'Receiving' ? 'bg-emerald-950/10' :
                    c.kind === 'adv'  ? 'bg-amber-950/10'  :
                    c.kind === 'ngs'  ? 'bg-indigo-950/10' :
                    c.kind === 'sit'  ? 'bg-teal-950/10' : ''
                  return (
                    <td key={c.key} className={`py-2.5 px-3 whitespace-nowrap tabular-nums font-semibold ${bgClass}
                      ${sep ? 'border-l border-gray-800/30' : ''}
                      ${c.kind === 'ngs' ? 'text-gray-700' : ''}
                      ${isNull ? 'text-gray-700' : isPos ? 'text-emerald-400' : isNeg ? 'text-red-400' : c.highlight ? 'text-white' : c.kind === 'adv' ? 'text-amber-200/80' : c.kind === 'sit' ? 'text-teal-200/80' : 'text-gray-300'}`}>
                      {isNull ? '—' : String(raw)}
                    </td>
                  )
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <TableEraNotes seasons={seasons} cols={cols} />
    </div>
  )
}

// Footer that explains "—" cells caused by era-availability gaps. Only
// shows notes that are actually relevant to this player's seasons and
// the columns visible in the table. A young player who debuted in 2020
// sees nothing here; Brady sees explanations for NGS / EPA / Snaps.
function TableEraNotes({ seasons, cols }: { seasons: number[]; cols: Col[] }) {
  if (seasons.length === 0) return null
  const oldest = Math.min(...seasons)
  const notes: string[] = []

  const hasNgs   = cols.some(c => c.kind === 'ngs')
  const hasAdv   = cols.some(c => c.kind === 'adv' || c.wpaOnly)
  const hasSnap  = cols.some(c => c.kind === 'snap')

  if (hasNgs  && oldest < 2016) notes.push('NGS metrics (CPOE, ADOT, separation, time to throw) only tracked from 2016+')
  if (hasAdv  && oldest < 2006) notes.push('EPA-based metrics start in 2006 when the model became available')
  if (hasSnap && oldest < 2012) notes.push('Snap counts tracked from 2012+')

  if (notes.length === 0) return null

  return (
    <div className="border-t border-gray-800/60 px-4 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-[10px] font-bold text-gray-600 uppercase tracking-widest shrink-0">—</span>
      <span className="text-[11px] text-gray-500">means data unavailable for that season:</span>
      {notes.map(n => (
        <span key={n} className="text-[11px] text-gray-500">· {n}</span>
      ))}
    </div>
  )
}

// — team splits —
function TeamSplits({ seasons, bySeason, position }: {
  seasons: number[]
  bySeason: Record<number, PlayerGame[]>
  position?: string | null
}) {
  const byTeam: Record<string, PlayerGame[]> = {}
  for (const s of seasons) {
    for (const g of bySeason[s]) {
      ;(byTeam[g.team] ??= []).push(g)
    }
  }
  const teamList = Object.entries(byTeam)
  if (teamList.length <= 1) return null

  const allTotals = sumGames(seasons.flatMap(s => bySeason[s]))
  const pos = detectPos(allTotals, position)
  const colSet = pos === 'QB' ? QB_COLS : pos === 'RB' ? RB_COLS : pos === 'WR' ? WR_COLS : pos === 'K' ? K_COLS : pos === 'P' ? P_COLS : pos === 'OL' ? OL_COLS : DEF_COLS
  const cols = colSet.filter(c => c.kind === 'trad' && c.key !== 'g')

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-4">
      <div className="px-4 py-2.5 border-b border-gray-800">
        <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">Career by Team</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="py-2 pl-4 pr-3 text-xs font-medium text-gray-500 text-left whitespace-nowrap">Team</th>
              <th className="py-2 px-3 text-xs font-medium text-gray-500 text-left whitespace-nowrap">Seasons</th>
              {cols.map(c => (
                <th key={c.key} className="py-2 px-3 text-xs font-medium text-gray-500 text-left whitespace-nowrap">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teamList.map(([team, games]) => {
              const t = sumGames(games)
              const teamSeasons = [...new Set(games.map(g => g.season))].sort()
              const label = teamSeasons.length === 1
                ? `${teamSeasons[0]} · ${games.length}G`
                : `${teamSeasons[0]}–${teamSeasons[teamSeasons.length - 1]} · ${games.length}G`
              return (
                <tr key={team} className="border-t border-gray-800/60 hover:bg-gray-800/30">
                  <td className="py-2.5 pl-4 pr-3">
                    <Link to={`/teams/${team}`} className="flex items-center gap-2 group w-fit">
                      <img src={teamLogoUrl(team)} className="w-5 h-5 object-contain opacity-80 group-hover:opacity-100" alt="" />
                      <span className="text-sm font-bold text-gray-300 group-hover:text-white transition-colors">{team}</span>
                    </Link>
                  </td>
                  <td className="py-2.5 px-3 text-xs text-gray-500 whitespace-nowrap">{label}</td>
                  {cols.map(c => {
                    const raw = c.cell(t, games.length)
                    const isNull = raw === null || raw === undefined
                    return (
                      <td key={c.key} className={`py-2.5 px-3 whitespace-nowrap tabular-nums text-sm ${isNull ? 'text-gray-700' : c.highlight ? 'text-white font-bold' : 'text-gray-300'}`}>
                        {isNull ? '—' : String(raw)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// — game log —
function resultBadge(result: PlayerGame['result']) {
  if (!result) return <span className="text-gray-600 text-xs font-bold">—</span>
  const cls = { W: 'text-green-400', L: 'text-red-400', T: 'text-gray-400' }
  return <span className={`text-xs font-bold ${cls[result]}`}>{result}</span>
}

type GameCol = { label: string; cell: (g: PlayerGame) => string | number | null; highlight?: boolean }

function getGameCols(pos: string): GameCol[] {
  if (pos === 'QB') return [
    { label: 'C/ATT', cell: g => g.attempts > 0 ? `${g.completions}/${g.attempts}` : null },
    { label: 'YDS',   cell: g => g.attempts > 0 ? g.pass_yards : null, highlight: true },
    { label: 'TD',    cell: g => g.attempts > 0 ? g.pass_tds : null },
    { label: 'INT',   cell: g => g.attempts > 0 ? g.interceptions_thrown : null },
    { label: 'RATE',  cell: g => g.attempts > 0 ? passerRating(g.completions, g.attempts, g.pass_yards, g.pass_tds, g.interceptions_thrown) : null },
    { label: 'EPA',   cell: g => g.attempts > 0 ? sfmt(g.pass_epa, 1) : null },
  ]
  if (pos === 'RB') return [
    { label: 'CAR',     cell: g => g.carries > 0 ? g.carries : null },
    { label: 'YDS',     cell: g => g.rush_yards, highlight: true },
    { label: 'Y/C',     cell: g => g.carries > 0 ? ratio(g.rush_yards, g.carries) : null },
    { label: 'TD',      cell: g => g.rush_tds > 0 ? g.rush_tds : null },
    { label: 'TGT',     cell: g => g.targets > 0 ? g.targets : null },
    { label: 'REC',     cell: g => g.targets > 0 ? g.receptions : null },
    { label: 'REC YDS', cell: g => g.receptions > 0 ? g.rec_yards : null },
    { label: 'EPA',     cell: g => sfmt(g.rush_epa, 1) },
  ]
  if (pos === 'WR' || pos === 'TE') return [
    { label: 'TGT', cell: g => g.targets },
    { label: 'REC', cell: g => g.receptions },
    { label: 'YDS', cell: g => g.rec_yards, highlight: true },
    { label: 'Y/R', cell: g => g.receptions > 0 ? ratio(g.rec_yards, g.receptions) : null },
    { label: 'TD',  cell: g => g.rec_tds > 0 ? g.rec_tds : null },
    { label: 'EPA', cell: g => sfmt(g.rec_epa, 1) },
  ]
  if (pos === 'K') return [
    { label: 'FG',   cell: g => g.fg_att > 0 ? `${g.fg_made}/${g.fg_att}` : null, highlight: true },
    { label: 'FG%',  cell: g => g.fg_att > 0 ? pct(g.fg_made, g.fg_att) : null },
    { label: 'XP',   cell: g => g.xp_att > 0 ? `${g.xp_made}/${g.xp_att}` : null },
    { label: 'PTS',  cell: g => (g.fg_made * 3 + g.xp_made) > 0 ? g.fg_made * 3 + g.xp_made : null },
  ]
  if (pos === 'P') return [
    { label: 'PUNTS', cell: g => g.punts > 0 ? g.punts : null, highlight: true },
    { label: 'YDS',   cell: g => g.punts > 0 ? g.punt_yards : null },
    { label: 'AVG',   cell: g => g.punts > 0 ? ratio(g.punt_yards, g.punts) : null },
  ]
  if (pos === 'OL') return []
  return [
    { label: 'TOT',  cell: g => g.solo_tackles + g.assist_tackles, highlight: true },
    { label: 'SOLO', cell: g => g.solo_tackles },
    { label: 'AST',  cell: g => g.assist_tackles },
    { label: 'SACK', cell: g => g.sacks > 0 ? g.sacks : null },
    { label: 'INT',  cell: g => g.def_interceptions > 0 ? g.def_interceptions : null },
    { label: 'PBU',  cell: g => g.pass_breakups > 0 ? g.pass_breakups : null },
  ]
}

function GameLog({ season, games, pos, playerId, playerName, fromGame, defaultOpen = false }: {
  season: number; games: PlayerGame[]; pos: string
  playerId: string; playerName: string; fromGame?: any; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const seasonTeams = [...new Set(games.map(g => g.team))]
  const wins = games.filter(g => g.result === 'W').length
  const losses = games.filter(g => g.result === 'L').length
  const ties = games.filter(g => g.result === 'T').length
  const record = ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`
  const gameCols = getGameCols(pos)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-gray-800/50 transition-colors text-left"
      >
        <div className="flex -space-x-1.5">
          {seasonTeams.map(t => (
            <img key={t} src={teamLogoUrl(t)} alt={t} className="w-6 h-6 object-contain ring-1 ring-gray-900 rounded-full bg-gray-900" />
          ))}
        </div>
        <span className="font-semibold text-white">{season}</span>
        <span className="text-gray-500 text-xs">{seasonTeams.join('/')} · {record} · {games.length}G</span>
        <span className="ml-auto text-gray-600 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="py-2 px-4 text-xs font-medium text-gray-600 text-left">Wk</th>
                <th className="py-2 px-4 text-xs font-medium text-gray-600 text-left">Opponent</th>
                <th className="py-2 px-4 text-xs font-medium text-gray-600 text-left">Result</th>
                {gameCols.map(c => (
                  <th key={c.label} className="py-2 px-4 text-xs font-medium text-gray-600 text-left">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {games.map(g => {
                const score = g.away_score !== null ? `${g.away_score}–${g.home_score}` : null
                return (
                  <tr key={g.game_id} className="border-t border-gray-800/60 hover:bg-gray-800/40">
                    <td className="py-2 px-4 text-xs tabular-nums whitespace-nowrap">
                      {g.game_type === 'REG'
                        ? <span className="text-gray-500">Wk {g.week}</span>
                        : <span className="text-amber-500 font-bold">{g.game_type}</span>
                      }
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex items-center gap-1.5">
                        <img src={teamLogoUrl(g.opponent)} alt={g.opponent} className="w-5 h-5 object-contain opacity-60" />
                        <Link
                          to={`/games/${g.game_id}`}
                          state={{ fromPlayer: { playerId, playerName, fromGame } }}
                          className="text-indigo-400 hover:underline text-sm"
                        >
                          {g.location === 'away' ? '@' : 'vs'} {g.opponent}
                        </Link>
                      </div>
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex items-center gap-1.5">
                        {resultBadge(g.result)}
                        {score && <span className="text-gray-600 text-xs">{score}</span>}
                      </div>
                    </td>
                    {gameCols.map(c => {
                      const val = c.cell(g)
                      const isNull = val === null || val === undefined
                      const strVal = isNull ? null : String(val)
                      const isSigned = c.label === 'EPA'
                      const isPos = isSigned && strVal?.startsWith('+')
                      const isNeg = isSigned && strVal?.startsWith('-')
                      return (
                        <td key={c.label} className={`py-2 px-4 tabular-nums text-sm whitespace-nowrap
                          ${isNull ? 'text-gray-700' : isPos ? 'text-emerald-400' : isNeg ? 'text-red-400' : c.highlight ? 'text-white font-semibold' : 'text-gray-300'}`}>
                          {isNull ? '—' : strVal}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// — comparables —
function simColor(s: number) {
  if (s >= 95) return 'text-emerald-400'
  if (s >= 88) return 'text-green-400'
  if (s >= 80) return 'text-yellow-400'
  return 'text-gray-500'
}

function simBar(s: number) {
  if (s >= 95) return 'bg-emerald-500'
  if (s >= 88) return 'bg-green-500'
  if (s >= 80) return 'bg-yellow-500'
  return 'bg-gray-600'
}

function ComparableCard({ p, pos }: { p: PlayerComparable; pos: string }) {
  const era = p.first_season === p.last_season ? `${p.first_season}` : `${p.first_season}–${p.last_season}`
  let statLine = ''
  if (pos === 'QB') {
    const ypa = p.att > 0 ? (p.pass_yards / p.att).toFixed(1) : '—'
    statLine = `${p.pass_yards.toLocaleString()} YDS · ${p.pass_tds} TD · ${p.ints} INT · ${ypa} Y/A`
  } else if (pos === 'RB') {
    const ypc = p.carries > 0 ? (p.rush_yards / p.carries).toFixed(1) : '—'
    statLine = `${p.rush_yards.toLocaleString()} YDS · ${p.rush_tds} TD · ${ypc} Y/C`
  } else if (pos === 'WR') {
    statLine = `${p.rec_yards.toLocaleString()} YDS · ${p.rec_tds} TD · ${p.targets} TGT`
  } else {
    statLine = `${p.games}G · ${p.first_season}–${p.last_season}`
  }

  return (
    <Link to={`/players/${p.player_id}`} className="block bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 hover:bg-gray-800/60 transition-all group">
      <div className="flex items-start gap-3 mb-3">
        {p.headshot_url
          ? <img src={p.headshot_url} className="w-12 h-12 rounded-full object-cover object-top bg-gray-800 shrink-0" alt="" />
          : <div className="w-12 h-12 rounded-full bg-gray-800 shrink-0" />
        }
        <div className="min-w-0 flex-1">
          <div className="font-bold text-white text-sm leading-tight group-hover:text-indigo-400 transition-colors truncate">{p.player_name}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-gray-500 font-medium">{p.position ?? '—'}</span>
            {p.team && (
              <>
                <span className="text-gray-700">·</span>
                <img src={teamLogoUrl(p.team)} className="w-4 h-4 object-contain opacity-70" alt="" />
                <span className="text-xs text-gray-500">{p.team}</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-600 mt-0.5">{era} · {p.games}G</div>
        </div>
      </div>

      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-gray-600 uppercase tracking-wider">Similarity</span>
          <span className={`text-sm font-black tabular-nums ${simColor(p.similarity)}`}>{p.similarity}%</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${simBar(p.similarity)}`} style={{ width: `${p.similarity}%` }} />
        </div>
      </div>

      <div className="text-[11px] text-gray-500 leading-relaxed">{statLine}</div>
    </Link>
  )
}

function ComparablesSection({ playerId, pos }: { playerId: string; pos: string }) {
  const { data: comps = [], isPending: loading } = usePlayerComparables(playerId)

  if (loading) return (
    <div className="mt-8">
      <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Similar Players</div>
      <p className="text-xs text-gray-600 pl-1">Computing comparables…</p>
    </div>
  )
  if (comps.length === 0) return null

  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">Similar Players</span>
        <span className="text-xs text-gray-700">Cosine similarity on career rate stats · same position group</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {comps.map(p => <ComparableCard key={p.player_id} p={p} pos={pos} />)}
      </div>
    </div>
  )
}

// — status strip: depth role + most-recent injury report —

function injuryToneClasses(status: string | null | undefined): string {
  switch (status) {
    case 'Out':           return 'bg-rose-950/60 border-rose-800 text-rose-300'
    case 'Doubtful':      return 'bg-orange-950/60 border-orange-800 text-orange-300'
    case 'Questionable':  return 'bg-amber-950/60 border-amber-800 text-amber-300'
    case 'Probable':      return 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
    default:              return 'bg-gray-900 border-gray-800 text-gray-400'
  }
}

function StatusStrip({ depth, injury }: {
  depth: DepthChartEntry | null
  injury: InjuryStatus | null
}) {
  // StatusStrip is intended as "what's going on with this player RIGHT NOW".
  // For retired players, the most-recent depth and injury entries are
  // years old and showing them as "Starting QB" / "Out" is misleading. Drop
  // any data not from the current NFL season — if nothing survives, the
  // strip doesn't render at all (correct behavior for retired players).
  const depthCurrent  = depth  && depth.season  === CURRENT_NFL_SEASON ? depth  : null
  const injuryCurrent = injury && injury.season === CURRENT_NFL_SEASON ? injury : null

  if (!depthCurrent && !injuryCurrent) return null

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {depthCurrent && depthCurrent.depth_position && depthCurrent.depth_team === '1' && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider bg-emerald-950/50 border border-emerald-800 text-emerald-300">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Starting {depthCurrent.depth_position}
        </span>
      )}
      {depthCurrent && depthCurrent.depth_position && depthCurrent.depth_team !== '1' && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider bg-gray-900 border border-gray-800 text-gray-400">
          {depthCurrent.depth_position} · {depthCurrent.depth_team === '2' ? 'Backup' : `Depth ${depthCurrent.depth_team}`}
        </span>
      )}
      {injuryCurrent && injuryCurrent.report_status && (
        <span
          title={[injuryCurrent.report_primary_injury, injuryCurrent.report_secondary_injury].filter(Boolean).join(' / ')}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider border ${injuryToneClasses(injuryCurrent.report_status)}`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {injuryCurrent.report_status}
          {injuryCurrent.report_primary_injury && (
            <span className="font-normal normal-case opacity-80">· {injuryCurrent.report_primary_injury}</span>
          )}
        </span>
      )}
    </div>
  )
}

// — background card: draft + combine + PFR career achievements —

function combineHasAny(c: CombineData | null): boolean {
  if (!c) return false
  return c.forty != null || c.vertical != null || c.bench != null
      || c.broad_jump != null || c.cone != null || c.shuttle != null
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

function BigStat({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{label}</span>
      <span className="text-2xl font-black text-white tabular-nums leading-tight mt-0.5">{value}</span>
      {sub && <span className="text-[10px] text-gray-600 uppercase tracking-wider mt-0.5">{sub}</span>}
    </div>
  )
}

function EmptyCardBody({ headline, sub }: { headline: string; sub?: string }) {
  // Shared empty-state styling so the three cards visually agree. The
  // headline reads as the "answer" (e.g. "Undrafted", "No accolades")
  // and the sub-line explains why or what era it's about.
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center py-4">
      <div className="text-xl font-black text-gray-500 leading-none">{headline}</div>
      {sub && <div className="mt-2 text-[10px] text-gray-700 uppercase tracking-wider max-w-[80%]">{sub}</div>}
    </div>
  )
}

function DraftCardContent({ player }: { player: PlayerProfile }) {
  const draft = player.draft

  // Filled state: full draft hero
  if (draft) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-1">Drafted</div>
          <div className="text-3xl font-black text-white leading-none">
            {ordinal(draft.round)} <span className="text-indigo-300">Round</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-5xl font-black text-white tabular-nums leading-none">#{draft.pick}</span>
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">overall · {draft.season}</span>
          </div>
          {draft.college && (
            <div className="mt-3 text-xs text-gray-400">
              <span className="text-gray-600 uppercase tracking-wider text-[10px] font-bold">College</span>
              <span className="ml-2 text-gray-200 font-semibold">{draft.college}</span>
            </div>
          )}
        </div>
        <Link
          to={`/teams/${draft.team}`}
          className="shrink-0 flex flex-col items-center gap-1 hover:opacity-90 transition-opacity"
          title={`Drafted by ${teamName(draft.team)}`}
        >
          <img src={teamLogoUrl(draft.team)} className="w-16 h-16 object-contain" alt="" />
          <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{draft.team}</span>
        </Link>
      </div>
    )
  }

  // Empty state: figure out which kind of empty.
  // Pre-1980 → era explanation. Otherwise → Undrafted (UDFA).
  const entryYear = player.entry_year
  const isPre1980 = entryYear != null && entryYear < 1980
  const headline = isPre1980 ? 'Pre-1980' : 'Undrafted'
  const sub = isPre1980
    ? 'Draft data not tracked before 1980'
    : entryYear != null ? `Entered the league in ${entryYear}` : 'Signed as a free agent'

  return (
    <>
      <div className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-3">Drafted</div>
      <EmptyCardBody headline={headline} sub={sub} />
    </>
  )
}

function CareerCardContent({ player }: { player: PlayerProfile }) {
  const draft = player.draft
  const career: Array<{ label: string; value: string }> = []

  // PFR-sourced fields (Pro Bowls, All-Pros, weighted career AV) only exist
  // for drafted players — the upstream draft_picks dataset is keyed on the
  // draft. UDFAs (Romo, Kurt Warner, Wes Welker) won't have these.
  if (draft) {
    if (draft.car_av   != null && draft.car_av   > 0) career.push({ label: 'AV',         value: String(Math.round(draft.car_av)) })
    if (draft.probowls != null && draft.probowls > 0) career.push({ label: 'Pro Bowls', value: String(draft.probowls) })
    if (draft.allpro   != null && draft.allpro   > 0) career.push({ label: 'All-Pro',   value: String(draft.allpro) })
  }

  // Games played: prefer PFR's count, fall back to our own ingest count so
  // UDFAs and any player missing from draft_picks still get a Games tile.
  const games = (draft?.games != null && draft.games > 0) ? draft.games : player.games_played
  if (games > 0) career.push({ label: 'Games', value: String(games) })

  // Major awards (MVP, OPOY, DPOY, OROY, DROY, CPOY) sourced from the
  // PAST_AWARDS ground-truth table. Lives in the same card so a player's
  // honors are one logical block: stat tiles + award badges.
  const awards = getPlayerAwards(player.player_name)

  const hasContent = career.length > 0 || awards.length > 0

  return (
    <>
      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Career Achievements</div>
      {hasContent ? (
        <div className="flex flex-col gap-3">
          {career.length > 0 && (
            <div className={`grid gap-3 ${career.length >= 3 ? 'grid-cols-4' : 'grid-cols-2'}`}>
              {career.map(c => <BigStat key={c.label} label={c.label} value={c.value} />)}
            </div>
          )}
          {awards.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {awards.map(a => <AwardBadge key={`${a.season}-${a.award}`} season={a.season} award={a.award} />)}
            </div>
          )}
        </div>
      ) : (
        <EmptyCardBody headline="—" sub="No accolades on record" />
      )}
    </>
  )
}

function CombineCardContent({ player }: { player: PlayerProfile }) {
  const combine = player.combine
  const hasAny = combineHasAny(combine)
  const entryYear = player.entry_year
  const isPre2000 = entryYear != null && entryYear < 2000

  return (
    <>
      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Combine</div>
      {hasAny && combine ? (
        <div className="grid grid-cols-3 gap-3">
          {combine.forty      != null && <BigStat label="40 yd"   value={combine.forty.toFixed(2)} sub="seconds" />}
          {combine.vertical   != null && <BigStat label="Vert"    value={`${combine.vertical}″`} />}
          {combine.bench      != null && <BigStat label="Bench"   value={String(combine.bench)} sub="reps" />}
          {combine.broad_jump != null && <BigStat label="Broad"   value={`${combine.broad_jump}″`} />}
          {combine.cone       != null && <BigStat label="3-cone"  value={combine.cone.toFixed(2)} sub="seconds" />}
          {combine.shuttle    != null && <BigStat label="Shuttle" value={combine.shuttle.toFixed(2)} sub="seconds" />}
        </div>
      ) : (
        <EmptyCardBody
          headline="—"
          sub={isPre2000 ? 'Combine data not tracked before 2000' : 'Did not participate / unavailable'}
        />
      )}
    </>
  )
}

function BackgroundCard({ player }: { player: PlayerProfile }) {
  // Always render the same three-card grid skeleton so the PlayerPage layout
  // is identical for every player. Each card shows its filled state when
  // data exists, and a tidy empty state with an explanation otherwise.
  return (
    <div className="mb-6 grid gap-3 grid-cols-1 md:grid-cols-3">
      <div className="relative overflow-hidden bg-gradient-to-br from-indigo-950/40 via-gray-900 to-gray-900 border border-indigo-900/60 rounded-xl p-5 flex flex-col min-h-[180px]">
        <DraftCardContent player={player} />
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col min-h-[180px]">
        <CareerCardContent player={player} />
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col min-h-[180px]">
        <CombineCardContent player={player} />
      </div>
    </div>
  )
}

// — page —
export default function PlayerPage() {
  const { playerId } = useParams<{ playerId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const fromGame = (location.state as any)?.fromGame
  const qc = useQueryClient()

  const statsRef = useRef<HTMLDivElement>(null)
  const advRef   = useRef<HTMLDivElement>(null)
  const postRef  = useRef<HTMLDivElement>(null)
  const logRef   = useRef<HTMLDivElement>(null)
  const compRef  = useRef<HTMLDivElement>(null)
  function scrollTo(ref: { current: HTMLDivElement | null | undefined }) {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const { data: player, isPending: loading } = usePlayer(playerId)

  // Poll seasons while any ingest is in-flight so the UI updates as
  // seasons finish loading. TanStack handles dedup + cancellation.
  const { data: seasonsList = [] } = useSeasons({
    refetchInterval: (q): number | false => {
      const d = q.state.data
      return d?.some(s => s.status === 'loading' || s.status === 'queued') ? 4000 : false
    },
  })
  const seasonMap = useMemo(
    () => Object.fromEntries(seasonsList.map(s => [s.season, s.status])) as Record<number, string>,
    [seasonsList],
  )

  // Most recent regular season the player appears in -> drives the "5th in NFL" context
  const recentSeason = useMemo(() => {
    if (!player) return null
    const regSeasons = [...new Set(player.games.filter(g => g.game_type === 'REG').map(g => g.season))]
    return regSeasons.length === 0 ? null : Math.max(...regSeasons)
  }, [player])

  const { data: recentLeadersData } = useLeaders(recentSeason)
  const recentLeaders: { season: number; leaders: LeagueLeader[] } | null =
    recentSeason != null && recentLeadersData ? { season: recentSeason, leaders: recentLeadersData } : null

  // Fire-and-forget: queue any seasons we don't yet have for this player.
  // The seasons poll above picks up the status changes; when newly-finished
  // seasons would affect this player, we invalidate their query.
  useEffect(() => {
    if (!player || !player.entry_year) return
    const loadedForPlayer = new Set(player.games.map(g => g.season))
    for (let y = CURRENT_NFL_SEASON; y >= player.entry_year; y--) {
      if (!loadedForPlayer.has(y) && seasonMap[y] === 'available') {
        api.loadSeason(y)
      }
    }
  }, [player?.player_id, player?.entry_year, seasonMap])

  useEffect(() => {
    if (!player) return
    const loadedForPlayer = new Set(player.games.map(g => g.season))
    const newlyDone = seasonsList.some(
      s => s.status === 'loaded' && !loadedForPlayer.has(s.season) && s.season >= (player.entry_year ?? 0),
    )
    if (newlyDone) qc.invalidateQueries({ queryKey: ['player', playerId] })
  }, [seasonsList, player, playerId, qc])

  if (loading) return <div className="min-h-screen bg-gray-950"><Nav /><p className="p-8 text-gray-500">Loading...</p></div>
  if (!player) return <div className="min-h-screen bg-gray-950"><Nav /><p className="p-8 text-gray-500">Player not found.</p></div>

  const regGames     = player.games.filter(g => g.game_type === 'REG')
  const playoffGames = player.games.filter(g => g.game_type !== 'REG')

  const regBySeason = regGames.reduce<Record<number, PlayerGame[]>>((acc, g) => {
    ;(acc[g.season] ??= []).push(g)
    return acc
  }, {})
  const playoffBySeason = playoffGames.reduce<Record<number, PlayerGame[]>>((acc, g) => {
    ;(acc[g.season] ??= []).push(g)
    return acc
  }, {})

  // All games per season for the game log (reg + playoffs together, ordered by week)
  const allBySeason = player.games.reduce<Record<number, PlayerGame[]>>((acc, g) => {
    ;(acc[g.season] ??= []).push(g)
    return acc
  }, {})

  const seasons        = Object.keys(regBySeason).map(Number).sort((a, b) => b - a)
  const playoffSeasons = Object.keys(playoffBySeason).map(Number).sort((a, b) => b - a)
  const allSeasons     = [...new Set([...seasons, ...playoffSeasons])].sort((a, b) => b - a)

  const recentGames = allSeasons.length > 0 ? allBySeason[allSeasons[0]] : []
  const recentTeams = [...new Set(recentGames.map(g => g.team))]

  // Highlights bar and career table use regular season only
  const allTotals   = seasons.length > 0 ? sumGames(seasons.flatMap(s => regBySeason[s])) : sumGames([])
  const careerGames = seasons.reduce((acc, s) => acc + regBySeason[s].length, 0)
  const playerPos   = detectPos(allTotals, player.position)
  const hasAdvanced = ['QB', 'RB', 'WR'].includes(playerPos)

  // (Career awards are now rendered inside BackgroundCard / CareerCardContent
  //  using getPlayerAwards(player.player_name).)

  // League ranks for the most recent regular season (computed once leaders load)
  const ranks: Record<string, string | null> = recentLeaders
    ? computeHighlightRanks(playerPos, player.player_id, recentLeaders.leaders, recentLeaders.season)
    : {}

  const careerInFlight = player.entry_year != null
    ? Object.entries(seasonMap).some(([y, s]) => Number(y) >= player.entry_year! && (s === 'loading' || s === 'queued'))
    : false

  const PLAYOFF_WEEKS: Record<number, string> = { 19: 'Wild Card', 20: 'Divisional', 21: 'Conference', 22: 'Super Bowl' }
  const wkLabel = (w: number) => PLAYOFF_WEEKS[w] ?? `Week ${w}`

  const crumbs: Crumb[] = []
  if (fromGame) {
    if (fromGame.fromWeek !== undefined) {
      crumbs.push({ label: wkLabel(fromGame.fromWeek), to: `/?season=${fromGame.season}&week=${fromGame.fromWeek}` })
    }
    crumbs.push({
      label: `${fromGame.awayTeam} @ ${fromGame.homeTeam}`,
      to: `/games/${fromGame.gameId}`,
      state: { fromWeek: fromGame.fromWeek },
    })
  }
  crumbs.push({ label: player.player_name })

  return (
    <div className="min-h-screen bg-gray-950">
      <Nav crumbs={crumbs} />
      <div className="max-w-6xl mx-auto px-4 py-8">
        <button onClick={() => navigate(-1)} className={`${backBtnCls} mb-6`}>← Back</button>

        {/* Profile header */}
        <div className="flex items-start gap-6 mb-8 flex-wrap">
          {player.headshot_url
            ? <img src={player.headshot_url} alt={player.player_name} className="w-24 h-24 rounded-full object-cover bg-gray-800 shrink-0 object-top ring-2 ring-gray-800" />
            : <div className="w-24 h-24 rounded-full bg-gray-800 shrink-0" />
          }
          <div className="flex-1 min-w-0">
            {(player.position || player.jersey_number != null) && (
              <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                {player.position && <span>{player.position}</span>}
                {player.jersey_number != null && (
                  <>
                    {player.position && <span className="text-gray-700">·</span>}
                    <span className="text-gray-600">#{player.jersey_number}</span>
                  </>
                )}
              </div>
            )}
            <h1 className="text-4xl font-black text-white tracking-tight leading-none mt-1">{player.player_name}</h1>

            {/* Team chips — prominent and clearly clickable */}
            {recentTeams.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {recentTeams.map(t => (
                  <Link
                    key={t}
                    to={`/teams/${t}`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-900 hover:bg-gray-800 border border-gray-800 hover:border-indigo-500 rounded-lg transition-colors group"
                  >
                    <img src={teamLogoUrl(t)} className="w-5 h-5 object-contain" alt="" />
                    <span className="text-sm font-bold text-white">{t}</span>
                    <span className="text-xs text-gray-400 group-hover:text-gray-200 transition-colors">{teamName(t)}</span>
                    <span className="text-indigo-400 text-xs">→</span>
                  </Link>
                ))}
              </div>
            )}

            {/* Status strip: starting role + injury report (current or historical) */}
            <StatusStrip
              depth={player.depth ?? null}
              injury={player.current_injury ?? null}
            />

            {/* Bio */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-xs text-gray-600">
              {player.height && <span>{player.height}</span>}
              {player.weight && <span>{player.weight} lbs</span>}
              {player.age && <span>Age {player.age}</span>}
              {player.college && <span>{player.college}</span>}
              {player.entry_year && <span>Since {player.entry_year}</span>}
            </div>
          </div>
        </div>

        {/* Background: draft pick + career achievements + combine.
            Always renders the same 3-card grid so the layout never shifts;
            each card has a filled and empty state. */}
        <BackgroundCard player={player} />

        {/* Highlights bar — regular season only */}
        {seasons.length > 0 && (
          <HighlightsBar
            pos={playerPos}
            totals={allTotals}
            games={careerGames}
            ngs={player.ngs ?? {}}
            ranks={ranks}
          />
        )}

        {/* Career trajectory chart — primary stat by season */}
        {seasons.length > 1 && (
          <CareerTrajectory seasons={seasons} bySeason={regBySeason} pos={playerPos} />
        )}

        {/* Sticky section nav */}
        {seasons.length > 0 && (
          <div className="sticky top-0 z-20 -mx-4 px-4 py-2 bg-gray-950/95 backdrop-blur border-b border-gray-800/60 mb-6 flex gap-1">
            <button onClick={() => scrollTo(statsRef)} className="px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors">Stats</button>
            {hasAdvanced && <button onClick={() => scrollTo(advRef)} className="px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors">Advanced</button>}
            {playoffSeasons.length > 0 && <button onClick={() => scrollTo(postRef)} className="px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors">Postseason</button>}
            <button onClick={() => scrollTo(logRef)} className="px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors">Game Log</button>
            <button onClick={() => scrollTo(compRef)} className="px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors">Comparables</button>
          </div>
        )}

        {/* Regular season — main stats */}
        <div ref={statsRef} className="scroll-mt-12 text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">
          Regular Season
        </div>
        <CareerTable
          seasons={seasons}
          bySeason={regBySeason}
          ngs={player.ngs ?? {}}
          snapTotals={player.snap_totals ?? {}}
          situational={player.situational ?? {}}
          wpa={player.wpa ?? {}}
          advStats={player.adv_stats ?? {}}
          position={player.position}
          onlyKinds={['trad', 'snap']}
          showGroupHeaders={true}
        />
        {careerInFlight && (
          <p className="text-xs text-gray-600 -mt-2 mb-4 pl-1 flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
            Loading historical seasons — stats will update automatically.
          </p>
        )}

        {/* Regular season — advanced stats */}
        {hasAdvanced && seasons.length > 0 && (
          <>
            <div ref={advRef} className="scroll-mt-12 text-xs font-bold text-gray-500 uppercase tracking-widest mb-3 mt-2">
              Advanced Stats
            </div>
            <CareerTable
              seasons={seasons}
              bySeason={regBySeason}
              ngs={player.ngs ?? {}}
              snapTotals={player.snap_totals ?? {}}
              situational={player.situational ?? {}}
              wpa={player.wpa ?? {}}
              advStats={player.adv_stats ?? {}}
              position={player.position}
              onlyKinds={['adv', 'ngs', 'sit']}
            />
          </>
        )}

        {/* Postseason stats */}
        {playoffSeasons.length > 0 && (
          <>
            <div ref={postRef} className="scroll-mt-12 text-xs font-bold text-gray-500 uppercase tracking-widest mb-3 mt-6 flex items-center gap-2">
              Postseason
              <span className="text-gray-700 font-normal normal-case tracking-normal text-xs">
                ({playoffGames.length} game{playoffGames.length !== 1 ? 's' : ''})
              </span>
            </div>
            <CareerTable
              seasons={playoffSeasons}
              bySeason={playoffBySeason}
              ngs={{}}
              snapTotals={player.snap_totals ?? {}}
              situational={{}}
              position={player.position}
              onlyKinds={['trad', 'snap', 'adv']}
              showGroupHeaders={false}
            />

          </>
        )}

        {/* Team splits — regular season only */}
        <TeamSplits seasons={seasons} bySeason={regBySeason} position={player.position} />

        {/* Game log — all games, playoff games show their round label */}
        <div ref={logRef} className="scroll-mt-12 text-xs font-bold text-gray-500 uppercase tracking-widest mb-3 mt-2">Game Log</div>
        <div className="space-y-2">
          {allSeasons.map((s, i) => (
            <GameLog
              key={s}
              season={s}
              games={allBySeason[s]}
              pos={playerPos}
              playerId={player.player_id}
              playerName={player.player_name}
              fromGame={fromGame}
              defaultOpen={i === 0}
            />
          ))}
        </div>

        {/* Similar players */}
        {seasons.length > 0 && (
          <div ref={compRef} className="scroll-mt-12">
            <ComparablesSection playerId={player.player_id} pos={playerPos} />
          </div>
        )}

      </div>
    </div>
  )
}
