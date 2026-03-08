const express   = require('express');
const { body, validationResult } = require('express-validator');
const User    = require('../models/User');
const Budget    = require('../models/Budget');
const { protect, generateToken } = require('../middleware/auth');

const router = express.Router();

// Validators
const signupRules = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('username').trim().isLength({ min: 3, max: 30 }).withMessage('Username 3–30 chars')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Letters, numbers, underscores only'),
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
];
const loginRules = [
  body('username').trim().notEmpty().withMessage('Username required'),
  body('password').notEmpty().withMessage('Password required'),
];

// POST /api/auth/signup
router.post('/signup', signupRules, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, username, email, password } = req.body;

    const existing = await User.findOne({
      $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }],
    });
    if (existing) {
      const field = existing.username === username.toLowerCase() ? 'username' : 'email';
      return res.status(409).json({ error: `That ${field} is already taken.` });
    }

    const user = await User.create({ name, username, email, password });

    // Seed empty budget for this month
    const now = new Date();
    await Budget.create({ user: user._id, month: now.getMonth() + 1, year: now.getFullYear() });

    const token = generateToken(user._id);
    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, username: user.username, email: user.email, monthlyIncome: user.monthlyIncome },
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', loginRules, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase() }).select('+password');
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid username or password.' });

    const token = generateToken(user._id);
    res.json({
      token,
      user: { id: user._id, name: user.name, username: user.username, email: user.email, monthlyIncome: user.monthlyIncome },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// GET /api/auth/me
router.get('/me', protect, (req, res) => res.json({ user: req.user }));

// PUT /api/auth/income
router.put('/income', protect, async (req, res) => {
  try {
    const { income } = req.body;
    if (!income || income <= 0) return res.status(400).json({ error: 'Invalid income amount.' });
    const user = await User.findByIdAndUpdate(req.user._id, { monthlyIncome: income }, { new: true });
    res.json({ monthlyIncome: user.monthlyIncome });
  } catch { res.status(500).json({ error: 'Failed to update income.' }); }
});

module.exports = router;