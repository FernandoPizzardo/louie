export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function formatDuration(ms: number): string {
  if (!ms) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}

/** Tailwind text colour for an HTTP status (0 = still in flight or failed). */
export function statusClass(status: number, error: string | null): string {
  if (error) return 'text-red-600 dark:text-red-400'
  if (!status) return 'text-muted-foreground'
  if (status >= 500) return 'text-red-600 dark:text-red-400'
  if (status >= 400) return 'text-amber-600 dark:text-amber-400'
  if (status >= 300) return 'text-sky-600 dark:text-sky-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

/** Pretty-print a body when it is JSON; otherwise return it unchanged. */
export function prettyBody(text: string, contentType: string): string {
  const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(text)
  if (!looksJson || !text) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
