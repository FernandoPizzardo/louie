import { useMemo, useRef, useState } from 'react'
import { Download, Upload, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/engine'
import {
  PROFILE_SECTIONS,
  type ProfileExportResult,
  type ProfileImportResult,
  type ProfileInspectResult,
} from '@/lib/types'

/**
 * Share tool configuration with a coworker.
 *
 * Export asks the engine for a profile (it redacts captures before serializing)
 * and downloads it. Import inspects the file first and only applies the sections
 * the user ticks — a profile can switch tools on but never off.
 */
export function ShareDialog({
  open,
  onOpenChange,
  captureCount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  captureCount: number
}) {
  const [mode, setMode] = useState<'export' | 'import'>('export')

  // export
  const [name, setName] = useState('')
  const [includeCaptures, setIncludeCaptures] = useState(false)
  const [includeFull, setIncludeFull] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // import
  const fileRef = useRef<HTMLInputElement>(null)
  const [profile, setProfile] = useState<unknown>(null)
  const [inspect, setInspect] = useState<ProfileInspectResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importErr, setImportErr] = useState<string | null>(null)

  const warnings = useMemo(() => {
    const out: string[] = []
    const counts = inspect?.info?.sections ?? {}
    if (selected.has('breakpoints') && (counts.breakpoints ?? 0) > 0) {
      out.push('Breakpoints arrive switched off — they will pause matching traffic once enabled.')
    }
    if (selected.has('mapLocal') && (counts.mapLocal ?? 0) > 0) {
      out.push('Map Local paths from another machine may not exist here; those requests fall through.')
    }
    return out
  }, [inspect, selected])

  async function doExport() {
    setBusy(true)
    setExportMsg(null)
    try {
      const r = await api<ProfileExportResult>('/api/profile/export', {
        body: { name: name || undefined, includeCaptures, full: includeFull },
      })
      if (!r.ok || !r.profile) {
        setExportMsg(r.error ?? 'export failed')
        return
      }
      const blob = new Blob([JSON.stringify(r.profile, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = r.fileName ?? 'profile.louie.json'
      a.click()
      URL.revokeObjectURL(url)
      setExportMsg(
        `Saved ${r.fileName}${r.captures ? ` with ${r.captures} redacted call(s)` : ''}. Review it before sending.`,
      )
    } catch (e) {
      setExportMsg(`export failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function onPickFile(file: File) {
    setImportMsg(null)
    setImportErr(null)
    setInspect(null)
    setProfile(null)
    try {
      const parsed = JSON.parse(await file.text())
      const r = await api<ProfileInspectResult>('/api/profile/inspect', {
        body: { profile: parsed },
      })
      if (!r.ok || !r.info) {
        setImportErr(r.error ?? 'That is not a Louie profile.')
        return
      }
      setProfile(parsed)
      setInspect(r)
      const keys = Object.keys(r.info.sections)
      setSelected(new Set(PROFILE_SECTIONS.map((s) => s.key).filter((k) => keys.includes(k))))
    } catch (e) {
      setImportErr(`Could not read that file: ${(e as Error).message}`)
    }
  }

  async function doImport() {
    if (!profile) return
    setBusy(true)
    setImportMsg(null)
    setImportErr(null)
    try {
      const r = await api<ProfileImportResult>('/api/profile/import', {
        body: { profile, sections: Array.from(selected) },
      })
      if (!r.ok) {
        setImportErr(r.error ?? 'import failed')
        return
      }
      const applied = r.applied?.join(', ') || 'nothing'
      setImportMsg(
        `Imported ${applied}.${r.warnings?.length ? ' ' + r.warnings.join(' ') : ''} Tools reloaded.`,
      )
    } catch (e) {
      setImportErr(`import failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  function toggle(key: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-4" /> Share a profile
          </DialogTitle>
          <DialogDescription>
            Hand a coworker your tools and captured calls as one file.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Button
            variant={mode === 'export' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('export')}
          >
            <Download /> Export
          </Button>
          <Button
            variant={mode === 'import' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('import')}
          >
            <Upload /> Import
          </Button>
        </div>

        <Separator />

        {mode === 'export' ? (
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                placeholder="Team staging setup"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="rounded-md border p-3">
              <p className="font-medium">What gets shared</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {PROFILE_SECTIONS.map((s) => (
                  <li key={s.key}>{s.label}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                The CA key, the control-API token and your local paths are never included.
              </p>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="include-captures"
                  checked={includeCaptures}
                  onCheckedChange={setIncludeCaptures}
                />
                <Label htmlFor="include-captures">
                  Include the {captureCount} captured call(s) in this session
                </Label>
              </div>
              {includeCaptures && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Captures are <strong>redacted before they are written</strong>: Authorization,
                    Cookie, Set-Cookie and common token/password fields are replaced. Calls held by a
                    breakpoint are skipped.
                  </p>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="include-full"
                      checked={includeFull}
                      onCheckedChange={setIncludeFull}
                    />
                    <Label htmlFor="include-full">Keep bodies over the size cap</Label>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onPickFile(f)
                e.target.value = ''
              }}
            />
            {!inspect && (
              <div className="space-y-2 rounded-md border p-3">
                <p>Pick a <code>.louie.json</code> profile someone shared with you.</p>
                <p className="text-xs text-muted-foreground">
                  You will see what it contains before anything is applied.
                </p>
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  Choose file…
                </Button>
              </div>
            )}

            {inspect?.info && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="font-medium">From {inspect.info.name ?? 'unnamed profile'}</p>
                {inspect.info.exportedAt && (
                  <p className="text-xs text-muted-foreground">
                    Exported {inspect.info.exportedAt}
                    {inspect.info.louieVersion ? ` · Louie ${inspect.info.louieVersion}` : ''}
                  </p>
                )}
                <div className="space-y-1.5 pt-1">
                  {PROFILE_SECTIONS.map((s) => {
                    const count = inspect.info!.sections[s.key]
                    if (count === undefined) return null
                    return (
                      <div key={s.key} className="flex items-center gap-2">
                        <Switch
                          id={`sec-${s.key}`}
                          checked={selected.has(s.key)}
                          onCheckedChange={(on) => toggle(s.key, on)}
                        />
                        <Label htmlFor={`sec-${s.key}`}>
                          {s.label}{' '}
                          <span className="text-muted-foreground">
                            ({count} {count === 1 ? 'entry' : 'entries'})
                          </span>
                        </Label>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {!!inspect?.captures?.length && (
              <div className="max-h-40 overflow-auto rounded-md border p-3">
                <p className="font-medium">Captured calls ({inspect.captures.length})</p>
                <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                  {inspect.captures.slice(0, 40).map((c, i) => (
                    <li key={i} className="truncate">
                      {c.status ?? '—'} {c.method} {c.host}
                      {c.path}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Shown for reference; not imported into your session.
                </p>
              </div>
            )}

            {warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                {warnings.map((w) => (
                  <li key={w} className="text-amber-700 dark:text-amber-400">
                    ⚠ {w}
                  </li>
                ))}
              </ul>
            )}

            {inspect && (
              <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
                Choose another…
              </Button>
            )}
          </div>
        )}

        {(exportMsg || importMsg) && (
          <p className="text-xs text-muted-foreground">{exportMsg ?? importMsg}</p>
        )}
        {importErr && <p className="text-xs text-red-600 dark:text-red-400">{importErr}</p>}

        <DialogFooter>
          {mode === 'export' ? (
            <Button onClick={() => void doExport()} disabled={busy}>
              {busy ? 'Saving…' : 'Save profile…'}
            </Button>
          ) : (
            <Button
              onClick={() => void doImport()}
              disabled={busy || !inspect || selected.size === 0}
            >
              {busy ? 'Importing…' : `Import ${selected.size} section(s)`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
