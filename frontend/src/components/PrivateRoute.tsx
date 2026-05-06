import { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { clearOfficerSession, isTokenExpired } from '../api/client'

export default function PrivateRoute({ children }: { children: ReactNode }) {
  const token = localStorage.getItem('access_token')
  if (!token || isTokenExpired(token)) {
    if (token) clearOfficerSession()
    return <Navigate to="/officer/login" replace />
  }
  return <>{children}</>
}

export function CitizenRoute({ children }: { children: ReactNode }) {
  return localStorage.getItem('citizen_token')
    ? <>{children}</>
    : <Navigate to="/citizen/login" replace />
}
