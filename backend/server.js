require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const mongoose   = require('mongoose');
const cron       = require('node-cron');

const authRoutes         = require('./routes/auth');
const expenseRoutes      = require('./routes/expenses');
const budgetRoutes       = require('./routes/budgets');
const subscriptionRoutes = require('./routes/subscriptions');
const aiRoutes           = require('./routes/ai');

const { checkSubscriptionReminders } = require('./services/subscriptionService');

const app = express();
app.set('trust proxy', 1); 

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// General rate limit
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200,
  message: { error: 'Too many requests, please try again later.' } }));

// Stricter limit on auth routes
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many auth attempts, please try again later.' } }));

// ── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅  MongoDB connected'))
  .catch(err => { console.error('❌  MongoDB error:', err); process.exit(1); });

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/expenses',      expenseRoutes);
app.use('/api/budgets',       budgetRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/ai',            aiRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── Cron: subscription reminders — daily at 9 AM ─────────────
cron.schedule('0 9 * * *', () => {
  console.log('⏰  Running subscription reminder check…');
  checkSubscriptionReminders();
});

// ── Global error handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀  FinTrack backend running on http://localhost:${PORT}`));