import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { api, ApiError } from '@/lib/engine'
import { TOOL_KEYS } from '@/lib/types'
import type { EngineConfig, PersistSettings } from '@/lib/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: Props) {
  const [persist, setPersist] = useState<PersistSettings | null>(null)
  const [config, setConfig] = useState<EngineConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    Promise.all([api<PersistSettings>('/api/persist'), api<EngineConfig>('/api/config')])
      .then(([p, c]) => { setPersist(p); setConfig(c); setError(null) })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)))
  }, [open])

  const togglePersist = async (on: boolean) => {
    try {
      await api('/api/persist', { body: { enabled: on } })
      setPersist((p) => (p ? { ...p, enabled: on } : p))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const toggleTool = async (key: string, on: boolean) => {
    if (!config) return
    const enabled = { ...config.enabled, [key]: on }
    try {
      await api('/api/config', { body: { enabled } })
      setConfig({ ...config, enabled })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Session history and tool switches.</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <section className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="persist">Store calls on disk</Label>
              <p className="text-xs text-muted-foreground">
                Redacted, 7-day retention. Read by the Louie MCP server.
              </p>
            </div>
            <Switch
              id="persist"
              checked={!!persist?.enabled}
              disabled={!persist}
              onCheckedChange={togglePersist}
            />
          </div>
          {persist?.dir && (
            <p className="break-all font-mono text-xs text-muted-foreground">{persist.dir}</p>
          )}
        </section>

        <Separator />

        <section className="space-y-3 text-sm">
          <h3 className="font-semibold">Tools</h3>
          {TOOL_KEYS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Label htmlFor={`tool-${key}`}>{label}</Label>
                {config?.enabled[key] && <Badge variant="secondary">on</Badge>}
              </div>
              <Switch
                id={`tool-${key}`}
                checked={!!config?.enabled[key]}
                disabled={!config}
                onCheckedChange={(on) => toggleTool(key, on)}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Rules for each tool are still edited in the macOS app for now.
          </p>
        </section>
      </DialogContent>
    </Dialog>
  )
}
