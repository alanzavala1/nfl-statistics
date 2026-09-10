import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { DivisionStandings, Game, LeagueLeader, SeasonEntry, StandingsTeam, WeekGroup } from '../api'
import type { LiveGameOut } from '../types'
import { LiveScoresProvider, useLiveGame } from '../hooks/useLiveScores'
import Card, { CardRow } from '../components/Card'
import Nav from '../components/Nav'
import { AWARD_LABEL, AWARD_ORDER, PAST_AWARDS, SB_CHAMPS } from '../utils/awards'
import { teamLogoUrl, teamName } from '../utils/teams'

const GAME_TYPE_LABELS: Record<string, string> = { WC: 'Wild Card', DIV: 'Divisional', CON: 'Conference', SB: 'Super Bowl' }
const GAME_TYPE_PRIORITY: Record<string, number> = { SB: 4, CON: 3, DIV: 2, WC: 1, REG: 0 }
const MICRO = 'text-[10px] font-bold uppercase tracking-[0.14em] text-ink-dim'

type LoadState<T> = {
  season: number | null
  data: T
  error: boolean
}

type Storyline = {
  tag: string
  title: string
  context: string
  game: Game
  logoTeam: string
}

type LeaderCategory = {
  label: string
  unit: string
  filter: (leader: LeagueLeader) => boolean
  value: (leader: LeagueLeader) => number
  display: (leader: LeagueLeader) => string
}

type PowerRankingRow = {
  rank: number
  team: string
  record: string
  net_epa_play: number | null
  movement: number | null
}

const LEADER_CATEGORIES: LeaderCategory[] = [
  { label: 'Passing',   unit: 'YDS', filter: p => p.attempts >= 100, value: p => p.pass_yards, display: p => p.pass_yards.toLocaleString() },
  { label: 'Rushing',   unit: 'YDS', filter: p => p.carries >= 50,   value: p => p.rush_yards, display: p => p.rush_yards.toLocaleString() },
  { label: 'Receiving', unit: 'YDS', filter: p => p.targets >= 20,   value: p => p.rec_yards,  display: p => p.rec_yards.toLocaleString() },
  { label: 'Defense',   unit: 'TKL', filter: p => p.solo_tackles + p.assist_tackles >= 10, value: p => p.solo_tackles + p.assist_tackles, display: p => (p.solo_tackles + p.assist_tackles).toString() },
]

function IngestProgress({ season, onDone }: { season: number; onDone: () => void }) {
  const [progress, setProgress] = useState<{ season: number; lines: string[] }>({ season, lines: [] })
  const onDoneRef = useRef(onDone)
  const lines = progress.season === season ? progress.lines : []

  useEffect(() => { onDoneRef.current = onDone }, [onDone])

  useEffect(() => {
    const es = new EventSource(`/api/seasons/${season}/progress`)
    es.onmessage = (e) => {
      const text = e.data as string
      if (text.startsWith('__DONE__')) {
        es.close()
        onDoneRef.current()
      } else if (text.startsWith('__ERROR__')) {
        const message = text.replace('__ERROR__ ', 'Error: ')
        setProgress(prev => ({ season, lines: prev.season === season ? [...prev.lines, message] : [message] }))
        es.close()
      } else if (text.trim()) {
        setProgress(prev => ({ season, lines: prev.season === season ? [...prev.lines, text] : [text] }))
      }
    }
    return () => es.close()
  }, [season])

  return (
    <div className="border-t border-surface-line px-4 py-4">
      <div className="space-y-1.5">
        {lines.map((line, index) => (
          <p
            key={`${line}-${index}`}
            className="animate-fade-in font-mono text-sm text-ink-mid"
            style={{ animationDelay: `${index * 30}ms`, opacity: 0, animationFillMode: 'forwards' }}
          >
            {line}
          </p>
        ))}
        <p className="animate-pulse font-mono text-sm text-ink-dim">...</p>
      </div>
    </div>
  )
}

function parseNumberParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// "scheduled" counts here where it doesn't on Leaders or Standings: a season
// whose fixtures are published but whose games haven't been charted yet has
// nothing to rank, but it does have a schedule — and during week one it is
// where the live scores are.
const SELECTABLE = new Set(['loaded', 'scheduled'])

function defaultSeason(seasons: SeasonEntry[]): number | null {
  if (!seasons.length) return null
  const selectable = seasons.filter(s => SELECTABLE.has(s.status))
  const pool = selectable.length ? selectable : seasons
  return [...pool].sort((a, b) => b.season - a.season)[0]?.season ?? null
}

function weekLabel(week: number, gameType?: string | null) {
  if (gameType && GAME_TYPE_LABELS[gameType]) return GAME_TYPE_LABELS[gameType]
  return `Week ${week}`
}

function shortWeekLabel(week: number, gameType?: string | null) {
  if (gameType === 'SB') return 'SB'
  if (gameType === 'CON') return 'CONF'
  if (gameType === 'DIV') return 'DIV'
  if (gameType === 'WC') return 'WC'
  return `W${week}`
}

