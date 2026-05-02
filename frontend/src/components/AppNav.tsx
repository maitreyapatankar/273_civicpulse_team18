import { Link } from 'react-router-dom'

type Role = 'public' | 'citizen' | 'officer'

interface AppNavProps {
  activeRole?: Role
}

function resolveRoleLink(role: Role): string {
  if (role === 'citizen') {
    return localStorage.getItem('citizen_token')
      ? '/citizen/dashboard'
      : '/citizen/login'
  }
  if (role === 'officer') {
    return localStorage.getItem('jwt_token')
      ? '/officer/dashboard'
      : '/officer/login'
  }
  return '/'
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
                to={resolveRoleLink('citizen')}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full transition ${
                  activeRole === 'citizen'
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Citizen
              </Link>
              <Link
                to={resolveRoleLink('officer')}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full transition ${
                  activeRole === 'officer'
                    ? 'bg-cyan-700 text-white'
                    : 'bg-cyan-50 text-cyan-900 hover:bg-cyan-100'
                }`}
              >
                Officer
              </Link>
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
