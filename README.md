# SacPath

An opportunity tracker for Sacramento-area community college students. Paste a posting or a screenshot, and Claude fills in the details. Track deadlines, match opportunities to your resume and preferences, and draft messages to people you've met.

Built for CRC Hacks 2026.

## APIs and tools used

- **Claude API (Anthropic):** reads pasted postings and screenshots (`/api/extract`), and powers resume matching and message drafting.
- **HireBase API:** live job and internship listings (`/api/jobs/search`).
- Node.js, Express, React (via CDN), HTML and CSS.

## Run it

1. Install Node.js 18 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and add your own keys:
   - `ANTHROPIC_API_KEY` from console.anthropic.com
   - `HIREBASE_API_KEY` from hirebase.org (Settings > API keys)
4. `npm start`, then open http://localhost:3000
5. `npm test` runs the server tests (no real keys or network needed).

## Endpoints

| Route | What it does |
|---|---|
| `GET /api/health` | Shows which keys are set (never the keys themselves) |
| `POST /api/jobs/search` | Body: `{ titles, keywords, remote, page, limit }`. Searches HireBase. Results are cached for 10 minutes because HireBase's free plan has a small daily limit. Add `"raw": true` to see the full HireBase response. |
| `POST /api/extract` | Body: `{ text }` and/or `{ imageBase64, mediaType }`. Returns the opportunity as JSON. |

## Keys and safety

- API keys live only in `.env`, which is git-ignored. Never paste a key into `public/index.html` or any file you commit.
- If a key is ever pasted into a public place, delete it and create a new one.

## Status

`public/index.html` is the interactive prototype with sample data. The two endpoints above are the real backend. Wiring the page's Smart Add and "Find internships" to these endpoints is the next step.

## Find internships tab

The page has a **Find internships** tab. It calls `POST /api/jobs/search` on this server, which calls HireBase with
your key from `.env` (the key never reaches the browser). Results can be added to the tracker. HireBase does not
list application deadlines, so added listings get a 30-day check-in date.

Live search only works when you open the app through the server (`npm start`, then http://localhost:3000).
Opening `index.html` directly shows a message and an optional sample-results fallback.
