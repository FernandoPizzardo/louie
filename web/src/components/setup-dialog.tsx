import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, ApiError, fetchBlob } from '@/lib/engine'
import type { CaInfo, NetInfo } from '@/lib/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SetupDialog({ open, onOpenChange }: Props) {
  const [ca, setCa] = useState<CaInfo | null>(null)
  const [net, setNet] = useState<NetInfo | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const load = () =>
    Promise.all([api<CaInfo>('/api/ca'), api<NetInfo>('/api/net')])
      .then(([c, n]) => { setCa(c); setNet(n); setMessage(null) })
      .catch((e: unknown) => setMessage({ tone: 'error', text: describe(e) }))

  useEffect(() => {
    if (open) load()
  }, [open])

  const trust = async () => {
    try {
      const r = await api<{ ok: boolean; error?: string }>('/api/ca/trust', { method: 'POST' })
      setMessage({ tone: r.ok ? 'ok' : 'error', text: r.ok ? 'Root CA trusted.' : r.error ?? 'Trust failed.' })
      await load()
    } catch (e) {
      setMessage({ tone: 'error', text: describe(e) })
    }
  }

  const toggleLan = async (on: boolean) => {
    try {
      await api('/api/lan', { body: { on } })
      await load()
    } catch (e) {
      setMessage({ tone: 'error', text: describe(e) })
    }
  }

  const toggleServe = async (on: boolean) => {
    try {
      await api('/api/ca/serve', { body: { on } })
      await load()
    } catch (e) {
      setMessage({ tone: 'error', text: describe(e) })
    }
  }

  const downloadPem = async () => {
    try {
      const blob = await fetchBlob('/api/ca.pem')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'louie-ca.pem'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setMessage({ tone: 'error', text: describe(e) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Setup</DialogTitle>
          <DialogDescription>
            Install the root CA so HTTPS calls can be decrypted, and optionally let other devices use the proxy.
          </DialogDescription>
        </DialogHeader>

        {message && (
          <Alert variant={message.tone === 'error' ? 'destructive' : 'default'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        <section className="space-y-2 text-sm">
          <h3 className="font-semibold">Root certificate</h3>
          {ca ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt>Subject</dt><dd className="break-all">{ca.subject ?? 'unknown'}</dd>
              <dt>SHA-256</dt><dd className="break-all">{ca.fingerprint ?? 'unknown'}</dd>
              <dt>Trusted</dt><dd>{ca.trusted ? 'yes' : 'no'}</dd>
              <dt>File</dt><dd className="break-all">{ca.path}</dd>
            </dl>
          ) : (
            <p className="text-muted-foreground">Loading…</p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={downloadPem}>Download PEM</Button>
            <Button size="sm" variant="outline" onClick={trust}>Trust in system keychain</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Keychain trust is macOS-only for now. On Linux, install the PEM with your system's CA tooling.
          </p>
        </section>

        <section className="space-y-3 border-t pt-4 text-sm">
          <h3 className="font-semibold">Devices on your network</h3>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="lan">Listen on LAN</Label>
            <Switch id="lan" checked={!!net?.lanEnabled} onCheckedChange={toggleLan} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="serve">Serve the certificate</Label>
            <Switch
              id="serve"
              checked={!!net?.serving}
              onCheckedChange={toggleServe}
              disabled={!net}
            />
          </div>
          {net && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt>Proxy</dt><dd>{net.proxyHost}</dd>
              <dt>Certificate</dt><dd className="break-all">{net.cerUrl}</dd>
              <dt>Profile (iOS)</dt><dd className="break-all">{net.mobileconfigUrl}</dd>
            </dl>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}

function describe(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}
