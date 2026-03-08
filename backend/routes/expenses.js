const express  = require('express');
const Expense  = require('../models/Expense');
const User     = require('../models/User');
const { protect } = require('../middleware/auth');
const { categorizeExpense } = require('../services/aiService');
const { detectSubscriptions } = require('../services/subscriptionService');

const router = express.Router();
router.use(protect);

// GET /api/expenses
router.get('/', async (req, res) => {
  try {
    const { month, year, category, limit = 100, page = 1 } = req.query;
    const filter = { user: req.user._id };
    if (month && year) {
      filter.date = {
        $gte: new Date(year, month - 1, 1),
        $lte: new Date(year, month, 0, 23, 59, 59),
      };
    }
    if (category) filter.category = category;

    const [expenses, total] = await Promise.all([
      Expense.find(filter).sort({ date: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean(),
      Expense.countDocuments(filter),
    ]);
    res.json({ expenses, total, page: Number(page) });
  } catch { res.status(500).json({ error: 'Failed to fetch expenses.' }); }
});

// POST /api/expenses
router.post('/', async (req, res) => {
  try {
    const { name, amount, category, date, notes, voiceInput, clientId } = req.body;
    if (!name || !amount) return res.status(400).json({ error: 'name and amount required.' });

    // AI categorization
    let finalCategory = category;
    let aiSuggestedCategory = null;
    if (!category || category === 'Others') {
      const ai = await categorizeExpense(name, req.user);
      aiSuggestedCategory = ai.category;
      finalCategory = ai.category;
    }

    const expense = await Expense.create({
      user: req.user._id, name, amount,
      category: finalCategory, aiSuggestedCategory,
      merchant: name,
      date: date ? new Date(date) : new Date(),
      notes: notes || '', voiceInput: voiceInput || null, clientId: clientId || null,
    });

    // Background subscription detection
    detectSubscriptions(req.user._id, expense).catch(console.error);

    res.status(201).json({ expense, aiSuggestedCategory });
  } catch (err) {
    console.error('Add expense error:', err);
    res.status(500).json({ error: 'Failed to add expense.' });
  }
});

// POST /api/expenses/bulk-sync  (offline sync)
router.post('/bulk-sync', async (req, res) => {
  try {
    const { expenses } = req.body;
    if (!Array.isArray(expenses)) return res.status(400).json({ error: 'expenses must be an array.' });

    const results = [];
    for (const e of expenses) {
      if (e.clientId) {
        const existing = await Expense.findOne({ user: req.user._id, clientId: e.clientId });
        if (existing) { results.push({ clientId: e.clientId, status: 'duplicate' }); continue; }
      }
      let cat = e.category;
      if (!cat || cat === 'Others') { const ai = await categorizeExpense(e.name, req.user); cat = ai.category; }
      const expense = await Expense.create({
        user: req.user._id, name: e.name, amount: e.amount, category: cat,
        date: e.date ? new Date(e.date) : new Date(),
        notes: e.notes || '', voiceInput: e.voiceInput || null, clientId: e.clientId || null, syncedAt: new Date(),
      });
      results.push({ clientId: e.clientId, expense, status: 'created' });
    }
    res.json({ synced: results.length, results });
  } catch { res.status(500).json({ error: 'Bulk sync failed.' }); }
});

// PUT /api/expenses/:id
router.put('/:id', async (req, res) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, user: req.user._id });
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });

    // Learn from user corrections
    const { category } = req.body;
    if (category && category !== expense.aiSuggestedCategory && expense.aiSuggestedCategory) {
      expense.aiCorrected = true;
      await User.findByIdAndUpdate(req.user._id, {
        $set: { [`categoryLearning.${expense.merchant.toLowerCase()}`]: category },
      });
    }

    Object.assign(expense, req.body);
    if (req.body.date) expense.date = new Date(req.body.date);
    await expense.save();
    res.json({ expense });
  } catch { res.status(500).json({ error: 'Failed to update expense.' }); }
});

// DELETE /api/expenses/:id
router.delete('/:id', async (req, res) => {
  try {
    const expense = await Expense.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });
    res.json({ message: 'Deleted.', id: req.params.id });
  } catch { res.status(500).json({ error: 'Failed to delete expense.' }); }
});

// GET /api/expenses/summary
router.get('/summary', async (req, res) => {
  try {
    const now = new Date();
    const m = Number(req.query.month) || now.getMonth() + 1;
    const y = Number(req.query.year)  || now.getFullYear();
    const summary = await Expense.aggregate([
      { $match: { user: req.user._id, date: { $gte: new Date(y, m - 1, 1), $lte: new Date(y, m, 0, 23, 59, 59) } } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);
    res.json({ summary, totalSpent: summary.reduce((s, c) => s + c.total, 0), month: m, year: y });
  } catch { res.status(500).json({ error: 'Failed to get summary.' }); }
});

module.exports = router;