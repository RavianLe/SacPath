import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const HIREBASE_URL = 'https://api.hirebase.org/v2/jobs/search';
const CACHE_TTL_MS = 10 * 60 * 1000; // HireBase's free tier is small, so cache searches

const EXTRACT_PROMPT = `You read internship, scholarship and fellowship postings for community college students.
Return ONLY a JSON object (no markdown, no commentary) with these keys:
title (string), org (string), type ("Internship" | "Scholarship" | "Fellowship"),
deadline (YYYY-MM-DD or null), location (string), city (string), remote (boolean),
season (like "Summer 2027" or null), hours (hours per week as a number or null),
pay (dollars per hour as a number or null), award (scholarship amount as a number or null),
lor (number of letters of recommendation required, 0 if none), essay (boolean),
major (string, "Any" if open to all), kw (array of up to 6 lowercase skill keywords), link (string or null).
Use null when the posting does not say. Today's date is {{TODAY}}; use it to pick the right year for deadlines.`;

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

// Field names follow HireBase's documented job object (docs.hirebase.org): _id, job_title,
// company_name, application_link, location_type, locations[{city,region,country}],
// location_raw, salary_range{min,max,currency,period}, date_posted.
export function normalizeJob(j) {
  const loc = Array.isArray(j.locations) && j.locations[0] ? j.locations[0] : null;
  const place = loc ? [loc.city, loc.region].filter(Boolean).join(', ') : '';
  const remote = String(j.location_type ?? '').toLowerCase() === 'remote';
  const sal = j.salary_range;
  let pay = null; // dollars per hour, when HireBase gives a usable salary
  if (sal && Number(sal.min) > 0) {
    const period = String(sal.period ?? '').toLowerCase();
    pay = period.startsWith('hour') ? Math.round(sal.min) : period.startsWith('year') || period.startsWith('annual') ? Math.round(sal.min / 2080) : null;
  }
  return {
    id: j._id,
    title: j.job_title,
    org: j.company_name,
    link: j.application_link || j.apply_url || j.url || null,
    location: remote ? 'Remote' : place || j.location_raw || j.location || null,
    city: loc?.city ?? null,
    remote,
    jobType: j.job_type ?? null,
    pay,
    posted: j.date_posted ?? null,
  };
}

export function createApp(deps = {}) {
  const app = express();
  const doFetch = deps.fetch ?? fetch;
  const cache = new Map();
  let client = deps.anthropic;
  const getClaude = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

  app.use(express.json({ limit: '8mb' })); // screenshots arrive as base64
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      claudeKey: Boolean(process.env.ANTHROPIC_API_KEY),
      hirebaseKey: Boolean(process.env.HIREBASE_API_KEY),
    });
  });

  // Live listings from HireBase. The key stays on the server.
  app.post('/api/jobs/search', async (req, res) => {
    const key = process.env.HIREBASE_API_KEY;
    if (!key) return res.status(500).json({ error: 'HIREBASE_API_KEY is not set. Add it to your .env file.' });

    const { titles = [], keywords = [], remote = false, city = '', region = 'California', page = 1, limit = 10, raw = false } = req.body ?? {};
    const body = {
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(Number(limit) || 10, 25),
      include_no_salary: 'true', // HireBase expects the string "true", not a JSON boolean
      sort_by: 'date_posted',
      sort_order: 'desc',
    };
    if (titles.length) body.job_titles = titles;
    if (keywords.length) body.keywords = keywords;
    if (remote) body.location_types = ['Remote'];
    else if (city) body.geo_locations = [{ city: String(city), region: String(region), country: 'United States' }];

    const cacheKey = JSON.stringify(body);
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json(raw ? { cached: true, ...hit.data } : { cached: true, jobs: hit.data.jobs.map(normalizeJob) });
    }

    try {
      const r = await doFetch(HIREBASE_URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) return res.status(r.status).json({ error: `HireBase returned ${r.status}`, detail: await r.text() });
      const data = await r.json();
      cache.set(cacheKey, { at: Date.now(), data });
      res.json(raw ? { cached: false, ...data } : { cached: false, jobs: (data.jobs ?? []).map(normalizeJob) });
    } catch (e) {
      res.status(502).json({ error: 'Could not reach HireBase', detail: String(e.message ?? e) });
    }
  });

  // Smart Add: text and/or a screenshot in, structured opportunity out.
  app.post('/api/extract', async (req, res) => {
    if (!deps.anthropic && !process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set. Add it to your .env file.' });
    }
    const { text, imageBase64, mediaType = 'image/png' } = req.body ?? {};
    if (!text && !imageBase64) return res.status(400).json({ error: 'Send "text" and/or "imageBase64".' });

    const content = [];
    if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
    content.push({
      type: 'text',
      text: EXTRACT_PROMPT.replace('{{TODAY}}', new Date().toISOString().slice(0, 10)) + (text ? `\n\nPosting text:\n${text}` : ''),
    });

    try {
      const msg = await getClaude().messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
        max_tokens: 800,
        messages: [{ role: 'user', content }],
      });
      const out = msg.content.find((b) => b.type === 'text')?.text ?? '';
      res.json({ opportunity: parseJson(out) });
    } catch (e) {
      res.status(502).json({ error: 'Claude could not read that posting', detail: String(e.message ?? e) });
    }
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`SacPath running at http://localhost:${port}`));
}
