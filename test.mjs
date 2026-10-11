import test from 'node:test';
import assert from 'node:assert';
import { createAgent, createStore, studySummary, resolveSettings } from './agent.js';
const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
const mk = (script, extra = {}) => {
  const store = createStore(mem()); store.set('settings', { key: 'K', provider: 'gemini' }); const calls = [];
  const fetchFn = async (url, o) => { const b = JSON.parse(o.body); calls.push({ url, b, h: o.headers });
    return { ok: true, json: async () => script(b, calls.length) }; };
  return { store, calls, agent: createAgent({ store, fetchFn, ...extra }) };
};
const reply = parts => ({ candidates: [{ content: { role: 'model', parts } }] });

test('tool loop: calls tool, echoes signature, returns final answer', async () => {
  const steps = [];
  const { agent, calls } = mk((b, n) => n === 1
    ? reply([{ functionCall: { name: 'calculate', args: { expression: '(1200*0.18)/12' } }, thoughtSignature: 'SIG' }])
    : reply([{ text: 'It is 18' }]), { onStep: n => steps.push(n) });
  const r = await agent.run([{ role: 'user', content: 'calc' }]);
  assert.equal(r.reply, 'It is 18'); assert.deepEqual(steps, ['calculate']);
  const second = calls[1].b.contents;
  assert.equal(second.at(-2).parts[0].thoughtSignature, 'SIG');
  assert.equal(second.at(-1).parts[0].functionResponse.response.result, 18);
  assert.equal(calls[0].h['x-goog-api-key'], 'K'); assert.match(calls[0].url, /gemini-3\.1-pro-preview/);
});
test('research uses grounded sub-call and returns sources', async () => {
  const { agent, calls } = mk((b, n) => b.tools?.[0]?.google_search
    ? { candidates: [{ content: { parts: [{ text: 'Found it' }] }, groundingMetadata: { groundingChunks: [{ web: { title: 'PIB', uri: 'https://pib.gov.in/x' } }] } }] }
    : n === 1 ? reply([{ functionCall: { name: 'research', args: { query: 'q' } } }]) : reply([{ text: 'Done' }]));
  const r = await agent.run([{ role: 'user', content: 'news' }], 'upsc');
  assert.deepEqual(r.sources, [{ title: 'PIB', url: 'https://pib.gov.in/x' }]);
  assert.match(calls[0].b.systemInstruction.parts[0].text, /UPSC MENTOR/);
});
test('calculate rejects code injection', async () => {
  const { agent } = mk(() => reply([{ text: '' }]));
  assert.ok((await agent.tools.calculate({ expression: 'process.exit()' })).error);
  assert.equal((await agent.tools.calculate({ expression: '2**10' })).result, 1024);
});
test('remember needs approval', async () => {
  const no = mk(() => 0); assert.equal((await no.agent.tools.remember({ text: 'x' })).saved, false);
  assert.deepEqual(no.store.get('memories', []), []);
  const yes = mk(() => 0, { confirmFn: async () => true }); await yes.agent.tools.remember({ text: 'likes tea' });
  assert.equal(yes.store.get('memories', [])[0].text, 'likes tea');
});
test('study log + progress', async () => {
  const { agent, store } = mk(() => 0);
  await agent.tools.log_study({ subject: 'Polity', minutes: 90 }); await agent.tools.log_study({ subject: 'Polity', minutes: 30 });
  const s = studySummary(store); assert.equal(s.totalMinutes, 120); assert.equal(s.streakDays, 1); assert.equal(s.minutesBySubject.Polity, 120);
});
test('missing key and step limit', async () => {
  const a = createAgent({ store: createStore(mem()), fetchFn: async () => 0 });
  await assert.rejects(a.run([{ role: 'user', content: 'hi' }]), /API key/);
  const { agent } = mk(() => reply([{ functionCall: { name: 'now', args: {} } }]));
  assert.match((await agent.run([{ role: 'user', content: 'x' }])).reply, /step limit/);
});

const dsMk = (script, settings = {}) => { const store = createStore(mem()); store.set('settings', { provider: 'deepseek', dsKey: 'DK', ...settings }); const calls = [];
  const fetchFn = async (url, o) => { const b = o?.body ? JSON.parse(o.body) : null; calls.push({ url, b, h: o?.headers }); const r = script(url, b, calls.length); return { ok: r.status ? false : true, status: r.status || 200, json: async () => r.body ?? r }; };
  return { store, calls, agent: createAgent({ store, fetchFn }) }; };
