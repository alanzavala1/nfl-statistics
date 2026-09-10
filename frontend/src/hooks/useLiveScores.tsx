/**
 * Live scores, paced by the server.
 *
 * The client never decides how often to poll. Every response carries
 * `poll_after` — the server already knows whether a game is being played,
 * whether one has run into overtime, and whether it is a Wednesday in June —
 * so the hook simply does what it is told, and stops entirely when told null.
 *
 * One fetch feeds every card on the page: the provider holds the board, and
 * `useLiveGame(game_id)` picks a single game out of it.
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { api } from '../api'
import type { LiveGameOut, Scoreboard } from '../types'

type Board = {
  byGameId: Record<string, LiveGameOut>
  source: Scoreboard['source'] | null
  fetchedAt: string | null
}

const EMPTY: Board = { byGameId: {}, source: null, fetchedAt: null }

const LiveScoresContext = createContext<Board>(EMPTY)

export function LiveScoresProvider({ children }: { children: ReactNode }) {
  const [board, setBoard] = useState<Board>(EMPTY)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let cancelled = false

    async function tick() {
      try {
        const data = await api.liveScoreboard()
        if (cancelled) return

        const byGameId: Record<string, LiveGameOut> = {}
        for (const g of data.games) if (g.game_id) byGameId[g.game_id] = g
        setBoard({ byGameId, source: data.source, fetchedAt: data.fetched_at })

        // null means there is nothing to watch — stop, don't fall back to a
        // default interval. An idle tab should cost nothing.
        if (data.poll_after != null) {
          timer.current = window.setTimeout(tick, data.poll_after * 1000)
        }
      } catch {
        // The scoreboard is an enhancement over cards that already render from
        // the schedule. If it fails, leave what we have and try again later
        // rather than surfacing an error for something nobody asked for.
        if (!cancelled) timer.current = window.setTimeout(tick, 60_000)
      }
    }

    tick()
    return () => {
      cancelled = true
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  return <LiveScoresContext.Provider value={board}>{children}</LiveScoresContext.Provider>
}

/** The live state for one game, or null if it isn't on today's board. */
export function useLiveGame(gameId: string | null | undefined): LiveGameOut | null {
  const board = useContext(LiveScoresContext)
  if (!gameId) return null
  return board.byGameId[gameId] ?? null
}

/** Whether any game on the board is being played right now. */
export function useAnyGameLive(): boolean {
  const board = useContext(LiveScoresContext)
  return Object.values(board.byGameId).some(g => g.state === 'in')
}
