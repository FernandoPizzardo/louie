import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { api, ApiError } from '@/lib/engine'
import type {
  EngineConfig,
  PersistSettings,
  LocationPattern,
  RewriteRule,
  ThrottleConfig,
  BreakpointRule,
} from '@/lib/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Section =
  | 'general'
  | 'blocklist'
  | 'mapRemote'
  | 'mapLocal'
  | 'rewrite'
  | 'throttle'
  | 'breakpoints'
  | 'ssl'

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'blocklist', label: 'Block List' },
  { key: 'mapRemote', label: 'Map Remote' },
  { key: 'mapLocal', label: 'Map Local' },
  { key: 'rewrite', label: 'Rewrite' },
  { key: 'throttle', label: 'Throttle' },
  { key: 'breakpoints', label: 'Breakpoints' },
  { key: 'ssl', label: 'SSL Proxying' },
]

export function SettingsDialog({ open, onOpenChange }: Props) {
  const [persist, setPersist] = useState<PersistSettings | null>(null)
  const [config, setConfig] = useState<EngineConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState<Section>('general')

  useEffect(() => {
    if (!open) return
    Promise.all([api<PersistSettings>('/api/persist'), api<EngineConfig>('/api/config')])
      .then(([p, c]) => { setPersist(p); setConfig(c); setError(null) })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)))
  }, [open])

  const save = async () => {
    if (!config) return
    setBusy(true)
    setError(null)
    try {
      await api('/api/config', {
        body: {
          enabled: config.enabled,
          blockAction: config.blockAction,
          blocklist: config.blocklist,
          mapRemote: config.mapRemote,
          mapLocal: config.mapLocal,
          rewrite: config.rewrite,
          throttle: config.throttle,
          breakpoints: config.breakpoints,
          sslLocations: config.sslLocations,
        },
      })
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const update = useCallback((patch: Partial<EngineConfig>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c))
  }, [])

  const toggleTool = async (key: string, on: boolean) => {
    if (!config) return
    const enabled = { ...config.enabled, [key]: on }
    update({ enabled })
    try {
      await api('/api/config', { body: { enabled } })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] flex-col overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Edit proxy tools and session options.</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive" className="mx-6">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <nav className="w-44 shrink-0 border-r p-2">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  section === s.key ? 'bg-muted font-medium' : 'hover:bg-muted/50'
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <ScrollArea className="flex-1 p-6">
            {!config ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : section === 'general' ? (
              <GeneralSection
                persist={persist}
                config={config}
                onToggleTool={toggleTool}
                onTogglePersist={async (on) => {
                  try {
                    await api('/api/persist', { body: { enabled: on } })
                    setPersist((p) => (p ? { ...p, enabled: on } : p))
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : String(e))
                  }
                }}
              />
            ) : section === 'blocklist' ? (
              <BlocklistSection config={config} onUpdate={update} />
            ) : section === 'mapRemote' ? (
              <MapRemoteSection config={config} onUpdate={update} />
            ) : section === 'mapLocal' ? (
              <MapLocalSection config={config} onUpdate={update} />
            ) : section === 'rewrite' ? (
              <RewriteSection config={config} onUpdate={update} />
            ) : section === 'throttle' ? (
              <ThrottleSection config={config} onUpdate={update} />
            ) : section === 'breakpoints' ? (
              <BreakpointsSection config={config} onUpdate={update} />
            ) : (
              <SslSection config={config} onUpdate={update} />
            )}
          </ScrollArea>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- General ----------

