import { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'

export default function PrivateRoute({ children }: { children: ReactNode }) {
  return localStorage.getItem('jwt_token')
    ? <>{children}</>
    : <Navigate to="/login" replace />
}
