import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { api, eventsUrl, setToken } from '@/lib/engine'
import type { Status, TxSummary } from '@/lib/types'

export type Conn = 'connecting' | 'live' | 'offline' | 'unauthorized'

interface State {
  txs: Map<number, TxSummary>
  recording: boolean
  conn: Conn
}

type Action =
  | { type: 'upsert'; txs: TxSummary[] }
  | { type: 'clear' }
  | { type: 'recording'; on: boolean }
  | { type: 'conn'; conn: Conn }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'upsert': {
      const txs = new Map(s.txs)
      for (const t of a.txs) txs.set(t.id, t)
      return { ...s, txs }
    }
    case 'clear':
      return { ...s, txs: new Map() }
    case 'recording':
      return { ...s, recording: a.on }
    case 'conn':
      return { ...s, conn: a.conn }
  }
}

// SSE bursts can arrive many times a second; applying them in one batch every
// FLUSH_MS keeps the table from re-rendering per event.
const FLUSH_MS = 150

export function useEngine() {
  const [state, dispatch] = useReducer(reducer, {
    txs: new Map(),
    recording: true,
    conn: 'connecting',
  } satisfies State)
  const [status, setStatus] = useState<Status | null>(null)
  const [generation, setGeneration] = useState(0)
  const pending = useRef<TxSummary[]>([])

  // Initial snapshot plus the live stream. Bumping `generation` reconnects,
  // which is how a newly entered token takes effect.
  useEffect(() => {
    let cancelled = false
    dispatch({ type: 'conn', conn: 'connecting' })

    Promise.all([api<TxSummary[]>('/api/transactions'), api<Status>('/api/status')])
      .then(([list, st]) => {
        if (cancelled) return
        dispatch({ type: 'upsert', txs: list })
        dispatch({ type: 'recording', on: st.recording })
        setStatus(st)
      })
      .catch((e: { status?: number }) => {
        if (cancelled) return
        dispatch({ type: 'conn', conn: e.status === 401 ? 'unauthorized' : 'offline' })
      })

    const es = new EventSource(eventsUrl())
    es.onopen = () => dispatch({ type: 'conn', conn: 'live' })
    es.onerror = () => {
      // A rejected token closes the stream for good; anything else is retried
      // by the browser, so we just show the link as offline meanwhile.
      dispatch({ type: 'conn', conn: es.readyState === EventSource.CLOSED ? 'unauthorized' : 'offline' })
    }
    es.addEventListener('tx', (e) => {
      pending.current.push(JSON.parse((e as MessageEvent).data) as TxSummary)
    })
    es.addEventListener('clear', () => {
      pending.current = []
      dispatch({ type: 'clear' })
    })
    es.addEventListener('recording', (e) => {
      dispatch({ type: 'recording', on: (JSON.parse((e as MessageEvent).data) as { on: boolean }).on })
    })

    return () => {
      cancelled = true
      es.close()
    }
  }, [generation])

  useEffect(() => {
    const timer = setInterval(() => {
      if (!pending.current.length) return
      const batch = pending.current
      pending.current = []
      dispatch({ type: 'upsert', txs: batch })
    }, FLUSH_MS)
    return () => clearInterval(timer)
  }, [])

  const setRecording = useCallback(async (on: boolean) => {
    const r = await api<{ on: boolean }>('/api/recording', { body: { on } })
    dispatch({ type: 'recording', on: r.on })
  }, [])

  const clear = useCallback(async () => {
    await api('/api/clear', { method: 'POST' })
    pending.current = []
    dispatch({ type: 'clear' })
  }, [])

  const reconnect = useCallback((token: string | null) => {
    setToken(token)
    setGeneration((g) => g + 1)
  }, [])

  return { ...state, status, setRecording, clear, reconnect }
}
