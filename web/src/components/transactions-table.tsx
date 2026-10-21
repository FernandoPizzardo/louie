import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { formatBytes, formatClock, formatDuration, statusClass } from '@/lib/format'
import type { TxSummary } from '@/lib/types'

interface Props {
  rows: TxSummary[]
  selectedId: number | null
  onSelect: (id: number) => void
}

export function TransactionsTable({ rows, selectedId, onSelect }: Props) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No calls yet. Point a device or browser at the proxy to start capturing.
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead className="w-20">Time</TableHead>
            <TableHead className="w-20">Method</TableHead>
            <TableHead className="w-16">Status</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Path</TableHead>
            <TableHead className="w-20 text-right">Time</TableHead>
            <TableHead className="w-24 text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t) => (
            <TableRow
              key={t.id}
              data-state={t.id === selectedId ? 'selected' : undefined}
              onClick={() => onSelect(t.id)}
              className="cursor-pointer"
            >
              <TableCell className="font-mono text-xs text-muted-foreground">{t.id}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{formatClock(t.start)}</TableCell>
              <TableCell>
                <Badge variant="outline" className="font-mono">{t.method}</Badge>
              </TableCell>
              <TableCell className={cn('font-mono text-xs font-medium', statusClass(t.status, t.error))}>
                {t.error ? 'ERR' : t.status || '…'}
              </TableCell>
              <TableCell className="max-w-48 truncate" title={t.host}>
                {t.host}
                {t.sslProxied && <span className="ml-1 text-xs text-emerald-600">🔓</span>}
                {t.tunneled && <span className="ml-1 text-xs text-muted-foreground">tunnel</span>}
              </TableCell>
              <TableCell className="max-w-96 truncate font-mono text-xs" title={t.path}>
                {t.path}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {formatDuration(t.durationMs)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {formatBytes(t.resSize)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
