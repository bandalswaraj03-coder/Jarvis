import test from 'node:test';
import assert from 'node:assert';
import { createAgent, createStore, studySummary } from './agent.js';
const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
const mk = (script, extra = {}) => {
  const store = createStore(mem()); store.set('settings', { key: 'K' }); const calls = [];
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
