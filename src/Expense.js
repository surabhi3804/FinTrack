import { useState, useEffect, useCallback, useRef } from 'react';
import { API } from './Auth';
import './Expense.css';

const CATEGORIES = ['Food','Rent','Travel','Entertainment','Utilities','Healthcare','Shopping','Education','Subscriptions','Transport','Others'];

const CAT_META = {
  Food:          { color:'#2F3A7E', icon:'🍽' },
  Rent:          { color:'#607CBD', icon:'🏠' },
  Travel:        { color:'#4A8FA8', icon:'✈️' },
  Entertainment: { color:'#8B5E9E', icon:'🎬' },
  Utilities:     { color:'#3D9E8C', icon:'⚡' },
  Healthcare:    { color:'#5B7FBF', icon:'🏥' },
  Shopping:      { color:'#7A9E5F', icon:'🛍' },
  Education:     { color:'#9E7A50', icon:'📚' },
  Subscriptions: { color:'#E8A838', icon:'🔔' },
  Transport:     { color:'#607CBD', icon:'🚗' },
  Others:        { color:'#8CA5C2', icon:'📦' },
};

const fmt = (n) => Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});

const DB_NAME = 'fintrack_offline', STORE = 'pending_expenses';
let _db = null;
const openDB = () => new Promise((res,rej)=>{
  if(_db) return res(_db);
  const r = indexedDB.open(DB_NAME,1);
  r.onupgradeneeded = e=>{ const d=e.target.result; if(!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE,{keyPath:'clientId'}); };
  r.onsuccess = e=>{ _db=e.target.result; res(_db); };
  r.onerror   = e=>rej(e.target.error);
});
const idbAdd = async(item)=>{ const d=await openDB(); return new Promise((res,rej)=>{ const tx=d.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(item); tx.oncomplete=()=>res(item); tx.onerror=e=>rej(e.target.error); }); };
const idbAll = async()=>{ const d=await openDB(); return new Promise((res,rej)=>{ const tx=d.transaction(STORE,'readonly'); const r=tx.objectStore(STORE).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=e=>rej(e.target.error); }); };
const idbDel = async(id)=>{ const d=await openDB(); return new Promise((res,rej)=>{ const tx=d.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete=res; tx.onerror=e=>rej(e.target.error); }); };

const useOnline = () => {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(()=>{
    const on=()=>setOnline(true), off=()=>setOnline(false);
    window.addEventListener('online',on); window.addEventListener('offline',off);
    return ()=>{ window.removeEventListener('online',on); window.removeEventListener('offline',off); };
  },[]);
  return online;
};

/* ─────────────────────────────────────────────
   Voice hook — AI parse with local regex fallback
───────────────────────────────────────────── */

// Local regex parser — runs when AI doesn't return structured fields
const parseVoiceLocally = (text) => {
  const t = text.toLowerCase();

  // Extract number: digits like "500" or "50.5"
  const amountMatch = t.match(/(\d+(?:\.\d+)?)/);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

  // Map keywords → categories
  const catMap = [
    ['Food',          ['food','dinner','lunch','breakfast','restaurant','eat','meal','snack','barbeque','café','cafe','pizza','burger','biryani','chai','coffee','swiggy','zomato','dhaba','hotel']],
    ['Travel',        ['travel','trip','flight','train','bus','ticket','hotel','uber','ola','cab','auto','petrol','fuel','toll','journey']],
    ['Transport',     ['transport','metro','rickshaw','bike','parking','commute']],
    ['Shopping',      ['shopping','clothes','shirt','shoes','amazon','flipkart','myntra','mall','buy','purchase','grocery','groceries','supermarket','vegetables','fruit']],
    ['Healthcare',    ['health','medicine','doctor','hospital','pharmacy','medical','clinic','chemist','tablet','prescription']],
    ['Entertainment', ['movie','film','netflix','ott','game','concert','show','entertainment','theatre','cinema','series']],
    ['Subscriptions', ['subscription','spotify','youtube','prime','disney','hotstar','apple','renewal','membership']],
    ['Education',     ['education','book','course','school','college','tuition','class','fee','stationery']],
    ['Utilities',     ['electricity','water','gas','internet','wifi','bill','recharge','mobile','broadband','dth']],
    ['Rent',          ['rent','house','flat','apartment','pg','hostel','room','maintenance']],
  ];

  let detectedCat = 'Others';
  for (const [cat, keywords] of catMap) {
    if (keywords.some(k => t.includes(k))) { detectedCat = cat; break; }
  }

  // Clean up name: strip command words, numbers, filler words
  let name = text
    .replace(/^(add|spent|spend|paid|pay|bought|purchase|log|record)\s*/i, '')
    .replace(/\b\d+(?:\.\d+)?\s*(rupees?|rs\.?|₹|bucks?)?\b/gi, '')
    .replace(/\b(for|on|at|to|in|the|a|an)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length < 2) name = detectedCat !== 'Others' ? detectedCat : text;

  return { name, amount, category: detectedCat };
};

const useVoice = ({ onResult, onError }) => {
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const ref = useRef(null);
  const supported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;

  const start = useCallback(()=>{
    if(!supported){ onError?.('Voice not supported in this browser'); return; }
    const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
    const r = new SR(); r.lang='en-IN'; r.maxAlternatives=1; ref.current=r;
    r.onstart = ()=>setListening(true);
    r.onend   = ()=>setListening(false);
    r.onerror = e=>{ setListening(false); onError?.(e.error==='not-allowed'?'Microphone access denied.':`Voice error: ${e.error}`); };
    r.onresult = async e=>{
      const text = e.results[0][0].transcript;
      setProcessing(true);
      try {
        const res = await API.post('/ai/voice',{text});
        const d = res.data;
        const parsed = d.parsed || d;
        const aiAmount = Number(parsed.amount || parsed.value || 0);
        const aiName   = (parsed.name || parsed.merchant || parsed.description || '').trim();
        const aiCat    = parsed.category || '';

        // Use AI result only if it actually parsed (amount > 0, name differs from raw text)
        const aiWorked = aiAmount > 0 && aiName && aiName.toLowerCase() !== text.toLowerCase();
        if (aiWorked) {
          const matchedCat = CATEGORIES.find(c => c.toLowerCase() === aiCat.toLowerCase())
            || CATEGORIES.find(c => aiCat.toLowerCase().includes(c.toLowerCase()))
            || 'Others';
          onResult?.({ name: aiName, amount: aiAmount, category: matchedCat });
        } else {
          onResult?.(parseVoiceLocally(text));
        }
      } catch {
        // AI call failed — parse locally so voice always works
        onResult?.(parseVoiceLocally(text));
      }
      finally { setProcessing(false); }
    };
    r.start();
  },[supported,onResult,onError]);

  const stop = useCallback(()=>{ ref.current?.stop(); setListening(false); },[]);
  return { listening, processing, supported, start, stop };
};

