import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DispatcherDashboard from './pages/DispatcherDashboard'
import CitizenTracker from './pages/CitizenTracker'
import PrivateRoute from './components/PrivateRoute'
import Landing from './pages/Landing'
import OfficerLogin from './pages/OfficerLogin'
import OfficerSignup from './pages/OfficerSignup'
import CitizenDashboard from './pages/CitizenDashboard'
import StaffDashboard from './pages/StaffDashboard'
import 'leaflet/dist/leaflet.css'
import './index.css'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
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
  </React.StrictMode>,
)
