# 30x30 Challenge

> Build 30 things in 30 days. One per day. Ship it.

Live at: [30x30.fun](https://30x30.fun)

## Stack

- **Frontend**: Single-file HTML (`public/index.html`)
- **API proxy**: Cloudflare Pages Function (`functions/api.js`)
- **AI**: Claude Haiku via Anthropic API
- **Hosting**: Cloudflare Pages

## Deploy

### 1. Fork / clone this repo

### 2. Connect to Cloudflare Pages
- Go to [pages.cloudflare.com](https://pages.cloudflare.com)
- Create project → Connect to Git → select this repo
- Build settings:
  - Framework preset: **None**
  - Build command: *(leave empty)*
  - Build output directory: `public`

### 3. Add environment variable
- Pages → Settings → Environment Variables
- Add: `ANTHROPIC_API_KEY` = your Anthropic API key (mark as secret)

### 4. Deploy
Every push to `main` auto-deploys. That's it.

## Local dev

```bash
npm install -g wrangler
wrangler pages dev public --compatibility-date=2024-01-01
```

Set your API key locally:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Submissions

All 30x30 builds get posted to [vibecode.fun](https://vibecode.fun) with `#30x30`.
