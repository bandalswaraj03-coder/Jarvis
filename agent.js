// JARVIS agent core: plans, calls tools, loops until it can answer. No dependencies; runs in Safari or Node.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const S = (d, req) => ({ type: 'STRING', description: d });

export function createStore(storage) {
  return { get: (k, d) => { try { return JSON.parse(storage.getItem('jv_' + k)) ?? d; } catch { return d; } },
           set: (k, v) => storage.setItem('jv_' + k, JSON.stringify(v)) };
}
const day = d => new Date(d).toISOString().slice(0, 10);
export function studySummary(store) {
  const log = store.get('study', []);
  if (!log.length) return { sessions: 0, note: 'Nothing logged yet.' };
  const bySubject = {}; let total = 0;
  for (const e of log) { bySubject[e.subject] = (bySubject[e.subject] || 0) + e.minutes; total += e.minutes; }
  const days = new Set(log.map(e => e.date)); let streak = 0;
  for (let t = Date.now(); days.has(day(t)); t -= 864e5) streak++;
  const wk = log.filter(e => Date.now() - new Date(e.date) < 7 * 864e5).reduce((a, e) => a + e.minutes, 0);
  return { sessions: log.length, totalMinutes: total, last7DaysMinutes: wk, streakDays: streak, minutesBySubject: bySubject, recent: log.slice(-5) };
}

export const TOOLS = [{ functionDeclarations: [
  { name: 'research', description: 'Search the live web (Google) and read pages. Use for anything recent, changing, or needing sources. Returns findings plus source URLs.',
    parameters: { type: 'OBJECT', properties: { query: S('A specific search question') }, required: ['query'] } },
  { name: 'now', description: "Current date, time and timezone on the user's iPhone." },
  { name: 'calculate', description: 'Evaluate arithmetic exactly. Operators + - * / % ** and parentheses.',
    parameters: { type: 'OBJECT', properties: { expression: S('e.g. (1200*0.18)/12') }, required: ['expression'] } },
  { name: 'remember', description: 'Propose saving a durable fact or preference about the user. The user must approve it. Never save secrets.',
    parameters: { type: 'OBJECT', properties: { text: S('The fact, phrased briefly') }, required: ['text'] } },
  { name: 'log_study', description: 'Record a UPSC study session the user reports.',
    parameters: { type: 'OBJECT', properties: { subject: S('e.g. Polity, History, Essay'), minutes: { type: 'NUMBER' }, note: S('optional') }, required: ['subject', 'minutes'] } },
  { name: 'study_progress', description: "Get the user's logged UPSC study totals, streak and recent sessions." }
] }];

export function createAgent({ store, fetchFn = (...a) => fetch(...a), confirmFn = async () => false, onStep = () => {} }) {
  const settings = () => ({ model: 'gemini-3.1-pro-preview', ...store.get('settings', {}) });
  async function call(body) {
    const s = settings();
    if (!s.key) throw new Error('Add your Gemini API key: menu → Settings.');
    const r = await fetchFn(`${s.base || BASE}/models/${s.model}:generateContent`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': s.key }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Gemini error ' + r.status);
    return j;
  }
  const text = c => (c?.content?.parts || []).map(p => p.text || '').join('');
  const tools = {
    async research({ query }, mode) {
      const j = await call({ systemInstruction: { parts: [{ text: 'Answer using Google Search results. Be factual and concise. Give each source\'s publication date when you can find it. Prefer official sources' + (mode === 'upsc' ? ' (PIB, PRS, UPSC, MEA, NCERT, Constitution)' : '') + '. State clearly what you could not verify.' }] },
        contents: [{ role: 'user', parts: [{ text: String(query) }] }], tools: [{ google_search: {} }, { url_context: {} }] });
      const c = j.candidates?.[0];
      const sources = (c?.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ title: w.title, url: w.uri }));
      return { findings: text(c).slice(0, 6000), sources };
    },
    async now() { return { iso: new Date().toISOString(), local: new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' }), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }; },
    async calculate({ expression }) {
      if (!/^[0-9+\-*/%().\s]+$/.test(expression)) return { error: 'Only numbers and + - * / % ( ) allowed' };
      const v = Function('"use strict";return (' + expression + ')')();
      return Number.isFinite(v) ? { result: v } : { error: 'Not a finite number' };
    },
    async remember({ text }) {
      if (!(await confirmFn(text))) return { saved: false, reason: 'User declined' };
      const m = store.get('memories', []); m.push({ id: Date.now().toString(36), text, created: new Date().toISOString() });
      store.set('memories', m); return { saved: true };
    },
    async log_study({ subject, minutes, note = '' }) {
      if (!(minutes > 0)) return { error: 'minutes must be positive' };
      const l = store.get('study', []); l.push({ date: day(Date.now()), subject, minutes, note }); store.set('study', l); return { logged: true };
    },
    async study_progress() { return studySummary(store); }
  };
  const system = mode => 'You are JARVIS, the user\'s personal AI on their iPhone. Be genuinely smart: for non-trivial requests, plan briefly, use tools when they improve accuracy, and double-check before asserting. ' +
    'Use `research` for anything recent, changing or source-dependent; never state current events from memory. Use `calculate` for arithmetic and `now` for dates. ' +
    'Separate "Verified (from sources)" from "Uncertain", and name sources with dates. Never invent facts, quotes or links. Write for a phone: lead with the answer, short paragraphs, no wide tables. ' +
    'Propose `remember` only for durable personal facts the user would want kept. Today is ' + new Date().toDateString() + '.' +
    (mode === 'upsc' ? ' UPSC MENTOR MODE: you coach Prelims, Mains, Essay, current affairs, syllabus mapping and revision plans. Prefer official Indian sources (PIB, PRS, UPSC, Constitution, NCERT) and always show publication dates. For answer evaluation give marks /10, strengths, gaps and a model structure. Call `study_progress` before making revision plans, and `log_study` when the user reports studying.' : '') +
    (store.get('memories', []).length ? '\n\nUser-approved memories:\n' + store.get('memories', []).map(m => '- ' + m.text).join('\n') : '');

  return { tools, async run(history, mode = 'auto') {
    const contents = history.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const sources = [];
    for (let step = 0; step < 6; step++) {
      const j = await call({ systemInstruction: { parts: [{ text: system(mode) }] }, contents, tools: TOOLS });
      const content = j.candidates?.[0]?.content;
      if (!content) throw new Error(j.promptFeedback?.blockReason ? 'Blocked: ' + j.promptFeedback.blockReason : 'Empty reply from Gemini');
      contents.push(content); // kept verbatim (Gemini 3 needs thought signatures echoed back)
      const calls = (content.parts || []).filter(p => p.functionCall);
      if (!calls.length) return { reply: text(j.candidates[0]) || '(empty reply)', sources: [...new Map(sources.map(s => [s.url, s])).values()] };
      const parts = [];
      for (const { functionCall: { name, args = {} } } of calls) {
        onStep(name, args); let out;
        try { out = tools[name] ? await tools[name](args, mode) : { error: 'unknown tool ' + name }; if (name === 'research') sources.push(...out.sources); }
        catch (e) { out = { error: e.message }; }
        parts.push({ functionResponse: { name, response: out } });
      }
      contents.push({ role: 'user', parts });
    }
    return { reply: 'I reached my step limit. Ask me to continue and I will pick up from here.', sources };
  } };
}
