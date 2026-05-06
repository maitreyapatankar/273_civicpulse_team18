import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api, { extractErrorMessage } from '../api/client'
import AppNav from '../components/AppNav'
import { OfficerAuthResponse } from '../api/types'

export default function OfficerLogin() {
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
      const { data } = await api.post<OfficerAuthResponse>('/auth/officer/login', {
        email,
        password,
      })
      console.log('Login successful, storing token:', data.access_token.substring(0, 20) + '...')
      localStorage.setItem('access_token', data.access_token)
      if (data.name) localStorage.setItem('officer_name', data.name)
      if (data.email) localStorage.setItem('officer_email', data.email)
      if (data.role) localStorage.setItem('officer_role', data.role)
      if (data.officer_id) localStorage.setItem('officer_id', data.officer_id)
      console.log('Token stored, navigating to /staff...')
      navigate('/staff', { replace: true })
      console.log('Navigate called')
    } catch (error) {
      // F20: 401 means wrong credentials on a login form, not an expired session.
      // For everything else (network down, server error) use the shared extractor.
      const status = (error as { response?: { status?: number } })?.response?.status
      setError(status === 401 ? 'Invalid email or password.' : extractErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-grid flex flex-col">
      <AppNav activeRole="officer" />
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="glass-card w-full max-w-4xl rounded-3xl shadow-2xl grid lg:grid-cols-2 overflow-hidden">
        <div className="p-8 lg:p-10 bg-slate-900 text-white">
          <p className="text-xs uppercase tracking-[0.32em] text-slate-300">Officer Access</p>
          <h1 className="font-display text-3xl lg:text-4xl mt-4">Dispatcher console.</h1>
          <p className="text-sm text-slate-200 mt-3">
            Review high-priority tickets, override AI decisions, and coordinate city response.
          </p>
          <div className="mt-8 text-xs text-slate-300">
            Need access?{' '}
            <Link to="/officer/signup" className="text-white underline">
              Request an account
            </Link>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-8 lg:p-10 bg-white">
          <h2 className="text-xl font-semibold text-slate-900">Officer Login</h2>
          <p className="text-sm text-slate-500 mt-1">Secure dispatcher sign-in.</p>

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
            className="mt-6 w-full rounded-2xl bg-cyan-700 text-white py-3 text-sm font-semibold hover:bg-cyan-800 disabled:opacity-60 transition"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        </div>
      </div>
    </div>
  )
}
