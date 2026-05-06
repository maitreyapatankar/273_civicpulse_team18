import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import DispatcherDashboard from './pages/DispatcherDashboard'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CitizenTracker from './pages/CitizenTracker'
import PrivateRoute from './components/PrivateRoute'
import Landing from './pages/Landing'
import OfficerLogin from './pages/OfficerLogin'
import OfficerSignup from './pages/OfficerSignup'
import CitizenDashboard from './pages/CitizenDashboard'
import StaffDashboard from './pages/StaffDashboard'
import ErrorBoundary from './components/ErrorBoundary'
import SchedulePage from './pages/SchedulePage'
import 'leaflet/dist/leaflet.css'
import './index.css'

// F40: global offline indicator
function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine)
  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline  = () => setOffline(false)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online',  goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online',  goOnline)
    }
  }, [])
  if (!offline) return null
  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-rose-600 text-white text-xs text-center py-2 font-semibold">
      No internet connection — updates paused.
    </div>
  )
}

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <OfflineBanner />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Navigate to="/officer/login" replace />} />
            <Route path="/officer/login" element={<OfficerLogin />} />
            <Route path="/officer/signup" element={<OfficerSignup />} />
            <Route path="/report" element={<CitizenDashboard />} />
            <Route path="/report/:ticketId" element={<CitizenDashboard />} />
            <Route path="/citizen/*" element={<Navigate to="/report" replace />} />
            <Route
              path="/officer/dashboard"
              element={
                <PrivateRoute>
                  <DispatcherDashboard />
                </PrivateRoute>
              }
            />
            <Route
              path="/staff"
              element={
                <PrivateRoute>
                  <StaffDashboard />
                </PrivateRoute>
              }
            />
            <Route path="/track/:ticketId" element={<CitizenTracker />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Navigate to="/officer/login" replace />} />
          <Route path="/officer/login" element={<OfficerLogin />} />
          <Route path="/officer/signup" element={<OfficerSignup />} />
          <Route path="/report" element={<CitizenDashboard />} />
          <Route path="/report/:ticketId" element={<CitizenDashboard />} />
          <Route path="/citizen/*" element={<Navigate to="/report" replace />} />
          <Route
            path="/officer/dashboard"
            element={
              <PrivateRoute>
                <DispatcherDashboard />
              </PrivateRoute>
            }
          />
          <Route
            path="/staff"
            element={
              <PrivateRoute>
                <StaffDashboard />
              </PrivateRoute>
            }
          />
          <Route
            path="/officer/schedule"
            element={
              <PrivateRoute>
                <SchedulePage />
              </PrivateRoute>
            }
          />
          <Route path="/track/:ticketId" element={<CitizenTracker />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
