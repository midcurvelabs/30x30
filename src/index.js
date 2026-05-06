// 30x30 — Cloudflare Worker
// Routes:
//   POST /api              → Claude proxy (idea + plan generation)
//   POST /subscribe        → email capture (D1 only — email provider TBD: switching to Kit)
//   POST /api/checkout     → create Stripe Checkout Session
//   POST /api/webhook      → Stripe webhook (checkout.session.completed → mark paid + send "plan ready")
//   GET  /api/verify-paid  → frontend confirms paid status by session_id
//   *                      → static assets from /public

const MODEL = 'claude-haiku-4-5-20251001';

// Allowlist of origins that may call /api. Empty Referer (same-origin nav, curl from terminal during dev)
// is allowed because browsers don't always send one. Production frontend always sends Referer/Origin.
const ALLOWED_ORIGIN_HOSTS = [
  '30x30.midcurved.com',
  '30x30.midcurvelabs.workers.dev',
  '30x30.fun',                  // works post DNS migration; harmless until then
  'localhost',
  '127.0.0.1',
];

const SITE_URL = 'https://30x30.midcurved.com';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── HTTPS redirect ──
    if (url.protocol === 'http:' && !url.hostname.includes('localhost')) {
      return Response.redirect(url.href.replace('http:', 'https:'), 301);
    }

    // ─────────────────────────────────────────────────────────────────
    // /api  — Claude proxy
    // ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/api') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405 });

      if (!isAllowedOrigin(request)) {
        return jsonResponse({ error: { message: 'Forbidden' } }, 403);
      }

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: { message: 'Bad request' } }, 400); }

      if (!body.messages || !Array.isArray(body.messages)) {
        return jsonResponse({ error: { message: 'Missing messages' } }, 400);
      }

      if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: { message: 'ANTHROPIC_API_KEY not configured' } }, 500);
      }

      const max_tokens = body.max_tokens || 1000;
      const payload = { model: MODEL, max_tokens, messages: body.messages };
      if (body.system) payload.system = body.system;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        return jsonResponse(data, res.status);
      } catch (err) {
        return jsonResponse({ error: { message: 'Claude unreachable: ' + err.message } }, 502);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // /subscribe — email capture → D1
    // (Email-provider integration TBD: switching to Kit. See notes in repo.)
    // ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/subscribe') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405 });

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Bad request' }, 400); }

      // `ideas` is accepted in the body for forward-compat (will be forwarded to the email provider
      // once Kit is wired up) but is not currently used or stored.
      const { name, email, answers /*, ideas */ } = body;
      if (!name || !email || !email.includes('@')) {
        return jsonResponse({ error: 'Missing name or email' }, 400);
      }

      const cleanEmail = email.toLowerCase().trim();
      const nowIso = new Date().toISOString();

      if (env.DB) {
        try {
          await env.DB.prepare(`
            INSERT INTO subscribers (name, email, background, formats, time_per_day, tools, goal, signup_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
              name = excluded.name,
              background = excluded.background,
              formats = excluded.formats,
              time_per_day = excluded.time_per_day,
              tools = excluded.tools,
              goal = excluded.goal
          `).bind(
            name,
            cleanEmail,
            JSON.stringify(answers?.background || []),
            JSON.stringify(answers?.format || []),
            JSON.stringify(answers?.time || []),
            JSON.stringify(answers?.tools || []),
            JSON.stringify(answers?.goal || []),
            nowIso,
          ).run();
        } catch (err) {
          console.error('DB error:', err);
        }
      }

      return jsonResponse({ success: true });
    }

    // ─────────────────────────────────────────────────────────────────
    // /api/checkout — create Stripe Checkout Session
    // body: { email, name, ideaTitles: string[] }
    // ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/api/checkout') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405 });

      if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
        return jsonResponse({ error: 'Stripe not configured' }, 500);
      }

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Bad request' }, 400); }

      const { email, name, ideaTitles } = body;
      if (!email || !email.includes('@')) {
        return jsonResponse({ error: 'Missing email' }, 400);
      }

      const params = new URLSearchParams();
      params.set('mode', 'payment');
      params.set('line_items[0][price]', env.STRIPE_PRICE_ID);
      params.set('line_items[0][quantity]', '1');
      params.set('customer_email', email.toLowerCase().trim());
      params.set('success_url', `${SITE_URL}/?paid={CHECKOUT_SESSION_ID}`);
      params.set('cancel_url',  `${SITE_URL}/`);
      params.set('metadata[email]', email.toLowerCase().trim());
      if (name) params.set('metadata[name]', name);
      if (Array.isArray(ideaTitles)) {
        params.set('metadata[ideaTitles]', ideaTitles.slice(0, 3).join(' | ').slice(0, 480));
      }
      params.set('allow_promotion_codes', 'true');

      try {
        const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params,
        });
        const data = await res.json();
        if (!res.ok) {
          return jsonResponse({ error: data.error?.message || 'Stripe error' }, res.status);
        }
        return jsonResponse({ url: data.url, id: data.id });
      } catch (err) {
        return jsonResponse({ error: 'Stripe unreachable: ' + err.message }, 502);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // /api/webhook — Stripe webhook
    // ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/api/webhook') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

      const sig = request.headers.get('Stripe-Signature') || '';
      const raw = await request.text();

      if (!env.STRIPE_WEBHOOK_SECRET) {
        return new Response('Webhook secret not configured', { status: 500 });
      }

      const ok = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
      if (!ok) {
        return new Response('Invalid signature', { status: 400 });
      }

      let event;
      try { event = JSON.parse(raw); }
      catch { return new Response('Bad payload', { status: 400 }); }

      if (event.type === 'checkout.session.completed') {
        const session = event.data?.object || {};
        const email = (session.customer_email || session.metadata?.email || '').toLowerCase().trim();
        const sessionId = session.id;

        if (email && env.DB) {
          try {
            await env.DB.prepare(`
              UPDATE subscribers
              SET paid = 1, paid_at = ?, stripe_session_id = ?
              WHERE email = ?
            `).bind(new Date().toISOString(), sessionId, email).run();
          } catch (err) {
            console.error('DB update error:', err);
          }
        }

        // Email-provider hook (Kit) goes here when we wire it up:
        // - update Kit subscriber tag / move to "paid" segment
        // - trigger "plan ready" broadcast/sequence email with the unlock link
      }

      return new Response('ok', { status: 200 });
    }

    // ─────────────────────────────────────────────────────────────────
    // /api/verify-paid — frontend hits this on ?paid=… return to confirm
    // ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/api/verify-paid') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'GET')    return new Response('Method not allowed', { status: 405 });

      const sessionId = url.searchParams.get('session_id');
      if (!sessionId) return jsonResponse({ paid: false, error: 'missing session_id' }, 400);

      if (env.DB) {
        try {
          const row = await env.DB.prepare(
            'SELECT email, paid FROM subscribers WHERE stripe_session_id = ? LIMIT 1'
          ).bind(sessionId).first();
          if (row && row.paid === 1) {
            return jsonResponse({ paid: true, email: row.email });
          }
        } catch (err) {
          console.error('verify-paid DB error:', err);
        }
      }

      // Webhook may not have fired yet — fall back to Stripe API for the source of truth.
      if (env.STRIPE_SECRET_KEY) {
        try {
          const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
            headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          const session = await res.json();
          if (res.ok && session.payment_status === 'paid') {
            // Best-effort backfill: mark paid in D1 so the next call is fast.
            const email = (session.customer_email || session.metadata?.email || '').toLowerCase().trim();
            if (email && env.DB) {
              ctx.waitUntil(env.DB.prepare(
                `UPDATE subscribers SET paid = 1, paid_at = COALESCE(paid_at, ?), stripe_session_id = ? WHERE email = ?`
              ).bind(new Date().toISOString(), sessionId, email).run());
            }
            return jsonResponse({ paid: true, email });
          }
        } catch (err) {
          console.error('verify-paid Stripe error:', err);
        }
      }

      return jsonResponse({ paid: false });
    }

    // ─────────────────────────────────────────────────────────────────
    // static assets
    // ─────────────────────────────────────────────────────────────────
    return env.ASSETS.fetch(request);
  },
};

// ════════════════════════════════════════════════════════════════════
// helpers
// ════════════════════════════════════════════════════════════════════

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
    },
  });
}

function corsOk() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
    },
  });
}

function isAllowedOrigin(request) {
  const origin  = request.headers.get('Origin')  || '';
  const referer = request.headers.get('Referer') || '';
  if (!origin && !referer) return true; // empty referer (curl, RSS, etc.) — D1 stays protected because /api just forwards to Anthropic
  const probe = origin || referer;
  try {
    const host = new URL(probe).hostname;
    return ALLOWED_ORIGIN_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
  } catch {
    return false;
  }
}

// ──────────── Stripe signature verification (Web Crypto, no SDK) ────────────
// Verifies the t= timestamp + v1= HMAC-SHA256 signature in the Stripe-Signature header.

async function verifyStripeSignature(payload, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map(s => s.split('=').map(x => x.trim()))
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  // Reject very old timestamps (> 5 min) to prevent replay
  const ts = parseInt(t, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time-ish compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
