import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../api/client'
import AppNav from '../components/AppNav'
import { useTicketStream } from '../hooks/useTicketStream'

interface StatusResponse {
  id: string
  status: 'queued' | 'processing' | 'open' | 'in_progress' | 'resolved' | 'failed'
  issue_type: string | null
  urgency_score: number | null
  duplicate_of: string | null
  cluster_count: number
  assigned_to: string | null
  assigned_at: string | null
  resolved_at: string | null
  created_at: string
}

const TERMINAL = new Set(['resolved', 'failed'])

const STATUS_META: Record<string, { label: string; classes: string; description: string }> = {
  queued:      { label: 'In Queue',         classes: 'bg-slate-100 text-slate-600',     description: "We've received your report and it's waiting to be processed." },
  processing:  { label: 'Processing',       classes: 'bg-cyan-100 text-cyan-800',       description: 'Our AI is analyzing your report now.' },
  open:        { label: 'Under Review',     classes: 'bg-amber-100 text-amber-800',     description: 'A dispatcher is reviewing your report.' },
  in_progress: { label: 'In Progress',      classes: 'bg-indigo-100 text-indigo-800',   description: 'A crew has been dispatched. Work is underway.' },
  resolved:    { label: 'Resolved',         classes: 'bg-emerald-100 text-emerald-800', description: 'This issue has been resolved. Thank you for reporting it!' },
  failed:      { label: 'Could Not Process', classes: 'bg-rose-100 text-rose-700',      description: 'We had trouble processing your report. Please try submitting again.' },
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function CitizenTracker() {
  const { ticketId } = useParams<{ ticketId: string }>()
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery<StatusResponse>({
    queryKey: ['ticket-status', ticketId],
    queryFn: () => api.get(`/tickets/${ticketId}/status`).then((r) => r.data),
    // Long-poll fallback in case SSE is blocked by a proxy.
    refetchInterval: (query) =>
      TERMINAL.has(query.state.data?.status ?? '') ? false : 60_000,
    enabled: Boolean(ticketId),
  })

  useTicketStream({
    path: `/events/citizen/${ticketId ?? ''}`,
    enabled: Boolean(ticketId) && !TERMINAL.has(data?.status ?? ''),
    onEvent: () => {
      queryClient.invalidateQueries({ queryKey: ['ticket-status', ticketId] })
    },
  })

  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="citizen" />
      <div className="w-full max-w-md mx-auto px-4 pb-10">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1 className="font-display text-3xl text-slate-900">Report Status</h1>
          <p className="text-xs text-slate-500 mt-2 font-mono break-all">{ticketId}</p>
        </div>

        {isLoading && (
          <div className="glass-card rounded-2xl shadow-sm p-8 text-center text-slate-400 text-sm animate-pulse">
            Loading your report…
          </div>
        )}

        {isError && (
          <div className="glass-card rounded-2xl shadow-sm p-8 text-center">
            <p className="text-rose-600 font-medium">Report not found</p>
            <p className="text-slate-500 text-sm mt-1">
              Check the link and try again.
            </p>
          </div>
        )}

        {data && (() => {
          const meta = STATUS_META[data.status] ?? STATUS_META['queued']
          const isResolved = data.status === 'resolved'
          return (
            <div className="glass-card rounded-2xl shadow-sm overflow-hidden">
              {/* Status band */}
              <div className={`px-5 py-4 ${meta.classes}`}>
                <div className="flex items-center gap-2">
                  {isResolved && (
                    <svg className="w-5 h-5 text-emerald-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {!isResolved && data.status !== 'failed' && (
                    <span className="inline-block w-2 h-2 rounded-full bg-current opacity-70 animate-pulse flex-shrink-0" />
                  )}
                  <span className="font-semibold text-base">{meta.label}</span>
                </div>
                <p className="text-sm mt-1 opacity-80">{meta.description}</p>
              </div>

              {/* Details */}
              <div className="px-5 py-4 space-y-4">
                {/* Duplicate / merge notice */}
                {data.duplicate_of && data.cluster_count > 1 && (
                  <div className="bg-cyan-50 border border-cyan-100 rounded-xl px-4 py-3 text-sm text-cyan-900">
                    Your report was merged with{' '}
                    <strong>{data.cluster_count - 1}</strong> similar nearby report
                    {data.cluster_count > 2 ? 's' : ''}. We're addressing them together.
                  </div>
                )}

                {/* Issue type */}
                {data.issue_type && (
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                      Issue Type
                    </p>
                    <p className="text-slate-900 font-medium capitalize">
                      {data.issue_type.replace('_', ' ')}
                    </p>
                  </div>
                )}

                {/* Crew assignment */}
                {data.assigned_to && (
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                      Assigned crew
                    </p>
                    <p className="text-slate-700 text-sm">{data.assigned_to}</p>
                    {data.assigned_at && (
                      <p className="text-xs text-slate-400">{formatDate(data.assigned_at)}</p>
                    )}
                  </div>
                )}

                {/* Timeline */}
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                    Submitted
                  </p>
                  <p className="text-slate-700 text-sm">{formatDate(data.created_at)}</p>
                </div>

                {data.resolved_at && (
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                      Resolved
                    </p>
                    <p className="text-slate-700 text-sm">{formatDate(data.resolved_at)}</p>
                  </div>
                )}

                {/* Auto-refresh notice */}
                {!TERMINAL.has(data.status) && (
                  <p className="text-xs text-slate-400 text-center pt-1">
                    Live updates — this page refreshes the moment your report changes.
                  </p>
                )}
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
