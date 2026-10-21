// Thin client for the engine control API. Requests are same-origin (Vite's dev
// proxy in development, the Electron shell later), so no CORS handling here.

const TOKEN_KEY = 'louie.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['x-charles-token'] = token

  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const res = await fetch(path, {
    method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | undefined)?.error ?? res.statusText
    throw new ApiError(res.status, msg)
  }
  return json as T
}

/** EventSource cannot send headers, so the token rides in the query string. */
export function eventsUrl(): string {
  const token = getToken()
  return token ? `/events?token=${encodeURIComponent(token)}` : '/events'
}

/** Fetch a route that needs the token header and hand back a Blob. */
export async function fetchBlob(path: string): Promise<Blob> {
  const token = getToken()
  const res = await fetch(path, { headers: token ? { 'x-charles-token': token } : {} })
  if (!res.ok) throw new ApiError(res.status, res.statusText)
  return res.blob()
}
