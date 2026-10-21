import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, ApiError } from '@/lib/engine'
import { formatBytes, formatDuration, prettyBody, statusClass } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { SaveResult, TxBody, TxDetail, TxSummary } from '@/lib/types'

interface Props {
  summary: TxSummary | null
}

export function Inspector({ summary }: Props) {
  const [detail, setDetail] = useState<TxDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Refetch when the selected call changes or finishes (complete flips true).
  const id = summary?.id
  const complete = summary?.complete
  useEffect(() => {
    if (id === undefined) return
    let cancelled = false
    api<TxDetail>(`/api/transaction/${id}`)
      .then((d) => { if (!cancelled) { setDetail(d); setError(null) } })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof ApiError ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [id, complete])

  if (!summary) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a call to inspect its headers and bodies.
      </div>
    )
  }

  const d = detail && detail.id === summary.id ? detail : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono">{summary.method}</Badge>
          <span className={cn('font-mono text-sm font-semibold', statusClass(summary.status, summary.error))}>
            {summary.error ? 'Error' : summary.status || 'pending'}
          </span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">#{summary.id}</span>
        </div>
        <p className="break-all font-mono text-xs">
          {summary.scheme}://{summary.host}{summary.port ? `:${summary.port}` : ''}{summary.path}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{formatDuration(summary.durationMs)}</span>
          <span>↑ {formatBytes(summary.reqSize)}</span>
          <span>↓ {formatBytes(summary.resSize)}</span>
          {summary.sslProxied && <span className="text-emerald-600">SSL proxied</span>}
          {summary.tunneled && <span>tunneled</span>}
        </div>
        {summary.error && (
          <Alert variant="destructive">
            <AlertDescription className="break-all font-mono text-xs">{summary.error}</AlertDescription>
          </Alert>
        )}
        <PinButton key={summary.id} id={summary.id} />
      </div>

      {error && <p className="p-4 text-sm text-red-600">{error}</p>}

      <Tabs defaultValue="response" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="m-3 w-auto self-start">
          <TabsTrigger value="request">Request</TabsTrigger>
          <TabsTrigger value="response">Response</TabsTrigger>
          <TabsTrigger value="notes">Notes ({summary.notes.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="request" className="min-h-0 flex-1">
          <MessagePane headers={d?.requestHeaders} body={d?.requestBody} />
        </TabsContent>
        <TabsContent value="response" className="min-h-0 flex-1">
          <MessagePane headers={d?.responseHeaders} body={d?.responseBody} />
        </TabsContent>
        <TabsContent value="notes" className="min-h-0 flex-1">
          <ScrollArea className="h-full p-4">
            {summary.notes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tool touched this call.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {summary.notes.map((n, i) => (
                  <li key={i}>
                    <span className="font-medium">{n.tool}:</span> {n.text}
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function MessagePane({ headers, body }: { headers?: Record<string, string>; body?: TxBody }) {
  if (!headers || !body) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>
  }
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? ''
  const text = body.type === 'text' ? prettyBody(body.text, contentType) : ''
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Headers</h3>
          {Object.keys(headers).length === 0 ? (
            <p className="text-sm text-muted-foreground">None</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              {Object.entries(headers).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-semibold">{k}</dt>
                  <dd className="break-all text-muted-foreground">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Body</h3>
          {body.type === 'empty' && <p className="text-sm text-muted-foreground">Empty</p>}
          {body.type === 'binary' && <p className="text-sm text-muted-foreground">{body.text}</p>}
          {body.type === 'text' && (
            <>
              {body.truncated && (
                <p className="mb-2 text-xs text-amber-600">Truncated at the display cap.</p>
              )}
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{text}</pre>
            </>
          )}
        </section>
      </div>
    </ScrollArea>
  )
}

function PinButton({ id }: { id: number }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [oversize, setOversize] = useState<{ size: number; cap: number } | null>(null)

  const save = async (full?: boolean) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await api<SaveResult>(`/api/transaction/${id}/save`, {
        body: full === undefined ? {} : { full },
      })
      if (r.needsConfirm && r.size !== undefined && r.cap !== undefined) {
        setOversize({ size: r.size, cap: r.cap })
      } else if (r.ok) {
        setMessage(r.truncated ? 'Pinned (truncated copy)' : 'Pinned for MCP')
      } else {
        setMessage(r.error ?? 'Could not pin')
      }
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not pin')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => save()}>
        Save for MCP
      </Button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}

      <Dialog open={oversize !== null} onOpenChange={(o) => !o && setOversize(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Body is larger than the cap</DialogTitle>
            <DialogDescription>
              This call is {formatBytes(oversize?.size ?? 0)}, over the {formatBytes(oversize?.cap ?? 0)} cap.
              Keep the full body or save a truncated copy?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOversize(null); save(false) }}>
              Truncated
            </Button>
            <Button onClick={() => { setOversize(null); save(true) }}>Full body</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
