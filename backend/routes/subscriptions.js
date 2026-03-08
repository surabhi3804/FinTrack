const express      = require('express');
const Subscription = require('../models/Subscription');
const { protect }  = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/', async (req, res) => {
  try {
    const subs = await Subscription.find({ user: req.user._id, active: true }).sort({ nextRenewalDate: 1 });
    res.json({ subscriptions: subs });
  } catch { res.status(500).json({ error: 'Failed to fetch subscriptions.' }); }
});

router.get('/upcoming', async (req, res) => {
  try {
    const days  = Number(req.query.days) || 7;
    const until = new Date(); until.setDate(until.getDate() + days);
    const subs  = await Subscription.find({ user: req.user._id, active: true, nextRenewalDate: { $lte: until } }).sort({ nextRenewalDate: 1 });
    res.json({ upcoming: subs });
  } catch { res.status(500).json({ error: 'Failed to fetch upcoming renewals.' }); }
});

router.post('/', async (req, res) => {
  try {
    const { name, amount, billingCycle, nextRenewalDate, icon, color } = req.body;
    if (!name || !amount) return res.status(400).json({ error: 'name and amount required.' });

    const merchantKey = name.toLowerCase().trim().replace(/\s+/g, '_');

    const sub = await Subscription.findOneAndUpdate(
      { user: req.user._id, merchantKey },
      {
        $set: {
          name,
          amount:          parseFloat(amount),
          billingCycle:    billingCycle || 'monthly',
          nextRenewalDate: nextRenewalDate ? new Date(nextRenewalDate) : null,
          lastChargedAt:   new Date(),
          active:          true,
          icon:            icon  || '📦',
          color:           color || '#607CBD',
        },
        $setOnInsert: {
          user:       req.user._id,
          merchantKey,
          detectedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({ subscription: sub });
  } catch (err) {
    console.error('Add subscription error:', err.message);
    res.status(500).json({ error: 'Failed to add subscription.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const sub = await Subscription.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: req.body },
      { new: true }
    );
    if (!sub) return res.status(404).json({ error: 'Not found.' });
    res.json({ subscription: sub });
  } catch { res.status(500).json({ error: 'Failed to update.' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await Subscription.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { active: false } }
    );
    res.json({ message: 'Subscription cancelled.' });
  } catch { res.status(500).json({ error: 'Failed to cancel.' }); }
});

module.exports = router;