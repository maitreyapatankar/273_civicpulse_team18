import { Link } from 'react-router-dom'

type Role = 'public' | 'citizen' | 'officer'

interface AppNavProps {
  activeRole?: Role
}

function staffLink(): string {
  return localStorage.getItem('jwt_token') ? '/staff' : '/officer/login'
}

export default function AppNav({ activeRole = 'public' }: AppNavProps) {
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
                to={staffLink()}
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 transition"
              >
                Staff
              </Link>
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
