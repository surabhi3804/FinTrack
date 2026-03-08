const mongoose = require('mongoose');

const budgetSchema = new mongoose.Schema({
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  month:         { type: Number, required: true, min: 1, max: 12 },
  year:          { type: Number, required: true },
  monthlyIncome: { type: Number, default: 0 },
  categoryLimits:      { type: Map, of: Number, default: {} },
  aiSuggestedLimits:   { type: Map, of: Number, default: {} },
  aiSuggestionAccepted:{ type: Boolean, default: false },
  totalBudget:   { type: Number, default: 0 },
}, { timestamps: true });

// One budget doc per user per month
budgetSchema.index({ user: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Budget', budgetSchema);