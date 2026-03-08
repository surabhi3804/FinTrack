/**
 * subscriptionService.js
 * Detects recurring expenses and sends subscription reminders.
 */

const Expense      = require('../models/Expense');
const Subscription = require('../models/Subscription'); // create if missing — see note below

// ─── Keyword / merchant patterns that suggest a subscription ─────────────────
const SUBSCRIPTION_KEYWORDS = [
  'netflix', 'spotify', 'amazon prime', 'prime', 'disney', 'hotstar',
  'youtube', 'apple', 'icloud', 'google one', 'microsoft', 'office 365',
  'adobe', 'notion', 'slack', 'zoom', 'dropbox', 'github', 'figma',
  'canva', 'grammarly', 'nordvpn', 'expressvpn', 'hulu', 'peacock',
  'paramount', 'crunchyroll', 'duolingo', 'headspace', 'calm',
  'subscription', 'monthly', 'annual', 'yearly', 'renewal',
];

/**
 * Checks whether an expense looks like a subscription.
 */
function looksLikeSubscription(expense) {
  const text = `${expense.name} ${expense.notes || ''}`.toLowerCase();
  return SUBSCRIPTION_KEYWORDS.some(kw => text.includes(kw));
}

/**
 * detectSubscriptions
 * Called after every new expense is saved.
 * If the expense resembles a subscription and we haven't tracked it yet,
 * upsert a Subscription document so the user can manage it.
 *
 * @param {ObjectId} userId
 * @param {Object}   expense  — the newly created Expense document
 */
async function detectSubscriptions(userId, expense) {
  try {
    if (!looksLikeSubscription(expense)) return;

    const merchantKey = (expense.merchant || expense.name).toLowerCase().trim();

    // Look for past occurrences of the same merchant (at least 2 total = recurring)
    const pastCount = await Expense.countDocuments({
      user:     userId,
      merchant: { $regex: new RegExp(merchantKey, 'i') },
    });

    if (pastCount < 2) return; // not yet confirmed as recurring

    // Upsert into Subscription collection
    await Subscription.findOneAndUpdate(
      { user: userId, merchantKey },
      {
        $setOnInsert: {
          user:        userId,
          name:        expense.merchant || expense.name,
          merchantKey,
          amount:      expense.amount,
          category:    expense.category,
          detectedAt:  new Date(),
          active:      true,
        },
        $set: {
          lastChargedAt: expense.date || new Date(),
          amount:        expense.amount, // update in case price changed
        },
      },
      { upsert: true, new: true }
    );

    console.log(`🔁  Subscription detected/updated: ${merchantKey} for user ${userId}`);
  } catch (err) {
    // Non-fatal — caller already does .catch(console.error)
    console.error('detectSubscriptions error:', err.message);
  }
}

/**
 * checkSubscriptionReminders
 * Run daily by cron. Finds subscriptions due within the next 3 days
 * and logs a reminder (extend this to send email/push as needed).
 *
 * @param {number} daysAhead  — how many days before renewal to remind (default 3)
 */
async function checkSubscriptionReminders(daysAhead = 3) {
  try {
    const now     = new Date();
    const cutoff  = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    // Find active subscriptions whose next renewal falls within the window.
    // nextRenewalAt is optional; fall back to lastChargedAt + 30 days.
    const subscriptions = await Subscription.find({ active: true }).lean();

    let reminded = 0;
    for (const sub of subscriptions) {
      const base    = sub.nextRenewalAt || sub.lastChargedAt;
      if (!base) continue;

      const renewal = new Date(base);
      // Advance renewal date by 30-day increments until it's in the future
      while (renewal <= now) renewal.setDate(renewal.getDate() + 30);

      if (renewal <= cutoff) {
        // TODO: replace console.log with real notification (email, push, etc.)
        console.log(
          `🔔  Reminder — ${sub.name} renews on ${renewal.toDateString()} ` +
          `for ₹${sub.amount} (user: ${sub.user})`
        );
        reminded++;
      }
    }

    console.log(`✅  Subscription reminder check done. Reminders sent: ${reminded}`);
  } catch (err) {
    console.error('checkSubscriptionReminders error:', err.message);
  }
}

module.exports = { detectSubscriptions, checkSubscriptionReminders };