function GeneralSection({
  persist,
  config,
  onToggleTool,
  onTogglePersist,
}: {
  persist: PersistSettings | null
  config: EngineConfig
  onToggleTool: (key: string, on: boolean) => void
  onTogglePersist: (on: boolean) => void
}) {
  const tools = [
    { key: 'blocklist', label: 'Block List' },
    { key: 'mapRemote', label: 'Map Remote' },
    { key: 'mapLocal', label: 'Map Local' },
    { key: 'rewrite', label: 'Rewrite' },
    { key: 'throttle', label: 'Throttle' },
    { key: 'noCache', label: 'No Caching' },
    { key: 'breakpoints', label: 'Breakpoints' },
  ]
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Session history</h3>
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
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
            onCheckedChange={onTogglePersist}
          />
        </div>
        {persist?.dir && (
          <p className="break-all font-mono text-xs text-muted-foreground">{persist.dir}</p>
        )}
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Tool switches</h3>
        <div className="space-y-2">
          {tools.map((t) => (
            <div key={t.key} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Label htmlFor={`tool-${t.key}`}>{t.label}</Label>
                {config.enabled[t.key] && <Badge variant="secondary">on</Badge>}
              </div>
              <Switch
                id={`tool-${t.key}`}
                checked={!!config.enabled[t.key]}
                onCheckedChange={(on) => onToggleTool(t.key, on)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- helpers ----------

function emptyLocation(): LocationPattern {
  return { host: '' }
}

function LocationFields({
  value,
  onChange,
}: {
  value: LocationPattern
  onChange: (v: LocationPattern) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Input
        placeholder="protocol"
        value={value.protocol || ''}
        onChange={(e) => onChange({ ...value, protocol: e.target.value || undefined })}
      />
      <Input
        placeholder="host *"
        value={value.host || ''}
        onChange={(e) => onChange({ ...value, host: e.target.value || undefined })}
      />
      <Input
        placeholder="port"
        value={String(value.port ?? '')}
        onChange={(e) => onChange({ ...value, port: e.target.value || undefined })}
      />
      <Input
        placeholder="path"
        value={value.path || ''}
        onChange={(e) => onChange({ ...value, path: e.target.value || undefined })}
      />
    </div>
  )
}

function RowCard({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="relative rounded-md border p-3">
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-2 top-2 text-red-600"
        onClick={onRemove}
      >
        Remove
      </Button>
      <div className="pr-16">{children}</div>
    </div>
  )
}

// ---------- Block List ----------

function BlocklistSection({
  config,
  onUpdate,
}: {
  config: EngineConfig
  onUpdate: (p: Partial<EngineConfig>) => void
}) {
  const list = config.blocklist || []
  const action = config.blockAction || 'drop'
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Label>Action</Label>
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={action}
          onChange={(e) => onUpdate({ blockAction: e.target.value as 'drop' | '403' })}
        >
          <option value="drop">Drop connection</option>
          <option value="403">Return 403</option>
        </select>
      </div>
      <div className="space-y-2">
        {list.map((rule, i) => (
          <RowCard key={i} onRemove={() => {
            const next = list.slice()
            next.splice(i, 1)
            onUpdate({ blocklist: next })
          }}>
            <div className="mb-2 flex items-center gap-2">
              <Switch
                checked={rule.enabled !== false}
                onCheckedChange={(on) => {
                  const next = list.slice()
                  next[i] = { ...rule, enabled: on }
                  onUpdate({ blocklist: next })
                }}
              />
              <span className="text-sm text-muted-foreground">Enabled</span>
            </div>
            <LocationFields
              value={rule.location}
              onChange={(v) => {
                const next = list.slice()
                next[i] = { ...rule, location: v }
                onUpdate({ blocklist: next })
              }}
            />
          </RowCard>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={() => onUpdate({ blocklist: [...list, { location: emptyLocation() }] })}
      >
        Add rule
      </Button>
    </div>
  )
}

// ---------- Map Remote ----------

function MapRemoteSection({
  config,
  onUpdate,
}: {
  config: EngineConfig
  onUpdate: (p: Partial<EngineConfig>) => void
}) {
  const list = config.mapRemote || []
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {list.map((rule, i) => (
          <RowCard key={i} onRemove={() => {
            const next = list.slice()
            next.splice(i, 1)
            onUpdate({ mapRemote: next })
          }}>
            <div className="mb-2 flex items-center gap-2">
              <Switch
                checked={rule.enabled !== false}
                onCheckedChange={(on) => {
                  const next = list.slice()
                  next[i] = { ...rule, enabled: on }
                  onUpdate({ mapRemote: next })
                }}
              />
              <span className="text-sm text-muted-foreground">Enabled</span>
            </div>
            <div className="mb-2 text-sm font-medium">From</div>
            <LocationFields
              value={rule.from}
              onChange={(v) => {
                const next = list.slice()
                next[i] = { ...rule, from: v }
                onUpdate({ mapRemote: next })
              }}
            />
            <div className="mb-2 mt-3 text-sm font-medium">To</div>
            <LocationFields
              value={rule.to || {}}
              onChange={(v) => {
                const next = list.slice()
                next[i] = { ...rule, to: v }
                onUpdate({ mapRemote: next })
              }}
            />
          </RowCard>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={() => onUpdate({ mapRemote: [...list, { from: emptyLocation(), to: {} }] })}
      >
        Add rule
      </Button>
    </div>
  )
}

// ---------- Map Local ----------

function MapLocalSection({
  config,
  onUpdate,
}: {
  config: EngineConfig
  onUpdate: (p: Partial<EngineConfig>) => void
}) {
  const list = config.mapLocal || []
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {list.map((rule, i) => (
          <RowCard key={i} onRemove={() => {
            const next = list.slice()
            next.splice(i, 1)
            onUpdate({ mapLocal: next })
          }}>
            <div className="mb-2 flex items-center gap-2">
              <Switch
                checked={rule.enabled !== false}
                onCheckedChange={(on) => {
                  const next = list.slice()
                  next[i] = { ...rule, enabled: on }
                  onUpdate({ mapLocal: next })
                }}
              />
              <span className="text-sm text-muted-foreground">Enabled</span>
            </div>
            <div className="mb-2 text-sm font-medium">Location</div>
            <LocationFields
              value={rule.location}
              onChange={(v) => {
                const next = list.slice()
                next[i] = { ...rule, location: v }
                onUpdate({ mapLocal: next })
              }}
            />
            <div className="mb-2 mt-3 text-sm font-medium">Local path</div>
            <Input
              placeholder="/path/to/file or ~/dir"
              value={rule.localPath || ''}
              onChange={(e) => {
                const next = list.slice()
                next[i] = { ...rule, localPath: e.target.value }
                onUpdate({ mapLocal: next })
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <Switch
                checked={!!rule.caseSensitive}
                onCheckedChange={(on) => {
                  const next = list.slice()
                  next[i] = { ...rule, caseSensitive: on }
                  onUpdate({ mapLocal: next })
                }}
              />
              <span className="text-sm text-muted-foreground">Case-sensitive</span>
            </div>
          </RowCard>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={() => onUpdate({ mapLocal: [...list, { location: emptyLocation(), localPath: '' }] })}
      >
        Add rule
      </Button>
    </div>
  )
}

// ---------- Rewrite ----------

function RewriteSection({
  config,
  onUpdate,
}: {
  config: EngineConfig
  onUpdate: (p: Partial<EngineConfig>) => void
}) {
  const sets = config.rewrite || []

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        {sets.map((set, si) => (
          <div key={si} className="rounded-md border p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Switch
                  checked={set.enabled !== false}
                  onCheckedChange={(on) => {
                    const next = sets.slice()
                    next[si] = { ...set, enabled: on }
                    onUpdate({ rewrite: next })
                  }}
                />
                <span className="text-sm font-medium">Set {si + 1}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600"
                onClick={() => {
                  const next = sets.slice()
                  next.splice(si, 1)
                  onUpdate({ rewrite: next })
                }}
              >
                Remove
              </Button>
            </div>
            <div className="mb-2 text-sm text-muted-foreground">Location</div>
            <LocationFields
              value={set.location}
              onChange={(v) => {
                const next = sets.slice()
                next[si] = { ...set, location: v }
                onUpdate({ rewrite: next })
              }}
            />
            <div className="mt-3 space-y-2">
              {(set.rules || []).map((rule, ri) => (
                <div key={ri} className="grid grid-cols-[auto_1fr_1fr_auto_auto] items-center gap-2">
                  <Switch
                    checked={rule.enabled !== false}
                    onCheckedChange={(on) => {
                      const next = sets.slice()
                      const rules = next[si].rules.slice()
                      rules[ri] = { ...rule, enabled: on }
                      next[si] = { ...next[si], rules }
                      onUpdate({ rewrite: next })
                    }}
                  />
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    value={rule.type}
                    onChange={(e) => {
                      const next = sets.slice()
                      const rules = next[si].rules.slice()
                      rules[ri] = { ...rule, type: e.target.value as RewriteRule['type'] }
                      next[si] = { ...next[si], rules }
                      onUpdate({ rewrite: next })
                    }}
                  >
                    <option value="url">URL</option>
                    <option value="header">Header</option>
                    <option value="body">Body</option>
                  </select>
                  <Input
                    placeholder="match regex"
                    value={rule.match}
                    onChange={(e) => {
                      const next = sets.slice()
                      const rules = next[si].rules.slice()
                      rules[ri] = { ...rule, match: e.target.value }
                      next[si] = { ...next[si], rules }
                      onUpdate({ rewrite: next })
                    }}
                  />
                  <Input
                    placeholder="replace"
                    value={rule.replace}
                    onChange={(e) => {
                      const next = sets.slice()
                      const rules = next[si].rules.slice()
                      rules[ri] = { ...rule, replace: e.target.value }
                      next[si] = { ...next[si], rules }
                      onUpdate({ rewrite: next })
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600"
                    onClick={() => {
                      const next = sets.slice()
                      const rules = next[si].rules.slice()
                      rules.splice(ri, 1)
                      next[si] = { ...next[si], rules }
                      onUpdate({ rewrite: next })
                    }}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => {
                  const next = sets.slice()
                  const rules = [...(next[si].rules || []), { type: 'body' as const, match: '', replace: '' }]
                  next[si] = { ...next[si], rules }
                  onUpdate({ rewrite: next })
                }}
              >
                Add rule
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={() => onUpdate({ rewrite: [...sets, { location: emptyLocation(), rules: [] }] })}
      >
        Add rewrite set
      </Button>
    </div>
  )
}

// ---------- Throttle ----------

function ThrottleSection({
  config,
  onUpdate,
}: {
  config: EngineConfig
  onUpdate: (p: Partial<EngineConfig>) => void
}) {
  const t = config.throttle || {}
  const patch = (p: Partial<ThrottleConfig>) =>
    onUpdate({ throttle: { ...t, ...p } })
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs">Latency (ms)</Label>
          <Input
            type="number"
            value={t.latency ?? ''}
            onChange={(e) => patch({ latency: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label className="text-xs">Bandwidth down (KB/s)</Label>
          <Input
            type="number"
            value={t.bandwidthDown ?? ''}
            onChange={(e) => patch({ bandwidthDown: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label className="text-xs">Bandwidth up (KB/s)</Label>
          <Input
            type="number"
            value={t.bandwidthUp ?? ''}
            onChange={(e) => patch({ bandwidthUp: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label className="text-xs">Packet loss (%)</Label>
          <Input
            type="number"
            value={t.loss ?? ''}
            onChange={(e) => patch({ loss: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Hosts</h4>
        {(t.hosts || []).map((loc, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              placeholder="host"
              value={loc.host || ''}
              onChange={(e) => {
                const next = (t.hosts || []).slice()
                next[i] = { ...loc, host: e.target.value || undefined }
                patch({ hosts: next })
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600"
              onClick={() => {
                const next = (t.hosts || []).slice()
                next.splice(i, 1)
                patch({ hosts: next })
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => patch({ hosts: [...(t.hosts || []), emptyLocation()] })}>
          Add host
        </Button>
      </div>
    </div>
  )
}

// ---------- Breakpoints ----------

function BreakpointsSection({
  config,
  onUpdate,
}: {
  config: EngineConfig
  onUpdate: (p: Partial<EngineConfig>) => void
}) {
  const b = config.breakpoints || { rules: [] }
  const updateRules = (rules: BreakpointRule[]) =>
    onUpdate({ breakpoints: { ...b, rules } })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Switch
          checked={b.enabled !== false}
          onCheckedChange={(on) => onUpdate({ breakpoints: { ...b, enabled: on } })}
        />
        <span className="text-sm">Breakpoints enabled</span>
      </div>
      <div>
        <Label className="text-xs">Timeout (ms)</Label>
        <Input
          type="number"
          value={b.timeoutMs ?? ''}
          onChange={(e) =>
            onUpdate({ breakpoints: { ...b, timeoutMs: e.target.value ? Number(e.target.value) : undefined } })
          }
        />
      </div>
      <div className="space-y-2">
        {b.rules.map((rule, i) => (
          <RowCard key={i} onRemove={() => {
            const next = b.rules.slice()
            next.splice(i, 1)
            updateRules(next)
          }}>
            <div className="mb-2 flex items-center gap-2">
              <Switch
                checked={rule.enabled !== false}
                onCheckedChange={(on) => {
                  const next = b.rules.slice()
                  next[i] = { ...rule, enabled: on }
                  updateRules(next)
                }}
              />
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={rule.scope}
                onChange={(e) => {
                  const next = b.rules.slice()
                  next[i] = { ...rule, scope: e.target.value as BreakpointRule['scope'] }
                  updateRules(next)
                }}
              >
                <option value="request">Request</option>
                <option value="response">Response</option>
                <option value="both">Both</option>
              </select>
            </div>
            <LocationFields
              value={rule.location}
              onChange={(v) => {
                const next = b.rules.slice()
                next[i] = { ...rule, location: v }
                updateRules(next)
              }}
            />
          </RowCard>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={() => updateRules([...b.rules, { scope: 'both', location: emptyLocation() }])}
      >
        Add rule
      </Button>
    </div>
  )
}

// ---------- SSL ----------

function SslSection({
  config,
  onUpdate,
}: {
  config: EngineConfig
  onUpdate: (p: Partial<EngineConfig>) => void
}) {
  const list = config.sslLocations || []
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Only hosts in this list are intercepted (MITM). All others get a blind tunnel.
      </p>
      <div className="space-y-2">
        {list.map((loc, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              placeholder="host"
              value={loc.host || ''}
              onChange={(e) => {
                const next = list.slice()
                next[i] = { ...loc, host: e.target.value || undefined }
                onUpdate({ sslLocations: next })
              }}
            />
            <Input
              className="w-24"
              placeholder="port"
              value={String(loc.port ?? '')}
              onChange={(e) => {
                const next = list.slice()
                next[i] = { ...loc, port: e.target.value || undefined }
                onUpdate({ sslLocations: next })
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600"
              onClick={() => {
                const next = list.slice()
                next.splice(i, 1)
                onUpdate({ sslLocations: next })
              }}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        onClick={() => onUpdate({ sslLocations: [...list, emptyLocation()] })}
      >
        Add host
      </Button>
    </div>
  )
}
