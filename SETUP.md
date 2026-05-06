# 30x30 — Pre-launch setup checklist

Last updated: 2026-05-04. Follow top to bottom. Each step has a verify-it-worked check.

**Email funnel: deferred.** We're going with Kit (formerly ConvertKit) but wiring it up after the rest is tested. For now `/subscribe` only captures to D1; nothing goes out by email yet. See "Phase 2 — Kit" at the bottom.

---

## 0. Pre-flight

- [ ] Confirm `30x30.midcurved.com` still loads the working app: `curl -sSI https://30x30.midcurved.com/ | grep server` → `cloudflare`
- [ ] Confirm Anthropic key still works: `curl -sS -X POST https://30x30.midcurved.com/api -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":20}'` → returns `content` array
- [ ] Decide which Stripe account to use (existing BeClaire/Midcurved or fresh)

---

## 1. D1 — apply the payments migration

```bash
cd /Users/rik/Documents/rik-code/30x30-repo
wrangler d1 execute 30x30-subscribers --remote --file=migrations/0002_payments.sql
```

Verify:
```bash
wrangler d1 execute 30x30-subscribers --remote --command "PRAGMA table_info(subscribers)"
# expect to see: paid, paid_at, stripe_session_id, signup_date
```

---

## 2. Stripe — product + webhook

1. **Dashboard:** stripe.com → Products → **+ New** → "30x30 — Personalized 30-Day Plan", €9.00 EUR, **one-time**. Copy the **Price ID** (`price_…`).
2. **API keys** (Developers → API keys): copy the **secret key** (`sk_live_…` for prod, `sk_test_…` for staging).
3. **Webhook:** Developers → Webhooks → **+ Add endpoint**:
   - URL: `https://30x30.midcurved.com/api/webhook`
   - Events: `checkout.session.completed`
   - Copy the **Signing secret** (`whsec_…`).

Test mode first — use `sk_test_…` and the test webhook signing secret while you're verifying. Switch to live when ready.

---

## 3. Cloudflare — set Worker secrets

```bash
cd /Users/rik/Documents/rik-code/30x30-repo

wrangler secret put STRIPE_SECRET_KEY            # paste sk_live_… (or sk_test_… for staging)
wrangler secret put STRIPE_WEBHOOK_SECRET        # paste whsec_…
wrangler secret put STRIPE_PRICE_ID              # paste price_…
```

(`ANTHROPIC_API_KEY` already set.)

Verify all secrets are bound:
```bash
wrangler secret list
```

---

## 4. Cloudflare — rate-limit rule on /api

Dashboard → Workers & Pages → `30x30` → Settings → ... or zone-level Security → Rate Limiting Rules:

- **Path equals** `/api`
- 10 requests / 5 minutes / per IP → block 5 minutes

Verify:
```bash
for i in $(seq 1 12); do
  curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://30x30.midcurved.com/api \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
done
# expect: 200 200 200 ... 429 429 429
```

---

## 5. Deploy

```bash
cd /Users/rik/Documents/rik-code/30x30-repo
git add -A
git status                                     # eyeball
git commit -m "feat: stripe checkout + paid flow"
git push                                       # auto-deploys via the connected GitHub → CF Pages/Workers integration

# OR direct deploy:
wrangler deploy
```

---

## 6. End-to-end verification (test mode)

Run all of these on `https://30x30.midcurved.com`:

- [ ] **Quiz path 1** (builder + apps + 1hr + AI tools + portfolio): completes → 3 ideas appear
- [ ] **Subscribe writes to D1**: `wrangler d1 execute 30x30-subscribers --remote --command "SELECT email, signup_date FROM subscribers ORDER BY signup_date DESC LIMIT 5"` shows the test signup
- [ ] **Stripe Checkout**: select an idea → click "Build my 30-day plan" → redirects to Stripe → use test card `4242 4242 4242 4242`, any future expiry, any CVC, any zip → completes → redirects back to `?paid=cs_test_…`
- [ ] **Plan generates after redirect**: page lands on plan screen, plan renders
- [ ] **Webhook fired**: Stripe dashboard → Webhooks → recent events → 200 response logged
- [ ] **D1 row updated**: `wrangler d1 execute 30x30-subscribers --remote --command "SELECT email, paid, paid_at FROM subscribers WHERE paid = 1 LIMIT 5"`
- [ ] **Forged signature rejected**: `curl -X POST https://30x30.midcurved.com/api/webhook -d 'fake' -H 'Stripe-Signature: t=1,v1=00'` → 400
- [ ] **Origin allowlist**: `curl -X POST https://30x30.midcurved.com/api -H 'Origin: https://evil.example.com' -H 'Content-Type: application/json' -d '{"messages":[]}'` → 403

---

## 7. Switch to live

- Replace test Stripe keys with live keys: `wrangler secret put STRIPE_SECRET_KEY` (`sk_live_…`) + `STRIPE_WEBHOOK_SECRET` (live webhook signing secret) + `STRIPE_PRICE_ID` (live price ID).
- In Stripe dashboard, add the same `https://30x30.midcurved.com/api/webhook` endpoint under the **Live** tab.
- One smoke test with a real €9 charge (immediately refund in Stripe dashboard).

---

## Phase 2 — Kit (email funnel, post-launch)

Wire up after the Stripe + idea/plan flow is verified live.

1. Create Kit account at [kit.com](https://kit.com), upgrade if needed.
2. Verify `midcurved.com` as sending domain (DNS: SPF/DKIM TXT records at registrar).
3. Build the broadcast/sequence in Kit:
   - **Welcome (Day 0)** — "Your 3 ideas are inside" with the 3 idea titles
   - **Day 2** — "Why most 30-day challenges die on day 4"
   - **Day 5** — "Build #3 was the one that mattered"
   - **Day 9** — "Where do you ship it?" (vibecode.fun tease)
   - **Day 14** — "What I'd do with you 1:1" (BeClaire intro)
   - Source copy in `~/Documents/rik-docs/02_projects/30x30/emails/`
4. Add Kit form/tag fields: `source=30x30`, `paid` (bool to branch the funnel)
5. Wire `/subscribe` (in `src/index.js`) and the Stripe webhook to call Kit's API:
   - `POST https://api.kit.com/v3/forms/<FORM_ID>/subscribe` with `email`, `first_name`, `fields[source]=30x30`, `fields[idea1Title]=…` (etc)
   - On `checkout.session.completed`, tag subscriber as `paid` so the funnel branches
6. Worker secrets: `KIT_API_KEY`, `KIT_FORM_ID`, `KIT_TAG_PAID`
7. Test: signup → email arrives within 30s; pay → `paid` tag applied; subsequent funnel emails reflect that.
