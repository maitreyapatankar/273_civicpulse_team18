import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

function shouldSkipAuth(url?: string): boolean {
  if (!url) return false
  return url.startsWith('/auth/')
}

function shouldUseCitizenToken(url?: string): boolean {
  if (!url) return false
  return url.startsWith('/citizens') || url.startsWith('/reports')
}

// Attach JWT from localStorage for authenticated endpoints
api.interceptors.request.use((config) => {
  if (shouldSkipAuth(config.url)) {
    return config
  }

  const citizenToken = localStorage.getItem('citizen_token')
  const officerToken = localStorage.getItem('jwt_token')

  if (shouldUseCitizenToken(config.url)) {
    if (citizenToken) {
      config.headers.Authorization = `Bearer ${citizenToken}`
    }
  } else if (officerToken) {
    config.headers.Authorization = `Bearer ${officerToken}`
  }

  return config
})

export default api
