import { Link, useNavigate } from 'react-router-dom'
import { clearOfficerSession, isTokenExpired } from '../api/client'

type Role = 'public' | 'citizen' | 'officer'

interface AppNavProps {
  activeRole?: Role
}

export default function AppNav({ activeRole = 'public' }: AppNavProps) {
  const navigate = useNavigate()
  const isStaffActive = activeRole === 'officer'
  const officerToken = localStorage.getItem('jwt_token') || ''
  const isLoggedIn = Boolean(officerToken) && !isTokenExpired(officerToken)

  if (officerToken && !isLoggedIn) {
    clearOfficerSession()
  }

  // F41: clear all officer and citizen tokens, then redirect home
  function handleLogout() {
    clearOfficerSession()
    localStorage.removeItem('citizen_token')
    navigate('/', { replace: true })
  }

  const staffTarget = isLoggedIn ? '/staff' : '/officer/login'

  return (
    <nav className="w-full">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="glass-card rounded-3xl px-5 py-4 shadow-lg">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-semibold">
                CP
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">CivicPulse</p>
                <p className="text-xs text-slate-500">AI-first city operations</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/"
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 transition"
              >
                Home
              </Link>
              <Link
                to="/report"
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 transition"
              >
                Report issue
              </Link>
              <Link
                to={staffTarget}
                aria-current={isStaffActive ? 'page' : undefined}
                className={`text-xs font-semibold transition ${
                  isStaffActive ? 'text-slate-900' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Staff
              </Link>
              {isLoggedIn && (
                <button
                  type="button"
                  onClick={handleLogout}
                  className="text-xs font-semibold text-rose-600 hover:text-rose-700 transition"
                >
                  Sign out
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
