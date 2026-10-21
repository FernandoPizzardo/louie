// Shapes of the engine control API. Source of truth: docs/control-api.md.

export interface TxNote {
  tool: string
  text: string
}

export interface TxSummary {
  id: number
  scheme: string
  method: string
  host: string
  port: number
  path: string
  status: number
  durationMs: number
  sslProxied: boolean
  tunneled: boolean
  error: string | null
  complete: boolean
  reqSize: number
  resSize: number
  contentType: string
  notes: TxNote[]
  start: number
}

export interface TxBody {
  type: 'empty' | 'text' | 'binary'
  text: string
  truncated?: boolean
}

export interface TxDetail extends TxSummary {
  requestHeaders: Record<string, string>
  requestBody: TxBody
  responseHeaders: Record<string, string>
  responseBody: TxBody
}

export interface Status {
  proxyPort: number
  webPort: number
  recording: boolean
  count: number
  leafCertsGenerated: number
  sslLocations: { host: string; port?: number | string }[]
  enabled: Record<string, boolean>
}

export interface PersistSettings {
  enabled: boolean
  dir: string | null
  maxBodyBytes: number
  retentionDays: number
}

export interface SaveResult {
  ok: boolean
  needsConfirm?: boolean
  size?: number
  cap?: number
  name?: string
  path?: string
  truncated?: boolean
  error?: string
}

export interface CaInfo {
  path: string
  subject: string | null
  fingerprint: string | null
  fingerprintHex: string | null
  trusted: boolean
}

export interface NetInfo {
  lanEnabled: boolean
  ip: string
  proxyPort: number
  caServePort: number
  serving: boolean
  cerUrl: string
  mobileconfigUrl: string
  proxyHost: string
}

export interface EngineConfig {
  enabled: Record<string, boolean>
  lanEnabled: boolean
  [key: string]: unknown
}

export const TOOL_KEYS = [
  { key: 'blocklist', label: 'Block List' },
  { key: 'mapRemote', label: 'Map Remote' },
  { key: 'mapLocal', label: 'Map Local' },
  { key: 'rewrite', label: 'Rewrite' },
  { key: 'throttle', label: 'Throttle' },
  { key: 'noCache', label: 'No Caching' },
] as const
