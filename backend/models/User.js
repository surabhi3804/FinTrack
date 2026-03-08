const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  username: {
    type: String, required: true, unique: true,
    trim: true, lowercase: true, minlength: 3, maxlength: 30,
    match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers and underscores'],
  },
  email: {
    type: String, required: true, unique: true,
    trim: true, lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
  },
  password: { type: String, required: true, minlength: 6, select: false },

  // AI category corrections — merchant → category
  categoryLearning: { type: Map, of: String, default: {} },

  monthlyIncome: { type: Number, default: 0 },

  preferences: {
    currency:     { type: String,  default: 'INR' },
    reminderDays: { type: Number,  default: 3 },
  },
}, { timestamps: true });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Strip password from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);