function dateFromYmd(gameday: string | null) {
  if (!gameday) return null
  const [year, month, day] = gameday.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function dayOfWeek(gameday: string): number {
  return dateFromYmd(gameday)?.getDay() ?? 0
}

function dayAbbrev(gameday: string | null) {
  const date = dateFromYmd(gameday)
  return date ? date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase() : 'TBD'
}

function formatTimeShort(time: string | null) {
  if (!time || time === 'TBD') return 'TBD'
  const [hours, minutes] = time.split(':').map(Number)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const hour = hours % 12 || 12
  return `${hour}:${String(minutes).padStart(2, '0')} ${ampm}`
}

function formatDateShort(gameday: string | null) {
  const date = dateFromYmd(gameday)
  return date ? date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : null
}

function formatMonthDay(gameday: string | null) {
  const date = dateFromYmd(gameday)
  return date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'TBD'
}

function isFinished(game: Game) {
  return game.away_score !== null && game.home_score !== null
}

function gameTypePriority(game: Game) {
  return GAME_TYPE_PRIORITY[game.game_type] ?? 0
}

function primetimeBadge(gameday: string | null, gametime: string | null): string | null {
  if (!gameday) return null
  const dow = dayOfWeek(gameday)
  const hour = gametime ? parseInt(gametime.split(':')[0], 10) : 0
  if (dow === 4) return 'TNF'
  if (dow === 1) return 'MNF'
  if (dow === 0 && hour >= 20) return 'SNF'
  if (dow === 6) return 'SAT'
  return null
}

function kickoffKey(game: Game) {
  return `${game.gameday ?? '9999-99-99'} ${game.gametime ?? '99:99'} ${game.game_id}`
}

function spreadCloseness(game: Game) {
  if (game.spread_line === null) return 0
  return Math.max(0, 21 - Math.abs(game.spread_line))
}

function pickFeaturedGame(games: Game[]): Game | null {
  if (!games.length) return null
  const hasUpcoming = games.some(g => !isFinished(g))
  const pool = hasUpcoming ? games.filter(g => !isFinished(g)) : games
  return [...pool].sort((a, b) => {
    const typeDiff = gameTypePriority(b) - gameTypePriority(a)
    if (typeDiff !== 0) return typeDiff

    if (hasUpcoming) {
      const primeDiff = Number(Boolean(primetimeBadge(b.gameday, b.gametime))) - Number(Boolean(primetimeBadge(a.gameday, a.gametime)))
      if (primeDiff !== 0) return primeDiff
      const divDiff = Number(b.div_game === 1) - Number(a.div_game === 1)
      if (divDiff !== 0) return divDiff
      const spreadDiff = spreadCloseness(b) - spreadCloseness(a)
      if (spreadDiff !== 0) return spreadDiff
      return kickoffKey(a).localeCompare(kickoffKey(b))
    }

    const marginA = Math.abs(a.away_score! - a.home_score!)
    const marginB = Math.abs(b.away_score! - b.home_score!)
    if (marginA !== marginB) return marginA - marginB
    const otDiff = Number(b.overtime === 1) - Number(a.overtime === 1)
    if (otDiff !== 0) return otDiff
    const totalDiff = (b.away_score! + b.home_score!) - (a.away_score! + a.home_score!)
    if (totalDiff !== 0) return totalDiff
    return kickoffKey(b).localeCompare(kickoffKey(a))
  })[0] ?? null
}

function findCurrentWeek(schedule: WeekGroup[]): number | null {
  const inProgress = schedule.find(w =>
    w.games.some(g => isFinished(g)) &&
    w.games.some(g => !isFinished(g))
  )
  if (inProgress) return inProgress.week
  const allComplete = schedule.filter(w => w.games.every(isFinished))
  if (allComplete.length) return allComplete[allComplete.length - 1].week
  const firstUpcoming = schedule.find(w => w.games.every(g => !isFinished(g)))
  return firstUpcoming?.week ?? schedule[0]?.week ?? null
}

function teamNickname(abbrev: string) {
  const full = teamName(abbrev)
  if (full === abbrev) return abbrev
  return full.split(' ').at(-1) ?? abbrev
}

function recordText(record?: string | null) {
  return record && record.trim() ? record : '0-0'
}

function leaderInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase()
}

function formatRecord(row: StandingsTeam) {
  return `${row.w}-${row.l}${row.t ? `-${row.t}` : ''}`
}

