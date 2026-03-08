const express  = require('express');
const { protect } = require('../middleware/auth');
const Expense  = require('../models/Expense');
const { categorizeExpense, parseVoiceInput, generateBudgetSuggestion, generateForecast } = require('../services/aiService');

const router = express.Router();
router.use(protect);

// POST /api/ai/categorize
router.post('/categorize', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required.' });
    const result = await categorizeExpense(name, req.user);
    res.json(result);
  } catch { res.status(500).json({ error: 'AI categorization failed.' }); }
});

// POST /api/ai/voice  — parse voice text into expense fields
router.post('/voice', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required.' });
    const parsed = await parseVoiceInput(text, req.user);
    res.json(parsed);
  } catch { res.status(500).json({ error: 'Voice parsing failed.' }); }
});

// GET /api/ai/budget-suggestion
router.get('/budget-suggestion', async (req, res) => {
  try {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const expenses = await Expense.find({ user: req.user._id, date: { $gte: threeMonthsAgo } }).lean();
    if (expenses.length < 3)
      return res.json({ suggestion: null, message: 'Add at least 3 expenses for AI budget suggestions.' });
    const suggestion = await generateBudgetSuggestion(expenses, req.user);
    res.json({ suggestion });
  } catch { res.status(500).json({ error: 'Budget suggestion failed.' }); }
});

// GET /api/ai/forecast
router.get('/forecast', async (req, res) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const expenses = await Expense.find({ user: req.user._id, date: { $gte: sixMonthsAgo } }).lean();
    if (expenses.length < 5)
      return res.json({ forecast: null, message: 'Add more expenses for AI forecasting.' });
    const forecast = await generateForecast(expenses, req.user);
    res.json({ forecast });
  } catch { res.status(500).json({ error: 'Forecast failed.' }); }
});

module.exports = router;