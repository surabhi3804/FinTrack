const mongoose = require('mongoose');

const CATEGORIES = [
  'Food','Rent','Travel','Entertainment','Utilities',
  'Healthcare','Shopping','Education','Subscriptions','Transport','Others',
];

const expenseSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:     { type: String, required: true, trim: true, maxlength: 200 },
  amount:   { type: Number, required: true, min: 0 },
  category: { type: String, enum: CATEGORIES, default: 'Others' },

  // AI fields
  aiSuggestedCategory: { type: String, enum: [...CATEGORIES, null], default: null },
  aiCorrected:         { type: Boolean, default: false },
  merchant:            { type: String, trim: true, default: '' },

  date:       { type: Date, default: Date.now, index: true },
  notes:      { type: String, maxlength: 500, default: '' },
  voiceInput: { type: String, default: null },   // original voice transcript

  isRecurring:     { type: Boolean, default: false },
  subscriptionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },

  // Offline sync
  clientId: { type: String, default: null },
  syncedAt: { type: Date,   default: Date.now },
}, { timestamps: true });

expenseSchema.index({ user: 1, date: -1 });
expenseSchema.index({ user: 1, category: 1 });

module.exports = mongoose.model('Expense', expenseSchema);
module.exports.CATEGORIES = CATEGORIES;