const DonutChart = ({ expenses, animateChart, spentPct, totalExpenses }) => {
  if(!totalExpenses) return (
    <div className="et-donut-empty"><span className="et-donut-empty__icon">◎</span><p>No expenses yet</p></div>
  );
  const totals={};
  CATEGORIES.forEach(c=>totals[c]=0);
  expenses.forEach(e=>totals[e.category]=(totals[e.category]||0)+e.amount);
  const slices=Object.entries(totals).filter(([,a])=>a>0).sort((a,b)=>b[1]-a[1]);
  const R=80, C=2*Math.PI*R; let offset=0;
  const painted=slices.map(([cat,amount])=>{
    const pct=amount/totalExpenses, dash=pct*C;
    const s={cat,amount,pct,dash,offset,color:CAT_META[cat]?.color||'#8CA5C2'};
    offset+=dash; return s;
  });
  return (
    <div className="et-donut">
      <svg viewBox="0 0 200 200" width="200" height="200">
        {painted.map((s,i)=>(
          <circle key={i} className={`et-donut__slice${animateChart?' et-donut__slice--animate':''}`}
            cx="100" cy="100" r={R} fill="none" stroke={s.color} strokeWidth="28"
            strokeDasharray={`${s.dash} ${C-s.dash}`}
            strokeDashoffset={-s.offset+C*0.25}
            style={{animationDelay:`${i*0.12}s`}}
          />
        ))}
        <circle cx="100" cy="100" r="56" fill="#F5EFEB"/>
        <text x="100" y="95" textAnchor="middle" fill="#607CBD" fontSize="11" fontFamily="DM Sans,sans-serif" fontWeight="600">SPENT</text>
        <text x="100" y="115" textAnchor="middle" fill="#1E2655" fontSize="13" fontFamily="DM Sans,sans-serif" fontWeight="700">{spentPct.toFixed(0)}%</text>
      </svg>
      <div className="et-donut-legend">
        {painted.map((s,i)=>(
          <div key={i} className="et-legend-row">
            <span className="et-legend-dot" style={{background:s.color}}/>
            <span className="et-legend-cat">{s.cat}</span>
            <span className="et-legend-amt">₹{fmt(s.amount)}</span>
            <span className="et-legend-pct">{(s.pct*100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const Expense = ({ user, onLogout }) => {
  const [activeTab, setActiveTab]     = useState('overview');
  const [expenses,  setExpenses]      = useState([]);
  const [monthlyIncome, setMonthlyIncome] = useState(user?.monthlyIncome||0);
  const [incomeInput, setIncomeInput] = useState('');
  const [loading,   setLoading]       = useState(true);
  const [animateChart, setAnimateChart] = useState(false);

  const [expName,   setExpName]   = useState('');
  const [expAmt,    setExpAmt]    = useState('');
  const [expCat,    setExpCat]    = useState('Food');
  const [expDate,   setExpDate]   = useState(() => new Date().toISOString().split('T')[0]);
  const [viewMode,  setViewMode]  = useState('monthly'); // 'daily' | 'weekly' | 'monthly'
  const [aiTag,     setAiTag]     = useState(null);

  const [subs,     setSubs]     = useState([]);
  const [subForm,  setSubForm]  = useState({name:'',amount:'',billingCycle:'monthly',nextRenewalDate:''});
  const [showSubForm, setShowSubForm] = useState(false);

  const [aiCard,   setAiCard]   = useState(null);
  const [budget,   setBudget]   = useState(null);
  const [forecast, setForecast] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError,  setAiError]  = useState('');

  // Feature 1: Goals
  const [goals, setGoals] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ft_goals')) || []; } catch { return []; }
  });
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [goalForm, setGoalForm] = useState({ name:'', targetAmount:'', targetDate:'', icon:'🎯' });
  const [goalRecs, setGoalRecs] = useState([]);
  const [goalsLoading, setGoalsLoading] = useState(false);

  // Feature 4: Anomaly Detector
  const [anomalies, setAnomalies] = useState(null);

  // Feature 5: Lifestyle Impact
  const [lifestyle, setLifestyle] = useState(null);

  // EMI & Loan Tracker
  const [loans, setLoans] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ft_loans')) || []; } catch { return []; }
  });
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [loanForm, setLoanForm] = useState({ name:'', principal:'', rate:'', tenureMonths:'', startDate:'', icon:'💳', type:'home' });

  // Salary Day Countdown
  const [salaryDay, setSalaryDay] = useState(() => parseInt(localStorage.getItem('ft_salaryDay')) || 1);
  const [salaryDayInput, setSalaryDayInput] = useState('');
  const [affordCheck, setAffordCheck] = useState('');
  const [affordResult, setAffordResult] = useState(null);

  // Feature 6: Weekly Summary
  const [weeklySummary, setWeeklySummary] = useState(null);
  const [weeklyLoading, setWeeklyLoading] = useState(false);

  // Feature 2: Dynamic Savings
  const [savingsAlloc, setSavingsAlloc] = useState(null);

  // Feature 3: Travel Mode
  const [travelMode, setTravelMode] = useState(false);
  const [travelCurrency, setTravelCurrency] = useState('USD');
  const [exchangeRate, setExchangeRate] = useState(null);
  const [rateLoading, setRateLoading] = useState(false);

  const online = useOnline();
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(()=>{
    const now=new Date();
    Promise.all([
      API.get('/expenses',{params:{month:now.getMonth()+1,year:now.getFullYear(),limit:100}}),
      API.get('/subscriptions'),
    ]).then(([exp,sub])=>{
      setExpenses(exp.data.expenses||[]);
      setSubs(sub.data.subscriptions||[]);
    }).catch(console.error)
      .finally(()=>setLoading(false));
    idbAll().then(p=>setPendingCount(p.length));
  },[]);

  useEffect(()=>{ if(online && pendingCount>0) syncOffline(); },[online]);
  useEffect(()=>{ if(activeTab==='analytics'){ setAnimateChart(false); setTimeout(()=>setAnimateChart(true),50); } },[activeTab]);

  const totalExpenses = expenses.reduce((s,e)=>s+e.amount,0);
  const balance       = monthlyIncome - totalExpenses;
  const spentPct      = monthlyIncome>0 ? Math.min((totalExpenses/monthlyIncome)*100,100) : 0;
  const initials      = user?.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) || '?';

  const topCategories = () => {
    const t={};
    expenses.forEach(e=>{ t[e.category]=(t[e.category]||0)+e.amount; });
    return Object.entries(t).filter(([,a])=>a>0).sort((a,b)=>b[1]-a[1]);
  };

  const handleSetIncome = async()=>{
    const val=parseFloat(incomeInput);
    if(!val||val<=0){ alert('Enter a valid income amount'); return; }
    try { await API.put('/auth/income',{income:val}); } catch {}
    setMonthlyIncome(val); setIncomeInput('');
  };

  const handleAddExpense = async()=>{
    const amount=parseFloat(expAmt);
    if(!expName.trim()){ alert('Enter expense name'); return; }
    if(!amount||amount<=0){ alert('Enter a valid amount'); return; }
    const payload={name:expName,amount,category:expCat,date:new Date(expDate+'T12:00:00').toISOString(),clientId:`c_${Date.now()}`};
    if(!online){
      await idbAdd({...payload,queuedAt:new Date().toISOString()});
      setExpenses(prev=>[{...payload,_id:payload.clientId,date:new Date()},...prev]);
      setPendingCount(c=>c+1);
    } else {
      try {
        const res = await API.post('/expenses',payload);
        const {expense,aiSuggestedCategory} = res.data;
        setExpenses(prev=>[expense,...prev]);
        if(aiSuggestedCategory && aiSuggestedCategory!==expCat) setAiTag({category:aiSuggestedCategory,merchant:expName});
      } catch {
        await idbAdd({...payload,queuedAt:new Date().toISOString()});
        setExpenses(prev=>[{...payload,_id:payload.clientId,date:new Date()},...prev]);
        setPendingCount(c=>c+1);
      }
    }
    setExpName(''); setExpAmt(''); setExpCat('Food'); setExpDate(new Date().toISOString().split('T')[0]); setAiTag(null);
  };

  const handleDelete = async(id)=>{
    const el=document.querySelector(`[data-id="${id}"]`);
    if(el){ el.classList.add('et-row--deleting'); await new Promise(r=>setTimeout(r,400)); }
    setExpenses(prev=>prev.filter(e=>e._id!==id));
    try { await API.delete(`/expenses/${id}`); } catch {}
  };

  const syncOffline = async()=>{
    const pending=await idbAll();
    if(!pending.length) return;
    setSyncing(true);
    try {
      const res=await API.post('/expenses/bulk-sync',{expenses:pending});
      for(const r of res.data.results||[]){ if(r.clientId) await idbDel(r.clientId); }
      setPendingCount(0);
      const now=new Date();
      const fresh=await API.get('/expenses',{params:{month:now.getMonth()+1,year:now.getFullYear(),limit:100}});
      setExpenses(fresh.data.expenses||[]);
    } catch {} finally { setSyncing(false); }
  };

  /* FIX 1: Voice result handler maps fields correctly */
  const { listening, processing, supported, start, stop } = useVoice({
    onResult:(parsed)=>{
      if(parsed.name)   setExpName(parsed.name);
      if(parsed.amount) setExpAmt(String(parsed.amount));
      if(parsed.category){
        // Match to our local CATEGORIES list (case-insensitive)
        const match = CATEGORIES.find(c => c.toLowerCase() === parsed.category.toLowerCase())
          || CATEGORIES.find(c => parsed.category.toLowerCase().includes(c.toLowerCase()));
        setExpCat(match || 'Others');
      }
    },
    onError:(msg)=>alert(msg),
  });

  const handleAddSub = async(e)=>{
    e.preventDefault();
    try {
      const res=await API.post('/subscriptions',{...subForm,amount:parseFloat(subForm.amount)});
      setSubs(prev=>[...prev,res.data.subscription]);
      setSubForm({name:'',amount:'',billingCycle:'monthly',nextRenewalDate:''});
      setShowSubForm(false);
    } catch { alert('Failed to add subscription.'); }
  };
  const handleCancelSub=async(id)=>{
    if(!window.confirm('Cancel this subscription?')) return;
    await API.delete(`/subscriptions/${id}`);
    setSubs(prev=>prev.filter(s=>s._id!==id));
  };
  const daysUntil=(date)=>Math.ceil((new Date(date)-new Date())/(1000*60*60*24));
  const totalMonthly=subs.reduce((s,sub)=>{const m={weekly:4,monthly:1,quarterly:1/3,yearly:1/12};return s+(sub.amount*(m[sub.billingCycle]||1));},0);

  /* ─────────────────────────────────────────────
     FIX 2: Budget — normalize API response
     API returns: { totalSuggestedBudget, categories: [{category, suggested, reason}] }
     UI expects:  { totalBudget, savingsTarget, categoryLimits, advice }
  ───────────────────────────────────────────── */
  // ── Feature 1: Save goals to localStorage ──
  const saveGoals = (updated) => {
    setGoals(updated);
    localStorage.setItem('ft_goals', JSON.stringify(updated));
  };

  const handleAddGoal = () => {
    if (!goalForm.name || !goalForm.targetAmount) return alert('Enter goal name and target amount.');
    const goal = {
      id: Date.now(),
      name: goalForm.name,
      targetAmount: parseFloat(goalForm.targetAmount),
      targetDate: goalForm.targetDate,
      icon: goalForm.icon,
      savedAmount: 0,
      createdAt: new Date().toISOString(),
    };
    saveGoals([...goals, goal]);
    setGoalForm({ name:'', targetAmount:'', targetDate:'', icon:'🎯' });
    setShowGoalForm(false);
  };

  const handleGoalDeposit = (id, amount) => {
    const updated = goals.map(g => g.id === id ? {...g, savedAmount: Math.min(g.savedAmount + amount, g.targetAmount)} : g);
    saveGoals(updated);
  };

  const handleDeleteGoal = (id) => {
    saveGoals(goals.filter(g => g.id !== id));
  };

  const generateGoalRecs = () => {
    setGoalsLoading(true);
    // Analyse spending by category to find cuttable areas
    const catTotals = {};
    expenses.forEach(e => { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });
    const recs = [];
    // Sort by highest spend first, suggest 10-20% cuts
    const sorted = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
    sorted.forEach(([cat, total]) => {
      const skip = ['Rent','Healthcare','Education','Utilities'];
      if (skip.includes(cat)) return;
      const cut10 = Math.round(total * 0.10);
      const cut15 = Math.round(total * 0.15);
      goals.forEach(goal => {
        const remaining = goal.targetAmount - goal.savedAmount;
        if (remaining <= 0) return;
        const monthsWith10 = Math.ceil(remaining / cut10);
        const monthsWith15 = Math.ceil(remaining / cut15);
        recs.push({
          goal: goal.name,
          goalIcon: goal.icon,
          category: cat,
          cut10, cut15,
          monthsWith10, monthsWith15,
          currentSpend: total,
        });
      });
    });
    setGoalRecs(recs.slice(0, 5));
    setGoalsLoading(false);
  };

  // ── Feature 2: Dynamic weekly savings ──
  const computeSavingsAlloc = () => {
    if (!monthlyIncome) return alert('Set your monthly income first.');
    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
    const daysPassed = today.getDate();
    const daysLeft = daysInMonth - daysPassed;
    const weeksLeft = Math.max(daysLeft / 7, 0.5);
    const dailyRate = totalExpenses / Math.max(daysPassed, 1);
    const projectedMonthly = dailyRate * daysInMonth;
    // If projected spend exceeds income, calculate how much to cut daily to save at least 15%
    const minSavingsTarget = monthlyIncome * 0.15;
    const maxSpendAllowed = monthlyIncome - minSavingsTarget;
    const isOverspending = projectedMonthly > maxSpendAllowed;
    const projectedSavings = monthlyIncome - projectedMonthly;
    const achievableSavings = Math.max(projectedSavings, 0);
    // How much to cut per day to hit 15% savings goal
    const dailyCutNeeded = isOverspending ? Math.ceil((projectedMonthly - maxSpendAllowed) / Math.max(daysLeft, 1)) : 0;
    const weeklySaving = Math.round(achievableSavings / weeksLeft);
    const dailySaving  = Math.round(achievableSavings / Math.max(daysLeft, 1));
    const savingsRate  = monthlyIncome > 0 ? ((achievableSavings / monthlyIncome) * 100).toFixed(1) : 0;
    setSavingsAlloc({ weeklySaving, dailySaving, projectedSavings: achievableSavings, projectedMonthly, savingsRate, daysLeft, isOverspending, dailyCutNeeded, minSavingsTarget });
  };

  // ── Feature 3: Travel Mode ──
  const CURRENCIES = [
    {code:'USD',name:'US Dollar',flag:'🇺🇸'},
    {code:'EUR',name:'Euro',flag:'🇪🇺'},
    {code:'GBP',name:'British Pound',flag:'🇬🇧'},
    {code:'JPY',name:'Japanese Yen',flag:'🇯🇵'},
    {code:'AED',name:'UAE Dirham',flag:'🇦🇪'},
    {code:'SGD',name:'Singapore Dollar',flag:'🇸🇬'},
    {code:'THB',name:'Thai Baht',flag:'🇹🇭'},
    {code:'AUD',name:'Australian Dollar',flag:'🇦🇺'},
    {code:'CAD',name:'Canadian Dollar',flag:'🇨🇦'},
    {code:'MYR',name:'Malaysian Ringgit',flag:'🇲🇾'},
  ];

  const fetchExchangeRate = async (currency) => {
    setRateLoading(true);
    try {
      const res = await fetch(`https://api.exchangerate-api.com/v4/latest/INR`);
      const data = await res.json();
      const rate = data.rates[currency];
      setExchangeRate({ rate, currency, base: 'INR', updatedAt: new Date() });
    } catch {
      // Fallback hardcoded rates if API fails
      const fallback = {USD:0.012,EUR:0.011,GBP:0.0095,JPY:1.78,AED:0.044,SGD:0.016,THB:0.42,AUD:0.018,CAD:0.016,MYR:0.056};
      setExchangeRate({ rate: fallback[currency]||0.012, currency, base:'INR', updatedAt: new Date(), fallback:true });
    } finally { setRateLoading(false); }
  };

  const toggleTravelMode = async (currency) => {
    const cur = currency || travelCurrency;
    setTravelCurrency(cur);
    if (!travelMode) {
      setTravelMode(true);
      await fetchExchangeRate(cur);
    } else {
      setTravelMode(false);
      setExchangeRate(null);
    }
  };

  const fmtTravel = (inr) => {
    if (!travelMode || !exchangeRate) return `₹${fmt(inr)}`;
    const converted = (inr * exchangeRate.rate).toFixed(2);
    const symbols = {USD:'$',EUR:'€',GBP:'£',JPY:'¥',AED:'د.إ',SGD:'S$',THB:'฿',AUD:'A$',CAD:'C$',MYR:'RM'};
    return `${symbols[exchangeRate.currency]||''}${Number(converted).toLocaleString('en-IN')}`;
  };

  // ── Feature 4: Spending Anomaly Detector ──
  const detectAnomalies = () => {
    if (expenses.length < 5) return alert('Add at least 5 expenses to detect anomalies.');
    const catTotals = {};
    const catCounts = {};
    const catHistory = {};
    expenses.forEach(e => {
      catTotals[e.category]  = (catTotals[e.category]  || 0) + e.amount;
      catCounts[e.category]  = (catCounts[e.category]  || 0) + 1;
      if (!catHistory[e.category]) catHistory[e.category] = [];
      catHistory[e.category].push(e.amount);
    });

    const results = [];

    Object.entries(catHistory).forEach(([cat, amounts]) => {
      if (amounts.length < 2) return;
      const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const std  = Math.sqrt(amounts.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / amounts.length);
      const max  = Math.max(...amounts);
      const min  = Math.min(...amounts);

      // Flag if any single expense is > 2 std deviations above mean
      amounts.forEach((amt, i) => {
        if (std > 0 && amt > mean + 2 * std) {
          results.push({
            type: 'spike',
            category: cat,
            amount: amt,
            mean: Math.round(mean),
            std: Math.round(std),
            severity: amt > mean + 3 * std ? 'high' : 'medium',
            message: `Unusually high ${cat} expense of ₹${amt.toLocaleString('en-IN')} detected — your average is ₹${Math.round(mean).toLocaleString('en-IN')}`,
          });
        }
      });

      // Flag if category total is > 40% of total spending
      const catPct = (catTotals[cat] / totalExpenses) * 100;
      if (catPct > 40 && catTotals[cat] > 1000) {
        results.push({
          type: 'dominant',
          category: cat,
          amount: catTotals[cat],
          pct: catPct.toFixed(1),
          severity: catPct > 60 ? 'high' : 'medium',
          message: `${cat} is eating ${catPct.toFixed(1)}% of your total spending — consider balancing your budget`,
        });
      }

      // Flag high frequency — more than 10 transactions in one category
      if (catCounts[cat] > 10) {
        results.push({
          type: 'frequency',
          category: cat,
          count: catCounts[cat],
          total: catTotals[cat],
          severity: 'low',
          message: `${catCounts[cat]} transactions in ${cat} this month — small amounts add up to ₹${catTotals[cat].toLocaleString('en-IN')}`,
        });
      }
    });

    // Check if spending > 90% of income
    if (monthlyIncome > 0 && totalExpenses > monthlyIncome * 0.9) {
      results.push({
        type: 'overspend',
        category: 'Overall',
        amount: totalExpenses,
        pct: ((totalExpenses / monthlyIncome) * 100).toFixed(1),
        severity: totalExpenses > monthlyIncome ? 'high' : 'medium',
        message: totalExpenses > monthlyIncome
          ? `⚠️ You've exceeded your income! Spent ₹${totalExpenses.toLocaleString('en-IN')} vs income ₹${monthlyIncome.toLocaleString('en-IN')}`
          : `You've used ${((totalExpenses / monthlyIncome) * 100).toFixed(1)}% of your monthly income already`,
      });
    }

    setAnomalies(results.length > 0 ? results : []);
  };

  // ── Feature 5: Lifestyle Impact Calculator ──
  const computeLifestyle = () => {
    if (expenses.length === 0) return alert('Add some expenses first.');
    const catTotals = {};
    expenses.forEach(e => { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });

    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
    const insights = [];

    // Food delivery / eating out
    const foodSpend = catTotals['Food'] || 0;
    if (foodSpend > 0) {
      const daily = (foodSpend / daysInMonth).toFixed(0);
      const annual = foodSpend * 12;
      const cut20 = Math.round(annual * 0.20);
      const invested1yr = Math.round(cut20 * 1.12); // 12% annual return
      const invested5yr = Math.round(cut20 * Math.pow(1.12, 5));
      insights.push({
        icon: '🍽',
        category: 'Food',
        daily: Number(daily),
        monthly: foodSpend,
        annual,
        title: `You spend ₹${daily}/day on food`,
        impact: `If you cut food spending by 20%, you'd save ₹${cut20.toLocaleString('en-IN')} annually.`,
        invested: `Invested at 12% returns: ₹${invested1yr.toLocaleString('en-IN')} in 1 year, ₹${invested5yr.toLocaleString('en-IN')} in 5 years.`,
        cut20,
      });
    }

    // Entertainment / subscriptions
    const entSpend = (catTotals['Entertainment'] || 0) + (catTotals['Subscriptions'] || 0);
    if (entSpend > 0) {
      const annual = entSpend * 12;
      const cut30 = Math.round(annual * 0.30);
      const invested3yr = Math.round(cut30 * Math.pow(1.12, 3));
      insights.push({
        icon: '🎬',
        category: 'Entertainment',
        monthly: entSpend,
        annual,
        title: `₹${entSpend.toLocaleString('en-IN')}/month on entertainment & subscriptions`,
        impact: `Cutting 30% saves ₹${cut30.toLocaleString('en-IN')}/year.`,
        invested: `Invested over 3 years at 12%: ₹${invested3yr.toLocaleString('en-IN')}.`,
        cut20: cut30,
      });
    }

    // Shopping
    const shopSpend = catTotals['Shopping'] || 0;
    if (shopSpend > 0) {
      const annual = shopSpend * 12;
      const cut25 = Math.round(annual * 0.25);
      insights.push({
        icon: '🛍',
        category: 'Shopping',
        monthly: shopSpend,
        annual,
        title: `₹${shopSpend.toLocaleString('en-IN')}/month on shopping`,
        impact: `A 25% reduction saves ₹${cut25.toLocaleString('en-IN')} per year.`,
        invested: `That's ₹${Math.round(cut25/12).toLocaleString('en-IN')}/month you could invest or save.`,
        cut20: cut25,
      });
    }

    // Transport
    const transSpend = (catTotals['Transport'] || 0) + (catTotals['Travel'] || 0);
    if (transSpend > 500) {
      const annual = transSpend * 12;
      const cut15 = Math.round(annual * 0.15);
      insights.push({
        icon: '🚗',
        category: 'Transport',
        monthly: transSpend,
        annual,
        title: `₹${transSpend.toLocaleString('en-IN')}/month on transport`,
        impact: `15% reduction = ₹${cut15.toLocaleString('en-IN')} saved annually.`,
        invested: `Equivalent to ${Math.round(cut15/50000*100)}% of a ₹50,000 emergency fund.`,
        cut20: cut15,
      });
    }

    // Overall savings potential
    const totalAnnual = totalExpenses * 12;
    const savePotential = Math.round(totalAnnual * 0.15);
    const fiveYr = Math.round(savePotential * ((Math.pow(1.12,5)-1)/0.12)); // SIP formula
    insights.push({
      icon: '💰',
      category: 'Overall',
      monthly: totalExpenses,
      annual: totalAnnual,
      title: `Total annual spend: ₹${totalAnnual.toLocaleString('en-IN')}`,
      impact: `Saving just 15% (₹${savePotential.toLocaleString('en-IN')}/yr) and investing in a SIP...`,
      invested: `...could grow to ₹${fiveYr.toLocaleString('en-IN')} in 5 years at 12% annual returns.`,
      cut20: savePotential,
      highlight: true,
    });

    setLifestyle(insights);
  };

  // ── Feature 6: Smart Weekly Summary ──
  const generateWeeklySummary = () => {
    if (expenses.length === 0) return alert('Add some expenses first.');
    setWeeklyLoading(true);

    const now   = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay()); // start of this week (Sunday)
    start.setHours(0, 0, 0, 0);

    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - 7);

    const thisWeek = expenses.filter(e => new Date(e.date) >= start);
    const lastWeek = expenses.filter(e => new Date(e.date) >= prevStart && new Date(e.date) < start);

    const thisTotal = thisWeek.reduce((s, e) => s + e.amount, 0);
    const lastTotal = lastWeek.reduce((s, e) => s + e.amount, 0);

    // Category breakdown this week
    const catTotals = {};
    thisWeek.forEach(e => { catTotals[e.category] = (catTotals[e.category] || 0) + e.amount; });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
    const topCat  = topCats[0];

    // Daily average
    const daysTracked = Math.max(now.getDay() || 7, 1);
    const dailyAvg    = thisTotal / daysTracked;

    // Weekly income (pro-rated)
    const weeklyIncome  = monthlyIncome > 0 ? Math.round((monthlyIncome / 4.33)) : 0;
    const weeklySavings = weeklyIncome > 0 ? weeklyIncome - thisTotal : 0;

    // WoW change
    const wowChange = lastTotal > 0 ? ((thisTotal - lastTotal) / lastTotal * 100).toFixed(1) : null;
    const wowDir    = wowChange === null ? null : thisTotal > lastTotal ? 'up' : 'down';

    // Smart suggestion — find biggest non-essential category to cut
    const nonEssential = topCats.filter(([cat]) => !['Rent','Healthcare','Education','Utilities'].includes(cat));
    let suggestion = null;
    if (nonEssential.length > 0) {
      const [sugCat, sugAmt] = nonEssential[0];
      const cut20 = Math.round(sugAmt * 0.20);
      const annualSave = cut20 * 52;
      suggestion = {
        category: sugCat,
        current: sugAmt,
        cut: cut20,
        annualSave,
        text: `Reduce ${sugCat} spending by 20% to save ₹${cut20.toLocaleString('en-IN')} this week — that's ₹${annualSave.toLocaleString('en-IN')} annually.`,
      };
    }

    // Day-by-day breakdown
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const byDay = Array(7).fill(0).map((_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const total = expenses
        .filter(e => new Date(e.date) >= d && new Date(e.date) < next)
        .reduce((s, e) => s + e.amount, 0);
      return { day: dayNames[i], total, isFuture: d > now };
    });
    const maxDay = Math.max(...byDay.map(d => d.total), 1);

    const summary = {
      weekStart:    start.toLocaleDateString('en-IN', { day:'numeric', month:'short' }),
      weekEnd:      now.toLocaleDateString('en-IN',   { day:'numeric', month:'short', year:'numeric' }),
      thisTotal,
      lastTotal,
      wowChange,
      wowDir,
      topCats:      topCats.slice(0, 4),
      topCat,
      dailyAvg,
      weeklyIncome,
      weeklySavings,
      suggestion,
      byDay,
      maxDay,
      txCount:      thisWeek.length,
    };

    setWeeklySummary(summary);
    setWeeklyLoading(false);
  };

  // ── EMI helpers ──
  const saveLoans = (updated) => {
    setLoans(updated);
    localStorage.setItem('ft_loans', JSON.stringify(updated));
  };

  const calcEMI = (principal, annualRate, months) => {
    const r = annualRate / 12 / 100;
    if (r === 0) return principal / months;
    return (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  };

  const getLoanSchedule = (loan) => {
    const { principal, rate, tenureMonths, startDate } = loan;
    const p = parseFloat(principal), r = parseFloat(rate), m = parseInt(tenureMonths);
    const emi = calcEMI(p, r, m);
    let balance = p;
    const schedule = [];
    const start = new Date(startDate);
    for (let i = 0; i < m; i++) {
      const interest = balance * (r / 12 / 100);
      const principalPaid = emi - interest;
      balance -= principalPaid;
      const date = new Date(start);
      date.setMonth(start.getMonth() + i);
      schedule.push({ month: i + 1, emi: Math.round(emi), interest: Math.round(interest), principal: Math.round(principalPaid), balance: Math.max(Math.round(balance), 0), date });
    }
    return schedule;
  };

  const handleAddLoan = () => {
    const { name, principal, rate, tenureMonths, startDate } = loanForm;
    if (!name || !principal || !rate || !tenureMonths || !startDate) return alert('Fill all fields.');
    const p = parseFloat(principal), r = parseFloat(rate), m = parseInt(tenureMonths);
    const emi = Math.round(calcEMI(p, r, m));
    const totalPayable = emi * m;
    const totalInterest = totalPayable - p;
    const loan = { id: Date.now(), ...loanForm, principal: p, rate: r, tenureMonths: m, emi, totalPayable, totalInterest, paidMonths: 0 };
    saveLoans([...loans, loan]);
    setLoanForm({ name:'', principal:'', rate:'', tenureMonths:'', startDate:'', icon:'💳', type:'home' });
    setShowLoanForm(false);
  };

  const handleLoanPayment = (id) => {
    saveLoans(loans.map(l => l.id === id ? { ...l, paidMonths: Math.min(l.paidMonths + 1, l.tenureMonths) } : l));
  };

  const handleDeleteLoan = (id) => { if(window.confirm('Delete this loan?')) saveLoans(loans.filter(l => l.id !== id)); };

  // ── Salary planner helpers ──
  const getSalaryCountdown = () => {
    const today = new Date();
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), salaryDay);
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, salaryDay);
    const nextSalary = today.getDate() >= salaryDay ? nextMonth : thisMonth;
    const daysLeft = Math.ceil((nextSalary - today) / (1000*60*60*24));
    const daysSinceSalary = today.getDate() >= salaryDay ? today.getDate() - salaryDay : (new Date(today.getFullYear(), today.getMonth(), 0).getDate() - salaryDay) + today.getDate();
    const dailyBudget = monthlyIncome > 0 ? monthlyIncome / 30 : 0;
    const budgetUsed = totalExpenses;
    const budgetExpected = dailyBudget * daysSinceSalary;
    const budgetRemaining = monthlyIncome - totalExpenses;
    const dailyRemaining = daysLeft > 0 ? budgetRemaining / daysLeft : 0;
    const onTrack = budgetUsed <= budgetExpected;
    return { daysLeft, daysSinceSalary, dailyBudget, budgetUsed, budgetExpected, budgetRemaining, dailyRemaining, onTrack, nextSalary };
  };

  const checkAffordability = () => {
    const amount = parseFloat(affordCheck);
    if (!amount || amount <= 0) return alert('Enter a valid amount.');
    const { budgetRemaining, dailyRemaining, daysLeft } = getSalaryCountdown();
    const canAfford = budgetRemaining >= amount;
    const impactOnDaily = dailyRemaining - (amount / daysLeft);
    setAffordResult({ amount, canAfford, budgetRemaining, impactOnDaily, daysLeft,
      message: canAfford
        ? `Yes! You can afford ₹${amount.toLocaleString('en-IN')}. You'll have ₹${Math.round(budgetRemaining - amount).toLocaleString('en-IN')} left for ${daysLeft} days.`
        : `Not recommended. You only have ₹${Math.round(budgetRemaining).toLocaleString('en-IN')} left and need it for ${daysLeft} more days.`
    });
  };

  const loadBudget=async()=>{
    setAiLoading(true); setAiError('');
    try{
      const res=await API.get('/ai/budget-suggestion');
      if(res.data.suggestion){
        const raw = res.data.suggestion;
        // Normalize to what the UI expects
        const totalBudget = raw.totalSuggestedBudget || raw.totalBudget || 0;
        // Always cap budget at 85% of income to ensure 15% savings
        const SAVINGS_RATE = 0.15;
        const maxAllowedBudget = monthlyIncome > 0 ? Math.round(monthlyIncome * (1 - SAVINGS_RATE)) : totalBudget;
        const scaleFactor = totalBudget > maxAllowedBudget ? (maxAllowedBudget / totalBudget) : 1;
        const cappedBudget = Math.min(Math.round(totalBudget * scaleFactor), maxAllowedBudget);
        const savingsTarget = monthlyIncome > 0 ? (monthlyIncome - cappedBudget) : 0;
        const categoryLimits = {};
        if(raw.categories){
          raw.categories.forEach(c => { categoryLimits[c.category] = Math.round((c.suggested || c.amount || 0) * scaleFactor); });
        } else if(raw.categoryLimits){
          Object.assign(categoryLimits, raw.categoryLimits);
        }
        const advice = raw.advice || (raw.categories?.[0]?.reason) || 'Based on your spending patterns.';
        setBudget({ totalBudget: cappedBudget, savingsTarget, categoryLimits, advice });
      } else {
        setAiError(res.data.message||'Add at least 3 expenses to get budget suggestions.');
      }
    }catch(err){
      console.error('Budget error:', err);
      setAiError('Budget suggestion failed. Check your Anthropic API key in .env');
    }
    finally{ setAiLoading(false); }
  };

  /* ─────────────────────────────────────────────
     FIX 3: Forecast — normalize API response
     API returns: { forecastedTotal, categories, insight }
     UI expects:  { predictedTotal, trend, confidence, insight }
  ───────────────────────────────────────────── */
  const loadForecast=async()=>{
    setAiLoading(true); setAiError('');
    try{
      const res=await API.get('/ai/forecast');
      if(res.data.forecast){
        const raw = res.data.forecast;
        // Normalize to what the UI expects
        const predictedTotal = raw.forecastedTotal || raw.predictedTotal || 0;
        // Determine trend by comparing to current month spending
        let trend = raw.trend || 'stable';
        if(!raw.trend && totalExpenses > 0){
          if(predictedTotal > totalExpenses * 1.05) trend = 'increasing';
          else if(predictedTotal < totalExpenses * 0.95) trend = 'decreasing';
          else trend = 'stable';
        }
        const confidence = raw.confidence || 'medium';
        const insight = raw.insight || 'Based on your recent spending, we estimate similar expenses next month.';
        setForecast({ predictedTotal, trend, confidence, insight });
      } else {
        setAiError(res.data.message||'Add at least 5 expenses for forecasting.');
      }
    }catch(err){
      console.error('Forecast error:', err);
      setAiError('Forecast failed. Check your Anthropic API key in .env');
    }
    finally{ setAiLoading(false); }
  };

  if(loading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',color:'var(--text-muted)',fontFamily:'var(--font)'}}>Loading…</div>;

  return (
    <div className="et">
      {(!online || pendingCount>0) && (
        <div className={`et-offline-banner ${online?'et-offline-banner--syncing':'et-offline-banner--offline'}`}>
          <span>{online?(syncing?'⏳':'☁️'):'📵'}</span>
          <span className="et-offline-banner__text">
            {!online?`You're offline — ${pendingCount} expense${pendingCount!==1?'s':''} queued`:
             syncing?'Syncing offline data…':`${pendingCount} expense${pendingCount!==1?'s':''} pending sync`}
          </span>
          {online&&!syncing&&pendingCount>0&&(
            <button className="et-offline-banner__btn" onClick={syncOffline}>Sync now</button>
          )}
        </div>
      )}

      <aside className="et-sidebar">
        <div className="et-brand">
          <div className="et-brand__logo">₹</div>
          <div>
            <div className="et-brand__name">FinTrack</div>
            <div className="et-brand__sub">Personal Finance</div>
          </div>
        </div>
        <nav className="et-nav">
          {[
            {id:'overview',     icon:'⊞', label:'Overview'},
            {id:'transactions', icon:'≡', label:'Transactions'},
            {id:'analytics',    icon:'◈', label:'Analytics'},
            {id:'subscriptions',icon:'🔔',label:'Subscriptions'},
            {id:'ai',           icon:'✨',label:'AI Insights'},
            {id:'goals',         icon:'🎯',label:'Goals & Travel'},
            {id:'insights',      icon:'🧠',label:'Smart Insights'},
            {id:'weekly',        icon:'📋',label:'Weekly Summary'},
            {id:'emi',           icon:'💳',label:'EMI Tracker'},
            {id:'salary',        icon:'📅',label:'Salary Planner'},
          ].map(t=>(
            <button key={t.id}
              className={`et-nav__item${activeTab===t.id?' et-nav__item--active':''}`}
              onClick={()=>setActiveTab(t.id)}>
              <span className="et-nav__icon">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="et-income-widget">
          <div className="et-income-widget__label">Monthly Income</div>
          <div className="et-income-widget__amount">₹{fmt(monthlyIncome)}</div>
          <div className="et-income-widget__input">
            <input className="et-income-input" type="number" placeholder="Update income"
              value={incomeInput} onChange={e=>setIncomeInput(e.target.value)}
              onKeyPress={e=>e.key==='Enter'&&handleSetIncome()} />
            <button className="et-btn et-btn--sky et-btn--sm" onClick={handleSetIncome}>Set</button>
          </div>
        </div>
        <div className="et-user-card">
          <div className="et-user-card__avatar">{initials}</div>
          <div>
            <div className="et-user-card__name">{user?.name}</div>
            <div className="et-user-card__username">@{user?.username}</div>
          </div>
        </div>
        <div className="et-sidebar-actions">
          <button onClick={onLogout} className="et-btn et-btn--logout et-btn--sm">⎋ Sign Out</button>
        </div>
      </aside>

      <main className="et-main">
        <header className="et-topbar">
          <div>
            <h1 className="et-topbar__title">
              {activeTab==='overview'?`Hello, ${user?.name?.split(' ')[0]} 👋`:
               activeTab==='transactions'?'Transactions':
               activeTab==='analytics'?'Analytics':
               activeTab==='subscriptions'?'Subscriptions':
               activeTab==='goals'?'Goals & Travel':
               activeTab==='insights'?'Smart Insights':
               activeTab==='weekly'?'Weekly Summary':
               activeTab==='emi'?'EMI & Loan Tracker':
               activeTab==='salary'?'Salary Planner':'AI Insights'}
            </h1>
            <p className="et-topbar__date">
              {new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
            </p>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8,fontSize:12,color:'var(--text-muted)'}}>
            <span style={{width:8,height:8,borderRadius:'50%',background:online?'var(--green)':'var(--red)',display:'inline-block'}}/>
            {online?'Online':'Offline'}
          </div>
        </header>

        {/* ══ OVERVIEW ══ */}
        {activeTab==='overview' && (
          <div className="et-tab-content">
            <div className="et-kpi-strip">
              <div className="et-kpi et-kpi--income">
                <div className="et-kpi__label">Total Income</div>
                <div className="et-kpi__value">₹{fmt(monthlyIncome)}</div>
                <div className="et-kpi__badge et-kpi__badge--up">↑ Monthly</div>
              </div>
              <div className="et-kpi et-kpi--expense">
                <div className="et-kpi__label">Total Spent</div>
                <div className="et-kpi__value">₹{fmt(totalExpenses)}</div>
                <div className="et-kpi__badge et-kpi__badge--out">{expenses.length} items</div>
              </div>
              <div className={`et-kpi ${balance>=0?'et-kpi--balance':'et-kpi--negative'}`}>
                <div className="et-kpi__label">Net Balance</div>
                <div className="et-kpi__value">₹{fmt(Math.abs(balance))}</div>
                <div className={`et-kpi__badge ${balance>=0?'et-kpi__badge--up':'et-kpi__badge--down'}`}>
                  {balance>=0?'✓ Surplus':'⚠ Deficit'}
                </div>
              </div>
            </div>
            {monthlyIncome>0 && (
              <div className="et-budget-bar">
                <div className="et-budget-bar__header">
                  <span>Budget Utilization</span>
                  <span className="et-budget-bar__pct">{spentPct.toFixed(1)}%</span>
                </div>
                <div className="et-budget-bar__track">
                  <div className={`et-budget-bar__fill${spentPct>85?' et-budget-bar__fill--danger':spentPct>60?' et-budget-bar__fill--warn':''}`}
                    style={{width:`${spentPct}%`}}/>
                </div>
                <div className="et-budget-bar__labels"><span>₹0</span><span>₹{fmt(monthlyIncome)}</span></div>
              </div>
            )}
            {topCategories().length>0 && (
              <div className="et-category-grid">
                {topCategories().slice(0,6).map(([cat,amt])=>{
                  const meta=CAT_META[cat]||{color:'#8CA5C2',icon:'📦'};
                  const pct=totalExpenses>0?((amt/totalExpenses)*100).toFixed(1):0;
                  return (
                    <div key={cat} className="et-cat-card">
                      <div className="et-cat-card__icon">{meta.icon}</div>
                      <div className="et-cat-card__name">{cat}</div>
                      <div className="et-cat-card__amount">₹{fmt(amt)}</div>
                      <div className="et-cat-card__bar">
                        <div className="et-cat-card__fill" style={{width:`${pct}%`,background:meta.color}}/>
                      </div>
                      <div className="et-cat-card__pct">{pct}%</div>
                    </div>
                  );
                })}
              </div>
            )}
            {expenses.length===0&&monthlyIncome===0&&(
              <div className="et-empty"><div className="et-empty__icon">🚀</div><p>Set your income and add your first expense!</p></div>
            )}
          </div>
        )}

        {/* ══ TRANSACTIONS ══ */}
        {activeTab==='transactions' && (
          <div className="et-tab-content">
            <div className="et-form-card">
              <h2 className="et-form-card__title">Add Transaction</h2>
              {supported && (
                <div className="et-voice-row" style={{marginBottom:16}}>
                  <button className={`et-voice-btn${listening?' et-voice-btn--active':''}`}
                    onClick={listening?stop:start}
                    title={listening?'Stop recording':'Voice input'}>
                    <span>{processing?'⏳':listening?'⏹':'🎙'}</span>
                    {listening&&<><span className="et-voice-ring"/><span className="et-voice-ring"/></>}
                  </button>
                  {listening&&<><span className="et-voice-dot"/><span>Listening…</span></>}
                  {processing&&<span>Parsing with AI…</span>}
                  {!listening&&!processing&&<span style={{color:'var(--text-muted)'}}>Say: "Add ₹500 for dinner at Barbeque Nation"</span>}
                </div>
              )}
              {aiTag && (
                <div style={{padding:'10px 14px',background:'rgba(47,58,126,.07)',borderRadius:'var(--radius-sm)',fontSize:13,color:'var(--text-secondary)',marginBottom:14,display:'flex',gap:8,alignItems:'center'}}>
                  🤖 AI suggested <strong>{aiTag.category}</strong> for "{aiTag.merchant}"
                  <button style={{marginLeft:'auto',fontSize:12,color:'var(--teal)',fontWeight:600,background:'none',border:'none',cursor:'pointer'}}
                    onClick={()=>setAiTag(null)}>Dismiss</button>
                </div>
              )}
              <div className="et-form-grid">
                <div className="et-field">
                  <label className="et-label">Description</label>
                  <input className="et-input" type="text" placeholder="e.g. Grocery run"
                    value={expName} onChange={e=>setExpName(e.target.value)}/>
                </div>
                <div className="et-field">
                  <label className="et-label">Amount (₹)</label>
                  <input className="et-input" type="number" placeholder="0.00"
                    value={expAmt} onChange={e=>setExpAmt(e.target.value)}
                    onKeyPress={e=>e.key==='Enter'&&handleAddExpense()}/>
                </div>
                <div className="et-field">
                  <label className="et-label">Category</label>
                  <select className="et-input et-select" value={expCat} onChange={e=>setExpCat(e.target.value)}>
                    {CATEGORIES.map(c=><option key={c} value={c}>{CAT_META[c]?.icon} {c}</option>)}
                  </select>
                </div>
                <div className="et-field">
                  <label className="et-label">Date</label>
                  <input className="et-input" type="date"
                    value={expDate} onChange={e=>setExpDate(e.target.value)}
                    max={new Date().toISOString().split('T')[0]}/>
                </div>
                <div className="et-field et-field--btn">
                  <button onClick={handleAddExpense} className="et-btn et-btn--primary et-btn--full">
                    + Add{!online?' (Offline)':''}
                  </button>
                </div>
              </div>
            </div>
            {/* View mode toggle */}
            {expenses.length > 0 && (
              <div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center'}}>
                <span style={{fontSize:12,color:'var(--text-muted)',marginRight:4}}>View:</span>
                {['daily','weekly','monthly'].map(m=>(
                  <button key={m} onClick={()=>setViewMode(m)}
                    style={{padding:'5px 14px',borderRadius:20,border:'1px solid',fontSize:12,cursor:'pointer',fontWeight:500,
                      borderColor: viewMode===m?'var(--navy)':'rgba(0,0,0,.12)',
                      background:  viewMode===m?'var(--navy)':'transparent',
                      color:       viewMode===m?'white':'var(--text-secondary)'}}>
                    {m.charAt(0).toUpperCase()+m.slice(1)}
                  </button>
                ))}
              </div>
            )}

            {expenses.length===0 ? (
              <div className="et-empty"><div className="et-empty__icon">📭</div><p>No transactions yet. Add one above.</p></div>
            ) : viewMode==='daily' ? (
              /* ── Daily grouped view ── */
              (() => {
                const byDay = {};
                expenses.forEach(e=>{
                  const d = new Date(e.date).toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
                  if(!byDay[d]) byDay[d] = { label:d, exps:[], total:0, date: new Date(e.date) };
                  byDay[d].exps.push(e);
                  byDay[d].total += e.amount;
                });
                const days = Object.values(byDay).sort((a,b)=>b.date-a.date);
                return (
                  <div style={{display:'grid',gap:12}}>
                    {days.map(({label,exps,total})=>(
                      <div key={label} style={{background:'white',borderRadius:'var(--radius-sm)',boxShadow:'var(--shadow-sm)',overflow:'hidden'}}>
                        <div style={{display:'flex',justifyContent:'space-between',padding:'10px 16px',background:'var(--sky-pale)',borderBottom:'1px solid rgba(0,0,0,.06)'}}>
                          <span style={{fontWeight:600,fontSize:13,color:'var(--navy)'}}>{label}</span>
                          <span style={{fontWeight:700,fontSize:13,color:'var(--teal)'}}>₹{fmt(total)}</span>
                        </div>
                        {exps.map((exp,i)=>{
                          const meta=CAT_META[exp.category]||{color:'#8CA5C2',icon:'📦'};
                          return (
                            <div key={exp._id} data-id={exp._id} className="et-row" style={{animationDelay:`${i*.04}s`,borderRadius:0,borderBottom:'1px solid rgba(0,0,0,.04)'}}>
                              <div className="et-row__name">
                                <div className="et-row__avatar" style={{background:`${meta.color}18`,color:meta.color}}>{meta.icon}</div>
                                <span>{exp.name}</span>
                              </div>
                              <div><span className="et-tag" style={{'--c':meta.color}}>{exp.category}</span></div>
                              <div className="et-row__date">{new Date(exp.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</div>
                              <div className="et-row__amount">₹{fmt(exp.amount)}</div>
                              <button className="et-row__del" onClick={()=>handleDelete(exp._id)}>×</button>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    <div style={{textAlign:'right',fontSize:13,color:'var(--text-muted)',padding:'4px 0'}}>
                      Total: <strong style={{color:'var(--navy)'}}>₹{fmt(totalExpenses)}</strong>
                    </div>
                  </div>
                );
              })()
            ) : viewMode==='weekly' ? (
              /* ── Weekly grouped view ── */
              (() => {
                const getWeekLabel = (date) => {
                  const d = new Date(date);
                  const day = d.getDay();
                  const sun = new Date(d); sun.setDate(d.getDate()-day); sun.setHours(0,0,0,0);
                  const sat = new Date(sun); sat.setDate(sun.getDate()+6);
                  return `${sun.toLocaleDateString('en-IN',{day:'numeric',month:'short'})} – ${sat.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}`;
                };
                const byWeek = {};
                expenses.forEach(e=>{
                  const wk = getWeekLabel(e.date);
                  const d = new Date(e.date); const day=d.getDay();
                  const sun=new Date(d); sun.setDate(d.getDate()-day);
                  if(!byWeek[wk]) byWeek[wk]={label:wk,exps:[],total:0,catTotals:{},weekStart:sun};
                  byWeek[wk].exps.push(e);
                  byWeek[wk].total+=e.amount;
                  byWeek[wk].catTotals[e.category]=(byWeek[wk].catTotals[e.category]||0)+e.amount;
                });
                const weeks = Object.values(byWeek).sort((a,b)=>b.weekStart-a.weekStart);
                return (
                  <div style={{display:'grid',gap:16}}>
                    {weeks.map(({label,exps,total,catTotals})=>{
                      const topCat = Object.entries(catTotals).sort((a,b)=>b[1]-a[1])[0];
                      return (
                        <div key={label} style={{background:'white',borderRadius:'var(--radius-sm)',boxShadow:'var(--shadow-sm)',overflow:'hidden'}}>
                          <div style={{padding:'12px 16px',background:'linear-gradient(135deg,var(--navy),#2F3A7E)',color:'white'}}>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                              <span style={{fontWeight:700,fontSize:14}}>Week of {label}</span>
                              <span style={{fontWeight:700,fontSize:16}}>₹{fmt(total)}</span>
                            </div>
                            <div style={{fontSize:12,opacity:.7,marginTop:2}}>
                              {exps.length} transactions · Most spent on {topCat?.[0]}: ₹{fmt(topCat?.[1])}
                            </div>
                          </div>
                          <div style={{padding:'10px 16px',display:'flex',flexWrap:'wrap',gap:8}}>
                            {Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>{
                              const meta=CAT_META[cat]||{color:'#8CA5C2',icon:'📦'};
                              return (
                                <div key={cat} style={{display:'flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:20,background:`${meta.color}12`,fontSize:12}}>
                                  <span>{meta.icon}</span>
                                  <span style={{color:'var(--text-secondary)'}}>{cat}</span>
                                  <span style={{fontWeight:700,color:meta.color}}>₹{fmt(amt)}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    <div style={{textAlign:'right',fontSize:13,color:'var(--text-muted)'}}>
                      Monthly Total: <strong style={{color:'var(--navy)'}}>₹{fmt(totalExpenses)}</strong>
                    </div>
                  </div>
                );
              })()
            ):(
              /* ── Monthly (default) flat list ── */
              <div className="et-table-card">
                <div className="et-table-header">
                  <span>Description</span><span>Category</span><span>Date</span><span>Amount</span><span/>
                </div>
                <div className="et-table-body">
                  {expenses.map((exp,i)=>{
                    const meta=CAT_META[exp.category]||{color:'#8CA5C2',icon:'📦'};
                    return (
                      <div key={exp._id} data-id={exp._id} className="et-row" style={{animationDelay:`${i*.04}s`}}>
                        <div className="et-row__name">
                          <div className="et-row__avatar" style={{background:`${meta.color}18`,color:meta.color}}>{meta.icon}</div>
                          <span>{exp.name}</span>
                        </div>
                        <div><span className="et-tag" style={{'--c':meta.color}}>{exp.category}</span></div>
                        <div className="et-row__date">{new Date(exp.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</div>
                        <div className="et-row__amount">₹{fmt(exp.amount)}</div>
                        <button className="et-row__del" onClick={()=>handleDelete(exp._id)}>×</button>
                      </div>
                    );
                  })}
                </div>
                <div className="et-table-footer">
                  <span>{expenses.length} transaction{expenses.length!==1?'s':''}</span>
                  <span className="et-table-footer__total">Total: ₹{fmt(totalExpenses)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ ANALYTICS ══ */}
        {activeTab==='analytics' && (
          <div className="et-tab-content">
            {expenses.length===0 ? (
              <div className="et-empty"><div className="et-empty__icon">📊</div><p>Add expenses to see analytics.</p></div>
            ):(
              <div className="et-analytics-grid">
                <div className="et-analytics-card">
                  <h3 className="et-analytics-card__title">Spending Distribution</h3>
                  <DonutChart expenses={expenses} animateChart={animateChart} spentPct={spentPct} totalExpenses={totalExpenses}/>
                </div>
                <div className="et-analytics-card">
                  <h3 className="et-analytics-card__title">Category Breakdown</h3>
                  <div className="et-bars">
                    {topCategories().map(([cat,amt],i)=>{
                      const meta=CAT_META[cat]||{color:'#8CA5C2',icon:'📦'};
                      const pct=totalExpenses>0?(amt/totalExpenses)*100:0;
                      return (
                        <div key={cat} className="et-bar-row" style={{animationDelay:`${i*.08}s`}}>
                          <div className="et-bar-row__label"><span>{meta.icon} {cat}</span><span>₹{fmt(amt)}</span></div>
                          <div className="et-bar-track"><div className="et-bar-fill" style={{width:`${pct}%`,background:`linear-gradient(90deg,${meta.color}99,${meta.color})`}}/></div>
                          <div className="et-bar-row__pct">{pct.toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="et-stat-grid">
                    <div className="et-stat"><div className="et-stat__label">Avg/Transaction</div><div className="et-stat__val">₹{fmt(expenses.length?totalExpenses/expenses.length:0)}</div></div>
                    <div className="et-stat"><div className="et-stat__label">Largest Expense</div><div className="et-stat__val">₹{fmt(expenses.length?Math.max(...expenses.map(e=>e.amount)):0)}</div></div>
                    <div className="et-stat"><div className="et-stat__label">Categories</div><div className="et-stat__val">{topCategories().length}</div></div>
                    <div className="et-stat"><div className="et-stat__label">Savings Rate</div><div className="et-stat__val">{monthlyIncome>0?((balance/monthlyIncome)*100).toFixed(1):'—'}%</div></div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ SUBSCRIPTIONS ══ */}
        {activeTab==='subscriptions' && (
          <div className="et-tab-content">
            <div className="et-sub-summary">
              <div className="et-sub-summary__item"><div className="et-sub-summary__label">Active</div><div className="et-sub-summary__value">{subs.length}</div></div>
              <div className="et-sub-summary__item"><div className="et-sub-summary__label">Monthly Cost</div><div className="et-sub-summary__value et-sub-summary__value--accent">₹{fmt(totalMonthly)}</div></div>
              <div className="et-sub-summary__item"><div className="et-sub-summary__label">Annual Cost</div><div className="et-sub-summary__value">₹{fmt(totalMonthly*12)}</div></div>
            </div>
            {subs.filter(s=>daysUntil(s.nextRenewalDate)<=7).length>0 && (
              <div className="et-sub-alerts">
                <div className="et-sub-alerts__title">⏰ Upcoming Renewals (within 7 days)</div>
                {subs.filter(s=>daysUntil(s.nextRenewalDate)<=7).map(sub=>(
                  <div key={sub._id} className="et-sub-alert">
                    <span>{sub.icon}</span>
                    <span className="et-sub-alert__name">{sub.name}</span>
                    <span className="et-sub-alert__days">{daysUntil(sub.nextRenewalDate)<=0?'Today!':`in ${daysUntil(sub.nextRenewalDate)}d`}</span>
                    <span className="et-sub-alert__amount">₹{fmt(sub.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <button className="et-btn et-btn--primary" onClick={()=>setShowSubForm(s=>!s)}>
              {showSubForm?'✕ Cancel':'+ Add Subscription'}
            </button>
            {showSubForm && (
              <form className="et-sub-form" onSubmit={handleAddSub}>
                <div className="et-sub-form__grid">
                  {[{k:'name',label:'Name',type:'text',ph:'e.g. Netflix'},{k:'amount',label:'Amount (₹)',type:'number',ph:'0.00'},{k:'nextRenewalDate',label:'Next Renewal',type:'date',ph:''}].map(({k,label,type,ph})=>(
                    <div className="et-field" key={k}>
                      <label className="et-label">{label}</label>
                      <input className="et-input" type={type} placeholder={ph} required
                        value={subForm[k]} onChange={e=>setSubForm(f=>({...f,[k]:e.target.value}))}/>
                    </div>
                  ))}
                  <div className="et-field">
                    <label className="et-label">Billing Cycle</label>
                    <select className="et-input et-select" value={subForm.billingCycle}
                      onChange={e=>setSubForm(f=>({...f,billingCycle:e.target.value}))}>
                      {['weekly','monthly','quarterly','yearly'].map(c=><option key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</option>)}
                    </select>
                  </div>
                </div>
                <button type="submit" className="et-btn et-btn--primary">Save Subscription</button>
              </form>
            )}
            <div className="et-sub-list">
              {subs.length===0 ? (
                <div className="et-empty"><div className="et-empty__icon">🔔</div><p>No subscriptions yet.</p><p>Add them above or they'll auto-detect from recurring expenses.</p></div>
              ):subs.map(sub=>{
                const days=daysUntil(sub.nextRenewalDate);
                return (
                  <div key={sub._id} className={`et-sub-item${days<=3?' et-sub-item--urgent':''}`}>
                    <div className="et-sub-item__icon" style={{background:(sub.color||'#607CBD')+'20',color:sub.color||'#607CBD'}}>{sub.icon||'📦'}</div>
                    <div>
                      <div className="et-sub-item__name">{sub.name}</div>
                      <div className="et-sub-item__meta">
                        {sub.billingCycle} • Renews {new Date(sub.nextRenewalDate).toLocaleDateString('en-IN')}
                        {sub.autoDetected&&<span className="et-sub-badge">Auto-detected</span>}
                      </div>
                    </div>
                    <div className="et-sub-item__amount">₹{fmt(sub.amount)}</div>
                    {days<=3&&<div className="et-sub-item__urgent">⚡ {days<=0?'Due!':`${days}d`}</div>}
                    <button className="et-sub-item__cancel" onClick={()=>handleCancelSub(sub._id)}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ══ AI INSIGHTS ══ */}
        {activeTab==='ai' && (
          <div className="et-tab-content">
            <div className="et-ai-panel">
              <div className="et-ai-panel__title"><span>✨</span> AI Insights</div>
              {aiError&&<div style={{padding:'10px 14px',background:'rgba(192,57,43,.08)',border:'1px solid rgba(192,57,43,.2)',borderRadius:'var(--radius-sm)',fontSize:13,color:'var(--red)',marginBottom:12}}>⚠ {aiError}</div>}

              {/* Budget Card */}
              <div className={`et-ai-card${aiCard==='budget'?' et-ai-card--open':''}`}>
                <div className="et-ai-card__head" onClick={()=>{ setAiCard(c=>c==='budget'?null:'budget'); setAiError(''); }}>
                  <div className="et-ai-card__icon">💡</div>
                  <div><div className="et-ai-card__name">Smart Budget Suggestions</div><div className="et-ai-card__desc">AI-recommended limits based on your spending patterns</div></div>
                  <span className="et-ai-card__chevron">{aiCard==='budget'?'▲':'▼'}</span>
                </div>
                {aiCard==='budget'&&(
                  <div className="et-ai-card__body">
                    {!budget?(
                      <button className="et-ai-btn" onClick={loadBudget} disabled={aiLoading}>
                        {aiLoading?'⏳ Analysing…':'🔮 Generate Budget Suggestion'}
                      </button>
                    ):(
                      <div>
                        {budget.advice&&<div className="et-ai-advice">💬 {budget.advice}</div>}
                        <div className="et-ai-stats">
                          <div className="et-ai-stat"><div className="et-ai-stat__label">Suggested Budget</div><div className="et-ai-stat__val">₹{fmt(budget.totalBudget)}</div></div>
                          <div className="et-ai-stat"><div className="et-ai-stat__label">Savings Target</div><div className="et-ai-stat__val et-ai-stat__val--green">₹{fmt(budget.savingsTarget)}</div></div>
                        </div>
                        {Object.entries(budget.categoryLimits||{}).map(([cat,limit])=>(
                          <div key={cat} style={{display:'grid',gridTemplateColumns:'120px 1fr 70px',alignItems:'center',gap:10,marginBottom:8}}>
                            <span style={{fontSize:12,color:'var(--text-secondary)'}}>{CAT_META[cat]?.icon||'📦'} {cat}</span>
                            <div style={{height:6,background:'var(--sky-pale)',borderRadius:99,overflow:'hidden'}}>
                              <div style={{height:'100%',background:'linear-gradient(90deg,var(--navy),var(--teal))',width:`${Math.min((limit/budget.totalBudget)*100,100)}%`,borderRadius:99}}/>
                            </div>
                            <span style={{fontSize:12,fontFamily:'var(--mono)',color:'var(--text-secondary)',textAlign:'right'}}>₹{fmt(limit)}</span>
                          </div>
                        ))}
                        <button className="et-ai-btn" style={{marginTop:12}} onClick={()=>{ setBudget(null); loadBudget(); }}>↻ Regenerate</button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Forecast Card */}
              <div className={`et-ai-card${aiCard==='forecast'?' et-ai-card--open':''}`}>
                <div className="et-ai-card__head" onClick={()=>{ setAiCard(c=>c==='forecast'?null:'forecast'); setAiError(''); }}>
                  <div className="et-ai-card__icon">🔭</div>
                  <div><div className="et-ai-card__name">Predictive Forecasting</div><div className="et-ai-card__desc">Estimate next month's spending from historical data</div></div>
                  <span className="et-ai-card__chevron">{aiCard==='forecast'?'▲':'▼'}</span>
                </div>
                {aiCard==='forecast'&&(
                  <div className="et-ai-card__body">
                    {!forecast?(
                      <button className="et-ai-btn" onClick={loadForecast} disabled={aiLoading}>
                        {aiLoading?'⏳ Forecasting…':'📊 Generate Forecast'}
                      </button>
                    ):(
                      <div>
                        <div className="et-forecast-main">
                          <div className="et-forecast-label">Predicted Next Month</div>
                          <div className="et-forecast-total">₹{fmt(forecast.predictedTotal)}</div>
                          <div style={{display:'flex',alignItems:'center',gap:10,fontSize:13}}>
                            <span>{{increasing:'📈',stable:'➡️',decreasing:'📉'}[forecast.trend]||'➡️'} {forecast.trend}</span>
                            <span style={{padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:600,background:'rgba(255,255,255,.15)'}}>{forecast.confidence} confidence</span>
                          </div>
                        </div>
                        {forecast.insight&&<div className="et-forecast-insight">💬 {forecast.insight}</div>}
                        {monthlyIncome>0&&<div style={{fontSize:13,color:'var(--text-secondary)',marginTop:10}}>Projected savings: <strong style={{color:'var(--green)'}}>₹{fmt(monthlyIncome-forecast.predictedTotal)}</strong></div>}
                        <button className="et-ai-btn" style={{marginTop:12}} onClick={()=>{ setForecast(null); loadForecast(); }}>↻ Regenerate</button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Voice info */}
              <div className={`et-ai-card${aiCard==='voice'?' et-ai-card--open':''}`}>
                <div className="et-ai-card__head" onClick={()=>setAiCard(c=>c==='voice'?null:'voice')}>
                  <div className="et-ai-card__icon">🎙</div>
                  <div><div className="et-ai-card__name">Voice Input</div><div className="et-ai-card__desc">Log expenses hands-free using your microphone</div></div>
                  <span className="et-ai-card__chevron">{aiCard==='voice'?'▲':'▼'}</span>
                </div>
                {aiCard==='voice'&&(
                  <div className="et-ai-card__body" style={{fontSize:14,color:'var(--text-secondary)',lineHeight:1.7}}>
                    <p>Go to the <strong>Transactions</strong> tab and tap the 🎙 mic button.</p>
                    <p style={{marginTop:8}}>Try saying: <em>"Add five hundred for dinner at Barbeque Nation"</em></p>
                    <p style={{marginTop:8}}>AI will parse the amount, name, and category automatically.</p>
                    {!supported&&<p style={{marginTop:8,color:'var(--red)'}}>⚠ Voice input not supported in this browser. Use Chrome or Edge.</p>}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══ GOALS & TRAVEL ══ */}
        {activeTab==='goals' && (
          <div className="et-tab-content">

            {/* ── Travel Mode Banner ── */}
            <div style={{background: travelMode ? 'linear-gradient(135deg,#1a3a5c,#2d6a9f)' : 'var(--sky-pale)', borderRadius:'var(--radius)',padding:'20px 24px',marginBottom:24,display:'flex',alignItems:'center',gap:16,flexWrap:'wrap'}}>
              <div style={{fontSize:32}}>{travelMode ? (CURRENCIES.find(c=>c.code===travelCurrency)?.flag||'✈️') : '✈️'}</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:16,color: travelMode?'#fff':'var(--navy)'}}>
                  {travelMode ? `Travel Mode ON — ${travelCurrency}` : 'Travel Mode'}
                </div>
                <div style={{fontSize:13,color: travelMode?'rgba(255,255,255,.75)':'var(--text-muted)',marginTop:2}}>
                  {travelMode
                    ? `1 ₹ = ${exchangeRate?.rate?.toFixed(4)||'...'} ${travelCurrency}${exchangeRate?.fallback?' (estimated)':''} · All amounts shown in ${travelCurrency}`
                    : 'Enable to auto-convert amounts to your travel currency'}
                </div>
              </div>
              <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
                <select
                  style={{padding:'8px 12px',borderRadius:8,border:'1px solid rgba(0,0,0,.1)',fontSize:13,background:'white',cursor:'pointer'}}
                  value={travelCurrency}
                  onChange={e=>{ setTravelCurrency(e.target.value); if(travelMode) fetchExchangeRate(e.target.value); }}>
                  {CURRENCIES.map(c=><option key={c.code} value={c.code}>{c.flag} {c.code} — {c.name}</option>)}
                </select>
                <button
                  className={`et-btn ${travelMode?'et-btn--logout':'et-btn--primary'}`}
                  onClick={()=>toggleTravelMode()}
                  disabled={rateLoading}>
                  {rateLoading?'⏳ Loading…': travelMode?'✕ Disable':'✈️ Enable Travel Mode'}
                </button>
              </div>
              {travelMode && expenses.length > 0 && (
                <div style={{width:'100%',display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginTop:8}}>
                  {[
                    {label:'Total Spent', inr: totalExpenses},
                    {label:'Monthly Income', inr: monthlyIncome},
                    {label:'Net Balance', inr: Math.abs(balance)},
                  ].map(({label,inr})=>(
                    <div key={label} style={{background:'rgba(255,255,255,.12)',borderRadius:10,padding:'12px 16px'}}>
                      <div style={{fontSize:11,color:'rgba(255,255,255,.65)',textTransform:'uppercase',letterSpacing:1}}>{label}</div>
                      <div style={{fontSize:18,fontWeight:700,color:'#fff',marginTop:4}}>{fmtTravel(inr)}</div>
                      <div style={{fontSize:11,color:'rgba(255,255,255,.5)',marginTop:2}}>₹{fmt(inr)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Dynamic Savings Allocation ── */}
            <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',marginBottom:24,boxShadow:'var(--shadow-sm)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                <div>
                  <div style={{fontWeight:700,fontSize:16,color:'var(--navy)'}}>💰 Dynamic Savings Allocation</div>
                  <div style={{fontSize:13,color:'var(--text-muted)',marginTop:2}}>How much to save based on your current spending rate</div>
                </div>
                <button className="et-btn et-btn--primary et-btn--sm" onClick={computeSavingsAlloc}>Calculate</button>
              </div>
              {!savingsAlloc ? (
                <div style={{textAlign:'center',padding:'20px 0',color:'var(--text-muted)',fontSize:13}}>
                  Click Calculate to get your personalised savings plan for this month
                </div>
              ):(
                <div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:12,marginBottom:16}}>
                    {[
                      {label:'Save This Week',  value:`₹${fmt(savingsAlloc.weeklySaving)}`,  color:'var(--teal)',  icon:'📅'},
                      {label:'Save Per Day',    value:`₹${fmt(savingsAlloc.dailySaving)}`,   color:'var(--navy)', icon:'📆'},
                      {label:'Projected Savings',value:`₹${fmt(savingsAlloc.projectedSavings)}`,color:'var(--green)',icon:'💚'},
                      {label:'Savings Rate',    value:`${savingsAlloc.savingsRate}%`,         color:'#8B5E9E',     icon:'📊'},
                    ].map(({label,value,color,icon})=>(
                      <div key={label} style={{background:'var(--sky-pale)',borderRadius:10,padding:'14px 16px',borderLeft:`3px solid ${color}`}}>
                        <div style={{fontSize:12,color:'var(--text-muted)'}}>{icon} {label}</div>
                        <div style={{fontSize:20,fontWeight:700,color,marginTop:4}}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {savingsAlloc.isOverspending && (
                    <div style={{fontSize:13,background:'rgba(192,57,43,.08)',border:'1px solid rgba(192,57,43,.2)',borderRadius:8,padding:'10px 14px',marginBottom:8,color:'#c0392b'}}>
                      ⚠️ You're on track to overspend by ₹{fmt(savingsAlloc.projectedMonthly - monthlyIncome)} this month.
                      Cut spending by <strong>₹{fmt(savingsAlloc.dailyCutNeeded)}/day</strong> to save at least ₹{fmt(savingsAlloc.minSavingsTarget)} (15%).
                    </div>
                  )}
                  <div style={{fontSize:13,color:'var(--text-secondary)',background:'var(--sky-pale)',padding:'10px 14px',borderRadius:8}}>
                    📌 Based on ₹{fmt(savingsAlloc.projectedMonthly)} projected spend · {savingsAlloc.daysLeft} days remaining · Min target: ₹{fmt(savingsAlloc.minSavingsTarget)}
                  </div>
                  <button className="et-btn et-btn--sm" style={{marginTop:12,background:'var(--sky-pale)',color:'var(--text-secondary)'}} onClick={()=>setSavingsAlloc(null)}>Reset</button>
                </div>
              )}
            </div>

            {/* ── Goal-Oriented Recommendations ── */}
            <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',boxShadow:'var(--shadow-sm)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                <div>
                  <div style={{fontWeight:700,fontSize:16,color:'var(--navy)'}}>🎯 Savings Goals</div>
                  <div style={{fontSize:13,color:'var(--text-muted)',marginTop:2}}>Track goals and get AI-powered recommendations</div>
                </div>
                <button className="et-btn et-btn--primary et-btn--sm" onClick={()=>setShowGoalForm(s=>!s)}>
                  {showGoalForm?'✕ Cancel':'+ Add Goal'}
                </button>
              </div>

              {showGoalForm && (
                <div style={{background:'var(--sky-pale)',borderRadius:10,padding:'16px',marginBottom:16}}>
                  <div style={{display:'grid',gridTemplateColumns:'40px 1fr 1fr 1fr',gap:10,alignItems:'end'}}>
                    <div>
                      <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:4}}>Icon</div>
                      <select style={{padding:'8px',borderRadius:8,border:'1px solid rgba(0,0,0,.1)',fontSize:18,width:'100%'}}
                        value={goalForm.icon} onChange={e=>setGoalForm(f=>({...f,icon:e.target.value}))}>
                        {['🎯','✈️','🏠','🚗','💻','🎓','💍','🏖','📱','🏋️','🛍','🎸'].map(ic=><option key={ic} value={ic}>{ic}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:4}}>Goal Name</div>
                      <input className="et-input" placeholder="e.g. Vacation to Goa"
                        value={goalForm.name} onChange={e=>setGoalForm(f=>({...f,name:e.target.value}))}/>
                    </div>
                    <div>
                      <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:4}}>Target (₹)</div>
                      <input className="et-input" type="number" placeholder="50000"
                        value={goalForm.targetAmount} onChange={e=>setGoalForm(f=>({...f,targetAmount:e.target.value}))}/>
                    </div>
                    <div>
                      <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:4}}>Target Date</div>
                      <input className="et-input" type="date"
                        value={goalForm.targetDate} onChange={e=>setGoalForm(f=>({...f,targetDate:e.target.value}))}/>
                    </div>
                  </div>
                  <button className="et-btn et-btn--primary et-btn--sm" style={{marginTop:12}} onClick={handleAddGoal}>Save Goal</button>
                </div>
              )}

              {goals.length === 0 ? (
                <div style={{textAlign:'center',padding:'24px 0',color:'var(--text-muted)',fontSize:13}}>
                  <div style={{fontSize:32,marginBottom:8}}>🎯</div>
                  <p>No goals yet. Add a savings goal to get started!</p>
                </div>
              ):(
                <div>
                  <div style={{display:'grid',gap:12,marginBottom:16}}>
                    {goals.map(goal=>{
                      const pct = Math.min((goal.savedAmount / goal.targetAmount)*100, 100);
                      const remaining = goal.targetAmount - goal.savedAmount;
                      const daysToTarget = goal.targetDate ? Math.ceil((new Date(goal.targetDate)-new Date())/(1000*60*60*24)) : null;
                      const monthlyNeeded = daysToTarget ? Math.ceil(remaining/(daysToTarget/30)) : null;
                      return (
                        <div key={goal.id} style={{border:'1px solid rgba(0,0,0,.07)',borderRadius:12,padding:'16px',position:'relative'}}>
                          <div style={{display:'flex',gap:12,alignItems:'flex-start'}}>
                            <div style={{fontSize:28,lineHeight:1}}>{goal.icon}</div>
                            <div style={{flex:1}}>
                              <div style={{fontWeight:600,color:'var(--navy)',fontSize:15}}>{goal.name}</div>
                              <div style={{fontSize:12,color:'var(--text-muted)',marginTop:2}}>
                                ₹{fmt(goal.savedAmount)} saved of ₹{fmt(goal.targetAmount)}
                                {daysToTarget !== null && <span> · {daysToTarget > 0 ? `${daysToTarget} days left` : '🎉 Date reached!'}</span>}
                              </div>
                              <div style={{height:8,background:'var(--sky-pale)',borderRadius:99,margin:'10px 0',overflow:'hidden'}}>
                                <div style={{height:'100%',background:`linear-gradient(90deg,var(--teal),var(--navy))`,width:`${pct}%`,borderRadius:99,transition:'width .5s ease'}}/>
                              </div>
                              <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--text-muted)'}}>
                                <span>{pct.toFixed(0)}% complete</span>
                                <span>₹{fmt(remaining)} to go</span>
                              </div>
                              {monthlyNeeded && remaining > 0 && (
                                <div style={{marginTop:8,fontSize:12,color:'var(--teal)',fontWeight:500}}>
                                  💡 Save ₹{fmt(monthlyNeeded)}/month to reach by {new Date(goal.targetDate).toLocaleDateString('en-IN',{month:'short',year:'numeric'})}
                                </div>
                              )}
                              {pct < 100 && (
                                <div style={{marginTop:10,display:'flex',gap:8}}>
                                  {[500,1000,5000].map(amt=>(
                                    <button key={amt} onClick={()=>handleGoalDeposit(goal.id,amt)}
                                      style={{padding:'4px 12px',borderRadius:20,border:'1px solid var(--teal)',background:'transparent',color:'var(--teal)',fontSize:12,cursor:'pointer',fontWeight:500}}>
                                      +₹{amt}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {pct >= 100 && <div style={{marginTop:8,color:'var(--green)',fontWeight:600,fontSize:13}}>🎉 Goal reached!</div>}
                            </div>
                            <button onClick={()=>handleDeleteGoal(goal.id)}
                              style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',fontSize:18,lineHeight:1,padding:0}}>×</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Goal Recommendations */}
                  <div style={{borderTop:'1px solid rgba(0,0,0,.07)',paddingTop:16}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                      <div style={{fontWeight:600,color:'var(--navy)',fontSize:14}}>🤖 Smart Recommendations</div>
                      <button className="et-btn et-btn--sm et-btn--sky" onClick={generateGoalRecs} disabled={goalsLoading}>
                        {goalsLoading?'⏳':'✨ Generate'}
                      </button>
                    </div>
                    {goalRecs.length === 0 ? (
                      <div style={{fontSize:13,color:'var(--text-muted)'}}>
                        Click Generate to see how small spending cuts can fast-track your goals.
                      </div>
                    ):(
                      <div style={{display:'grid',gap:10}}>
                        {goalRecs.map((rec,i)=>(
                          <div key={i} style={{background:'linear-gradient(135deg,rgba(47,58,126,.04),rgba(61,158,140,.06))',borderRadius:10,padding:'14px 16px',borderLeft:'3px solid var(--teal)'}}>
                            <div style={{fontWeight:600,fontSize:13,color:'var(--navy)',marginBottom:4}}>
                              {rec.goalIcon} {rec.goal} · Cut {rec.category} spending
                            </div>
                            <div style={{fontSize:13,color:'var(--text-secondary)',lineHeight:1.6}}>
                              Cutting <strong>{rec.category}</strong> by 15% saves <strong>₹{fmt(rec.cut15)}/month</strong> — reaching your goal <strong>{rec.monthsWith15} months sooner</strong>.
                            </div>
                            <div style={{fontSize:12,color:'var(--text-muted)',marginTop:6}}>
                              Current spend: ₹{fmt(rec.currentSpend)} · 10% cut: ₹{fmt(rec.cut10)}/mo · 15% cut: ₹{fmt(rec.cut15)}/mo
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══ SMART INSIGHTS ══ */}
        {activeTab==='insights' && (
          <div className="et-tab-content">

            {/* ── Anomaly Detector ── */}
            <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',marginBottom:24,boxShadow:'var(--shadow-sm)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div>
                  <div style={{fontWeight:700,fontSize:16,color:'var(--navy)'}}>🔍 Spending Anomaly Detector</div>
                  <div style={{fontSize:13,color:'var(--text-muted)',marginTop:2}}>Detects unusual or abnormal spending behaviour</div>
                </div>
                <button className="et-btn et-btn--primary et-btn--sm" onClick={detectAnomalies}>Analyse</button>
              </div>

              {anomalies === null ? (
                <div style={{textAlign:'center',padding:'20px 0',color:'var(--text-muted)',fontSize:13}}>
                  Click Analyse to scan your spending for anomalies
                </div>
              ) : anomalies.length === 0 ? (
                <div style={{textAlign:'center',padding:'20px 0'}}>
                  <div style={{fontSize:32,marginBottom:8}}>✅</div>
                  <div style={{fontWeight:600,color:'var(--navy)'}}>All clear!</div>
                  <div style={{fontSize:13,color:'var(--text-muted)',marginTop:4}}>No unusual spending patterns detected.</div>
                </div>
              ) : (
                <div style={{display:'grid',gap:10,marginTop:12}}>
                  {anomalies.map((a,i) => {
                    const colors = { high:'#c0392b', medium:'#e67e22', low:'#2980b9' };
                    const bg     = { high:'rgba(192,57,43,.07)', medium:'rgba(230,126,34,.07)', low:'rgba(41,128,185,.07)' };
                    const icons  = { spike:'📈', dominant:'⚖️', frequency:'🔄', overspend:'🚨' };
                    return (
                      <div key={i} style={{background:bg[a.severity],border:`1px solid ${colors[a.severity]}30`,borderRadius:10,padding:'14px 16px',borderLeft:`3px solid ${colors[a.severity]}`}}>
                        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                          <span style={{fontSize:16}}>{icons[a.type]||'⚠️'}</span>
                          <span style={{fontWeight:600,fontSize:13,color:'var(--navy)'}}>{a.category}</span>
                          <span style={{marginLeft:'auto',fontSize:11,fontWeight:600,padding:'2px 8px',borderRadius:99,background:colors[a.severity],color:'white',textTransform:'uppercase'}}>{a.severity}</span>
                        </div>
                        <div style={{fontSize:13,color:'var(--text-secondary)',lineHeight:1.6}}>{a.message}</div>
                        {a.amount && <div style={{fontSize:12,color:'var(--text-muted)',marginTop:4}}>Amount: ₹{Number(a.amount).toLocaleString('en-IN')}</div>}
                      </div>
                    );
                  })}
                  <button className="et-btn et-btn--sm" style={{background:'var(--sky-pale)',color:'var(--text-secondary)',marginTop:4}} onClick={()=>setAnomalies(null)}>Reset</button>
                </div>
              )}
            </div>

            {/* ── Lifestyle Impact Calculator ── */}
            <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',boxShadow:'var(--shadow-sm)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div>
                  <div style={{fontWeight:700,fontSize:16,color:'var(--navy)'}}>💡 Lifestyle Impact Calculator</div>
                  <div style={{fontSize:13,color:'var(--text-muted)',marginTop:2}}>See the long-term financial impact of your daily habits</div>
                </div>
                <button className="et-btn et-btn--primary et-btn--sm" onClick={computeLifestyle}>Calculate</button>
              </div>

              {!lifestyle ? (
                <div style={{textAlign:'center',padding:'20px 0',color:'var(--text-muted)',fontSize:13}}>
                  Click Calculate to see how your spending habits affect your future wealth
                </div>
              ) : (
                <div style={{display:'grid',gap:14,marginTop:12}}>
                  {lifestyle.map((item, i) => (
                    <div key={i} style={{
                      borderRadius:12,
                      padding:'18px 20px',
                      background: item.highlight
                        ? 'linear-gradient(135deg,#1E2655,#2F3A7E)'
                        : 'linear-gradient(135deg,rgba(47,58,126,.04),rgba(61,158,140,.06))',
                      border: item.highlight ? 'none' : '1px solid rgba(0,0,0,.07)',
                    }}>
                      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
                        <span style={{fontSize:24}}>{item.icon}</span>
                        <div style={{fontWeight:700,fontSize:14,color: item.highlight?'#fff':'var(--navy)'}}>{item.title}</div>
                      </div>
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                        {[
                          {label:'Monthly', value:`₹${item.monthly.toLocaleString('en-IN')}`},
                          {label:'Annual',  value:`₹${item.annual.toLocaleString('en-IN')}`},
                        ].map(({label,value})=>(
                          <div key={label} style={{background: item.highlight?'rgba(255,255,255,.1)':'var(--sky-pale)',borderRadius:8,padding:'8px 12px'}}>
                            <div style={{fontSize:11,color: item.highlight?'rgba(255,255,255,.6)':'var(--text-muted)'}}>{label}</div>
                            <div style={{fontSize:15,fontWeight:700,color: item.highlight?'#fff':'var(--navy)',marginTop:2}}>{value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontSize:13,color: item.highlight?'rgba(255,255,255,.85)':'var(--text-secondary)',lineHeight:1.7,borderTop: item.highlight?'1px solid rgba(255,255,255,.15)':'1px solid rgba(0,0,0,.06)',paddingTop:10}}>
                        <div>📉 {item.impact}</div>
                        <div style={{marginTop:4,fontWeight:600,color: item.highlight?'#7DFFB3':'var(--teal)'}}>📈 {item.invested}</div>
                      </div>
                      {!item.highlight && (
                        <div style={{marginTop:10,fontSize:12,color:'var(--text-muted)',background:'var(--sky-pale)',borderRadius:6,padding:'6px 10px'}}>
                          Potential annual saving: <strong style={{color:'var(--green)'}}>₹{item.cut20.toLocaleString('en-IN')}</strong>
                        </div>
                      )}
                    </div>
                  ))}
                  <button className="et-btn et-btn--sm" style={{background:'var(--sky-pale)',color:'var(--text-secondary)'}} onClick={()=>setLifestyle(null)}>Reset</button>
                </div>
              )}
            </div>

          </div>
        )}

        {/* ══ WEEKLY SUMMARY ══ */}
        {activeTab==='weekly' && (
          <div className="et-tab-content">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
              <div style={{fontSize:13,color:'var(--text-muted)'}}>Auto-generates from your current week's transactions</div>
              <button className="et-btn et-btn--primary" onClick={generateWeeklySummary} disabled={weeklyLoading}>
                {weeklyLoading ? '⏳ Generating…' : weeklySummary ? '↻ Regenerate' : '📋 Generate Summary'}
              </button>
            </div>

            {!weeklySummary ? (
              <div style={{textAlign:'center',padding:'60px 0',color:'var(--text-muted)'}}>
                <div style={{fontSize:48,marginBottom:16}}>📋</div>
                <div style={{fontWeight:600,fontSize:16,color:'var(--navy)',marginBottom:8}}>Weekly Financial Summary</div>
                <div style={{fontSize:13}}>Click Generate to see your personalised weekly report</div>
              </div>
            ) : (
              <div style={{display:'grid',gap:16}}>

                {/* Header card */}
                <div style={{background:'linear-gradient(135deg,#1E2655,#2F3A7E)',borderRadius:'var(--radius)',padding:'24px 28px',color:'white'}}>
                  <div style={{fontSize:12,letterSpacing:2,textTransform:'uppercase',opacity:.7,marginBottom:4}}>Weekly Financial Summary</div>
                  <div style={{fontSize:13,opacity:.6,marginBottom:20}}>{weeklySummary.weekStart} – {weeklySummary.weekEnd}</div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
                    {[
                      {label:'Total Spent',    value:`₹${fmt(weeklySummary.thisTotal)}`,             sub: weeklySummary.wowChange ? `${weeklySummary.wowDir==='up'?'↑':'↓'} ${Math.abs(weeklySummary.wowChange)}% vs last week` : 'First week tracked'},
                      {label:'Daily Average',  value:`₹${fmt(weeklySummary.dailyAvg)}`,              sub:`Over ${new Date().getDay()||7} days`},
                      {label:'Weekly Savings', value:`₹${fmt(Math.abs(weeklySummary.weeklySavings))}`,sub: weeklySummary.weeklySavings>=0?'✓ On track':'⚠ Over budget', green:weeklySummary.weeklySavings>=0},
                    ].map(({label,value,sub,green})=>(
                      <div key={label} style={{background:'rgba(255,255,255,.1)',borderRadius:10,padding:'14px 16px'}}>
                        <div style={{fontSize:11,opacity:.65,textTransform:'uppercase',letterSpacing:1}}>{label}</div>
                        <div style={{fontSize:20,fontWeight:700,marginTop:4}}>{value}</div>
                        <div style={{fontSize:11,marginTop:4,color:green?'#7DFFB3':'rgba(255,255,255,.6)'}}>{sub}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Day-by-day bar chart */}
                <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',boxShadow:'var(--shadow-sm)'}}>
                  <div style={{fontWeight:700,fontSize:15,color:'var(--navy)',marginBottom:16}}>📅 Daily Spending This Week</div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:8,alignItems:'end',height:140}}>
                    {weeklySummary.byDay.map(({day,total,isFuture})=>{
                      const h = total>0 ? Math.max((total/weeklySummary.maxDay)*100,8) : 4;
                      const isToday = day===(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()]);
                      return (
                        <div key={day} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                          <div style={{fontSize:10,color:'var(--text-muted)',fontFamily:'var(--mono)',height:16,display:'flex',alignItems:'center'}}>
                            {total>0?`₹${total>=1000?(total/1000).toFixed(1)+'k':Math.round(total)}`:''}
                          </div>
                          <div style={{width:'100%',height:`${h}px`,background:isFuture?'var(--sky-pale)':isToday?'var(--teal)':'var(--navy)',borderRadius:'4px 4px 0 0',opacity:isFuture?.3:1,transition:'height .4s ease'}}/>
                          <div style={{fontSize:11,fontWeight:isToday?700:400,color:isToday?'var(--teal)':'var(--text-muted)'}}>{day}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Top categories */}
                <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',boxShadow:'var(--shadow-sm)'}}>
                  <div style={{fontWeight:700,fontSize:15,color:'var(--navy)',marginBottom:16}}>🏆 Top Spending Categories</div>
                  {weeklySummary.topCats.length===0?(
                    <div style={{color:'var(--text-muted)',fontSize:13}}>No transactions this week yet.</div>
                  ):(
                    <div style={{display:'grid',gap:10}}>
                      {weeklySummary.topCats.map(([cat,amt])=>{
                        const meta=CAT_META[cat]||{color:'#8CA5C2',icon:'📦'};
                        const pct=((amt/weeklySummary.thisTotal)*100).toFixed(1);
                        return (
                          <div key={cat} style={{display:'grid',gridTemplateColumns:'28px 1fr 80px 50px',alignItems:'center',gap:10}}>
                            <span style={{fontSize:16}}>{meta.icon}</span>
                            <div>
                              <div style={{fontSize:13,fontWeight:600,color:'var(--navy)'}}>{cat}</div>
                              <div style={{height:5,background:'var(--sky-pale)',borderRadius:99,marginTop:4,overflow:'hidden'}}>
                                <div style={{height:'100%',width:`${pct}%`,background:meta.color,borderRadius:99}}/>
                              </div>
                            </div>
                            <div style={{fontSize:13,fontFamily:'var(--mono)',color:'var(--text-secondary)',textAlign:'right'}}>₹{fmt(amt)}</div>
                            <div style={{fontSize:11,color:'var(--text-muted)',textAlign:'right'}}>{pct}%</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Suggestion */}
                {weeklySummary.suggestion && (
                  <div style={{background:'linear-gradient(135deg,rgba(61,158,140,.08),rgba(47,58,126,.08))',border:'1px solid rgba(61,158,140,.25)',borderRadius:'var(--radius)',padding:'20px 24px'}}>
                    <div style={{fontWeight:700,fontSize:15,color:'var(--navy)',marginBottom:8}}>💡 This Week's Suggestion</div>
                    <div style={{fontSize:14,color:'var(--text-secondary)',lineHeight:1.7}}>{weeklySummary.suggestion.text}</div>
                    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginTop:14}}>
                      {[
                        {label:'Current Spend',  value:`₹${fmt(weeklySummary.suggestion.current)}`,   color:'var(--navy)'},
                        {label:'Potential Cut',  value:`₹${fmt(weeklySummary.suggestion.cut)}`,        color:'#c0392b'},
                        {label:'Annual Savings', value:`₹${fmt(weeklySummary.suggestion.annualSave)}`, color:'var(--green)'},
                      ].map(({label,value,color})=>(
                        <div key={label} style={{background:'white',borderRadius:8,padding:'10px 14px'}}>
                          <div style={{fontSize:11,color:'var(--text-muted)'}}>{label}</div>
                          <div style={{fontSize:16,fontWeight:700,color,marginTop:2}}>{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{fontSize:12,color:'var(--text-muted)',textAlign:'center'}}>
                  Based on {weeklySummary.txCount} transaction{weeklySummary.txCount!==1?'s':''} this week
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ EMI & LOAN TRACKER ══ */}
        {activeTab==='emi' && (
          <div className="et-tab-content">

            {/* Summary strip */}
            {loans.length > 0 && (
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginBottom:20}}>
                {[
                  {label:'Active Loans',     value: loans.filter(l=>l.paidMonths<l.tenureMonths).length, icon:'💳'},
                  {label:'Total EMI/month',  value:`₹${(loans.filter(l=>l.paidMonths<l.tenureMonths).reduce((s,l)=>s+l.emi,0)).toLocaleString('en-IN')}`, icon:'📆'},
                  {label:'Total Interest',   value:`₹${(loans.reduce((s,l)=>s+l.totalInterest,0)).toLocaleString('en-IN')}`, icon:'📊'},
                ].map(({label,value,icon})=>(
                  <div key={label} style={{background:'white',borderRadius:'var(--radius-sm)',padding:'14px 18px',boxShadow:'var(--shadow-sm)'}}>
                    <div style={{fontSize:12,color:'var(--text-muted)'}}>{icon} {label}</div>
                    <div style={{fontSize:20,fontWeight:700,color:'var(--navy)',marginTop:4}}>{value}</div>
                  </div>
                ))}
              </div>
            )}

            <button className="et-btn et-btn--primary" style={{marginBottom:16}} onClick={()=>setShowLoanForm(s=>!s)}>
              {showLoanForm?'✕ Cancel':'+ Add Loan / EMI'}
            </button>

            {showLoanForm && (
              <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',marginBottom:20,boxShadow:'var(--shadow-sm)'}}>
                <div style={{fontWeight:700,fontSize:15,color:'var(--navy)',marginBottom:14}}>New Loan Details</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:12}}>
                  {[
                    {key:'name',label:'Loan Name',type:'text',ph:'e.g. Home Loan'},
                    {key:'principal',label:'Loan Amount (₹)',type:'number',ph:'500000'},
                    {key:'rate',label:'Annual Interest Rate (%)',type:'number',ph:'8.5'},
                    {key:'tenureMonths',label:'Tenure (months)',type:'number',ph:'240'},
                    {key:'startDate',label:'Start Date',type:'date',ph:''},
                  ].map(({key,label,type,ph})=>(
                    <div key={key}>
                      <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:4}}>{label}</div>
                      <input className="et-input" type={type} placeholder={ph}
                        value={loanForm[key]} onChange={e=>setLoanForm(f=>({...f,[key]:e.target.value}))}/>
                    </div>
                  ))}
                  <div>
                    <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:4}}>Type</div>
                    <select className="et-input et-select" value={loanForm.type} onChange={e=>setLoanForm(f=>({...f,type:e.target.value,icon:({home:'🏠',car:'🚗',personal:'👤',education:'🎓',other:'💳'})[e.target.value]}))}>
                      {[['home','🏠 Home Loan'],['car','🚗 Car Loan'],['personal','👤 Personal Loan'],['education','🎓 Education Loan'],['other','💳 Other']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                </div>
                <button className="et-btn et-btn--primary et-btn--sm" style={{marginTop:16}} onClick={handleAddLoan}>Calculate & Save</button>
              </div>
            )}

            {loans.length === 0 ? (
              <div style={{textAlign:'center',padding:'48px 0',color:'var(--text-muted)'}}>
                <div style={{fontSize:40,marginBottom:12}}>💳</div>
                <div style={{fontWeight:600,color:'var(--navy)'}}>No loans tracked yet</div>
                <div style={{fontSize:13,marginTop:4}}>Add your home loan, car loan, or any EMI above</div>
              </div>
            ) : (
              <div style={{display:'grid',gap:16}}>
                {loans.map(loan => {
                  const progress = (loan.paidMonths / loan.tenureMonths) * 100;
                  const remaining = loan.tenureMonths - loan.paidMonths;
                  const paidAmount = loan.emi * loan.paidMonths;
                  const schedule = getLoanSchedule(loan);
                  const nextPayment = schedule[loan.paidMonths];
                  const completed = loan.paidMonths >= loan.tenureMonths;
                  return (
                    <div key={loan.id} style={{background:'white',borderRadius:'var(--radius)',boxShadow:'var(--shadow-sm)',overflow:'hidden'}}>
                      {/* Header */}
                      <div style={{background: completed?'linear-gradient(135deg,#27ae60,#2ecc71)':'linear-gradient(135deg,#1E2655,#2F3A7E)',padding:'18px 20px',color:'white'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                          <div style={{display:'flex',gap:10,alignItems:'center'}}>
                            <span style={{fontSize:24}}>{loan.icon}</span>
                            <div>
                              <div style={{fontWeight:700,fontSize:16}}>{loan.name}</div>
                              <div style={{fontSize:12,opacity:.7,marginTop:2}}>
                                {loan.rate}% p.a. · {loan.tenureMonths} months · Started {new Date(loan.startDate).toLocaleDateString('en-IN',{month:'short',year:'numeric'})}
                              </div>
                            </div>
                          </div>
                          <button onClick={()=>handleDeleteLoan(loan.id)} style={{background:'rgba(255,255,255,.15)',border:'none',color:'white',borderRadius:6,padding:'4px 10px',cursor:'pointer',fontSize:12}}>Delete</button>
                        </div>
                        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginTop:16}}>
                          {[
                            {label:'Monthly EMI',    val:`₹${loan.emi.toLocaleString('en-IN')}`},
                            {label:'Total Interest', val:`₹${loan.totalInterest.toLocaleString('en-IN')}`, warn:true},
                            {label:'Total Payable',  val:`₹${loan.totalPayable.toLocaleString('en-IN')}`},
                          ].map(({label,val,warn})=>(
                            <div key={label} style={{background:'rgba(255,255,255,.1)',borderRadius:8,padding:'10px 12px'}}>
                              <div style={{fontSize:11,opacity:.65}}>{label}</div>
                              <div style={{fontSize:15,fontWeight:700,marginTop:2,color:warn?'#FFD580':'white'}}>{val}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      {/* Progress */}
                      <div style={{padding:'16px 20px'}}>
                        <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:6}}>
                          <span style={{color:'var(--text-muted)'}}>Repayment Progress</span>
                          <span style={{fontWeight:600,color:'var(--navy)'}}>{loan.paidMonths}/{loan.tenureMonths} months</span>
                        </div>
                        <div style={{height:8,background:'var(--sky-pale)',borderRadius:99,overflow:'hidden',marginBottom:12}}>
                          <div style={{height:'100%',width:`${progress}%`,background:`linear-gradient(90deg,var(--teal),var(--navy))`,borderRadius:99,transition:'width .5s'}}/>
                        </div>
                        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14,fontSize:12}}>
                          <div style={{background:'rgba(39,174,96,.08)',borderRadius:8,padding:'8px 10px'}}>
                            <div style={{color:'var(--text-muted)'}}>Paid</div>
                            <div style={{fontWeight:700,color:'var(--green)',marginTop:2}}>₹{paidAmount.toLocaleString('en-IN')}</div>
                          </div>
                          <div style={{background:'rgba(47,58,126,.06)',borderRadius:8,padding:'8px 10px'}}>
                            <div style={{color:'var(--text-muted)'}}>Remaining</div>
                            <div style={{fontWeight:700,color:'var(--navy)',marginTop:2}}>{remaining} months</div>
                          </div>
                          <div style={{background:'rgba(192,57,43,.06)',borderRadius:8,padding:'8px 10px'}}>
                            <div style={{color:'var(--text-muted)'}}>Balance</div>
                            <div style={{fontWeight:700,color:'#c0392b',marginTop:2}}>₹{nextPayment?nextPayment.balance.toLocaleString('en-IN'):'0'}</div>
                          </div>
                        </div>
                        {!completed && nextPayment && (
                          <div style={{background:'var(--sky-pale)',borderRadius:8,padding:'10px 14px',marginBottom:12,fontSize:13}}>
                            <span style={{color:'var(--text-muted)'}}>Next payment: </span>
                            <strong>₹{nextPayment.emi.toLocaleString('en-IN')}</strong>
                            <span style={{color:'var(--text-muted)'}}> (₹{nextPayment.interest.toLocaleString('en-IN')} interest + ₹{nextPayment.principal.toLocaleString('en-IN')} principal)</span>
                          </div>
                        )}
                        {completed ? (
                          <div style={{textAlign:'center',padding:'8px',color:'var(--green)',fontWeight:700}}>🎉 Loan Fully Paid!</div>
                        ) : (
                          <button className="et-btn et-btn--primary et-btn--sm" onClick={()=>handleLoanPayment(loan.id)}>✓ Mark EMI Paid This Month</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ══ SALARY PLANNER ══ */}
        {activeTab==='salary' && (() => {
          const cd = getSalaryCountdown();
          return (
            <div className="et-tab-content">

              {/* Salary day setup */}
              <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',marginBottom:20,boxShadow:'var(--shadow-sm)'}}>
                <div style={{fontWeight:700,fontSize:15,color:'var(--navy)',marginBottom:12}}>⚙️ Your Salary Date</div>
                <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
                  <div style={{fontSize:13,color:'var(--text-muted)'}}>Salary credited on day</div>
                  <input className="et-input" type="number" min="1" max="31" placeholder="e.g. 1"
                    style={{width:80}} value={salaryDayInput}
                    onChange={e=>setSalaryDayInput(e.target.value)}/>
                  <div style={{fontSize:13,color:'var(--text-muted)'}}>of every month</div>
                  <button className="et-btn et-btn--primary et-btn--sm" onClick={()=>{
                    const d=parseInt(salaryDayInput);
                    if(d>=1&&d<=31){setSalaryDay(d);localStorage.setItem('ft_salaryDay',d);setSalaryDayInput('');}
                    else alert('Enter a day between 1 and 31');
                  }}>Set</button>
                  <span style={{fontSize:13,color:'var(--teal)',fontWeight:600}}>Currently: {salaryDay}{['st','nd','rd'][salaryDay-1]||'th'} of month</span>
                </div>
              </div>

              {/* Countdown hero */}
              <div style={{background:'linear-gradient(135deg,#1E2655,#2F3A7E)',borderRadius:'var(--radius)',padding:'28px',marginBottom:20,color:'white'}}>
                <div style={{textAlign:'center',marginBottom:24}}>
                  <div style={{fontSize:13,opacity:.65,letterSpacing:2,textTransform:'uppercase'}}>Next Salary In</div>
                  <div style={{fontSize:64,fontWeight:800,lineHeight:1,margin:'8px 0'}}>{cd.daysLeft}</div>
                  <div style={{fontSize:18,opacity:.8}}>day{cd.daysLeft!==1?'s':''}</div>
                  <div style={{fontSize:13,opacity:.55,marginTop:6}}>{cd.nextSalary.toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'})}</div>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:12}}>
                  {[
                    {label:'Budget Remaining', val:`₹${Math.round(cd.budgetRemaining).toLocaleString('en-IN')}`, color: cd.budgetRemaining>0?'#7DFFB3':'#FF6B6B'},
                    {label:'Daily Budget Left', val:`₹${Math.round(cd.dailyRemaining).toLocaleString('en-IN')}/day`, color:'#FFD580'},
                    {label:'Spent So Far',      val:`₹${Math.round(cd.budgetUsed).toLocaleString('en-IN')}`,      color:'rgba(255,255,255,.85)'},
                    {label:'Expected Spend',    val:`₹${Math.round(cd.budgetExpected).toLocaleString('en-IN')}`, color:'rgba(255,255,255,.65)'},
                  ].map(({label,val,color})=>(
                    <div key={label} style={{background:'rgba(255,255,255,.1)',borderRadius:10,padding:'12px 16px'}}>
                      <div style={{fontSize:11,opacity:.65,textTransform:'uppercase',letterSpacing:1}}>{label}</div>
                      <div style={{fontSize:18,fontWeight:700,color,marginTop:4}}>{val}</div>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:16,padding:'10px 14px',borderRadius:8,background: cd.onTrack?'rgba(125,255,179,.15)':'rgba(255,107,107,.15)',border:`1px solid ${cd.onTrack?'rgba(125,255,179,.3)':'rgba(255,107,107,.3)'}`,fontSize:13,textAlign:'center'}}>
                  {cd.onTrack ? '✅ You are on track with your spending!' : `⚠️ You are ₹${Math.round(cd.budgetUsed-cd.budgetExpected).toLocaleString('en-IN')} over expected spend for this point in the month`}
                </div>
              </div>

              {/* Can I afford this? */}
              <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',marginBottom:20,boxShadow:'var(--shadow-sm)'}}>
                <div style={{fontWeight:700,fontSize:15,color:'var(--navy)',marginBottom:4}}>🤔 Can I Afford This?</div>
                <div style={{fontSize:13,color:'var(--text-muted)',marginBottom:14}}>Enter any amount to instantly check if it fits your remaining budget</div>
                <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
                  <div style={{position:'relative',flex:1,minWidth:160}}>
                    <span style={{position:'absolute',left:12,top:'50%',transform:'translateY(-50%)',color:'var(--text-muted)',fontSize:14}}>₹</span>
                    <input className="et-input" type="number" placeholder="e.g. 2500"
                      style={{paddingLeft:28}} value={affordCheck}
                      onChange={e=>{setAffordCheck(e.target.value);setAffordResult(null);}}
                      onKeyPress={e=>e.key==='Enter'&&checkAffordability()}/>
                  </div>
                  <button className="et-btn et-btn--primary" onClick={checkAffordability}>Check</button>
                </div>
                {affordResult && (
                  <div style={{marginTop:14,padding:'14px 18px',borderRadius:10,
                    background: affordResult.canAfford?'rgba(39,174,96,.08)':'rgba(192,57,43,.08)',
                    border:`1px solid ${affordResult.canAfford?'rgba(39,174,96,.25)':'rgba(192,57,43,.25)'}`}}>
                    <div style={{fontWeight:700,fontSize:15,color:affordResult.canAfford?'var(--green)':'#c0392b',marginBottom:6}}>
                      {affordResult.canAfford ? '✅ Yes, you can afford it!' : '❌ Not recommended right now'}
                    </div>
                    <div style={{fontSize:13,color:'var(--text-secondary)',lineHeight:1.7}}>{affordResult.message}</div>
                    {affordResult.canAfford && (
                      <div style={{fontSize:12,color:'var(--text-muted)',marginTop:6}}>
                        After this purchase your daily budget drops to <strong>₹{Math.round(affordResult.impactOnDaily).toLocaleString('en-IN')}/day</strong> for the remaining {affordResult.daysLeft} days
                      </div>
                    )}
                  </div>
                )}
                {/* Quick checks */}
                <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>
                  {[500,1000,2000,5000,10000].map(amt=>(
                    <button key={amt} onClick={()=>{setAffordCheck(String(amt));setAffordResult(null);setTimeout(()=>checkAffordability(),0);}}
                      style={{padding:'5px 14px',borderRadius:20,border:'1px solid rgba(0,0,0,.1)',background:'var(--sky-pale)',fontSize:12,cursor:'pointer',color:'var(--text-secondary)'}}>
                      ₹{amt.toLocaleString('en-IN')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Spend breakdown this cycle */}
              <div style={{background:'white',borderRadius:'var(--radius)',padding:'20px 24px',boxShadow:'var(--shadow-sm)'}}>
                <div style={{fontWeight:700,fontSize:15,color:'var(--navy)',marginBottom:14}}>📊 This Pay Cycle Breakdown</div>
                {totalExpenses === 0 ? (
                  <div style={{color:'var(--text-muted)',fontSize:13}}>No expenses tracked yet this month.</div>
                ) : (
                  <>
                    <div style={{display:'grid',gap:8}}>
                      {Object.entries((() => { const t={}; expenses.forEach(e=>{ t[e.category]=(t[e.category]||0)+e.amount; }); return t; })())
                        .sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>{
                          const meta=CAT_META[cat]||{color:'#8CA5C2',icon:'📦'};
                          const pct=((amt/totalExpenses)*100).toFixed(1);
                          const daily=(amt/cd.daysSinceSalary).toFixed(0);
                          return (
                            <div key={cat} style={{display:'grid',gridTemplateColumns:'28px 1fr 60px 70px 60px',alignItems:'center',gap:8,fontSize:12}}>
                              <span>{meta.icon}</span>
                              <div>
                                <div style={{fontWeight:600,color:'var(--navy)',marginBottom:3}}>{cat}</div>
                                <div style={{height:4,background:'var(--sky-pale)',borderRadius:99,overflow:'hidden'}}>
                                  <div style={{height:'100%',width:`${pct}%`,background:meta.color,borderRadius:99}}/>
                                </div>
                              </div>
                              <div style={{color:'var(--text-muted)',textAlign:'right'}}>₹{daily}/d</div>
                              <div style={{fontFamily:'var(--mono)',fontWeight:600,color:'var(--navy)',textAlign:'right'}}>₹{amt.toLocaleString('en-IN')}</div>
                              <div style={{color:'var(--text-muted)',textAlign:'right'}}>{pct}%</div>
                            </div>
                          );
                        })}
                    </div>
                    <div style={{borderTop:'1px solid rgba(0,0,0,.07)',marginTop:12,paddingTop:12,display:'flex',justifyContent:'space-between',fontSize:13}}>
                      <span style={{color:'var(--text-muted)'}}>Daily average this cycle</span>
                      <strong style={{color:'var(--navy)'}}>₹{cd.daysSinceSalary>0?Math.round(totalExpenses/cd.daysSinceSalary).toLocaleString('en-IN'):0}/day</strong>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
};
export default Expense;