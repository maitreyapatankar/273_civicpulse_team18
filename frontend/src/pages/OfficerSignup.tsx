import { Link } from 'react-router-dom'
import AppNav from '../components/AppNav'

export default function OfficerSignup() {
  return (
    <div className="min-h-screen bg-grid flex flex-col">
      <AppNav activeRole="officer" />
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="glass-card w-full max-w-3xl rounded-3xl shadow-2xl overflow-hidden">
          <div className="p-10 bg-white">
          <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Officer Access</p>
          <h1 className="font-display text-3xl mt-4">Officer accounts are provisioned.</h1>
          <p className="text-sm text-slate-600 mt-3">
            Dispatcher access is managed by city administration. Contact your supervisor
            or return to login if you already have credentials.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <Link
              to="/officer/login"
              className="rounded-2xl bg-slate-900 text-white px-5 py-3 text-sm font-semibold hover:bg-slate-800 transition"
            >
              Go to officer login
            </Link>
            <Link
              to="/"
              className="rounded-2xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
            >
              Back to home
            </Link>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