test('deepseek tool loop with reasoning preserved', async () => {
  const { agent, calls } = dsMk((u, b, n) => n === 1
    ? { choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'thinking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"6*7"}' } }] } }] }
    : { choices: [{ message: { role: 'assistant', content: 'Answer 42' } }] });
  const r = await agent.run([{ role: 'user', content: 'x' }]);
  assert.equal(r.reply, 'Answer 42'); assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].h.authorization, 'Bearer DK'); assert.equal(calls[0].b.model, 'deepseek-v4-pro');
  assert.equal(calls[0].b.tools[0].function.parameters.type, 'object');
  const m = calls[1].b.messages; assert.equal(m.at(-2).reasoning_content, 'thinking');
  assert.equal(JSON.parse(m.at(-1).content).result, 42); assert.equal(m.at(-1).tool_call_id, 'c1');
});
test('research needs gemini key under deepseek; wikipedia works', async () => {
  const { agent } = dsMk((u) => ({ query: { pages: { 1: { index: 1, title: 'Polity', pageid: 7, extract: 'Text' } } } }));
  assert.match((await agent.tools.research({ query: 'q' })).error, /Gemini key/);
  const w = await agent.tools.wikipedia({ topic: 'polity' });
  assert.equal(w.results[0].title, 'Polity'); assert.match(w.sources[0].url, /curid=7/);
});
test('retries on 503 but not on quota errors', async () => {
  let n = 0; const ok = dsMk(() => ++n === 1 ? { status: 503, body: { error: { message: 'busy' } } } : { choices: [{ message: { content: 'ok' } }] });
  assert.equal((await ok.agent.run([{ role: 'user', content: 'x' }])).reply, 'ok');
  const q = dsMk(() => ({ status: 429, body: { error: { message: 'quota limit: 0' } } }));
  await assert.rejects(q.agent.run([{ role: 'user', content: 'x' }]), /quota/); assert.equal(q.calls.length, 1);
});
test('settings resolve: model follows provider', () => {
  const s = createStore(mem()); s.set('settings', { key: 'g', model: 'gemini-flash-latest' });
  assert.deepEqual([resolveSettings(s).provider, resolveSettings(s).model], ['deepseek', 'deepseek-v4-pro']);
  s.set('settings', { provider: 'gemini', model: 'gemini-flash-latest' }); assert.equal(resolveSettings(s).model, 'gemini-flash-latest');
});

test('deep_research: plans, runs parallel searches, merges + dedupes sources', async () => {
  const { agent, calls } = mk((b, n) => b.generationConfig?.responseMimeType
    ? { candidates: [{ content: { parts: [{ text: '["official q","critics q","base q"]' }] } }] }
    : b.tools?.[0]?.google_search
      ? { candidates: [{ content: { parts: [{ text: 'finding for ' + b.contents[0].parts[0].text }] }, groundingMetadata: { groundingChunks: [{ web: { title: 'PIB', uri: 'https://pib.gov.in/a' } }] } }] }
      : reply([{ text: 'x' }]));
  const r = await agent.tools.deep_research({ question: 'Q?' }, 'upsc');
  assert.deepEqual(r.searches, ['official q', 'critics q', 'base q']);
  assert.equal(calls.filter(c => c.b.tools?.[0]?.google_search).length, 3);
  assert.equal(r.sources.length, 1); assert.match(r.findings, /finding for critics q/);
  assert.match(calls[0].b.contents[0].parts[0].text, /PIB, PRS/);
});
test('deep_research: bad plan falls back; no key errors; deep flag reaches prompt', async () => {
  const { agent } = mk((b) => b.generationConfig?.responseMimeType ? { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }
    : b.tools?.[0]?.google_search ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } : reply([{ text: 'x' }]));
  assert.deepEqual((await agent.tools.deep_research({ question: 'Q' }, 'auto')).searches, ['Q']);
  const d = dsMk(() => ({ choices: [{ message: { content: 'hi' } }] }));
  assert.match((await d.agent.tools.deep_research({ question: 'Q' })).error, /Gemini key/);
  await d.agent.run([{ role: 'user', content: 'x' }], 'auto', true);
  assert.match(d.calls[0].b.messages[0].content, /DEEP MODE/);
});