function formatNetEpa(value: number | null | undefined) {
  if (value == null) return '--'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

function movementMeta(movement: number | null | undefined) {
  if (!movement) return { text: '—', className: 'text-ink-dim' }
  if (movement > 0) return { text: `▲ ${movement}`, className: 'text-data-win' }
  return { text: `▼ ${Math.abs(movement)}`, className: 'text-data-loss' }
}

function pointDiff(row: StandingsTeam) {
  return row.pf - row.pa
}

function formatPointDiff(row: StandingsTeam) {
  const diff = pointDiff(row)
  return `${diff > 0 ? '+' : ''}${diff}`
}

function formatSpread(game: Game) {
  if (game.spread_line === null) return null
  if (game.spread_line === 0) return 'PICK'
  const favorite = game.spread_line > 0 ? game.home_team : game.away_team
  return `${favorite} -${Math.abs(game.spread_line)}`
}

function formatTotalLine(game: Game) {
  return game.total_line === null ? null : `O/U ${game.total_line}`
}

function formatTotalValue(game: Game) {
  return game.total_line === null ? null : String(game.total_line)
}

function formatKickoffFact(game: Game) {
  const date = formatDateShort(game.gameday)
  const time = formatTimeShort(game.gametime)
  if (date && time !== 'TBD') return `${date} ${time} ET`
  return date ?? `${time} ET`
}

function finalLabel(game: Game) {
  return game.overtime === 1 ? 'FINAL OT' : 'FINAL'
}

function gameWinner(game: Game): string | null {
  if (!isFinished(game)) return null
  if (game.away_score! > game.home_score!) return game.away_team
  if (game.home_score! > game.away_score!) return game.home_team
  return null
}

function scoreLine(game: Game) {
  return `${game.away_team} ${game.away_score ?? '-'} – ${game.home_score ?? '-'} ${game.home_team}`
}

function spreadValue(value: number) {
  return Number.isInteger(value) ? value.toFixed(0) : value.toString()
}

function upsetLine(game: Game) {
  const winner = gameWinner(game)
  if (!winner || game.spread_line === null) return null
  const favorite = game.spread_line > 0 ? game.home_team : game.away_team
  const underdog = favorite === game.home_team ? game.away_team : game.home_team
  if (winner !== underdog) return null
  return `${winner} were +${spreadValue(Math.abs(game.spread_line))}`
}

function divisionSort(division: string) {
  const order = ['East', 'North', 'South', 'West']
  const suffix = division.split(' ').at(-1) ?? division
  const index = order.indexOf(suffix)
  return index === -1 ? order.length : index
}

function groupKickoffSlots(games: Game[]) {
  const slots = new Map<string, { label: string; games: Game[]; sort: string }>()
  for (const game of [...games].sort((a, b) => kickoffKey(a).localeCompare(kickoffKey(b)))) {
    const key = `${game.gameday ?? 'TBD'}|${game.gametime ?? 'TBD'}`
    const label = [formatDateShort(game.gameday), game.gametime ? `${formatTimeShort(game.gametime)} ET` : null]
      .filter(Boolean)
      .join(' - ') || 'TBD'
    const current = slots.get(key)
    if (current) current.games.push(game)
    else slots.set(key, { label, games: [game], sort: kickoffKey(game) })
  }
  return [...slots.entries()].map(([key, slot]) => ({ key, ...slot })).sort((a, b) => a.sort.localeCompare(b.sort))
}

function SeasonCard({
  seasons,
  season,
  onSeasonChange,
}: {
  seasons: SeasonEntry[]
  season: number | null
  onSeasonChange: (season: number) => void
}) {
  const sorted = [...seasons].sort((a, b) => b.season - a.season)

  return (
    <Card title="Season">
      <div className="relative border-t border-surface-line px-4 py-[11px] transition-colors hover:bg-surface-raise">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold tabular-nums text-ink">{season ?? 'Season'}</span>
          <span className="text-xs text-ink-dim">current ▾</span>
        </div>
        <select
          id="season-picker"
          aria-label="Season"
          value={season ?? ''}
          onChange={e => onSeasonChange(Number(e.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          {sorted.map(entry => (
            <option key={entry.season} value={entry.season}>{entry.season}</option>
          ))}
        </select>
      </div>
    </Card>
  )
}

function TeamsCard({ rankings, loading }: { rankings: PowerRankingRow[]; loading: boolean }) {
  const topTeams = rankings.slice(0, 10)

  return (
    <Card title="Power rankings" action={<span className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-dim">EPA</span>}>
      {topTeams.length ? topTeams.map(team => {
        const movement = movementMeta(team.movement)
        return (
        <CardRow key={team.team} to={`/teams/${team.team}`} className="!grid grid-cols-[20px_28px_minmax(0,1fr)_38px_48px] gap-2">
          <span className="text-right text-xs font-bold tabular-nums text-ink-dim">{team.rank}</span>
          <img src={teamLogoUrl(team.team)} className="h-7 w-7 shrink-0 object-contain" alt="" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-ink">{teamNickname(team.team)}</span>
            <span className="block text-[11px] font-bold tabular-nums text-ink-dim">{team.record}</span>
          </span>
          <span className={`text-right text-[11px] font-black tabular-nums ${movement.className}`}>{movement.text}</span>
          <span className={`text-right text-xs font-black tabular-nums ${(team.net_epa_play ?? 0) >= 0 ? 'text-data-win' : 'text-data-loss'}`}>
            {formatNetEpa(team.net_epa_play)}
          </span>
        </CardRow>
        )
      }) : (
        <CardRow className="text-sm text-ink-dim">{loading ? 'Power rankings loading...' : 'No rankings found'}</CardRow>
      )}
      {topTeams.length > 0 && (
        <div className="border-t border-surface-line px-4 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-dim">
          Net EPA per play · updated weekly
        </div>
      )}
    </Card>
  )
}

function WeekNavigator({
  schedule,
  activeWeek,
  season,
  onWeekChange,
}: {
  schedule: WeekGroup[]
  activeWeek: number | null
  season: number
  onWeekChange: (week: number) => void
}) {
  const activePill = useRef<HTMLButtonElement>(null)
  const activeGroup = schedule.find(group => group.week === activeWeek) ?? null
  const activeIndex = schedule.findIndex(group => group.week === activeWeek)
  const previous = activeIndex > 0 ? schedule[activeIndex - 1] : null
  const next = activeIndex >= 0 && activeIndex < schedule.length - 1 ? schedule[activeIndex + 1] : null
  const title = activeGroup ? weekLabel(activeGroup.week, activeGroup.games[0]?.game_type) : `${season} season`
  const firstGame = activeGroup?.games[0]
  const subtitle = activeGroup
    ? firstGame?.game_type === 'SB'
      ? [formatMonthDay(firstGame.gameday), firstGame.stadium].filter(Boolean).join(' - ')
      : formatMonthDay(firstGame?.gameday ?? null)
    : 'Select a week'

  useEffect(() => {
    activePill.current?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [activeWeek])

  return (
    <Card>
      <div className="flex items-center gap-3 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={() => previous && onWeekChange(previous.week)}
          disabled={!previous}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-surface-raise text-sm font-black text-ink transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="Previous week"
        >
          &lt;
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-bold text-ink">{title}</div>
          <div className="truncate text-xs text-ink-dim">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={() => next && onWeekChange(next.week)}
          disabled={!next}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-surface-raise text-sm font-black text-ink transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="Next week"
        >
          &gt;
        </button>
      </div>
      <div className="flex gap-1.5 overflow-x-auto px-3 pb-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {schedule.map(group => {
          const active = group.week === activeWeek
          return (
            <button
              key={`${group.week}-${group.games[0]?.game_type ?? 'REG'}`}
              ref={active ? activePill : undefined}
              type="button"
              onClick={() => onWeekChange(group.week)}
              className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11.5px] font-bold transition-colors ${
                active
                  ? 'bg-indigo-500 text-white'
                  : 'bg-surface-raise text-ink-mid hover:bg-indigo-500/35 hover:text-ink'
              }`}
            >
              {shortWeekLabel(group.week, group.games[0]?.game_type)}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function HeroTeam({
  team,
  record,
  score,
  won,
  finished,
  align,
}: {
  team: string
  record?: string | null
  score: number | null
  won: boolean
  finished: boolean
  align: 'left' | 'right'
}) {
  return (
    <div className={`flex min-w-0 items-center gap-3 max-[780px]:flex-col max-[780px]:gap-1 max-[780px]:text-center ${align === 'right' ? 'flex-row-reverse text-right' : ''}`}>
      <img src={teamLogoUrl(team)} className="h-[52px] w-[52px] shrink-0 object-contain max-[780px]:h-11 max-[780px]:w-11" alt="" />
      <div className="min-w-0">
        <div className={`truncate text-[26px] font-black leading-none text-ink max-[780px]:overflow-visible max-[780px]:whitespace-normal max-[780px]:text-lg ${finished && !won ? 'text-ink-dim' : ''}`}>
          {teamNickname(team)}
        </div>
        <div className="mt-1 truncate text-xs text-ink-dim max-[780px]:max-w-28">
          {recordText(record)}
        </div>
        {finished && (
          <div className={`mt-1 text-4xl font-black tabular-nums leading-none max-[780px]:text-3xl ${won ? 'text-ink' : 'text-ink-dim'}`}>
            {score}
          </div>
        )}
      </div>
    </div>
  )
}

function FeaturedGameHero({ game }: { game: Game }) {
  const finished = isFinished(game)
  const winner = gameWinner(game)
  const playoff = game.game_type === 'SB' || game.game_type === 'CON'
  const bandClass = playoff
    ? 'border-b border-gold/25 bg-linear-to-r from-gold/25 via-gold/10 to-transparent text-gold'
    : 'border-b border-surface-line bg-surface-raise text-ink-dim'
  const total = finished ? game.away_score! + game.home_score! : null
  const margin = finished ? Math.abs(game.away_score! - game.home_score!) : null
  const spread = formatSpread(game)
  const totalValue = formatTotalValue(game)
  const facts = finished
    ? [
        { label: 'Margin', value: margin?.toString() ?? '-' },
        { label: 'Total', value: total?.toString() ?? '-' },
        { label: 'Closing spread', value: spread ?? 'No line' },
        { label: 'Closing O/U', value: totalValue ?? 'No total' },
      ]
    : [
        { label: 'Kickoff', value: formatKickoffFact(game) },
        { label: 'Spread', value: spread ?? 'No line' },
        { label: 'O/U', value: totalValue ?? 'No total' },
        { label: 'Venue', value: game.stadium ?? 'TBD' },
      ]

  return (
    <Card>
      <div className={`flex items-center gap-3 px-4 py-[11px] ${bandClass}`}>
        <span className="text-[10px] font-bold uppercase tracking-[0.14em]">Featured</span>
        <span className="min-w-0 truncate text-xs font-bold text-ink">
          {weekLabel(game.week, game.game_type)}
          {primetimeBadge(game.gameday, game.gametime) ? ` - ${primetimeBadge(game.gameday, game.gametime)}` : ''}
        </span>
        <Link to={`/games/${game.game_id}`} className="ml-auto shrink-0 text-xs font-bold text-indigo-300 hover:text-indigo-200">
          Gamebook
        </Link>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-7 py-6 max-[780px]:gap-2 max-[780px]:px-4">
        <HeroTeam
          team={game.away_team}
          record={game.away_record}
          score={game.away_score}
          won={winner === game.away_team}
          finished={finished}
          align="left"
        />
        <div className="text-center">
          {finished ? (
            <div className="text-[11px] font-black uppercase tracking-[0.14em] text-ink-dim">{finalLabel(game)}</div>
          ) : (
            <>
              <div className="text-2xl font-black tabular-nums text-ink max-[780px]:text-lg">VS</div>
              <div className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-ink-dim">Preview</div>
            </>
          )}
        </div>
        <HeroTeam
          team={game.home_team}
          record={game.home_record}
          score={game.home_score}
          won={winner === game.home_team}
          finished={finished}
          align="right"
        />
      </div>
      <div className="grid grid-cols-4 border-t border-surface-line max-[780px]:grid-cols-2">
        {facts.map(fact => (
          <div
            key={fact.label}
            className="min-w-0 border-r border-surface-line px-4 py-3 last:border-r-0 max-[780px]:even:border-r-0 max-[780px]:[&:nth-child(n+3)]:border-t"
          >
            <div className={MICRO}>{fact.label}</div>
            <div className="mt-1 break-words text-sm font-bold leading-snug text-ink">
              {fact.value}
            </div>
          </div>
        ))}
      </div>
      {(spread || totalValue) && (
        <div className="border-t border-surface-line px-4 py-2 text-right text-[10px] text-ink-dim">
          Lines via nflverse
        </div>
      )}
    </Card>
  )
}

function GameTeam({
  team,
  record,
  won,
  finished,
  align,
}: {
  team: string
  record?: string | null
  won: boolean
  finished: boolean
  align: 'left' | 'right'
}) {
  return (
    <div className={`flex min-w-0 items-center gap-2 max-[780px]:gap-1.5 ${align === 'right' ? 'flex-row-reverse text-right' : ''}`}>
      <img src={teamLogoUrl(team)} className="h-8 w-8 shrink-0 object-contain max-[780px]:h-6 max-[780px]:w-6" alt="" />
      <div className="min-w-0">
        <div className={`truncate text-sm font-bold max-[780px]:text-[13px] ${finished && !won ? 'text-ink-dim' : 'text-ink'}`}>{teamNickname(team)}</div>
        <div className="truncate text-xs text-ink-dim">{recordText(record)}</div>
      </div>
    </div>
  )
}

function LiveScoreBlock({ live }: { live: LiveGameOut }) {
  // No dimming of a "losing" side here: the game isn't over, and greying out a
  // team that is one score behind reads as a result it hasn't earned.
  return (
    <div className="min-w-[78px] text-center">
      <div className="flex items-center justify-center gap-1.5 text-xl font-black tabular-nums text-ink">
        <span>{live.away_score ?? 0}</span>
        <span className="text-ink-dim">-</span>
        <span>{live.home_score ?? 0}</span>
      </div>
      <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.12em] tabular-nums text-data-live">
        {live.period ? `Q${live.period}` : 'LIVE'}{live.clock ? ` · ${live.clock}` : ''}
      </div>
    </div>
  )
}

function GameScoreBlock({ game, live }: { game: Game; live?: LiveGameOut | null }) {
  const finished = isFinished(game)
  const awayWon = gameWinner(game) === game.away_team
  const homeWon = gameWinner(game) === game.home_team

  if (live?.state === 'in') return <LiveScoreBlock live={live} />

  if (!finished) {
    return (
      <div className="min-w-[72px] text-center">
        <div className="text-sm font-black tabular-nums text-ink">{formatTimeShort(game.gametime)}</div>
        <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-dim">{formatMonthDay(game.gameday)}</div>
      </div>
    )
  }

  return (
    <div className="min-w-[78px] text-center">
      <div className="flex items-center justify-center gap-1.5 text-xl font-black tabular-nums">
        <span className={awayWon ? 'text-ink' : 'text-ink-dim'}>{game.away_score}</span>
        <span className="text-ink-dim">-</span>
        <span className={homeWon ? 'text-ink' : 'text-ink-dim'}>{game.home_score}</span>
      </div>
      <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-dim">{finalLabel(game)}</div>
    </div>
  )
}

function MarketLineMeta({ spread, total, label }: { spread: string | null; total: string | null; label: string }) {
  if (!spread && !total) {
    return <div className="justify-self-end text-right text-xs font-bold text-ink-dim max-[780px]:hidden">Line TBD</div>
  }

  return (
    <div className="justify-self-end rounded-lg border border-surface-line bg-surface-raise/45 px-3 py-2 text-right max-[780px]:hidden">
      <div className="mb-1 text-[9px] font-black uppercase tracking-[0.12em] text-ink-dim">{label}</div>
      <div className="flex flex-col items-end gap-0.5">
        {spread && <div className="text-xs font-bold tabular-nums text-ink">{spread}</div>}
        {total && <div className="text-xs font-bold tabular-nums text-ink">{total}</div>}
      </div>
    </div>
  )
}

function GameRow({ game }: { game: Game }) {
  const live = useLiveGame(game.game_id)
  const isLive = live?.state === 'in'
  // A game in progress is not finished, whatever the stored scores say.
  const finished = !isLive && isFinished(game)
  const winner = finished ? gameWinner(game) : null
  const spread = formatSpread(game)
  const total = formatTotalLine(game)

  return (
    <CardRow
      to={`/games/${game.game_id}`}
      className="grid grid-cols-[40px_minmax(0,1fr)_auto_minmax(0,1fr)_116px] gap-3 py-[13px] max-[780px]:grid-cols-[40px_minmax(0,1fr)_auto_minmax(0,1fr)] max-[780px]:gap-2"
    >
      {isLive ? (
        <span
          className="grid h-8 w-10 place-items-center gap-[3px] rounded-lg bg-surface-raise text-[9px] font-black uppercase tracking-[0.1em] text-data-live"
          title={live?.detail ?? 'In progress'}
        >
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-data-live motion-reduce:animate-none" />
            LIVE
          </span>
        </span>
      ) : (
        <span className="grid h-8 w-10 place-items-center rounded-lg bg-surface-raise text-[10px] font-black uppercase tracking-[0.12em] text-ink-mid">
          {finished ? 'FT' : dayAbbrev(game.gameday)}
        </span>
      )}
      <GameTeam
        team={game.away_team}
        record={game.away_record}
        won={winner === game.away_team}
        finished={finished}
        align="left"
      />
      <GameScoreBlock game={game} live={live} />
      <GameTeam
        team={game.home_team}
        record={game.home_record}
        won={winner === game.home_team}
        finished={finished}
        align="right"
      />
      {isLive
        ? <div className="justify-self-end text-right text-xs font-bold tabular-nums text-ink-mid max-[780px]:hidden">
            {live?.possession ? `${live.possession} ball` : 'In progress'}
          </div>
        : spread || total
          ? <MarketLineMeta spread={spread} total={total} label={finished ? 'Closing' : 'Line'} />
          : <div className="justify-self-end text-right text-xs font-bold text-ink-dim max-[780px]:hidden">{finished ? 'View' : 'Line TBD'}</div>
      }
    </CardRow>
  )
}

function KickoffSlotCard({ label, games }: { label: string; games: Game[] }) {
  const hasLineData = games.some(game => game.spread_line !== null || game.total_line !== null)
  const countLabel = `${games.length} game${games.length === 1 ? '' : 's'}`

  return (
    <Card
      title={<span className={MICRO}>{label}</span>}
      action={<span className="text-xs font-bold text-ink-dim">{hasLineData ? `${countLabel} · lines via nflverse` : countLabel}</span>}
    >
      {games.map(game => <GameRow key={game.game_id} game={game} />)}
    </Card>
  )
}

function buildStorylines(weekGames: Game[], seasonGames: Game[], omitGameId?: string): Storyline[] {
  const weekFinished = weekGames.filter(isFinished)
  const seasonFinished = seasonGames.filter(isFinished)
  const scope = weekFinished.length < 3 ? seasonFinished : weekFinished
  const finished = scope.filter(game => game.game_id !== omitGameId)
  const stories: Storyline[] = []

  if (!finished.length) return stories

  const closest = [...finished].sort((a, b) => {
    const marginA = Math.abs(a.away_score! - a.home_score!)
    const marginB = Math.abs(b.away_score! - b.home_score!)
    return marginA - marginB || (b.away_score! + b.home_score!) - (a.away_score! + a.home_score!)
  })[0]
  if (closest) {
    const margin = Math.abs(closest.away_score! - closest.home_score!)
    const result = margin === 0 ? 'Tied' : `${margin}-point game`
    stories.push({
      tag: 'Thriller',
      title: scoreLine(closest),
      context: [`Week ${closest.week}`, result, closest.overtime === 1 ? 'OT' : null].filter(Boolean).join(' · '),
      game: closest,
      logoTeam: gameWinner(closest) ?? closest.away_team,
    })
  }

  const shootout = [...finished]
    .filter(game => !stories.some(story => story.game.game_id === game.game_id))
    .sort((a, b) => (b.away_score! + b.home_score!) - (a.away_score! + a.home_score!))[0]
  if (shootout) {
    stories.push({
      tag: 'Shootout',
      title: scoreLine(shootout),
      context: `Week ${shootout.week} · ${shootout.away_score! + shootout.home_score!} combined points`,
      game: shootout,
      logoTeam: gameWinner(shootout) ?? shootout.away_team,
    })
  }

  const upsets = finished
    .filter(game => game.spread_line !== null && game.spread_line !== 0)
    .filter(game => {
      const favorite = game.spread_line! > 0 ? game.home_team : game.away_team
      return gameWinner(game) !== favorite
    })
    .filter(game => !stories.some(story => story.game.game_id === game.game_id))
    .sort((a, b) => Math.abs(b.spread_line!) - Math.abs(a.spread_line!))
  const upset = upsets[0]
  if (upset) {
    stories.push({
      tag: 'Upset',
      title: scoreLine(upset),
      context: `Week ${upset.week} · ${upsetLine(upset) ?? 'Underdog won'}`,
      game: upset,
      logoTeam: gameWinner(upset) ?? upset.away_team,
    })
  }

  return stories.slice(0, 3)
}

function StorylinesCard({ weekGames, seasonGames, omitGameId }: { weekGames: Game[]; seasonGames: Game[]; omitGameId?: string }) {
  const stories = buildStorylines(weekGames, seasonGames, omitGameId)
  if (!stories.length) return null

  return (
    <Card title="Storylines">
      <div className="grid grid-cols-3 max-[780px]:grid-cols-1">
        {stories.map((story, index) => (
          <Link
            key={`${story.tag}-${story.game.game_id}`}
            to={`/games/${story.game.game_id}`}
            className={`border-t border-surface-line px-4 py-4 text-inherit no-underline transition-colors hover:bg-surface-raise ${index > 0 ? 'min-[781px]:border-l' : ''}`}
          >
            <div className="mb-2 flex items-center gap-2">
              <img src={teamLogoUrl(story.logoTeam)} className="h-6 w-6 object-contain" alt="" />
              <span className="ml-auto text-[10px] font-bold uppercase tracking-[0.14em] text-indigo-300">{story.tag}</span>
            </div>
            <div className="truncate text-sm font-black text-ink">{story.title}</div>
            <div className="mt-1 truncate text-xs text-ink-dim">{story.context}</div>
          </Link>
        ))}
      </div>
    </Card>
  )
}

function LastSeasonRecap({ season }: { season: number }) {
  const previous = season - 1
  const champion = SB_CHAMPS[previous]
  const awards = PAST_AWARDS[previous] ?? []
  if (!champion && !awards.length) return null

  return (
    <Card title={`${previous} recap`}>
      {champion && (
        <CardRow className="justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src={teamLogoUrl(champion.team)} className="h-8 w-8 shrink-0 object-contain" alt="" />
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-ink">{teamName(champion.team)}</div>
              <div className="text-xs text-ink-dim">Super Bowl champion</div>
            </div>
          </div>
          <div className="text-sm font-black tabular-nums text-gold">{champion.score}</div>
        </CardRow>
      )}
      {AWARD_ORDER.slice(0, 3).map(award => {
        const winner = awards.find(item => item.award === award)
        if (!winner) return null
        return (
          <CardRow key={award} className="justify-between">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-ink">{winner.player}</div>
              <div className="text-xs text-ink-dim">{AWARD_LABEL[award]}</div>
            </div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-ink-mid">
              <img src={teamLogoUrl(winner.team)} className="h-5 w-5 object-contain" alt="" />
              {winner.team}
            </div>
          </CardRow>
        )
      })}
    </Card>
  )
}

function ConferenceLeadersCard({
  conference,
  standings,
  season,
  loading,
}: {
  conference: 'AFC' | 'NFC'
  standings: DivisionStandings[]
  season: number
  loading: boolean
}) {
  const leaders = standings
    .filter(group => group.division.startsWith(conference))
    .sort((a, b) => divisionSort(a.division) - divisionSort(b.division))
    .map(group => ({ division: group.division.replace(`${conference} `, ''), team: group.teams[0] }))
    .filter((entry): entry is { division: string; team: StandingsTeam } => Boolean(entry.team))

  const tagClass = conference === 'AFC' ? 'bg-surface-raise' : 'bg-surface-raise'

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className={`grid h-5 w-5 place-items-center rounded-md text-[8.5px] font-black text-white ${tagClass}`}>{conference}</span>
          <span>Division leaders</span>
        </span>
      }
      action={{ label: 'Full standings', to: `/standings?season=${season}` }}
    >
      {leaders.length ? (
        <>
          <div className={`${MICRO} grid grid-cols-[42px_minmax(0,1fr)_40px_44px] gap-2 border-t border-surface-line px-4 py-2`}>
            <span />
            <span>Team</span>
            <span className="text-right">W-L</span>
            <span className="text-right">Diff</span>
          </div>
          {leaders.map(entry => (
            <CardRow
              key={`${conference}-${entry.division}`}
              to={`/teams/${entry.team.team}`}
              className="!grid grid-cols-[42px_minmax(0,1fr)_40px_44px] gap-2"
            >
              <span className={MICRO}>{entry.division}</span>
              <span className="flex min-w-0 items-center gap-2 text-sm font-bold text-ink">
                <img src={teamLogoUrl(entry.team.team)} className="h-6 w-6 shrink-0 object-contain" alt="" />
                <span className="truncate">{teamNickname(entry.team.team)}</span>
              </span>
              <span className="text-right text-xs font-bold tabular-nums text-ink">{formatRecord(entry.team)}</span>
              <span className={`text-right text-xs font-black tabular-nums ${pointDiff(entry.team) >= 0 ? 'text-data-win' : 'text-data-loss'}`}>
                {formatPointDiff(entry.team)}
              </span>
            </CardRow>
          ))}
        </>
      ) : (
        <CardRow className="text-sm text-ink-dim">{loading ? 'Standings loading...' : 'No leaders found'}</CardRow>
      )}
    </Card>
  )
}

function LeaderFace({ leader }: { leader: LeagueLeader }) {
  if (leader.headshot_url) {
    return <img src={leader.headshot_url} className="h-9 w-9 shrink-0 rounded-full bg-surface-raise object-cover object-top" alt="" />
  }
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-raise text-xs font-black text-ink-mid">
      {leaderInitials(leader.player_name)}
    </div>
  )
}

function LeagueLeadersCard({ season, leaders, loading }: { season: number; leaders: LeagueLeader[]; loading: boolean }) {
  const tops = LEADER_CATEGORIES
    .map(category => ({ category, leader: leaders.filter(category.filter).sort((a, b) => category.value(b) - category.value(a))[0] }))
    .filter((entry): entry is { category: LeaderCategory; leader: LeagueLeader } => Boolean(entry.leader))

  return (
    <Card title="League leaders" action={{ label: 'All leaders', to: `/leaders?season=${season}` }}>
      {tops.length ? tops.map(({ category, leader }) => (
        <CardRow key={category.label} to={`/players/${leader.player_id}`} className="justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <LeaderFace leader={leader} />
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-ink">{leader.player_name}</div>
              <div className="truncate text-xs text-ink-dim">{[leader.team, category.label].filter(Boolean).join(' - ')}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-black tabular-nums text-ink">{category.display(leader)}</div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-dim">{category.unit}</div>
          </div>
        </CardRow>
      )) : (
        <CardRow className="text-sm text-ink-dim">{loading ? 'Leaders loading...' : 'No leaders found'}</CardRow>
      )}
    </Card>
  )
}

function LoadingCard({ title, message }: { title: string; message: string }) {
  return (
    <Card title={title}>
      <CardRow className="text-sm text-ink-dim">{message}</CardRow>
    </Card>
  )
}

function SchedulePageBody() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [seasons, setSeasons] = useState<SeasonEntry[]>([])
  const [loadingSeason, setLoadingSeason] = useState(false)
  const [scheduleState, setScheduleState] = useState<LoadState<WeekGroup[]>>({ season: null, data: [], error: false })
  const [standingsState, setStandingsState] = useState<LoadState<DivisionStandings[]>>({ season: null, data: [], error: false })
  const [leadersState, setLeadersState] = useState<LoadState<LeagueLeader[]>>({ season: null, data: [], error: false })
  const [powerState, setPowerState] = useState<LoadState<PowerRankingRow[]>>({ season: null, data: [], error: false })

  const seasonFromUrl = parseNumberParam(searchParams.get('season'))
  const season = seasonFromUrl ?? defaultSeason(seasons)
  const requestedWeek = parseNumberParam(searchParams.get('week'))
  const seasonEntry = season === null ? undefined : seasons.find(entry => entry.season === season)
  const isSeasonLoading = seasonEntry?.status === 'loading' || seasonEntry?.status === 'queued'
  const isSeasonAvailable = seasonEntry?.status === 'available'
  const schedule = season !== null && scheduleState.season === season ? scheduleState.data : []
  const standings = season !== null && standingsState.season === season ? standingsState.data : []
  const leaders = season !== null && leadersState.season === season ? leadersState.data : []
  const powerRankings = season !== null && powerState.season === season ? powerState.data : []
  const scheduleLoading = season !== null && !isSeasonLoading && !isSeasonAvailable && scheduleState.season !== season
  const standingsLoading = season !== null && standingsState.season !== season
  const leadersLoading = season !== null && leadersState.season !== season
  const powerLoading = season !== null && powerState.season !== season
  const seasonGames = useMemo(() => schedule.flatMap(group => group.games), [schedule])
  const defaultWeek = useMemo(() => findCurrentWeek(schedule), [schedule])
  const activeGroup = schedule.find(group => group.week === (requestedWeek ?? defaultWeek))
    ?? schedule.find(group => group.week === defaultWeek)
    ?? schedule[0]
    ?? null
  const activeWeek = activeGroup?.week ?? null
  const featuredGame = activeGroup ? pickFeaturedGame(activeGroup.games) : null
  const slotGames = activeGroup
    ? activeGroup.games.filter(game => game.game_id !== featuredGame?.game_id)
    : []
  const kickoffSlots = groupKickoffSlots(slotGames)
  const seasonFinished = seasonGames.filter(isFinished).length
  const showRecap = season !== null && seasonFinished < 3

  useEffect(() => {
    let cancelled = false
    api.seasons()
      .then(data => { if (!cancelled) setSeasons(data) })
      .catch(() => { if (!cancelled) setSeasons([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (season === null || isSeasonLoading || isSeasonAvailable) return
    let cancelled = false
    api.schedule(season)
      .then(data => { if (!cancelled) setScheduleState({ season, data, error: false }) })
      .catch(() => { if (!cancelled) setScheduleState({ season, data: [], error: true }) })
    return () => { cancelled = true }
  }, [season, isSeasonLoading, isSeasonAvailable])

  useEffect(() => {
    if (season === null || isSeasonLoading || isSeasonAvailable) return
    let cancelled = false
    api.standings(season)
      .then(data => { if (!cancelled) setStandingsState({ season, data, error: false }) })
      .catch(() => { if (!cancelled) setStandingsState({ season, data: [], error: true }) })
    return () => { cancelled = true }
  }, [season, isSeasonLoading, isSeasonAvailable])

  useEffect(() => {
    if (season === null || isSeasonLoading || isSeasonAvailable) return
    let cancelled = false
    api.leaders(season)
      .then(data => { if (!cancelled) setLeadersState({ season, data, error: false }) })
      .catch(() => { if (!cancelled) setLeadersState({ season, data: [], error: true }) })
    return () => { cancelled = true }
  }, [season, isSeasonLoading, isSeasonAvailable])

  useEffect(() => {
    if (season === null || isSeasonLoading || isSeasonAvailable) return
    let cancelled = false
    fetch(`/api/power-rankings?season=${season}`)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json() as Promise<PowerRankingRow[]>
      })
      .then(data => { if (!cancelled) setPowerState({ season, data, error: false }) })
      .catch(() => { if (!cancelled) setPowerState({ season, data: [], error: true }) })
    return () => { cancelled = true }
  }, [season, isSeasonLoading, isSeasonAvailable])

  function setSeasonParam(nextSeason: number) {
    const next = new URLSearchParams(searchParams)
    next.set('season', String(nextSeason))
    next.delete('week')
    next.delete('view')
    setSearchParams(next)
  }

  function setWeekParam(nextWeek: number) {
    if (season === null) return
    const next = new URLSearchParams(searchParams)
    next.set('season', String(season))
    next.set('week', String(nextWeek))
    next.delete('view')
    setSearchParams(next)
  }

  function refreshSeasonData() {
    api.seasons().then(setSeasons).catch(() => setSeasons([]))
    if (season !== null) {
      api.schedule(season)
        .then(data => setScheduleState({ season, data, error: false }))
        .catch(() => setScheduleState({ season, data: [], error: true }))
      fetch(`/api/power-rankings?season=${season}`)
        .then(res => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
          return res.json() as Promise<PowerRankingRow[]>
        })
        .then(data => setPowerState({ season, data, error: false }))
        .catch(() => setPowerState({ season, data: [], error: true }))
    }
  }

  function requestSeasonLoad() {
    if (season === null) return
    setLoadingSeason(true)
    api.loadSeason(season)
      .then(() => api.seasons().then(setSeasons))
      .finally(() => setLoadingSeason(false))
  }

  let centerContent
  if (season === null) {
    centerContent = <LoadingCard title="Season" message="Loading seasons..." />
  } else if (seasonEntry?.status === 'error') {
    centerContent = <LoadingCard title="Season unavailable" message="This season failed to load." />
  } else if (isSeasonAvailable) {
    centerContent = (
      <Card title={`${season} season`}>
        <div className="border-t border-surface-line p-4">
          <p className="text-sm text-ink-mid">This season is available but has not been loaded yet.</p>
          <button
            type="button"
            onClick={requestSeasonLoad}
            disabled={loadingSeason}
            className="mt-3 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingSeason ? 'Loading...' : 'Load season'}
          </button>
        </div>
      </Card>
    )
  } else if (isSeasonLoading) {
    centerContent = (
      <Card title={`Loading ${season}`}>
        <IngestProgress season={season} onDone={refreshSeasonData} />
      </Card>
    )
  } else if (scheduleLoading) {
    centerContent = <LoadingCard title={`${season} scores`} message="Loading schedule..." />
  } else if (scheduleState.error) {
    centerContent = <LoadingCard title={`${season} scores`} message="Schedule unavailable." />
  } else if (!schedule.length) {
    centerContent = <LoadingCard title={`${season} scores`} message="No games found." />
  } else {
    centerContent = (
      <>
        <WeekNavigator schedule={schedule} activeWeek={activeWeek} season={season} onWeekChange={setWeekParam} />
        {featuredGame && <FeaturedGameHero game={featuredGame} />}
        {kickoffSlots.map(slot => <KickoffSlotCard key={slot.key} label={slot.label} games={slot.games} />)}
        {activeGroup && (
          <StorylinesCard
            weekGames={activeGroup.games}
            seasonGames={seasonGames}
            omitGameId={featuredGame?.game_id}
          />
        )}
        {showRecap && <LastSeasonRecap season={season} />}
      </>
    )
  }

  return (
    <>
      <Nav />
      <main className="mx-auto grid max-w-[1460px] grid-cols-[250px_minmax(0,1fr)_330px] gap-5 px-7 pb-16 pt-5 max-[1100px]:grid-cols-[minmax(0,1fr)_330px] max-[780px]:grid-cols-1 max-[780px]:px-3 max-[780px]:pb-12 max-[780px]:pt-4">
        <aside className="grid h-fit gap-5 max-[1100px]:hidden">
          <SeasonCard
            seasons={seasons}
            season={season}
            onSeasonChange={setSeasonParam}
          />
          <TeamsCard rankings={powerRankings} loading={powerLoading} />
        </aside>

        <section className="grid min-w-0 content-start gap-5">
          {centerContent}
        </section>

        <aside className="grid h-fit gap-5">
          {season !== null && (
            <>
              <ConferenceLeadersCard conference="AFC" standings={standings} season={season} loading={standingsLoading || standingsState.error} />
              <ConferenceLeadersCard conference="NFC" standings={standings} season={season} loading={standingsLoading || standingsState.error} />
              <LeagueLeadersCard season={season} leaders={leaders} loading={leadersLoading || leadersState.error} />
            </>
          )}
        </aside>
      </main>
    </>
  )
}


export default function SchedulePage() {
  // One poll feeds every card on the page.
  return (
    <LiveScoresProvider>
      <SchedulePageBody />
    </LiveScoresProvider>
  )
}
