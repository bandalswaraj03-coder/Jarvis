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
  { name: 'deep_research', description: 'Thorough research: runs several differently-angled web searches in parallel and returns each one\'s findings for you to cross-check. Use for complex, recent, contested or high-stakes questions, or when the user asks to research or verify.',
    parameters: { type: 'OBJECT', properties: { question: S('The full question to research') }, required: ['question'] } },
  { name: 'wikipedia', description: 'Look up background knowledge on Wikipedia (free, no key). Good for concepts, history, geography, polity, people. Not for breaking news.',
    parameters: { type: 'OBJECT', properties: { topic: S('A topic or question') }, required: ['topic'] } },
  { name: 'now', description: "Current date, time and timezone on the user's iPhone." },
  { name: 'calculate', description: 'Evaluate arithmetic exactly. Operators + - * / % ** and parentheses.',
    parameters: { type: 'OBJECT', properties: { expression: S('e.g. (1200*0.18)/12') }, required: ['expression'] } },
  { name: 'remember', description: 'Propose saving a durable fact or preference about the user. The user must approve it. Never save secrets.',
    parameters: { type: 'OBJECT', properties: { text: S('The fact, phrased briefly') }, required: ['text'] } },
  { name: 'log_study', description: 'Record a UPSC study session the user reports.',
    parameters: { type: 'OBJECT', properties: { subject: S('e.g. Polity, History, Essay'), minutes: { type: 'NUMBER' }, note: S('optional') }, required: ['subject', 'minutes'] } },
  { name: 'study_progress', description: "Get the user's logged UPSC study totals, streak and recent sessions." }
] }];

const low = s => JSON.parse(JSON.stringify(s, (k, v) => k === 'type' && typeof v === 'string' ? v.toLowerCase() : v));
export const OPENAI_TOOLS = TOOLS[0].functionDeclarations.map(d => ({ type: 'function', function: { name: d.name, description: d.description,
  parameters: d.parameters ? low(d.parameters) : { type: 'object', properties: {} } } }));
