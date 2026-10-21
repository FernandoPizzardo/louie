import { useMemo, useState } from 'react'
import { Monitor, Moon, Settings, ShieldCheck, Sun, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Inspector } from '@/components/inspector'
import { SettingsDialog } from '@/components/settings-dialog'
import { SetupDialog } from '@/components/setup-dialog'
import { TokenDialog } from '@/components/token-dialog'
import { TransactionsTable } from '@/components/transactions-table'
import { useEngine, type Conn } from '@/hooks/use-engine'
import { useTheme } from '@/hooks/use-theme'
import type { Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { TxSummary } from '@/lib/types'

// The table renders at most this many rows; the rest stay in memory.
const ROW_LIMIT = 1000

export default function App() {
  const engine = useEngine()
  const { theme, cycle: cycleTheme } = useTheme()
  const [query, setQuery] = useState('')
  const [sslOnly, setSslOnly] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const all = useMemo(
    () => Array.from(engine.txs.values()).sort((a, b) => b.id - a.id),
    [engine.txs],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((t) => {
      if (q && !`${t.method} ${t.host}${t.path}`.toLowerCase().includes(q)) return false
      if (sslOnly && !t.sslProxied) return false
      if (errorsOnly && !(t.status >= 400 || t.error)) return false
      return true
    })
  }, [all, query, sslOnly, errorsOnly])

  const rows = filtered.slice(0, ROW_LIMIT)
  const selected: TxSummary | null = useMemo(
    () => (selectedId === null ? null : engine.txs.get(selectedId) ?? null),
    [engine.txs, selectedId],
  )

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <h1 className="text-base font-semibold tracking-tight">Louie</h1>
        <Separator orientation="vertical" className="h-5" />

        <div className="flex items-center gap-2">
          <Switch
            id="recording"
            checked={engine.recording}
            onCheckedChange={(on) => engine.setRecording(on)}
          />
          <Label htmlFor="recording">Recording</Label>
        </div>

        <Button variant="outline" size="sm" onClick={() => engine.clear()}>
          <Trash2 /> Clear
        </Button>

        <Input
          className="w-64"
          placeholder="Filter by method, host or path"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="flex items-center gap-2">
          <Switch id="ssl-only" checked={sslOnly} onCheckedChange={setSslOnly} />
          <Label htmlFor="ssl-only">SSL only</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="errors-only" checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          <Label htmlFor="errors-only">Errors</Label>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setSetupOpen(true)}>
            <ShieldCheck /> Setup
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings /> Settings
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={cycleTheme}
            title={`Theme: ${theme}`}
            aria-label={`Theme: ${theme}. Click to change.`}
          >
            <ThemeIcon theme={theme} />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <TransactionsTable rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
        </main>
        <aside className="w-[28rem] shrink-0 border-l">
          <Inspector summary={selected} />
        </aside>
      </div>

      <footer className="flex items-center gap-3 border-t px-4 py-1.5 text-xs text-muted-foreground">
        <ConnBadge conn={engine.conn} />
        <span>
          {filtered.length === all.length
            ? `${all.length} calls`
            : `${filtered.length} of ${all.length} calls`}
          {filtered.length > ROW_LIMIT && ` (showing first ${ROW_LIMIT})`}
        </span>
        {engine.status && (
          <>
            <span className="font-mono">proxy :{engine.status.proxyPort}</span>
            <span>leaf certs {engine.status.leafCertsGenerated}</span>
          </>
        )}
      </footer>

      <SetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <TokenDialog
        open={engine.conn === 'unauthorized'}
        onSubmit={(token) => engine.reconnect(token)}
      />
    </div>
  )
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'dark') return <Moon />
  if (theme === 'light') return <Sun />
  return <Monitor />
}

function ConnBadge({ conn }: { conn: Conn }) {
  const label = {
    connecting: 'Connecting',
    live: 'Live',
    offline: 'Engine offline',
    unauthorized: 'Token needed',
  }[conn]
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1.5',
        conn === 'live' && 'text-emerald-600 dark:text-emerald-400',
        (conn === 'offline' || conn === 'unauthorized') && 'text-red-600 dark:text-red-400',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          conn === 'live' ? 'bg-emerald-500' : conn === 'connecting' ? 'bg-amber-400' : 'bg-red-500',
        )}
      />
      {label}
    </Badge>
  )
}
