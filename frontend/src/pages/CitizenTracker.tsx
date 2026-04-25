import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../api/client'

interface StatusResponse {
  id: string
  status: 'queued' | 'processing' | 'open' | 'done' | 'resolved' | 'failed'
  issue_type: string | null
  urgency_score: number | null
  duplicate_of: string | null
  cluster_count: number
  created_at: string
  resolved_at: string | null
}

const TERMINAL = new Set(['done', 'resolved', 'failed'])

const STATUS_META: Record<string, { label: string; classes: string; description: string }> = {
  queued:     { label: 'In Queue',         classes: 'bg-gray-100 text-gray-600',   description: "We've received your report and it's waiting to be processed." },
  processing: { label: 'Processing',       classes: 'bg-blue-100 text-blue-700',   description: 'Our AI is analyzing your report now.' },
  open:       { label: 'Under Review',     classes: 'bg-amber-100 text-amber-700', description: 'A dispatcher is reviewing your report.' },
  done:       { label: 'Resolved',         classes: 'bg-green-100 text-green-700', description: 'This issue has been resolved. Thank you for reporting it!' },
  resolved:   { label: 'Resolved',         classes: 'bg-green-100 text-green-700', description: 'This issue has been resolved. Thank you for reporting it!' },
  failed:     { label: 'Could Not Process', classes: 'bg-red-100 text-red-600',    description: 'We had trouble processing your report. Please try submitting again.' },
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function CitizenTracker() {
  const { ticketId } = useParams<{ ticketId: string }>()

  const { data, isLoading, isError } = useQuery<StatusResponse>({
    queryKey: ['ticket-status', ticketId],
    queryFn: () => api.get(`/tickets/${ticketId}/status`).then((r) => r.data),
    refetchInterval: (query) =>
      TERMINAL.has(query.state.data?.status ?? '') ? false : 10_000,
    enabled: Boolean(ticketId),
  })

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Report Status</h1>
          <p className="text-sm text-gray-400 mt-1 font-mono break-all">{ticketId}</p>
        </div>

        {isLoading && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center text-gray-400 text-sm animate-pulse">
            Loading your report…
          </div>
        )}

        {isError && (
          <div className="bg-white rounded-2xl shadow-sm border border-red-200 p-8 text-center">
            <p className="text-red-600 font-medium">Report not found</p>
            <p className="text-gray-400 text-sm mt-1">
              Check the link and try again.
            </p>
          </div>
        )}

        {data && (() => {
          const meta = STATUS_META[data.status] ?? STATUS_META['queued']
          const isResolved = TERMINAL.has(data.status) && data.status !== 'failed'
          return (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
              {/* Status band */}
              <div className={`px-5 py-4 ${meta.classes}`}>
                <div className="flex items-center gap-2">
                  {isResolved && (
                    <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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
                  <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 text-sm text-indigo-800">
                    Your report was merged with{' '}
                    <strong>{data.cluster_count - 1}</strong> similar nearby report
                    {data.cluster_count > 2 ? 's' : ''}. We're addressing them together.
                  </div>
                )}

                {/* Issue type */}
                {data.issue_type && (
                  <div>
                    <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-0.5">
                      Issue Type
                    </p>
                    <p className="text-gray-800 font-medium capitalize">
                      {data.issue_type.replace('_', ' ')}
                    </p>
                  </div>
                )}

                {/* Timeline */}
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-0.5">
                    Submitted
                  </p>
                  <p className="text-gray-700 text-sm">{formatDate(data.created_at)}</p>
                </div>

                {data.resolved_at && (
                  <div>
                    <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-0.5">
                      Resolved
                    </p>
                    <p className="text-gray-700 text-sm">{formatDate(data.resolved_at)}</p>
                  </div>
                )}

                {/* Auto-refresh notice */}
                {!TERMINAL.has(data.status) && (
                  <p className="text-xs text-gray-400 text-center pt-1">
                    This page updates automatically every 10 seconds.
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
