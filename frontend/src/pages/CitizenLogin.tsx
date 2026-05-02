import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AppNav from '../components/AppNav'
import api from '../api/client'
import { CitizenAuthResponse } from '../api/types'

function extractApiError(error: unknown): string {
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (error as { response?: { data?: any } }).response
    const detail = response?.data?.detail
    if (typeof detail === 'string') return detail
  }
  return 'Invalid email or password.'
}

export default function CitizenLogin() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data } = await api.post<CitizenAuthResponse>('/auth/citizen/login', {
        email,
        password,
      })
      localStorage.setItem('citizen_token', data.access_token)
      navigate('/citizen/dashboard', { replace: true })
    } catch (error) {
      setError(extractApiError(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-grid flex flex-col">
      <AppNav activeRole="citizen" />
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="glass-card w-full max-w-4xl rounded-3xl shadow-2xl grid lg:grid-cols-2 overflow-hidden">
        <div className="p-8 lg:p-10 bg-slate-900 text-white">
          <p className="text-xs uppercase tracking-[0.32em] text-slate-300">Citizen Access</p>
          <h1 className="font-display text-3xl lg:text-4xl mt-4">Welcome back.</h1>
          <p className="text-sm text-slate-200 mt-3">
            Track your reports, submit new complaints, and stay updated as your city responds.
          </p>
          <div className="mt-8 text-xs text-slate-300">
            Not registered?{' '}
            <Link to="/citizen/signup" className="text-white underline">
              Create an account
            </Link>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-8 lg:p-10 bg-white">
          <h2 className="text-xl font-semibold text-slate-900">Citizen Login</h2>
          <p className="text-sm text-slate-500 mt-1">Sign in to access your reports.</p>

          <div className="mt-6 space-y-4">
            <div>
              <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>
          </div>

          {error && <p className="text-sm text-rose-600 mt-4">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-6 w-full rounded-2xl bg-cyan-700 text-white py-3 text-sm font-semibold hover:bg-cyan-800 transition"
          >
            {loading ? 'Signing in…' : 'Continue'}
          </button>
        </form>
        </div>
      </div>
    </div>
  )
}
