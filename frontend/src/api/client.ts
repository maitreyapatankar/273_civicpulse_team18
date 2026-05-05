import axios, { AxiosError } from 'axios'

// F4: validate env var at module load — fail visibly rather than silently hitting
// the wrong origin.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined
if (!API_BASE_URL) {
  console.warn(
    '[CivicPulse] VITE_API_BASE_URL is not set. ' +
    'API requests will target the current origin. ' +
    'Add VITE_API_BASE_URL=http://localhost:8000 to your .env file.',
  )
}

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  // F2: 20s timeout — prevents requests from hanging indefinitely on a slow or
  // unresponsive server. Image uploads (multipart/form-data) override this per-call.
  timeout: 20_000,
})

function shouldSkipAuth(url?: string): boolean {
  if (!url) return false
  return url.startsWith('/auth/')
}

function shouldUseCitizenToken(url?: string): boolean {
  if (!url) return false
  return url.startsWith('/citizens')
}

const OFFICER_STORAGE_KEYS = [
  'jwt_token',
  'officer_name',
  'officer_email',
  'officer_role',
  'officer_id',
] as const

export function clearOfficerSession(): void {
  OFFICER_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key))
}

function decodeJwtPayload(token: string): { exp?: number } | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  const payload = parts[1]
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null

  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  try {
    const json = atob(padded)
    return JSON.parse(json) as { exp?: number }
  } catch (error) {
    console.warn('[CivicPulse] Invalid JWT payload.', error)
    return null
  }
}

export function isTokenExpired(token: string, skewSeconds = 30): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload.exp !== 'number') return true
  const now = Math.floor(Date.now() / 1000)
  return payload.exp <= now + skewSeconds
}

// ── F3: Centralised error message extractor ────────────────────────────────────
// All pages import this instead of rolling their own. Handles:
//   • FastAPI 422 detail arrays  (list of {loc, msg, type})
//   • FastAPI string detail       ("Email already registered")
//   • Network / timeout errors    (no response object)
//   • HTTP status fallbacks
export function extractErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (!(error instanceof AxiosError)) return fallback

  // No response — network problem or request timed out
  if (!error.response) {
    if (error.code === 'ECONNABORTED') return 'The request timed out. Check your connection and try again.'
    return 'Cannot reach the server. Check your internet connection.'
  }

  const detail = error.response.data?.detail

  // FastAPI 422: detail is an array of validation errors
  if (Array.isArray(detail)) {
    const msgs = detail.map((d: { msg?: string }) => d.msg ?? '').filter(Boolean)
    return msgs.length ? msgs.join(', ') : fallback
  }

  if (typeof detail === 'string' && detail.trim()) return detail

  // Status-code fallbacks
  switch (error.response.status) {
    case 400: return 'Invalid request. Please check your inputs.'
    case 401: return 'Your session has expired. Please log in again.'
    case 403: return 'You do not have permission to perform this action.'
    case 404: return 'The requested resource was not found.'
    case 413: return 'The file you uploaded is too large.'
    case 422: return 'Invalid data. Please check your inputs.'
    case 429: return 'Too many requests. Please wait a moment and try again.'
    case 500: return 'Server error. Please try again in a moment.'
    case 502:
    case 503:
    case 504: return 'Service is temporarily unavailable. Please try again shortly.'
  }

  return fallback
}

// ── Request interceptor — attach JWT ──────────────────────────────────────────
api.interceptors.request.use((config) => {
  if (shouldSkipAuth(config.url)) return config

  const citizenToken = localStorage.getItem('citizen_token')
  const officerToken = localStorage.getItem('jwt_token')

  if (shouldUseCitizenToken(config.url)) {
    if (citizenToken) config.headers.Authorization = `Bearer ${citizenToken}`
  } else if (officerToken) {
    if (isTokenExpired(officerToken)) {
      clearOfficerSession()
      if (!window.location.pathname.startsWith('/officer/login')) {
        window.location.href = '/officer/login'
      }
      return config
    }
    config.headers.Authorization = `Bearer ${officerToken}`
  }

  return config
})

// ── F1: Response interceptor — handle expired / invalid JWTs ──────────────────
// 401 on an officer endpoint: wipe all officer state and redirect to login so the
// user is not stuck with an invisible "forbidden" state.
// 401 on a citizen endpoint: clear the citizen token but stay on the page — the
// citizen form is largely anonymous, so a hard redirect would be disruptive.
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const status = error.response?.status
    const url = error.config?.url ?? ''

    if (status === 401 && !shouldSkipAuth(url)) {
      if (shouldUseCitizenToken(url)) {
        localStorage.removeItem('citizen_token')
      } else {
        clearOfficerSession()
        // Only redirect if not already on the login page to avoid redirect loops.
        if (!window.location.pathname.startsWith('/officer/login')) {
          window.location.href = '/officer/login'
        }
      }
    }

    return Promise.reject(error)
  },
)

export default api
