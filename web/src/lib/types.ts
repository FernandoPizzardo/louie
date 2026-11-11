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
  paused?: boolean
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

// ---- breakpoints ----

export interface BreakpointBody {
  type: 'empty' | 'text' | 'binary'
  text: string
  editable?: boolean
}

export interface BreakpointRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: BreakpointBody
}

export interface BreakpointResponse {
  status: number
  headers: Record<string, string>
  body: BreakpointBody
}

export interface BreakpointHit {
  id: number
  transactionId: number
  phase: 'request' | 'response'
  deadline: number
  summary: TxSummary
  request: BreakpointRequest
  response: BreakpointResponse
}

// ---- tool config (editable via Settings) ----

export interface LocationPattern {
  protocol?: string
  host?: string
  port?: number | string
  path?: string
  query?: string
}

export interface BlocklistRule {
  enabled?: boolean
  location: LocationPattern
}

export interface MapRemoteRule {
  enabled?: boolean
  from: LocationPattern
  to: LocationPattern
}

export interface MapLocalRule {
  enabled?: boolean
  location: LocationPattern
  localPath: string
  caseSensitive?: boolean
}

export interface RewriteRule {
  enabled?: boolean
  type: 'url' | 'header' | 'body'
  match: string
  replace: string
}

export interface RewriteSet {
  enabled?: boolean
  location: LocationPattern
  rules: RewriteRule[]
}

export interface ThrottleConfig {
  latency?: number
  bandwidthDown?: number
  bandwidthUp?: number
  loss?: number
  hosts?: LocationPattern[]
}

export interface BreakpointRule {
  enabled?: boolean
  scope: 'request' | 'response' | 'both'
  location: LocationPattern
}

export interface BreakpointsConfig {
  enabled?: boolean
  timeoutMs?: number
  rules: BreakpointRule[]
}

export interface EngineConfig {
  enabled: Record<string, boolean>
  lanEnabled: boolean
  blockAction?: 'drop' | '403'
  blocklist?: BlocklistRule[]
  mapRemote?: MapRemoteRule[]
  mapLocal?: MapLocalRule[]
  rewrite?: RewriteSet[]
  throttle?: ThrottleConfig
  breakpoints?: BreakpointsConfig
  sslLocations?: LocationPattern[]
  [key: string]: unknown
}

// ---- profiles (shareable tool configuration) ----

export interface ProfileExportResult {
  ok: boolean
  name?: string
  fileName?: string
  captures?: number
  profile?: unknown
  error?: string
}

export interface ProfileSectionCount {
  name?: string
  exportedAt?: string
  louieVersion?: string
  sections: Record<string, number>
}

export interface ProfileCaptureSummary {
  ts?: string
  method?: string
  host?: string
  port?: number | string
  path?: string
  status?: number
  error?: string | null
  notes?: string[]
}

export interface ProfileInspectResult {
  ok: boolean
  info?: ProfileSectionCount
  captures?: ProfileCaptureSummary[]
  error?: string
}

export interface ProfileImportResult {
  ok: boolean
  applied?: string[]
  warnings?: string[]
  skipped?: string[]
  error?: string
}

/** Sections a profile can carry, with the label shown in the import picker. */
export const PROFILE_SECTIONS = [
  { key: 'enabled', label: 'Tool on/off switches' },
  { key: 'blocklist', label: 'Block List' },
  { key: 'mapRemote', label: 'Map Remote' },
  { key: 'mapLocal', label: 'Map Local' },
  { key: 'rewrite', label: 'Rewrite' },
  { key: 'throttle', label: 'Throttle' },
  { key: 'breakpoints', label: 'Breakpoints' },
  { key: 'sslLocations', label: 'SSL Proxying locations' },
] as const

export const TOOL_KEYS = [
  { key: 'blocklist', label: 'Block List' },
  { key: 'mapRemote', label: 'Map Remote' },
  { key: 'mapLocal', label: 'Map Local' },
  { key: 'rewrite', label: 'Rewrite' },
  { key: 'throttle', label: 'Throttle' },
  { key: 'noCache', label: 'No Caching' },
] as const
