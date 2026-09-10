import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { AreaChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceArea, ResponsiveContainer, CartesianGrid } from 'recharts'
import { api } from '../api'
import type { GameDetail, GameLineup, PlayerStats, WeekGroup, WinProbPlay } from '../api'
import Nav from '../components/Nav'
import GameLineupView, { GameRail, GameScorers, LINEUP_CSS } from '../components/GameLineupView'
import Card from '../components/Card'
import LiveGameCard from '../components/LiveGameCard'
import { LiveScoresProvider, useLiveGame } from '../hooks/useLiveScores'
import type { LiveGameOut } from '../types'
import { teamLogoUrl, teamName, teamPrimaryColor } from '../utils/teams'

interface GameCtx { gameId: string; season: number; week: number; awayTeam: string; homeTeam: string; fromWeek?: number }
const GameContext = createContext<GameCtx | null>(null)

function playerLink(playerId: string, ctx: GameCtx | null) {
  if (!ctx) return { to: `/players/${playerId}`, state: undefined }
  return { to: `/players/${playerId}`, state: { fromGame: ctx } }
}

const WEEK_LABELS: Record<number, string> = { 19: 'Wild Card', 20: 'Divisional', 21: 'Conference', 22: 'Super Bowl' }
type GameTab = 'overview' | 'lineup' | 'stats' | 'plays'
function weekLabel(w: number) { return WEEK_LABELS[w] ?? `Week ${w}` }
function sv(n: number) { return n === 0 ? '—' : n % 1 === 0 ? String(n) : n.toFixed(1) }
function ypa(y: number, a: number) { return a === 0 ? '—' : (y / a).toFixed(1) }

// ── Card 1: Scoreboard ────────────────────────────────────────────────────────

