/**
 * What a game page can honestly show before anything is charted.
 *
 * Play-by-play arrives from nflverse hours after the final whistle, so between
 * kickoff and the next ingest the page has no box score, no lineup, no plays —
 * it used to render an empty column. Everything here comes from the same live
 * response the scoreboard already fetches: no second request, and nothing that
 * pretends to be a charted stat.
 */
import Card, { CardRow } from './Card'
import type { LiveGameOut } from '../types'
import { teamLogoUrl, teamNickname } from '../utils/teams'

const CATEGORY_LABEL: Record<string, string> = {
  passing: 'Passing',
  rushing: 'Rushing',
  receiving: 'Receiving',
}

function periodLabels(count: number): string[] {
  // Anything past the fourth is overtime. Two OT periods is the most a regular
  // season game can reach, but the playoffs have no such limit.
  return Array.from({ length: count }, (_, i) =>
    i < 4 ? `Q${i + 1}` : count - 4 === 1 ? 'OT' : `OT${i - 3}`,
  )
}

function LineScore({ live }: { live: LiveGameOut }) {
  const columns = Math.max(live.away_periods.length, live.home_periods.length)
  if (!columns) return null
  const labels = periodLabels(columns)

  const rows: Array<{ team: string; periods: number[]; total: number | null }> = [
    { team: live.away_team, periods: live.away_periods, total: live.away_score },
    { team: live.home_team, periods: live.home_periods, total: live.home_score },
  ]

  return (
    <div className="overflow-x-auto border-t border-surface-line">
      <table className="w-full min-w-[320px] text-sm">
        <thead>
          <tr className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-dim">
            <th className="px-4 py-2 text-left font-black">Team</th>
            {labels.map(label => (
              <th key={label} className="w-10 px-1 py-2 text-center font-black">{label}</th>
            ))}
            <th className="w-12 px-4 py-2 text-right font-black">T</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.team} className="border-t border-surface-line">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <img src={teamLogoUrl(row.team)} alt="" className="h-5 w-5 shrink-0 object-contain" />
                  <span className="truncate text-[13px] font-bold text-ink">{teamNickname(row.team)}</span>
                </div>
              </td>
              {labels.map((label, i) => (
                <td key={label} className="px-1 py-2.5 text-center tabular-nums text-ink-mid">
                  {row.periods[i] ?? '–'}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right text-[15px] font-black tabular-nums text-ink">
                {row.total ?? '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Situation({ live }: { live: LiveGameOut }) {
  const facts: Array<[string, string]> = []
  if (live.possession) facts.push(['Possession', live.possession])
  if (live.down_distance) facts.push(['Down', live.down_distance])
  if (live.away_timeouts != null && live.home_timeouts != null) {
    facts.push(['Timeouts', `${live.away_team} ${live.away_timeouts} · ${live.home_team} ${live.home_timeouts}`])
  }
  if (!facts.length && !live.last_play) return null

  return (
    <>
      {facts.length > 0 && (
        <CardRow className="flex-wrap gap-x-6 gap-y-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <div className="text-[9px] font-black uppercase tracking-[0.12em] text-ink-dim">{label}</div>
              <div className="mt-0.5 text-[13px] font-bold tabular-nums text-ink">{value}</div>
            </div>
          ))}
          {live.red_zone && (
            <div className="ml-auto self-center rounded-md bg-data-live/15 px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-data-live">
              Red zone
            </div>
          )}
        </CardRow>
      )}
      {live.last_play && (
        <CardRow className="items-start">
          <div className="min-w-0">
            <div className="text-[9px] font-black uppercase tracking-[0.12em] text-ink-dim">Last play</div>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-mid">{live.last_play}</p>
          </div>
        </CardRow>
      )}
    </>
  )
}

function Leaders({ live }: { live: LiveGameOut }) {
  if (!live.leaders.length) return null
  return (
    <>
      {live.leaders.map(leader => (
        <CardRow key={leader.category} className="gap-3">
          <div className="w-[68px] shrink-0 text-[9px] font-black uppercase tracking-[0.12em] text-ink-dim">
            {CATEGORY_LABEL[leader.category] ?? leader.category}
          </div>
          {leader.team && (
            <img src={teamLogoUrl(leader.team)} alt="" className="h-5 w-5 shrink-0 object-contain" />
          )}
          <div className="min-w-0 truncate text-[13px] font-bold text-ink">{leader.player}</div>
          <div className="ml-auto shrink-0 text-right text-xs tabular-nums text-ink-mid">{leader.detail}</div>
        </CardRow>
      ))}
    </>
  )
}

export default function LiveGameCard({ live }: { live: LiveGameOut }) {
  const inProgress = live.state === 'in'

  return (
    <Card
      className="mb-5"
      title={
        <span className="flex items-center gap-2">
          {inProgress && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-data-live motion-reduce:animate-none" />
          )}
          <span className={inProgress ? 'text-data-live' : 'text-ink'}>
            {inProgress ? 'In progress' : 'Final'}
          </span>
        </span>
      }
      action={
        <span className="text-xs font-bold tabular-nums text-ink-mid">
          {inProgress
            ? [live.period ? `Q${live.period}` : null, live.clock].filter(Boolean).join(' · ')
            : 'Box score after charting'}
        </span>
      }
    >
      <LineScore live={live} />
      {inProgress && <Situation live={live} />}
      <Leaders live={live} />
      <CardRow>
        <p className="text-[11px] leading-snug text-ink-dim">
          {inProgress
            ? 'Live score and situation via ESPN. Play-by-play, snap counts and ratings are charted after the game.'
            : 'Final score via ESPN. Full stats appear once nflverse publishes the charted play-by-play.'}
        </p>
      </CardRow>
    </Card>
  )
}