export const MODELS = { deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'], gemini: ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-pro'] };
export function resolveSettings(store) {
  const s = { provider: 'deepseek', ...store.get('settings', {}) };
  if (!MODELS[s.provider]) s.provider = 'deepseek';
  if (!s.model || !s.model.startsWith(s.provider)) s.model = MODELS[s.provider][0];
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(fetchFn, url, headers, body) {
  let last;
  for (let i = 0; i < 3; i++) {
    let r;
    try { r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }
    catch (e) { throw new Error('Request failed or was blocked by the browser (' + e.message + ').'); }
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    last = new Error(j.error?.message || 'API error ' + r.status);
    if (![429, 500, 503].includes(r.status) || /quota|limit: 0|balance/i.test(last.message)) throw last;
    await sleep(1500 * (i + 1));
  }
  throw last;
}

export function createAgent({ store, fetchFn = (...a) => fetch(...a), confirmFn = async () => false, onStep = () => {} }) {
  const text = c => (c?.content?.parts || []).map(p => p.text || '').join('');
  const gem = (s, body) => post(fetchFn, `${s.base || BASE}/models/${s.model}:generateContent`, { 'x-goog-api-key': s.key }, body);
  const tools = {
    async research({ query }, mode) {
      const s = resolveSettings(store);
      if (!s.key) return { error: 'Live web search needs a Gemini key (optional, Menu → Settings). Use wikipedia for background knowledge.' };
      const j = await gem({ ...s, model: s.provider === 'gemini' ? s.model : 'gemini-flash-latest' }, { systemInstruction: { parts: [{ text: 'Answer using Google Search results. Be factual and concise. Give each source\'s publication date when you can find it. Prefer official sources' + (mode === 'upsc' ? ' (PIB, PRS, UPSC, MEA, NCERT, Constitution)' : '') + '. State clearly what you could not verify.' }] },
        contents: [{ role: 'user', parts: [{ text: String(query) }] }], tools: [{ google_search: {} }, { url_context: {} }] });
      const c = j.candidates?.[0];
      const sources = (c?.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ title: w.title, url: w.uri }));
      return { findings: text(c).slice(0, 6000), sources };
    },
    async deep_research({ question }, mode) {
      const s = resolveSettings(store);
      if (!s.key) return { error: 'Deep research needs a Gemini key (Menu → Settings). Use wikipedia for background knowledge.' };
      const g = { ...s, model: s.provider === 'gemini' ? s.model : 'gemini-flash-latest' };
      const plan = await gem(g, { contents: [{ role: 'user', parts: [{ text: 'Split this question into 3 distinct web search queries that together cover it. Make one aim at official or primary sources' + (mode === 'upsc' ? ' (PIB, PRS, UPSC, MEA)' : '') + ' and one look for corrections, criticism or opposing views. Return ONLY a JSON array of 3 strings.\n\nQuestion: ' + question }] }], generationConfig: { responseMimeType: 'application/json' } });
      let qs; try { qs = JSON.parse(text(plan.candidates?.[0])).slice(0, 3).map(String); if (!qs.length) throw 0; } catch { qs = [String(question)]; }
      const res = await Promise.all(qs.map(q => tools.research({ query: q }, mode).catch(e => ({ error: e.message }))));
      if (!res.some(r => r.findings)) return { error: res[0]?.error || 'No search results came back.' };
      const sources = [...new Map(res.flatMap(r => r.sources || []).map(x => [x.url, x])).values()];
      return { searches: qs, findings: res.map((r, i) => '### Search ' + (i + 1) + ': ' + qs[i] + '\n' + (r.findings || '(failed: ' + r.error + ')')).join('\n\n'),
        sources, how_to_answer: 'Cross-check the searches. Verified = confirmed by 2+ independent sources. Uncertain = one source or conflicting. State conflicts and publication dates.' };
    },
    async wikipedia({ topic }) {
      const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts&exintro=1&explaintext=1&redirects=1&generator=search&gsrlimit=2&gsrsearch=' + encodeURIComponent(topic);
      const j = await (await fetchFn(u)).json();
      const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index);
      const results = pages.map(p => ({ title: p.title, summary: (p.extract || '').slice(0, 1500), url: 'https://en.wikipedia.org/?curid=' + p.pageid }));
      return { results, sources: results.map(({ title, url }) => ({ title: 'Wikipedia: ' + title, url })) };
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
  const system = (mode, deep) => 'You are JARVIS, the user\'s personal AI on their iPhone. Be genuinely smart: for non-trivial requests, plan briefly, use tools when they improve accuracy, and double-check before asserting. ' +
    'Use `deep_research` for complex, contested, recent or high-stakes questions: compare what its searches say, mark claims backed by 2+ independent sources as Verified, single-source or conflicting claims as Uncertain, and state any conflict. Use `research` for quick lookups (if unavailable, say you cannot verify current facts), `wikipedia` for background knowledge, `calculate` for arithmetic and `now` for dates. Never state current events from memory. ' +
    'Separate "Verified (from sources)" from "Uncertain", and name sources with dates. Never invent facts, quotes or links. Write for a phone: lead with the answer, short paragraphs, no wide tables. ' +
    (deep ? 'DEEP MODE is on: call `deep_research` before answering any factual question. ' : '') + 'Propose `remember` only for durable personal facts the user would want kept. Today is ' + new Date().toDateString() + '.' +
    (mode === 'upsc' ? ' UPSC MENTOR MODE: you coach Prelims, Mains, Essay, current affairs, syllabus mapping and revision plans. Prefer official Indian sources (PIB, PRS, UPSC, Constitution, NCERT) and always show publication dates. For answer evaluation give marks /10, strengths, gaps and a model structure. Call `study_progress` before making revision plans, and `log_study` when the user reports studying.' : '') +
    (store.get('memories', []).length ? '\n\nUser-approved memories:\n' + store.get('memories', []).map(m => '- ' + m.text).join('\n') : '');
  async function exec(name, args, mode, sources) {
    onStep(name, args);
    try { const out = tools[name] ? await tools[name](args, mode) : { error: 'unknown tool ' + name }; if (out.sources) sources.push(...out.sources); return out; }
    catch (e) { return { error: e.message }; }
  }
  const finish = (reply, sources) => ({ reply, sources: [...new Map(sources.map(s => [s.url, s])).values()] });
  const LIMIT = 'I reached my step limit. Ask me to continue and I will pick up from here.';

  async function runGemini(history, mode, s, deep) {
    if (!s.key) throw new Error('Add your Gemini API key: menu → Settings.');
    const contents = history.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), sources = [];
    for (let step = 0; step < 6; step++) {
      const j = await gem(s, { systemInstruction: { parts: [{ text: system(mode, deep) }] }, contents, tools: TOOLS });
      const content = j.candidates?.[0]?.content;
      if (!content) throw new Error(j.promptFeedback?.blockReason ? 'Blocked: ' + j.promptFeedback.blockReason : 'Empty reply from Gemini');
      contents.push(content); // verbatim: Gemini 3 needs thought signatures echoed back
      const calls = (content.parts || []).filter(p => p.functionCall);
      if (!calls.length) return finish(text(j.candidates[0]) || '(empty reply)', sources);
      const parts = [];
      for (const { functionCall: { name, args = {} } } of calls) parts.push({ functionResponse: { name, response: await exec(name, args, mode, sources) } });
      contents.push({ role: 'user', parts });
    }
    return finish(LIMIT, sources);
  }
  async function runDeepseek(history, mode, s, deep) {
    if (!s.dsKey) throw new Error('Add your DeepSeek API key: menu → Settings.');
    const msgs = [{ role: 'system', content: system(mode, deep) }, ...history.slice(-20).map(m => ({ role: m.role, content: m.content }))], sources = [];
    for (let step = 0; step < 6; step++) {
      const j = await post(fetchFn, (s.dsBase || 'https://api.deepseek.com') + '/chat/completions', { authorization: 'Bearer ' + s.dsKey }, { model: s.model, messages: msgs, tools: OPENAI_TOOLS });
      const msg = j.choices?.[0]?.message;
      if (!msg) throw new Error('Empty reply from DeepSeek');
      msgs.push(msg); // verbatim, incl. any reasoning_content DeepSeek needs back during tool calls
      if (!msg.tool_calls?.length) return finish(msg.content || '(empty reply)', sources);
      for (const tc of msg.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(await exec(tc.function.name, args, mode, sources)).slice(0, 12000) });
      }
    }
    return finish(LIMIT, sources);
  }
  return { tools, run(history, mode = 'auto', deep = false) { const s = resolveSettings(store); return (s.provider === 'gemini' ? runGemini : runDeepseek)(history, mode, s, deep); } };
}
