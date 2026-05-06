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
    // /api/save-plan — persist generated plan, return UUID access token
    // body: { email, ideas, plan }
    // ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/api/save-plan') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405 });
      if (!isAllowedOrigin(request))   return jsonResponse({ error: 'Forbidden' }, 403);

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Bad request' }, 400); }

      const { email, ideas, plan } = body;
      if (!email || !email.includes('@'))       return jsonResponse({ error: 'Missing email' }, 400);
      if (!plan || !Array.isArray(plan.weeks))  return jsonResponse({ error: 'Missing plan' }, 400);

      const cleanEmail = email.toLowerCase().trim();
      const token = crypto.randomUUID();

      if (!env.DB) return jsonResponse({ error: 'DB not configured' }, 500);

      try {
        // Rate-limit: 1 save per email per 30 seconds
        const recent = await env.DB.prepare(
          `SELECT id FROM plans WHERE email = ? AND created_at > datetime('now', '-30 seconds') LIMIT 1`
        ).bind(cleanEmail).first();
        if (recent) return jsonResponse({ error: 'Too many requests' }, 429);

        await env.DB.prepare(
          `INSERT INTO plans (email, ideas_json, plan_json, token) VALUES (?, ?, ?, ?)`
        ).bind(cleanEmail, JSON.stringify(ideas || []), JSON.stringify(plan), token).run();

        return jsonResponse({ token });
      } catch (err) {
        console.error('save-plan DB error:', err);
        return jsonResponse({ error: 'DB error' }, 500);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // /api/email-plan — send saved plan to subscriber via Resend
    // body: { token }
    // ─────────────────────────────────────────────────────────────────
    if (url.pathname === '/api/email-plan') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405 });
      if (!isAllowedOrigin(request))   return jsonResponse({ error: 'Forbidden' }, 403);

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Bad request' }, 400); }

      const { token } = body;
      if (!token || !isValidUUID(token)) return jsonResponse({ error: 'Invalid token' }, 400);

      if (!env.DB)             return jsonResponse({ error: 'DB not configured' }, 500);
      if (!env.RESEND_API_KEY) return jsonResponse({ error: 'Email not configured' }, 500);

      try {
        const row = await env.DB.prepare(`
          SELECT p.email, p.plan_json, p.email_count, p.last_emailed_at, s.name
          FROM plans p
          LEFT JOIN subscribers s ON p.email = s.email
          WHERE p.token = ? LIMIT 1
        `).bind(token).first();

        if (!row) return jsonResponse({ error: 'Plan not found' }, 404);

        // Rate-limit: 1 email per token per 10 minutes
        if (row.last_emailed_at) {
          const elapsed = Date.now() - new Date(row.last_emailed_at).getTime();
          if (elapsed < 10 * 60 * 1000) {
            return jsonResponse({ error: 'Please wait a few minutes before requesting another copy' }, 429);
          }
        }

        // Hard cap: 10 emails per plan token
        if (row.email_count >= 10) {
          return jsonResponse({ error: 'Email limit reached for this plan' }, 429);
        }

        let plan;
        try { plan = JSON.parse(row.plan_json); }
        catch { return jsonResponse({ error: 'Plan data corrupt' }, 500); }

        const name = row.name || 'Builder';
        const html = formatPlanEmail(name, plan);

        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Ship Season <hi@updates.midcurved.com>',
            to: row.email,
            subject: 'Your 30-day plan — Ship Season 01',
            html,
          }),
        });

        if (!resendRes.ok) {
          const err = await resendRes.json().catch(() => ({}));
          console.error('Resend error:', err);
          return jsonResponse({ error: 'Failed to send email' }, 502);
        }

        await env.DB.prepare(
          `UPDATE plans SET email_count = email_count + 1, last_emailed_at = ? WHERE token = ?`
        ).bind(new Date().toISOString(), token).run();

        return jsonResponse({ success: true });
      } catch (err) {
        console.error('email-plan error:', err);
        return jsonResponse({ error: 'Internal error' }, 500);
      }
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

// ──────────── UUID v4 validation ────────────

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

// ──────────── Plan email HTML template ────────────

function formatPlanEmail(name, plan) {
  const weeks = (plan.weeks || []).map(week => {
    const days = (week.days || []).map(d => `
      <tr>
        <td style="padding:6px 16px 6px 0;font-family:monospace;font-size:20px;font-weight:800;color:#c8901a;vertical-align:top;white-space:nowrap;line-height:1.3;">${String(d.day).padStart(2, '0')}</td>
        <td style="padding:6px 0;vertical-align:top;">
          <div style="font-size:13px;font-weight:600;color:#f0ece0;margin-bottom:2px;line-height:1.3;">${d.title}</div>
          <div style="font-size:12px;color:#888;line-height:1.5;">${d.desc}</div>
        </td>
      </tr>`).join('');
    return `
      <div style="margin-bottom:28px;">
        <div style="font-size:9px;color:#c8901a;letter-spacing:0.18em;text-transform:uppercase;padding-bottom:8px;border-bottom:1px solid #2a2620;margin-bottom:10px;">${week.label}</div>
        <table style="width:100%;border-collapse:collapse;">${days}</table>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#100f0c;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:40px 24px;">
  <div style="margin-bottom:28px;">
    <span style="font-size:10px;color:#c8901a;letter-spacing:0.15em;text-transform:uppercase;border:1px solid #c8901a;border-radius:999px;padding:4px 12px;">Ship Season 01</span>
  </div>
  <h1 style="font-size:30px;font-weight:800;color:#f0ece0;line-height:1.1;margin:0 0 8px;">Your 30-day plan<span style="color:#c8901a;">.</span></h1>
  <p style="color:#666;font-size:13px;margin:0 0 36px;line-height:1.6;">Hey ${name} — one thing per day. Ship it. Share it.</p>
  ${weeks}
  <div style="margin-top:36px;padding:24px;border:1px solid #2a2620;border-radius:12px;text-align:center;background:#1a1814;">
    <div style="font-size:10px;color:#c8901a;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:10px;">Don't ship alone</div>
    <p style="font-size:14px;color:#f0ece0;font-weight:600;margin:0 0 6px;line-height:1.4;">Join the 30x30 builders on Telegram</p>
    <p style="font-size:12px;color:#888;margin:0 0 18px;line-height:1.5;">Share your daily build, ask for feedback, swipe ideas from other builders. Free, low-noise, builder-only.</p>
    <a href="https://t.me/+MKofBg9wwuhiZGNk" style="display:inline-block;background:#c8901a;color:#100f0c;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:12px 28px;text-decoration:none;border-radius:6px;">Join the Telegram →</a>
  </div>
  <div style="margin-top:24px;padding-top:24px;border-top:1px solid #2a2620;text-align:center;">
    <p style="font-size:12px;color:#666;margin:0 0 16px;">Post your builds with <span style="color:#c8901a;">#30x30</span> on vibecode.fun</p>
    <a href="https://vibecode.fun" style="display:inline-block;background:transparent;color:#c8901a;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:10px 22px;text-decoration:none;border:1px solid #c8901a;border-radius:6px;">Go to vibecode.fun →</a>
  </div>
  <p style="font-size:10px;color:#444;text-align:center;margin-top:28px;">
    <a href="https://30x30.midcurved.com" style="color:#444;text-decoration:none;">30x30.midcurved.com</a>
  </p>
</div>
</body></html>`;
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
