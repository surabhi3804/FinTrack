/**
 * services/aiService.js
 * AI-powered expense categorization, voice parsing, budget suggestions, and forecasting.
 * Uses Groq API via fetch (no SDK needed).
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const CATEGORIES = [
  'Food','Rent','Travel','Entertainment','Utilities',
  'Healthcare','Shopping','Education','Subscriptions','Transport','Others'
];

// ─── Helper: call Groq API ────────────────────────────────────────────────────
async function callClaude(prompt, systemPrompt = '') {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set in environment variables.');

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// ─── Helper: safely parse JSON from response ──────────────────────────────────
function parseJSON(text) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ─── 1. categorizeExpense ─────────────────────────────────────────────────────
/**
 * Categorizes an expense by name, respecting any learned mappings for this user.
 * @param {string} name       — expense/merchant name
 * @param {object} user       — Mongoose User document (may have categoryLearning map)
 * @returns {{ category: string, confidence: number }}
 */
async function categorizeExpense(name, user) {
  // Check user's learned mappings first (instant, no AI call needed)
  const learned = user?.categoryLearning || {};
  const key     = name.toLowerCase().trim();
  if (learned[key]) return { category: learned[key], confidence: 1.0 };

  const system = `You are an expense categorization assistant. 
Respond ONLY with valid JSON — no markdown, no explanation.
Available categories: ${CATEGORIES.join(', ')}.`;

  const prompt = `Categorize this expense: "${name}"
Respond with: {"category": "<one of the categories>", "confidence": <0.0-1.0>}`;

  try {
    const text   = await callClaude(prompt, system);
    const parsed = parseJSON(text);
    if (parsed?.category && CATEGORIES.includes(parsed.category)) {
      return { category: parsed.category, confidence: parsed.confidence ?? 0.8 };
    }
  } catch (err) {
    console.error('categorizeExpense error:', err.message);
  }

  return { category: 'Others', confidence: 0.5 };
}

// ─── 2. parseVoiceInput ───────────────────────────────────────────────────────
/**
 * Parses a voice/text input like "spent 500 on lunch yesterday" into expense fields.
 * @param {string} text   — raw voice input
 * @param {object} user   — Mongoose User document
 * @returns {{ name, amount, category, date, notes }}
 */
async function parseVoiceInput(text, user) {
  const today  = new Date().toISOString().split('T')[0];
  const system = `You are a voice-to-expense parser.
Respond ONLY with valid JSON — no markdown, no explanation.
Today's date is ${today}.
Available categories: ${CATEGORIES.join(', ')}.`;

  const prompt = `Parse this voice input into an expense:
"${text}"

Respond with:
{
  "name": "<merchant or item name>",
  "amount": <number>,
  "category": "<category>",
  "date": "<YYYY-MM-DD>",
  "notes": "<any extra info or empty string>"
}`;

  try {
    const raw    = await callClaude(prompt, system);
    const parsed = parseJSON(raw);
    if (parsed?.name && parsed?.amount) {
      return {
        name:     parsed.name,
        amount:   Number(parsed.amount),
        category: CATEGORIES.includes(parsed.category) ? parsed.category : 'Others',
        date:     parsed.date || today,
        notes:    parsed.notes || '',
      };
    }
  } catch (err) {
    console.error('parseVoiceInput error:', err.message);
  }

  return { name: text, amount: 0, category: 'Others', date: today, notes: '' };
}

// ─── 3. generateBudgetSuggestion ─────────────────────────────────────────────
/**
 * Analyses 3 months of expenses and suggests monthly category budgets.
 * @param {Array}  expenses  — array of Expense documents
 * @param {object} user      — Mongoose User document
 * @returns {object}         — { totalSuggestedBudget, categories: [{category, suggested, reason}] }
 */
async function generateBudgetSuggestion(expenses, user) {
  // Aggregate spending by category
  const totals = {};
  for (const e of expenses) {
    totals[e.category] = (totals[e.category] || 0) + e.amount;
  }
  const monthlyAvg = Object.entries(totals).map(([cat, total]) => ({
    category: cat,
    monthlyAverage: Math.round(total / 3),
  }));

  const system = `You are a personal finance advisor.
Respond ONLY with valid JSON — no markdown, no explanation.`;

  const prompt = `Based on this user's average monthly spending per category over 3 months:
${JSON.stringify(monthlyAvg, null, 2)}

Suggest realistic monthly budgets. Apply a 10-15% savings buffer where possible.
Respond with:
{
  "totalSuggestedBudget": <number>,
  "categories": [
    { "category": "<name>", "suggested": <number>, "reason": "<one sentence>" }
  ]
}`;

  try {
    const raw    = await callClaude(prompt, system);
    const parsed = parseJSON(raw);
    if (parsed?.categories) return parsed;
  } catch (err) {
    console.error('generateBudgetSuggestion error:', err.message);
  }

  // Fallback: 90% of historical average per category
  return {
    totalSuggestedBudget: monthlyAvg.reduce((s, c) => s + c.monthlyAverage, 0),
    categories: monthlyAvg.map(c => ({
      category:  c.category,
      suggested: Math.round(c.monthlyAverage * 0.9),
      reason:    'Based on your recent spending history.',
    })),
  };
}

// ─── 4. generateForecast ─────────────────────────────────────────────────────
/**
 * Forecasts next month's spending based on 6 months of history.
 * @param {Array}  expenses  — array of Expense documents
 * @param {object} user      — Mongoose User document
 * @returns {object}         — { forecastedTotal, categories, insight }
 */
async function generateForecast(expenses, user) {
  // Build month-by-month totals
  const byMonth = {};
  for (const e of expenses) {
    const key = `${new Date(e.date).getFullYear()}-${new Date(e.date).getMonth() + 1}`;
    if (!byMonth[key]) byMonth[key] = { total: 0, categories: {} };
    byMonth[key].total += e.amount;
    byMonth[key].categories[e.category] = (byMonth[key].categories[e.category] || 0) + e.amount;
  }

  const system = `You are a financial forecasting assistant.
Respond ONLY with valid JSON — no markdown, no explanation.`;

  const prompt = `Here is a user's monthly expense data for the past 6 months:
${JSON.stringify(byMonth, null, 2)}

Forecast next month's spending.
Respond with:
{
  "forecastedTotal": <number>,
  "categories": [
    { "category": "<name>", "forecasted": <number>, "trend": "up|down|stable" }
  ],
  "insight": "<2-3 sentence summary of spending patterns and advice>"
}`;

  try {
    const raw    = await callClaude(prompt, system);
    const parsed = parseJSON(raw);
    if (parsed?.forecastedTotal) return parsed;
  } catch (err) {
    console.error('generateForecast error:', err.message);
  }

  // Fallback: average of last 3 months
  const months   = Object.values(byMonth);
  const recent   = months.slice(-3);
  const avgTotal = Math.round(recent.reduce((s, m) => s + m.total, 0) / recent.length);
  return {
    forecastedTotal: avgTotal,
    categories:      [],
    insight:         'Based on your recent spending, we estimate similar expenses next month.',
  };
}

module.exports = { categorizeExpense, parseVoiceInput, generateBudgetSuggestion, generateForecast };