function formatGameday(s: string | null) {
  if (!s) return 'TBD'
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Card 2: Team stats (away | label | home) ──────────────────────────────────

function GameHeader({ game, lineup, tab, onTab, live }: { game: GameDetail; lineup: GameLineup | null; tab: GameTab; onTab: (tab: GameTab) => void; live?: LiveGameOut | null }) {
  const isLive = live?.state === 'in'
  const dbFinal = game.away_score != null && game.home_score != null
  // Between the final whistle and the next ingest — hours, every game day — the
  // database has no score but the live source does. Without this the page calls
  // a finished game Upcoming.
  const awayScore = dbFinal ? game.away_score : live?.away_score ?? null
  const homeScore = dbFinal ? game.home_score : live?.home_score ?? null
  const final = !isLive && (dbFinal || live?.state === 'post')
  const charted = game.away.length > 0 || game.home.length > 0
  const awayWon = final && awayScore != null && homeScore != null && awayScore > homeScore
  const homeWon = final && awayScore != null && homeScore != null && homeScore > awayScore
  return <Card className="mb-5">
    <div className={`flex items-center gap-4 border-b border-surface-line px-4 py-3 ${game.game_type === 'SB' ? 'bg-gradient-to-r from-gold/25 via-gold/10 to-transparent' : 'bg-surface-raise'}`}><div className="min-w-0"><div className={`text-[10px] font-bold uppercase tracking-[.14em] ${game.game_type === 'SB' ? 'text-gold' : 'text-ink-dim'}`}>{weekLabel(game.week)}</div><div className="mt-0.5 truncate text-xs text-ink-mid">{formatGameday(game.gameday)}{game.stadium ? ` · ${game.stadium}` : ''}</div></div><div className={`ml-auto shrink-0 text-[10px] font-bold uppercase tracking-[.14em] ${isLive ? 'text-data-live' : 'text-ink-dim'}`}>{isLive ? <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-data-live motion-reduce:animate-none" />Live</span> : final ? 'Final' : 'Upcoming'}</div></div>
    <div className="flex items-center gap-2 px-4 py-6 sm:px-6">
      <Link to={`/teams/${game.away_team}`} className={`group flex flex-1 flex-col items-center gap-2 sm:flex-row ${awayWon || !final ? '' : 'opacity-50'}`}><img src={teamLogoUrl(game.away_team)} alt="" className="h-12 w-12 object-contain sm:h-16 sm:w-16" /><div className="text-center sm:text-left"><div className="text-xs font-bold text-ink group-hover:text-indigo-400 sm:text-sm">{teamName(game.away_team)}</div>{game.away_record && <div className="text-[10px] text-ink-dim sm:text-xs">{game.away_record}</div>}</div></Link>
      <div className="flex shrink-0 flex-col items-center gap-1" aria-live="polite">{isLive ? <><div className="flex items-center gap-2 sm:gap-3"><span className="text-3xl font-black tabular-nums text-ink sm:text-5xl">{live?.away_score ?? 0}</span><span className="text-xl text-ink-dim">–</span><span className="text-3xl font-black tabular-nums text-ink sm:text-5xl">{live?.home_score ?? 0}</span></div><div className="text-[11px] font-bold uppercase tracking-[.12em] tabular-nums text-data-live">{live?.period ? `Q${live.period}` : 'Live'}{live?.clock ? ` · ${live.clock}` : ''}</div>{live?.possession && <div className="text-[10px] font-bold uppercase tracking-[.12em] text-ink-dim">{live.possession} ball</div>}</> : final ? <div className="flex items-center gap-2 sm:gap-3"><span className={`text-3xl font-black tabular-nums sm:text-5xl ${awayWon ? 'text-ink' : 'text-ink-dim'}`}>{awayScore}</span><span className="text-xl text-ink-dim">–</span><span className={`text-3xl font-black tabular-nums sm:text-5xl ${homeWon ? 'text-ink' : 'text-ink-dim'}`}>{homeScore}</span></div> : <span className="text-sm text-ink-dim">Upcoming</span>}</div>
      <Link to={`/teams/${game.home_team}`} className={`group flex flex-1 flex-col items-center gap-2 sm:flex-row-reverse ${homeWon || !final ? '' : 'opacity-50'}`}><img src={teamLogoUrl(game.home_team)} alt="" className="h-12 w-12 object-contain sm:h-16 sm:w-16" /><div className="text-center sm:text-right"><div className="text-xs font-bold text-ink group-hover:text-indigo-400 sm:text-sm">{teamName(game.home_team)}</div>{game.home_record && <div className="text-[10px] text-ink-dim sm:text-xs">{game.home_record}</div>}</div></Link>
    </div>
    {lineup && <GameScorers lineup={lineup} />}
    <div className="flex overflow-x-auto border-t border-surface-line px-2">{([['overview', 'Overview'], ['lineup', 'Lineup'], ['stats', 'Stats'], ['plays', 'Plays']] as const).map(([key, label]) => {
      // Everything but Overview is built from charted play-by-play, which
      // doesn't exist until hours after the whistle. A disabled tab that says
      // why beats a tab that opens onto nothing.
      const uncharted = key !== 'overview' && !charted
      return <button key={key} type="button" disabled={uncharted} onClick={() => onTab(key)} title={uncharted ? 'Available once the game is charted' : undefined} className={`relative min-w-24 px-4 py-3 text-xs font-bold ${uncharted ? 'cursor-not-allowed text-ink-dim/40' : tab === key ? 'text-indigo-400 after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-indigo-400' : 'text-ink-dim hover:text-ink'}`}>{label}</button>
    })}</div>
  </Card>
}

function QuarterScore({ game }: { game: GameDetail }) {
  const qs = game.quarter_scores ?? []
  if (!qs.length) return null
  const quarters = [1, 2, 3, 4, ...(qs.some(q => q.qtr >= 5) ? [5] : [])]
  const byQtr = Object.fromEntries(qs.map(q => [q.qtr, q]))
  const awayWon = (game.away_score ?? 0) > (game.home_score ?? 0), homeWon = (game.home_score ?? 0) > (game.away_score ?? 0)
  return <Card title="Scoring by quarter" className="mb-4"><div className="overflow-x-auto"><table className="w-full min-w-[420px] text-sm"><thead><tr className="border-t border-surface-line bg-surface-raise/40"><th className="px-4 py-2 text-left text-[10px] uppercase tracking-wider text-ink-dim">Team</th>{quarters.map(q => <th key={q} className="px-3 py-2 text-center text-[10px] uppercase tracking-wider text-ink-dim">{q <= 4 ? `Q${q}` : 'OT'}</th>)}<th className="border-l border-surface-line px-3 py-2 text-center text-[10px] uppercase tracking-wider text-ink-dim">Final</th></tr></thead><tbody>{([{ team: game.away_team, key: 'away' as const, won: awayWon, total: game.away_score }, { team: game.home_team, key: 'home' as const, won: homeWon, total: game.home_score }]).map(({ team, key, won, total }) => <tr key={team} className="border-t border-surface-line"><td className="px-4 py-3 font-bold text-ink">{team}</td>{quarters.map(q => <td key={q} className="px-3 py-3 text-center tabular-nums text-ink-mid">{byQtr[q]?.[key] ?? '—'}</td>)}<td className={`border-l border-surface-line px-3 py-3 text-center text-lg font-black tabular-nums ${won ? 'text-ink' : 'text-ink-dim'}`}>{total ?? '—'}</td></tr>)}</tbody></table></div></Card>
}

function teamTotals(players: PlayerStats[]) {
  const sum = (fn: (p: PlayerStats) => number) => players.reduce((a, p) => a + fn(p), 0)
  return {
    totalYds:   sum(p => p.pass_yards + p.rush_yards),
    passCmp:    sum(p => p.completions),
    passAtt:    sum(p => p.attempts),
    passYds:    sum(p => p.pass_yards),
    passTDs:    sum(p => p.pass_tds),
    ints:       sum(p => p.interceptions_thrown),
    sacksTaken: sum(p => p.sacks_taken),
    rushCar:    sum(p => p.carries),
    rushYds:    sum(p => p.rush_yards),
    rushTDs:    sum(p => p.rush_tds),
    sacks:      sum(p => p.sacks),
    defInts:    sum(p => p.def_interceptions),
  }
}

function BoxScore({ game }: { game: GameDetail }) {
  const A = teamTotals(game.away)
  const H = teamTotals(game.home)
  if (!A.passAtt && !A.rushCar && !H.passAtt && !H.rushCar) return null
  const AS = game.team_stats?.find(t => t.team === game.away_team)
  const HS = game.team_stats?.find(t => t.team === game.home_team)
  const ypp = (yds: number, plays?: number) => plays ? (yds / plays).toFixed(1) : '—'
  const epaFmt = (v: number | null | undefined) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`

  function StatBar({ label, a, h, lo = false, neutral = false }: {
    label: string; a: string | number; h: string | number; lo?: boolean; neutral?: boolean
  }) {
    const av = typeof a === 'number' ? a : parseFloat(String(a)) || 0
    const hv = typeof h === 'number' ? h : parseFloat(String(h)) || 0
    const total = av + hv
    const aPct = total > 0 ? (av / total) * 100 : 50
    const hPct = total > 0 ? (hv / total) * 100 : 50
    const aWon = !neutral && av !== hv && (lo ? av < hv : av > hv)
    const hWon = !neutral && av !== hv && (lo ? hv < av : hv > av)
    return (
      <div className="px-5 py-2.5">
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className={`text-base font-bold tabular-nums w-20 text-right ${aWon ? 'text-white' : 'text-ink-dim'}`}>{a}</span>
          <span className="text-[10px] font-semibold text-ink-dim uppercase tracking-wider text-center">{label}</span>
          <span className={`text-base font-bold tabular-nums w-20 text-left ${hWon ? 'text-white' : 'text-ink-dim'}`}>{h}</span>
        </div>
        {!neutral && total > 0 && (
          <div className="relative h-1 rounded-full bg-surface-raise/60 overflow-hidden flex">
            <div className={`h-full ${aWon ? 'bg-data-win' : 'bg-data-loss/30'}`} style={{ width: `${aPct}%` }} />
            <div className={`h-full ${hWon ? 'bg-data-win' : 'bg-data-loss/30'}`} style={{ width: `${hPct}%` }} />
          </div>
        )}
      </div>
    )
  }

  function SectionDivider({ label }: { label: string }) {
    return (
      <div className="px-5 pt-3 pb-1 text-center text-[10px] font-bold text-ink-dim uppercase tracking-widest border-t border-surface-line/40 mt-1">
        {label}
      </div>
    )
  }

  return (
    <Card className="mb-4">
      {/* Header */}
      <div className="flex items-center border-b border-surface-line bg-surface-raise/40">
        <div className="flex-1 flex items-center justify-end gap-2 px-5 py-3">
          <span className="font-bold text-white text-sm">{game.away_team}</span>
          <img src={teamLogoUrl(game.away_team)} className="w-6 h-6 object-contain" alt="" />
        </div>
        <div className="w-28 text-center text-[10px] font-bold text-ink-dim uppercase tracking-widest shrink-0">
          Team Stats
        </div>
        <div className="flex-1 flex items-center justify-start gap-2 px-5 py-3">
          <img src={teamLogoUrl(game.home_team)} className="w-6 h-6 object-contain" alt="" />
          <span className="font-bold text-white text-sm">{game.home_team}</span>
        </div>
      </div>

      <div className="pb-3">
        <StatBar label="Total Yards"   a={A.totalYds} h={H.totalYds} />
        {AS && HS && (
          <>
            <StatBar label="Total Plays"  a={AS.plays} h={HS.plays} neutral />
            <StatBar label="Yards / Play" a={ypp(A.totalYds, AS.plays)} h={ypp(H.totalYds, HS.plays)} />
            <StatBar label="First Downs"  a={AS.first_downs} h={HS.first_downs} />
            <StatBar label="3rd Down"     a={`${AS.third_conv}/${AS.third_att}`} h={`${HS.third_conv}/${HS.third_att}`} neutral />
            {(AS.fourth_att > 0 || HS.fourth_att > 0) &&
              <StatBar label="4th Down"   a={`${AS.fourth_conv}/${AS.fourth_att}`} h={`${HS.fourth_conv}/${HS.fourth_att}`} neutral />}
            <StatBar label="Turnovers"    a={AS.turnovers} h={HS.turnovers} lo />
            <StatBar label="Penalties"    a={`${AS.penalties}-${AS.penalty_yards}`} h={`${HS.penalties}-${HS.penalty_yards}`} lo />
            <SectionDivider label="Efficiency" />
            <StatBar label="EPA / Play"    a={epaFmt(AS.epa_play)} h={epaFmt(HS.epa_play)} />
            <StatBar label="Success Rate"  a={`${AS.success_pct ?? 0}%`} h={`${HS.success_pct ?? 0}%`} />
          </>
        )}
        <SectionDivider label="Passing" />
        <StatBar label="Comp / Att"    a={`${A.passCmp}/${A.passAtt}`} h={`${H.passCmp}/${H.passAtt}`} neutral />
        <StatBar label="Yards"         a={A.passYds}    h={H.passYds} />
        <StatBar label="Touchdowns"    a={A.passTDs}    h={H.passTDs} />
        <StatBar label="Interceptions" a={A.ints}       h={H.ints}       lo />
        <StatBar label="Sacks Taken"   a={A.sacksTaken} h={H.sacksTaken} lo />
        <SectionDivider label="Rushing" />
        <StatBar label="Carries"       a={A.rushCar}  h={H.rushCar}  neutral />
        <StatBar label="Yards"         a={A.rushYds}  h={H.rushYds} />
        <StatBar label="Touchdowns"    a={A.rushTDs}  h={H.rushTDs} />
        <SectionDivider label="Defense" />
        <StatBar label="Sacks"         a={A.sacks}   h={H.sacks} />
        <StatBar label="Interceptions" a={A.defInts} h={H.defInts} />
      </div>
    </Card>
  )
}

// ── Card 3: Game Leaders ──────────────────────────────────────────────────────

function GameLeaders({ game }: { game: GameDetail }) {
  const ctx = useContext(GameContext)
  type Leader = { player: PlayerStats; stat: string; sub: string } | null

  function top(
    players: PlayerStats[],
    filter: (p: PlayerStats) => boolean,
    sortVal: (p: PlayerStats) => number,
    statFn: (p: PlayerStats) => string,
    subFn: (p: PlayerStats) => string,
  ): Leader {
    const p = [...players].filter(filter).sort((a, b) => sortVal(b) - sortVal(a))[0]
    return p ? { player: p, stat: statFn(p), sub: subFn(p) } : null
  }

  const categories = [
    {
      label: 'Passing Yds',
      away: top(game.away, p => p.attempts > 0, p => p.pass_yards,
        p => sv(p.pass_yards),
        p => `${p.completions}/${p.attempts}, ${p.pass_tds} TD${p.interceptions_thrown ? `, ${p.interceptions_thrown} INT` : ''}`),
      home: top(game.home, p => p.attempts > 0, p => p.pass_yards,
        p => sv(p.pass_yards),
        p => `${p.completions}/${p.attempts}, ${p.pass_tds} TD${p.interceptions_thrown ? `, ${p.interceptions_thrown} INT` : ''}`),
    },
    {
      label: 'Rushing Yds',
      away: top(game.away, p => p.carries > 0, p => p.rush_yards,
        p => sv(p.rush_yards),
        p => `${p.carries} CAR${p.rush_tds ? `, ${p.rush_tds} TD` : ''}`),
      home: top(game.home, p => p.carries > 0, p => p.rush_yards,
        p => sv(p.rush_yards),
        p => `${p.carries} CAR${p.rush_tds ? `, ${p.rush_tds} TD` : ''}`),
    },
    {
      label: 'Receiving Yds',
      away: top(game.away, p => p.targets > 0, p => p.rec_yards,
        p => sv(p.rec_yards),
        p => `${p.receptions}/${p.targets} TGT${p.rec_tds ? `, ${p.rec_tds} TD` : ''}`),
      home: top(game.home, p => p.targets > 0, p => p.rec_yards,
        p => sv(p.rec_yards),
        p => `${p.receptions}/${p.targets} TGT${p.rec_tds ? `, ${p.rec_tds} TD` : ''}`),
    },
    {
      label: 'Tackles',
      away: top(game.away, p => p.solo_tackles + p.assist_tackles > 0,
        p => p.solo_tackles + p.assist_tackles,
        p => sv(p.solo_tackles + p.assist_tackles),
        p => `${p.solo_tackles} SOLO${p.sacks ? `, ${sv(p.sacks)} SCK` : ''}`),
      home: top(game.home, p => p.solo_tackles + p.assist_tackles > 0,
        p => p.solo_tackles + p.assist_tackles,
        p => sv(p.solo_tackles + p.assist_tackles),
        p => `${p.solo_tackles} SOLO${p.sacks ? `, ${sv(p.sacks)} SCK` : ''}`),
    },
  ]

  if (categories.every(c => !c.away && !c.home)) return null

  function Side({ leader, align }: { leader: Leader; align: 'left' | 'right' }) {
    if (!leader) return <div className="flex-1" />
    const { to, state } = playerLink(leader.player.player_id, ctx)
    const rev = align === 'right'
    return (
      <div className={`flex-1 flex items-center gap-3 min-w-0 ${rev ? 'flex-row-reverse' : ''}`}>
        {leader.player.headshot_url
          ? <img src={leader.player.headshot_url} alt="" className="w-12 h-12 rounded-full object-cover object-top shrink-0 bg-surface-raise" />
          : <div className="w-12 h-12 rounded-full bg-surface-raise shrink-0" />
        }
        <div className={`min-w-0 ${rev ? 'text-right' : ''}`}>
          <div className="text-xl font-black text-white tabular-nums leading-none">{leader.stat}</div>
          <Link to={to} state={state} className="text-indigo-400 hover:underline font-semibold text-sm leading-tight block truncate mt-0.5">
            {leader.player.player_name}
          </Link>
          <div className="text-[11px] text-ink-dim mt-0.5">{leader.sub}</div>
        </div>
      </div>
    )
  }

  return (
    <Card title="Game Leaders" className="mb-4">
      <div className="divide-y divide-surface-line/40">
        {categories.map(({ label, away, home }) => (away || home) && (
          <div key={label} className="flex items-center gap-3 px-4 py-3">
            <Side leader={away} align="left" />
            <div className="shrink-0 w-32 text-center">
              <span className="text-[10px] font-semibold text-ink-dim uppercase tracking-wider">{label}</span>
            </div>
            <Side leader={home} align="right" />
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── Card 4: Player stats (conventional sheet, no tabs) ────────────────────────

function TeamDivider({ team }: { team: string }) {
  return (
    <tr className="bg-surface-raise/40 border-t border-surface-line/60">
      <td colSpan={20} className="px-4 py-2">
        <div className="flex items-center gap-2.5">
          <img src={teamLogoUrl(team)} className="w-6 h-6 object-contain" alt="" />
          <span className="text-sm font-bold text-white">{team}</span>
          <span className="text-xs text-ink-dim">·</span>
          <span className="text-xs text-ink-dim">{teamName(team)}</span>
        </div>
      </td>
    </tr>
  )
}

function PlayerStats({ game }: { game: GameDetail }) {
  const ctx = useContext(GameContext)

  function PLink({ p }: { p: PlayerStats }) {
    const { to, state } = playerLink(p.player_id, ctx)
    return (
      <td className="py-2 px-4 whitespace-nowrap">
        <Link to={to} state={state} className="text-indigo-400 hover:underline font-medium text-sm">
          {p.player_name}
        </Link>
        {p.jersey_number !== null && <span className="text-ink-dim text-xs ml-1">#{p.jersey_number}</span>}
      </td>
    )
  }

  const TH = (label: string) => (
    <th key={label} className="py-2.5 px-3 text-right text-xs font-semibold text-ink-dim whitespace-nowrap">{label}</th>
  )
  const THL = (label: string) => (
    <th key={label} className="py-2.5 px-4 text-left text-xs font-semibold text-ink-dim whitespace-nowrap">{label}</th>
  )
  const TD = (val: string | number, dim = false) => {
    const empty = val === 0 || val === '0'
    return (
      <td className={`py-2 px-3 text-right tabular-nums text-sm whitespace-nowrap
        ${empty ? 'text-ink-dim' : dim ? 'text-ink-dim' : 'text-ink-mid'}`}>
        {empty ? '—' : val}
      </td>
    )
  }

  const rowCls = 'border-t border-surface-line/40 hover:bg-surface-raise/30'

  const passers   = { away: game.away.filter(p => p.attempts > 0), home: game.home.filter(p => p.attempts > 0) }
  const rushers   = { away: [...game.away].filter(p => p.carries > 0).sort((a, b) => b.rush_yards - a.rush_yards),
                      home: [...game.home].filter(p => p.carries > 0).sort((a, b) => b.rush_yards - a.rush_yards) }
  const receivers = { away: [...game.away].filter(p => p.targets > 0).sort((a, b) => b.rec_yards - a.rec_yards),
                      home: [...game.home].filter(p => p.targets > 0).sort((a, b) => b.rec_yards - a.rec_yards) }
  const defenders = { away: [...game.away].filter(p => p.solo_tackles + p.assist_tackles + p.sacks + p.def_interceptions > 0)
                               .sort((a, b) => (b.solo_tackles + b.assist_tackles) - (a.solo_tackles + a.assist_tackles)),
                      home: [...game.home].filter(p => p.solo_tackles + p.assist_tackles + p.sacks + p.def_interceptions > 0)
                               .sort((a, b) => (b.solo_tackles + b.assist_tackles) - (a.solo_tackles + a.assist_tackles)) }

  function Section({ title, headers, children }: { title: string; headers: React.ReactNode[]; children: React.ReactNode }) {
    return (
      <Card title={title}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-line/60 bg-surface-raise/20">{headers}</tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-4">

      {/* Passing */}
      {(passers.away.length > 0 || passers.home.length > 0) && (
        <Section title="Passing" headers={[THL('Player'), TH('C/ATT'), TH('YDS'), TH('Y/A'), TH('TD'), TH('INT'), TH('SCK'), TH('EPA')]}>
          {([{ team: game.away_team, list: passers.away }, { team: game.home_team, list: passers.home }] as const).map(({ team, list }) =>
            list.length === 0 ? null : (
              <React.Fragment key={team}>
                <TeamDivider team={team} />
                {list.map(p => (
                  <tr key={p.player_id} className={rowCls}>
                    <PLink p={p} />
                    {TD(`${p.completions}/${p.attempts}`)}
                    {TD(sv(p.pass_yards))}
                    {TD(ypa(p.pass_yards, p.attempts), true)}
                    {TD(p.pass_tds)}
                    {TD(p.interceptions_thrown)}
                    {TD(p.sacks_taken)}
                    {TD(sv(p.pass_epa), true)}
                  </tr>
                ))}
              </React.Fragment>
            )
          )}
        </Section>
      )}

      {/* Rushing */}
      {(rushers.away.length > 0 || rushers.home.length > 0) && (
        <Section title="Rushing" headers={[THL('Player'), TH('CAR'), TH('YDS'), TH('Y/C'), TH('TD'), TH('EPA')]}>
          {([{ team: game.away_team, list: rushers.away }, { team: game.home_team, list: rushers.home }] as const).map(({ team, list }) =>
            list.length === 0 ? null : (
              <React.Fragment key={team}>
                <TeamDivider team={team} />
                {list.map(p => (
                  <tr key={p.player_id} className={rowCls}>
                    <PLink p={p} />
                    {TD(p.carries)}
                    {TD(sv(p.rush_yards))}
                    {TD(ypa(p.rush_yards, p.carries), true)}
                    {TD(p.rush_tds)}
                    {TD(sv(p.rush_epa), true)}
                  </tr>
                ))}
              </React.Fragment>
            )
          )}
        </Section>
      )}

      {/* Receiving */}
      {(receivers.away.length > 0 || receivers.home.length > 0) && (
        <Section title="Receiving" headers={[THL('Player'), TH('REC/TGT'), TH('YDS'), TH('Y/R'), TH('TD'), TH('YAC'), TH('EPA')]}>
          {([{ team: game.away_team, list: receivers.away }, { team: game.home_team, list: receivers.home }] as const).map(({ team, list }) =>
            list.length === 0 ? null : (
              <React.Fragment key={team}>
                <TeamDivider team={team} />
                {list.map(p => (
                  <tr key={p.player_id} className={rowCls}>
                    <PLink p={p} />
                    {TD(`${p.receptions}/${p.targets}`)}
                    {TD(sv(p.rec_yards))}
                    {TD(ypa(p.rec_yards, p.receptions), true)}
                    {TD(p.rec_tds)}
                    {TD(sv(p.yac), true)}
                    {TD(sv(p.rec_epa), true)}
                  </tr>
                ))}
              </React.Fragment>
            )
          )}
        </Section>
      )}

      {/* Defense */}
      {(defenders.away.length > 0 || defenders.home.length > 0) && (
        <Section title="Defense" headers={[THL('Player'), TH('TOT'), TH('SOLO'), TH('AST'), TH('SACK'), TH('TFL'), TH('INT'), TH('PBU')]}>
          {([{ team: game.away_team, list: defenders.away }, { team: game.home_team, list: defenders.home }] as const).map(({ team, list }) =>
            list.length === 0 ? null : (
              <React.Fragment key={team}>
                <TeamDivider team={team} />
                {list.map(p => (
                  <tr key={p.player_id} className={rowCls}>
                    <PLink p={p} />
                    {TD(sv(p.solo_tackles + p.assist_tackles))}
                    {TD(sv(p.solo_tackles))}
                    {TD(sv(p.assist_tackles), true)}
                    {TD(sv(p.sacks))}
                    {TD(sv(p.tackles_for_loss), true)}
                    {TD(p.def_interceptions)}
                    {TD(p.pass_breakups)}
                  </tr>
                ))}
              </React.Fragment>
            )
          )}
        </Section>
      )}

    </div>
  )
}

// ── Win probability chart ─────────────────────────────────────────────────────

function fmtRemaining(rem: number): string {
  if (rem < 0) {
    const elapsedOT = -rem
    const min = Math.floor((600 - elapsedOT) / 60)
    const sec = (600 - elapsedOT) % 60
    return `OT ${Math.max(0, min)}:${Math.max(0, sec).toString().padStart(2, '0')}`
  }
  const qtr = rem > 2700 ? 1 : rem > 1800 ? 2 : rem > 900 ? 3 : 4
  const secInQtr = rem - (qtr === 1 ? 2700 : qtr === 2 ? 1800 : qtr === 3 ? 900 : 0)
  const min = Math.floor(secInQtr / 60)
  const sec = secInQtr % 60
  return `Q${qtr} ${min}:${sec.toString().padStart(2, '0')}`
}

// ── Scoring summary ───────────────────────────────────────────────────────────

const SCORE_KIND: Record<string, string> = {
  TD: 'text-data-win bg-data-win/15 border-data-win/30',
  FG: 'text-ink-mid bg-surface-raise border-surface-line',
  SAF: 'text-data-loss bg-data-loss/15 border-data-loss/30',
  SCORE: 'text-ink-mid bg-surface-raise/15 border-surface-line/30',
}
const trimScoreDesc = (d: string | null) =>
  (d ?? '').replace(/^\(\d+:\d+\)\s*/, '').replace(/^\((Shotgun|No Huddle)[^)]*\)\s*/, '')

function ScoringSummary({ game }: { game: GameDetail }) {
  const plays = game.scoring ?? []
  if (!plays.length) return null
  return (
    <Card title="Scoring Summary" className="mb-4">
      <div className="divide-y divide-surface-line/40">
        {plays.map((s, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2">
            <div className="shrink-0 w-14 text-[11px] text-ink-dim font-mono tabular-nums">Q{s.qtr} {s.clock}</div>
            {s.team && <img src={teamLogoUrl(s.team)} className="w-5 h-5 object-contain shrink-0 opacity-80" alt="" />}
            <span className={`shrink-0 inline-block text-[10px] font-bold uppercase tracking-wider border rounded px-1.5 py-0.5 ${SCORE_KIND[s.kind] ?? SCORE_KIND.SCORE}`}>{s.kind}</span>
            <p className="flex-1 text-xs text-ink-mid leading-snug line-clamp-1 min-w-0">{trimScoreDesc(s.desc)}</p>
            <span className="shrink-0 text-sm font-bold text-white tabular-nums">
              {s.away_score}<span className="text-ink-dim">–</span>{s.home_score}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── Key plays (turnovers + big non-scoring WP swings) ─────────────────────────

type KeyPlayKind = 'int' | 'fum' | 'big'
interface KeyPlayItem {
  qtr: number
  rem: number
  team: string | null
  desc: string | null
  kind: KeyPlayKind
  wpSwing: number  // points of WP added for the offense
}

// Scoring plays live in the Scoring Summary; this surfaces the OTHER pivotal
// moments — turnovers, and big non-scoring win-probability swings (4th-down
// stops, missed FGs, chunk plays).
const BIG_SWING = 10  // |WP%| change to count a non-scoring play as "key"
// Non-scrimmage plays (PATs, kicks, kneels) aren't "key plays" even if the
// win-prob diff around them looks large.
const NON_KEY = /extra point|field goal is good|kicks off|punts|two-point|kneels?\b|spiked/i

function detectKeyPlays(plays: WinProbPlay[]): KeyPlayItem[] {
  const out: KeyPlayItem[] = []
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i]
    const prevHomeWp = i > 0 ? plays[i - 1].home_wp : 0.5
    const homeSwing = (p.home_wp - prevHomeWp) * 100
    const base = { qtr: p.qtr, rem: p.game_seconds_remaining, team: p.posteam, desc: p.desc, wpSwing: homeSwing }
    if (p.interception === 1) {
      out.push({ ...base, kind: 'int' })
    } else if (p.fumble_lost === 1) {
      out.push({ ...base, kind: 'fum' })
    } else if (p.touchdown !== 1 && !NON_KEY.test(p.desc ?? '') && Math.abs(homeSwing) >= BIG_SWING) {
      out.push({ ...base, kind: 'big' })
    }
  }
  return out.sort((a, b) => b.rem - a.rem)
}

const KIND_META: Record<KeyPlayKind, { label: string; color: string; bg: string }> = {
  int: { label: 'INT', color: 'text-data-loss',    bg: 'bg-data-loss/15 border-data-loss/30' },
  fum: { label: 'FUM', color: 'text-data-loss',    bg: 'bg-data-loss/15 border-data-loss/30' },
  big: { label: 'KEY', color: 'text-ink-mid',     bg: 'bg-surface-raise/15 border-surface-line/30' },
}

function KeyPlays({ game }: { game: GameDetail }) {
  const plays = detectKeyPlays(game.win_prob ?? [])
  if (!plays.length) return null
  const homeTeam = game.home_team
  return (
    <Card title="Key Plays" action={<span className="text-[10px] text-ink-dim uppercase tracking-wider">{plays.length} events</span>} className="mb-4">
      <div className="divide-y divide-surface-line/40 max-h-96 overflow-y-auto">
        {plays.map((p, i) => {
          const isHome = p.team === homeTeam
          // For scoring plays, swing is in offense's favor; for turnovers, against
          const offSwing = isHome ? p.wpSwing : -p.wpSwing
          const swingStr = Math.abs(offSwing) >= 1 ? `${offSwing >= 0 ? '+' : ''}${offSwing.toFixed(0)}%` : null
          const meta = KIND_META[p.kind]
          return (
            <div key={i} className={`flex items-center gap-3 px-4 py-2.5 border-l-2 ${isHome ? 'border-l-indigo-500/60' : 'border-l-rose-500/60'}`}>
              <div className="shrink-0 w-12 text-[11px] text-ink-dim font-mono tabular-nums">{fmtRemaining(p.rem)}</div>
              <img src={teamLogoUrl(p.team ?? '')} className="w-5 h-5 object-contain shrink-0 opacity-70" alt="" />
              <span className={`shrink-0 inline-block text-[10px] font-bold uppercase tracking-wider border rounded px-1.5 py-0.5 ${meta.color} ${meta.bg}`}>
                {meta.label}
              </span>
              <p className="flex-1 text-xs text-ink-mid leading-snug line-clamp-2 min-w-0">{p.desc}</p>
              {swingStr && (
                <span className={`shrink-0 text-[11px] tabular-nums font-semibold ${offSwing >= 0 ? 'text-data-win' : 'text-data-loss'}`}>
                  {swingStr} WP
                </span>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function colorRgb(hex: string) {
  const value = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16))
}

function readableTeamColor(team: string) {
  const primary = teamPrimaryColor(team)
  const rgb = colorRgb(primary)
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  if (luminance >= 0.32) return primary
  const mixed = rgb.map(value => Math.round(value * 0.68 + 255 * 0.32))
  return `#${mixed.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function teamChartColors(awayTeam: string, homeTeam: string) {
  const home = readableTeamColor(homeTeam)
  const awayPrimary = readableTeamColor(awayTeam)
  const awayRgb = colorRgb(awayPrimary)
  const homeRgb = colorRgb(home)
  const distance = Math.sqrt(awayRgb.reduce((sum, value, i) => sum + (value - homeRgb[i]) ** 2, 0))
  return { away: distance < 90 ? '#f4f3f8' : awayPrimary, home }
}

function WpTooltip({ active, payload, awayColor, homeColor }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as ChartPoint
  return (
    <div className="bg-surface-card border border-surface-line rounded-xl px-3 py-2.5 shadow-2xl max-w-[220px] pointer-events-none">
      <div className="flex justify-between gap-3 text-xs font-bold mb-1.5">
        <span style={{ color: awayColor }}>{d.awayTeam} {(100 - d.wp).toFixed(1)}%</span>
        <span className="text-ink-dim font-normal">{fmtRemaining(d.rem)}</span>
        <span style={{ color: homeColor }}>{d.homeTeam} {d.wp.toFixed(1)}%</span>
      </div>
      {d.desc && <p className="text-[11px] text-ink-dim leading-snug line-clamp-2">{d.desc}</p>}
    </div>
  )
}

interface ChartPoint {
  t: number; wp: number; awayWp: number; rem: number; desc: string | null
  td: boolean; turnover: boolean; posteam: string | null
  homeTeam: string; awayTeam: string
}

function WinProbabilityChart({ game }: { game: GameDetail }) {
  const plays = game.win_prob
  if (!plays?.length) return null

  const homeTeam = game.home_team
  const awayTeam = game.away_team
  const colors = teamChartColors(awayTeam, homeTeam)

  const data: ChartPoint[] = plays.map((p: WinProbPlay) => ({
    t: 3600 - p.game_seconds_remaining,
    wp: Math.round(p.home_wp * 1000) / 10,
    awayWp: 100 - Math.round(p.home_wp * 1000) / 10,
    rem: p.game_seconds_remaining,
    desc: p.desc,
    td: p.touchdown === 1,
    turnover: p.interception === 1 || p.fumble_lost === 1,
    posteam: p.posteam,
    homeTeam,
    awayTeam,
  }))

  const maxT = Math.max(3600, data[data.length - 1]?.t ?? 3600)
  const finalWp = data[data.length - 1]?.wp ?? 50
  const scoringPlays = data.filter(d => d.td)
  const turnovers = data.filter(d => d.turnover)

  return (
    <Card title="Win Probability" action={<div className="flex items-center gap-4 text-xs text-ink-dim">
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colors.away }} />{awayTeam}</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colors.home }} />{homeTeam}</span>
        </div>} className="mb-4">

      <div className="px-1 pt-3 pb-1">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="wpFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.home} stopOpacity={0.18} />
                <stop offset="100%" stopColor={colors.home} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid vertical={false} stroke="#2e2b3e" strokeDasharray="0" />

            {/* Background territory tint */}
            <ReferenceArea y1={50} y2={100} fill={colors.home} fillOpacity={0.04} ifOverflow="hidden" />
            <ReferenceArea y1={0} y2={50} fill={colors.away} fillOpacity={0.04} ifOverflow="hidden" />

            {/* 50% line */}
            <ReferenceLine y={50} stroke="#2e2b3e" strokeDasharray="4 3" strokeWidth={1} />

            {/* Quarter separators */}
            {[900, 1800, 2700, 3600].filter(t => t < maxT).map(t => (
              <ReferenceLine key={t} x={t} stroke="#2e2b3e" strokeWidth={1.5} />
            ))}

            {/* Scoring play markers */}
            {scoringPlays.map((d, i) => (
              <ReferenceLine key={`td-${i}`} x={d.t} strokeWidth={1.5} strokeOpacity={0.55}
                stroke={d.posteam === homeTeam ? colors.home : colors.away} />
            ))}
            {turnovers.map((d, i) => (
              <ReferenceLine key={`to-${i}`} x={d.t} strokeWidth={1} strokeOpacity={0.4}
                stroke={d.posteam === homeTeam ? colors.away : colors.home} strokeDasharray="2 2" />
            ))}

            <XAxis dataKey="t" type="number" domain={[0, maxT]}
              ticks={[450, 1350, 2250, 3150, ...(maxT > 3600 ? [3825] : [])]}
              tickFormatter={v => (({ 450: 'Q1', 1350: 'Q2', 2250: 'Q3', 3150: 'Q4', 3825: 'OT' } as Record<number, string>)[v] ?? '')}
              tick={{ fill: '#6c6885', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} ticks={[0, 50, 100]}
              tickFormatter={v => v === 50 ? '50%' : `${v}%`}
              tick={{ fill: '#2e2b3e', fontSize: 10 }} axisLine={false} tickLine={false} width={34} />

            <Tooltip content={<WpTooltip awayColor={colors.away} homeColor={colors.home} />} cursor={{ stroke: '#a3a0b8', strokeWidth: 1, strokeDasharray: '3 3' }} />

            <Area type="monotone" dataKey="wp" stroke={colors.home} strokeWidth={2.5}
              fill="url(#wpFill)" dot={false}
              activeDot={{ r: 5, fill: colors.home, stroke: '#0e0d15', strokeWidth: 2 }} />
            <Line type="monotone" dataKey="awayWp" stroke={colors.away} strokeWidth={2} dot={false}
              activeDot={{ r: 4, fill: colors.away, stroke: '#0e0d15', strokeWidth: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Footer */}
      <div className="px-5 pb-4 pt-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src={teamLogoUrl(awayTeam)} className="w-6 h-6 object-contain opacity-60" alt="" />
          <span className="text-lg font-black tabular-nums" style={{ color: colors.away }}>{(100 - finalWp).toFixed(0)}%</span>
        </div>
        <span className="text-[10px] text-ink-dim uppercase tracking-widest">final</span>
        <div className="flex items-center gap-2">
          <span className="text-lg font-black tabular-nums" style={{ color: colors.home }}>{finalWp.toFixed(0)}%</span>
          <img src={teamLogoUrl(homeTeam)} className="w-6 h-6 object-contain opacity-60" alt="" />
        </div>
      </div>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

function GamePageBody() {
  const { gameId } = useParams<{ gameId: string }>()
  const live = useLiveGame(gameId)
  const location = useLocation()
  const fromWeek: number | undefined = (location.state as any)?.fromWeek
  const [game, setGame] = useState<GameDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<GameTab>('overview')
  const [lineup, setLineup] = useState<GameLineup | null>(null)
  const [weeks, setWeeks] = useState<WeekGroup[]>([])
  const season = game?.season
  // Show the live card only while there is nothing charted to replace it.
  const showLiveCard = !!live && live.state !== 'pre' && !!game && game.away.length === 0 && game.home.length === 0

  useEffect(() => {
    if (!gameId) return
    api.game(gameId).then(setGame).finally(() => setLoading(false))
  }, [gameId])
  useEffect(() => { if (gameId) api.gameLineup(gameId).then(setLineup).catch(() => setLineup(null)) }, [gameId])
  useEffect(() => { if (season) api.schedule(season).then(setWeeks).catch(() => setWeeks([])) }, [season])

  const sameRound = useMemo(() => {
    if (!game) return []
    const all = weeks.flatMap(w => w.games) as unknown as GameDetail[]
    if (game.game_type === 'REG') return all.filter(g => g.week === game.week)
    const teams = new Set([game.away_team, game.home_team])
    return all.filter(g => g.game_type !== 'REG' && g.away_score != null && g.home_score != null)
      .filter(g => teams.has(g.away_team) || teams.has(g.home_team) || g.game_id === game.game_id)
  }, [weeks, game])

  if (loading) return <div className="min-h-screen bg-surface-bg"><Nav /><p className="p-8 text-ink-dim">Loading...</p></div>
  if (!game) return <div className="min-h-screen bg-surface-bg"><Nav /><p className="p-8 text-ink-dim">Game not found.</p></div>

  return (
    <div className="min-h-screen bg-surface-bg">
      <Nav />
      <div className="max-w-6xl mx-auto px-4 py-8">
        <GameContext.Provider value={{ gameId: game.game_id, season: game.season, week: game.week, awayTeam: game.away_team, homeTeam: game.home_team, fromWeek }}>
          <style>{LINEUP_CSS}</style>
          <GameHeader game={game} lineup={lineup} tab={tab} onTab={setTab} live={live} />
          <div className="lineup-page">
          <main className="feed">
          {tab === 'overview' && (
            <>
              {showLiveCard && live && <LiveGameCard live={live} />}
              <QuarterScore game={game} />
              <ScoringSummary game={game} />
              <WinProbabilityChart game={game} />
              <KeyPlays game={game} />
              <GameLeaders game={game} />
              <BoxScore game={game} />
            </>
          )}
          {tab === 'lineup' && <GameLineupView game={game} lineup={lineup} />}
          {tab === 'stats' && (
            <>
              <BoxScore game={game} />
              {(game.away.length > 0 || game.home.length > 0) && <PlayerStats game={game} />}
            </>
          )}
          {tab === 'plays' && (
            <>
              <ScoringSummary game={game} />
              <WinProbabilityChart game={game} />
              <KeyPlays game={game} />
            </>
          )}
          </main>
          {lineup && <GameRail game={game} lineup={lineup} sameRound={sameRound} />}
          </div>
        </GameContext.Provider>

      </div>
    </div>
  )
}


export default function GamePage() {
  return (
    <LiveScoresProvider>
      <GamePageBody />
    </LiveScoresProvider>
  )
}
