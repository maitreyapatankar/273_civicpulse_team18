import { Link } from 'react-router-dom'
import AppNav from '../components/AppNav'

export default function Landing() {
  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="public" />
      <div className="relative overflow-hidden">
        <div className="absolute -top-40 -left-32 h-72 w-72 rounded-full bg-cyan-200/50 blur-3xl" />
        <div className="absolute top-16 right-[-6rem] h-80 w-80 rounded-full bg-amber-200/60 blur-3xl" />
        <div className="absolute bottom-[-8rem] left-1/2 h-80 w-80 rounded-full bg-rose-200/40 blur-3xl" />

        <div className="relative mx-auto max-w-6xl px-6 py-12 lg:py-20">
          <header className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.32em] text-slate-500">
                CivicPulse 2026
              </p>
              <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl text-slate-900 mt-3">
                The live pulse of city infrastructure.
              </h1>
              <p className="text-base sm:text-lg text-slate-600 mt-4 max-w-2xl">
                CivicPulse turns citizen reports into prioritized work orders in minutes.
                AI triage, smart deduplication, and a dispatcher-ready queue give cities
                a single source of truth for street safety.
              </p>
            </div>
            <div className="glass-card rounded-3xl p-6 shadow-xl max-w-lg w-full">
              <p className="text-sm text-slate-500 uppercase tracking-[0.18em]">
                Start here
              </p>
              <div className="mt-4 grid gap-4">
                <div className="rounded-3xl border border-slate-200 bg-white p-4">
                  <p className="text-sm font-semibold text-slate-900">For residents</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Submit a complaint anonymously and get a tracking link instantly.
                  </p>
                  <div className="mt-4 flex flex-col sm:flex-row gap-2">
                    <Link
                      to="/report"
                      className="rounded-2xl bg-slate-900 text-white px-4 py-2.5 text-xs font-semibold hover:bg-slate-800 transition text-center"
                    >
                      Submit complaint
                    </Link>
                  </div>
                </div>
                <div className="rounded-3xl border border-cyan-200 bg-cyan-50 p-4">
                  <p className="text-sm font-semibold text-cyan-900">For staff</p>
                  <p className="text-xs text-cyan-800 mt-1">
                    Review AI-prioritized tickets and dispatch crews faster.
                  </p>
                  <div className="mt-4 flex flex-col sm:flex-row gap-2">
                    <Link
                      to="/staff"
                      className="rounded-2xl bg-cyan-700 text-white px-4 py-2.5 text-xs font-semibold hover:bg-cyan-800 transition text-center"
                    >
                      Staff login
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </header>

          <section className="mt-16 grid gap-6 lg:grid-cols-3">
            {[
              {
                title: 'Report in seconds',
                desc: 'One photo, one location pin, instant queue placement.',
                tone: 'bg-white',
              },
              {
                title: 'AI triage',
                desc: 'Classification, dedup, urgency, and work order generation.',
                tone: 'bg-slate-50',
              },
              {
                title: 'Dispatcher clarity',
                desc: 'One queue, realtime confidence, actionable next steps.',
                tone: 'bg-white',
              },
            ].map((item) => (
              <div
                key={item.title}
                className={`glass-card rounded-3xl p-6 shadow-lg ${item.tone}`}
              >
                <h3 className="text-lg font-semibold text-slate-900">{item.title}</h3>
                <p className="text-sm text-slate-600 mt-2">{item.desc}</p>
              </div>
            ))}
          </section>

          <section className="mt-14 grid gap-6 lg:grid-cols-2">
            <div className="glass-card rounded-3xl p-6 shadow-lg">
              <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Live signal</p>
              <div className="mt-4 grid grid-cols-3 gap-4">
                {[
                  { label: 'Reports today', value: '1,248' },
                  { label: 'Avg. triage', value: '2m 11s' },
                  { label: 'Resolved this week', value: '9,311' },
                ].map((stat) => (
                  <div key={stat.label}>
                    <p className="text-2xl font-semibold text-slate-900">{stat.value}</p>
                    <p className="text-xs text-slate-500 mt-1">{stat.label}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="glass-card rounded-3xl p-6 shadow-lg">
              <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Trusted by</p>
              <div className="mt-5 grid grid-cols-2 gap-4 text-sm text-slate-600">
                <span className="rounded-2xl border border-slate-200 px-4 py-3">
                  Metro Ops
                </span>
                <span className="rounded-2xl border border-slate-200 px-4 py-3">
                  City Works
                </span>
                <span className="rounded-2xl border border-slate-200 px-4 py-3">
                  StreetSafe
                </span>
                <span className="rounded-2xl border border-slate-200 px-4 py-3">
                  DOT Central
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
