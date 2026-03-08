const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name:         { type: String, required: true, trim: true },
    merchantKey:  { type: String, required: true, lowercase: true, trim: true },
    amount:       { type: Number, required: true },
    billingCycle: { type: String, enum: ['weekly','monthly','quarterly','yearly'], default: 'monthly' },
    category:     { type: String, default: 'Subscriptions' },
    active:       { type: Boolean, default: true },
    icon:         { type: String, default: '📦' },
    color:        { type: String, default: '#607CBD' },
    autoDetected: { type: Boolean, default: false },
    lastChargedAt:   { type: Date },
    nextRenewalDate: { type: Date },
    detectedAt:      { type: Date, default: Date.now },
    notes:           { type: String, default: '' },
  },
  { timestamps: true }
);

subscriptionSchema.index({ user: 1, merchantKey: 1 }, { unique: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);