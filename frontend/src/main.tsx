import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DispatcherDashboard from './pages/DispatcherDashboard'
import CitizenTracker from './pages/CitizenTracker'
import Login from './pages/Login'
import PrivateRoute from './components/PrivateRoute'
import './index.css'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/dashboard"
            element={
              <PrivateRoute>
                <DispatcherDashboard />
              </PrivateRoute>
            }
          />
          <Route path="/track/:ticketId" element={<CitizenTracker />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
