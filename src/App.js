import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './Auth';
import Expense from './Expense';
import './App.css';

/* ── Route Guards ───────────────────────────────────────────── */
const PrivateRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading__logo">₹</div>
        <div className="app-loading__text">Loading FinTrack…</div>
      </div>
    );
  }
  return user ? children : <Navigate to="/login" replace />;
};

const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return null;
  return !user ? children : <Navigate to="/dashboard" replace />;
};

/* ── App ────────────────────────────────────────────────────── */
export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={
              <PublicRoute>
                <AuthPage mode="login" />
              </PublicRoute>
            }
          />
          <Route
            path="/signup"
            element={
              <PublicRoute>
                <AuthPage mode="signup" />
              </PublicRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <PrivateRoute>
                <DashboardPage />
              </PrivateRoute>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

/* ── Page wrappers ──────────────────────────────────────────── */
const { Login, Signup } = require('./Auth');

function AuthPage({ mode }) {
  if (mode === 'login') return <Login />;
  return <Signup />;
}

function DashboardPage() {
  const { user, logout } = useAuth();
  return <Expense user={user} onLogout={logout} />;
}