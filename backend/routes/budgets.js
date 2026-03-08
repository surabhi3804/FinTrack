const express  = require('express');
const Budget   = require('../models/Budget');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/', async (req, res) => {
  try {
    const now   = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year  = Number(req.query.year)  || now.getFullYear();
    let budget  = await Budget.findOne({ user: req.user._id, month, year });
    if (!budget) budget = await Budget.create({ user: req.user._id, month, year });
    res.json({ budget });
  } catch { res.status(500).json({ error: 'Failed to fetch budget.' }); }
});

router.put('/', async (req, res) => {
  try {
    const now   = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year  = Number(req.query.year)  || now.getFullYear();
    const budget = await Budget.findOneAndUpdate(
      { user: req.user._id, month, year },
      { $set: req.body },
      { new: true, upsert: true }
    );
    res.json({ budget });
  } catch { res.status(500).json({ error: 'Failed to update budget.' }); }
});

module.exports = router;