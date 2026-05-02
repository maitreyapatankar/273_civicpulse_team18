import { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'

export default function PrivateRoute({ children }: { children: ReactNode }) {
  return localStorage.getItem('jwt_token')
    ? <>{children}</>
    : <Navigate to="/officer/login" replace />
}

export function CitizenRoute({ children }: { children: ReactNode }) {
  return localStorage.getItem('citizen_token')
    ? <>{children}</>
    : <Navigate to="/citizen/login" replace />
}
