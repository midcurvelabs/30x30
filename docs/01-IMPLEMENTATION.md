# 30x30 — Implementation & Technical Reference

## What We Built

A web app that removes the #1 excuse for not joining the 30x30 challenge: "I don't know what to build." Users complete a 5-question quiz, drop their email, and get 3 AI-generated personalized challenge ideas. Selecting one or more and paying €9 unlocks a full 30-day plan built around their picks.

Built and shipped in a single session. Zero frameworks. No npm install. Just HTML, a Cloudflare Worker, and Claude.

---

## Repo

**GitHub:** github.com/midcurvelabs/30x30
**Live:** 30x30.midcurvelabs.workers.dev
**Custom domain:** 30x30.midcurved.com (connect in Worker → Domains & Routes)

```
30x30/
├── public/
│   └── index.html      ← entire frontend, single file
├── src/
│   └── index.js        ← Cloudflare Worker (API proxy + email capture)
├── wrangler.toml       ← Worker config, bindings
└── README.md
```

---

## Stack

| Layer | Tool | Why |
|-------|------|-----|
| Frontend | Single-file HTML | Ship fast, no build step |
| Hosting | Cloudflare Workers | Free, global, handles static assets + serverless |
| AI | Claude Haiku (`claude-haiku-4-5-20251001`) | Fast, cheap, great at structured JSON output |
| Database | Cloudflare D1 (SQLite) | Free, serverless, zero config |
| Payments | Lemon Squeezy | EU-friendly, VAT handled (not yet wired) |
| Repo | GitHub → auto-deploy via Wrangler | Push to main = live |

---

## How It Works

### User Flow
```
Land → Hero CTA
  → 5-question quiz (background, format, time, tools, goal)
  → Email gate (name + email required)
  → /subscribe saves to D1
  → /api calls Claude Haiku → 3 personalized ideas
  → Select 1+ ideas → paywall (€9)
  → /api calls Claude Haiku with max_tokens: 8000 → 30-day plan
  → View plan → submit daily builds to vibecode.fun
```

### API Proxy (`src/index.js`)
- `POST /api` — forwards `messages[]` to Anthropic API using `env.ANTHROPIC_API_KEY`
- `POST /subscribe` — saves name, email, quiz answers to D1
- Everything else → `env.ASSETS.fetch(request)` serves static HTML

### Token Budget
- Idea generation: `max_tokens: 1000` (3 ideas, compact JSON)
- Plan generation: `max_tokens: 8000` (30 days, structured JSON)

---

## Cloudflare Setup

**Worker:** `30x30` on `midcurvelabs.workers.dev`

**Secrets:**
- `ANTHROPIC_API_KEY` — set via `npx wrangler secret put ANTHROPIC_API_KEY`

**D1 Database:** `30x30-subscribers`
- ID: `0e07b0d3-e9a0-4825-8ff8-a222f032ee1f`
- Binding: `DB`
- Table: `subscribers` (id, name, email, background, formats, time_per_day, tools, goal, created_at)

**wrangler.toml:**
```toml
name = "30x30"
main = "src/index.js"
compatibility_date = "2024-01-01"

[assets]
directory = "./public"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "30x30-subscribers"
database_id = "0e07b0d3-e9a0-4825-8ff8-a222f032ee1f"
```

---

## Deploy Commands

```bash
# First time
git clone https://github.com/midcurvelabs/30x30
cd 30x30
npx wrangler login
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY

# Every update after
npx wrangler deploy
```

---

## What's Not Done Yet

- [ ] Lemon Squeezy €9 paywall wired up (currently skips to plan)
- [ ] 30x30.fun custom domain (own it? point it here)
- [ ] Email nurture sequence (emails captured in D1, nothing sent yet)
- [ ] vibecode.fun submissions feed on the site
- [ ] Telegram community link in UI
- [ ] Share card generator (OG image per day)
