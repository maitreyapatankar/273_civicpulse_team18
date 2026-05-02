import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AppNav from '../components/AppNav'
import api from '../api/client'
import { CitizenAuthResponse } from '../api/types'

function humanizeError(message: string): string {
  if (message.toLowerCase().includes('at least 8')) {
    return 'Password must be at least 8 characters.'
  }
  if (message.toLowerCase().includes('already exists')) {
    return 'An account with this email already exists.'
  }
  return message
}

function extractApiError(error: unknown): string {
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (error as { response?: { data?: any } }).response
    const detail = response?.data?.detail
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0]
      if (first?.msg) return humanizeError(first.msg)
    }
    if (typeof detail === 'string') return humanizeError(detail)
  }
  return 'Could not create account. Please try again.'
}

export default function CitizenSignup() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data } = await api.post<CitizenAuthResponse>('/auth/citizen/signup', {
        name,
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
        <div className="p-8 lg:p-10 bg-cyan-700 text-white">
          <p className="text-xs uppercase tracking-[0.32em] text-cyan-100">Citizen Access</p>
          <h1 className="font-display text-3xl lg:text-4xl mt-4">Join CivicPulse.</h1>
          <p className="text-sm text-cyan-50 mt-3">
            Report issues fast, get real-time status, and help keep streets safer.
          </p>
          <div className="mt-8 text-xs text-cyan-100">
            Already have an account?{' '}
            <Link to="/citizen/login" className="text-white underline">
              Log in
            </Link>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-8 lg:p-10 bg-white">
          <h2 className="text-xl font-semibold text-slate-900">Citizen Sign Up</h2>
          <p className="text-sm text-slate-500 mt-1">Create your account to file reports.</p>

          <div className="mt-6 space-y-4">
            <div>
              <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Full Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>
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
              <p className="text-xs text-slate-400 mt-2">Minimum 8 characters.</p>
            </div>
          </div>

          {error && <p className="text-sm text-rose-600 mt-4">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-6 w-full rounded-2xl bg-slate-900 text-white py-3 text-sm font-semibold hover:bg-slate-800 transition"
          >
            {loading ? 'Creating…' : 'Create account'}
          </button>
        </form>
        </div>
      </div>
    </div>
  )
}
