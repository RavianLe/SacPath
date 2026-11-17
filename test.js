import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './server.js';

process.env.HIREBASE_API_KEY = 'test-key-not-real';
let calls = 0, lastReq;
const fakeFetch = async (url, opts) => {
  calls++; lastReq = { url, opts };
  return { ok: true, json: async () => ({ jobs: [{ _id: '1', job_title: 'IT Intern', company_name: 'Acme' }] }) };
};
const fakeClaude = { messages: { create: async ({ messages }) => {
  assert.equal(messages[0].content.at(-1).type, 'text');
  return { content: [{ type: 'text', text: '```json\n{"title":"Dream Big","org":"Foundation","type":"Scholarship"}\n```' }] };
} } };

const server = http.createServer(createApp({ fetch: fakeFetch, anthropic: fakeClaude }));
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

let [s, j] = await post('/api/jobs/search', { titles: ['IT Intern'], remote: true });
assert.equal(s, 200); assert.equal(j.jobs[0].title, 'IT Intern'); assert.equal(j.cached, false);
assert.equal(lastReq.opts.headers['x-api-key'], 'test-key-not-real');
const sent = JSON.parse(lastReq.opts.body);
assert.deepEqual(sent.job_titles, ['IT Intern']); assert.deepEqual(sent.location_types, ['Remote']);
assert.equal(sent.include_no_salary, 'true');
[s, j] = await post('/api/jobs/search', { titles: ['IT Intern'], remote: true });
assert.equal(j.cached, true); assert.equal(calls, 1, 'second identical search should come from cache');

[s, j] = await post('/api/extract', {}); assert.equal(s, 400);
[s, j] = await post('/api/extract', { text: 'Dream Big scholarship...' });
assert.equal(s, 200); assert.equal(j.opportunity.title, 'Dream Big');

delete process.env.HIREBASE_API_KEY;
[s, j] = await post('/api/jobs/search', {}); assert.equal(s, 500); assert.match(j.error, /HIREBASE_API_KEY/);
const h = await fetch(base + '/api/health').then((r) => r.json());
assert.equal(h.hirebaseKey, false);
console.log('All server tests passed');
server.close();
