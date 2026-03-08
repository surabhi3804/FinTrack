import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import './Auth.css';

/* ─────────────────────────────────────────────
   API instance
───────────────────────────────────────────── */
const API = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:10000/api',
  timeout: 15000
});

API.interceptors.request.use((config) => {
  const token = localStorage.getItem('ft_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

API.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('ft_token');
      localStorage.removeItem('ft_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export { API };

/* ─────────────────────────────────────────────
   Auth Context
───────────────────────────────────────────── */
const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ft_user')); }
    catch { return null; }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('ft_token');
    if (!token) { setLoading(false); return; }
    API.get('/auth/me')
      .then(res => setUser(res.data.user))
      .catch(() => {
        // ✅ FIX: Fall back to stored user instead of wiping auth state
        try {
          const storedUser = JSON.parse(localStorage.getItem('ft_user'));
          if (storedUser) {
            setUser(storedUser);
          } else {
            localStorage.removeItem('ft_token');
            localStorage.removeItem('ft_user');
          }
        } catch {
          localStorage.removeItem('ft_token');
          localStorage.removeItem('ft_user');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (credentials) => {
    const res = await API.post('/auth/login', credentials);
    const { token, user: u } = res.data;
    localStorage.setItem('ft_token', token);
    localStorage.setItem('ft_user', JSON.stringify(u));
    setUser(u);
    return u;
  }, []);

  const signup = useCallback(async (data) => {
    const res = await API.post('/auth/signup', data);
    const { token, user: u } = res.data;
    localStorage.setItem('ft_token', token);
    localStorage.setItem('ft_user', JSON.stringify(u));
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('ft_token');
    localStorage.removeItem('ft_user');
    setUser(null);
  }, []);

  const updateUser = useCallback((updates) => {
    setUser(prev => {
      const updated = { ...prev, ...updates };
      localStorage.setItem('ft_user', JSON.stringify(updated));
      return updated;
    });
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

/* ─────────────────────────────────────────────
   Brand Panel (shared between Login & Signup)
───────────────────────────────────────────── */
const BrandPanel = ({ headline, sub, features }) => (
  <div className="auth-brand-panel">
    <div className="auth-brand-deco">
      <div className="auth-brand-deco__circle" />
      <div className="auth-brand-deco__circle" />
      <div className="auth-brand-deco__circle" />
      <div className="auth-brand-deco__dot" />
      <div className="auth-brand-deco__dot" />
      <div className="auth-brand-deco__dot" />
    </div>
    <div className="auth-logo">
      <div className="auth-logo__mark">₹</div>
      <div>
        <div className="auth-logo__name">FinTrack</div>
        <div className="auth-logo__sub">Personal Finance</div>
      </div>
    </div>
    <div className="auth-brand-content">
      <h1 dangerouslySetInnerHTML={{ __html: headline }} />
      <p>{sub}</p>
    </div>
    <div className="auth-brand-features">
      {features.map((f, i) => (
        <div key={i} className="auth-brand-feat">
          <div className="auth-brand-feat__icon">{f.icon}</div>
          <div className="auth-brand-feat__text">{f.text}</div>
        </div>
      ))}
    </div>
  </div>
);

/* ─────────────────────────────────────────────
   Password strength helper
───────────────────────────────────────────── */
const getStrength = (pw) => {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 6) s++;
  if (/[A-Z]/.test(pw) || /[0-9]/.test(pw)) s++;
  if (pw.length >= 10 && /[^a-zA-Z0-9]/.test(pw)) s++;
  return s;
};
const strengthLabel = ['', 'Weak', 'Fair', 'Strong'];

/* ─────────────────────────────────────────────
   LOGIN PAGE
───────────────────────────────────────────── */
export const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm]       = useState({ username: '', password: '' });
  const [showPw, setShowPw]   = useState(false);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [fieldErr, setFieldErr] = useState({});

  const set = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setError('');
    setFieldErr({});
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.username.trim()) errs.username = true;
    if (!form.password)        errs.password = true;
    if (Object.keys(errs).length) {
      setFieldErr(errs);
      setError('Please fill in all fields.');
      return;
    }
    setLoading(true);
    try {
      await login(form);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
      setFieldErr({ username: true, password: true });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <BrandPanel
        headline="Welcome back,<br/><span>sign back in.</span>"
        sub="Access your personal dashboard and pick up right where you left off — every rupee accounted for."
        features={[
          { icon: '🔒', text: 'Private per-user accounts' },
          { icon: '🤖', text: 'AI-powered expense categorization' },
          { icon: '📊', text: 'Visual spending analytics' },
        ]}
      />
      <div className="auth-form-panel">
        <div className="auth-form-box">
          <div className="auth-form-box__header">
            <h2 className="auth-form-box__title">Welcome back</h2>
            <p className="auth-form-box__subtitle">Sign in to your FinTrack account</p>
          </div>
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            {error && (
              <div className="auth-message auth-message--error">
                <span>⚠</span> {error}
              </div>
            )}

            {/* Username */}
            <div className="auth-field">
              <label className="auth-label">Username</label>
              <div className="auth-input-wrap">
                <span className="auth-input-wrap__icon">👤</span>
                <input
                  className={`auth-input${fieldErr.username ? ' auth-input--error' : ''}`}
                  type="text" placeholder="Enter your username"
                  value={form.username}
                  onChange={e => set('username', e.target.value)}
                  autoComplete="username" autoFocus
                />
              </div>
            </div>

            {/* Password */}
            <div className="auth-field">
              <label className="auth-label">Password</label>
              <div className="auth-input-wrap">
                <span className="auth-input-wrap__icon">🔑</span>
                <input
                  className={`auth-input${fieldErr.password ? ' auth-input--error' : ''}`}
                  type={showPw ? 'text' : 'password'}
                  placeholder="Enter your password"
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  autoComplete="current-password"
                />
                <button type="button" className="auth-password-toggle"
                  onClick={() => setShowPw(s => !s)}>
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
            </div>

            <button className="auth-btn-submit" type="submit" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign In →'}
            </button>
            <div className="auth-divider"><span>or</span></div>
            <div className="auth-switch">
              Don't have an account? <Link to="/signup">Create one</Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

/* ─────────────────────────────────────────────
   SIGNUP PAGE
───────────────────────────────────────────── */
export const Signup = () => {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm]       = useState({ name: '', username: '', email: '', password: '', confirm: '' });
  const [showPw, setShowPw]   = useState(false);
  const [error, setError]     = useState('');
  const [fieldErr, setFieldErr] = useState({});
  const [loading, setLoading] = useState(false);

  const set = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setError('');
    setFieldErr(fe => ({ ...fe, [k]: false }));
  };

  const strength = getStrength(form.password);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.name.trim())        errs.name     = true;
    if (form.username.length < 3) errs.username = true;
    if (!form.email.includes('@')) errs.email   = true;
    if (form.password.length < 6) errs.password = true;
    if (form.password !== form.confirm) errs.confirm = true;
    if (Object.keys(errs).length) {
      setFieldErr(errs);
      setError('Please fix the highlighted fields.');
      return;
    }
    setLoading(true);
    try {
      await signup(form);
      navigate('/dashboard');
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        err.response?.data?.errors?.[0]?.msg ||
        'Signup failed. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const fields = [
    { key: 'name',     label: 'Full Name', icon: '✏️', type: 'text',  placeholder: 'Your full name' },
    { key: 'username', label: 'Username',  icon: '@',  type: 'text',  placeholder: 'At least 3 characters' },
    { key: 'email',    label: 'Email',     icon: '✉️', type: 'email', placeholder: 'you@example.com' },
  ];

  return (
    <div className="auth-page">
      <BrandPanel
        headline="Start tracking<br/><span>smarter today.</span>"
        sub="Create your free account and get instant access to AI-powered expense tracking, voice input, and smart budgeting."
        features={[
          { icon: '🤖', text: 'AI auto-categorization' },
          { icon: '🎙', text: 'Voice expense logging' },
          { icon: '🔭', text: 'Predictive forecasting' },
        ]}
      />
      <div className="auth-form-panel">
        <div className="auth-form-box">
          <div className="auth-form-box__header">
            <h2 className="auth-form-box__title">Create account</h2>
            <p className="auth-form-box__subtitle">Join FinTrack — it's completely free</p>
          </div>
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            {error && (
              <div className="auth-message auth-message--error">
                <span>⚠</span> {error}
              </div>
            )}

            {fields.map(({ key, label, icon, type, placeholder }) => (
              <div className="auth-field" key={key}>
                <label className="auth-label">{label}</label>
                <div className="auth-input-wrap">
                  <span className="auth-input-wrap__icon">{icon}</span>
                  <input
                    className={`auth-input${fieldErr[key] ? ' auth-input--error' : ''}`}
                    type={type} placeholder={placeholder}
                    value={form[key]}
                    onChange={e =>
                      set(key, key === 'username'
                        ? e.target.value.replace(/\s/g, '')
                        : e.target.value)
                    }
                    autoFocus={key === 'name'}
                    autoComplete={key === 'email' ? 'email' : key === 'username' ? 'username' : 'off'}
                  />
                </div>
              </div>
            ))}

            {/* Password */}
            <div className="auth-field">
              <label className="auth-label">Password</label>
              <div className="auth-input-wrap">
                <span className="auth-input-wrap__icon">🔑</span>
                <input
                  className={`auth-input${fieldErr.password ? ' auth-input--error' : ''}`}
                  type={showPw ? 'text' : 'password'}
                  placeholder="Minimum 6 characters"
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  autoComplete="new-password"
                />
                <button type="button" className="auth-password-toggle"
                  onClick={() => setShowPw(s => !s)}>
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
              {form.password && (
                <div className="auth-strength">
                  <div className="auth-strength__bars">
                    {[1, 2, 3].map(i => (
                      <div key={i}
                        className={`auth-strength__bar${strength >= i ? ` auth-strength__bar--active-${strength}` : ''}`}
                      />
                    ))}
                  </div>
                  <div className="auth-strength__label">{strengthLabel[strength]}</div>
                </div>
              )}
            </div>

            {/* Confirm */}
            <div className="auth-field">
              <label className="auth-label">Confirm Password</label>
              <div className="auth-input-wrap">
                <span className="auth-input-wrap__icon">🔒</span>
                <input
                  className={`auth-input${fieldErr.confirm ? ' auth-input--error' : ''}`}
                  type={showPw ? 'text' : 'password'}
                  placeholder="Repeat your password"
                  value={form.confirm}
                  onChange={e => set('confirm', e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>

            <button className="auth-btn-submit" type="submit" disabled={loading}>
              {loading ? 'Creating account…' : 'Create Account →'}
            </button>
            <p className="auth-terms">
              By signing up you agree to store your data securely on our server.
            </p>
            <div className="auth-divider"><span>or</span></div>
            <div className="auth-switch">
              Already have an account? <Link to="/login">Sign in</Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default { AuthProvider, useAuth, Login, Signup };