// 30x30 — Cloudflare Worker
// Handles /api (Claude proxy) and /subscribe (email capture)
// Everything else served from static assets (public/)

const MODEL = 'claude-haiku-4-5-20251001';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── API: Claude proxy ──
    if (url.pathname === '/api') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

      let body;
      try { body = await request.json(); }
      catch { return new Response('Bad request', { status: 400 }); }

      if (!body.messages || !Array.isArray(body.messages)) {
        return new Response('Missing messages', { status: 400 });
      }

      if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: { message: 'ANTHROPIC_API_KEY not configured' } }, 500);
      }

      // Allow caller to pass max_tokens — default 1000 for ideas, 4000 for full plan
      const max_tokens = body.max_tokens || 1000;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens,
            messages: body.messages
          })
        });
        const data = await res.json();
        return jsonResponse(data, res.status);
      } catch (err) {
        return jsonResponse({ error: { message: 'Claude unreachable: ' + err.message } }, 502);
      }
    }

    // ── SUBSCRIBE: save email + quiz answers to D1 ──
    if (url.pathname === '/subscribe') {
      if (request.method === 'OPTIONS') return corsOk();
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Bad request' }, 400); }

      const { name, email, answers } = body;
      if (!name || !email || !email.includes('@')) {
        return jsonResponse({ error: 'Missing name or email' }, 400);
      }

      if (env.DB) {
        try {
          await env.DB.prepare(`
            INSERT INTO subscribers (name, email, background, formats, time_per_day, tools, goal)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
              name = excluded.name,
              background = excluded.background,
              formats = excluded.formats,
              time_per_day = excluded.time_per_day,
              tools = excluded.tools,
              goal = excluded.goal
          `).bind(
            name,
            email.toLowerCase().trim(),
            JSON.stringify(answers?.background || []),
            JSON.stringify(answers?.format || []),
            JSON.stringify(answers?.time || []),
            JSON.stringify(answers?.tools || []),
            JSON.stringify(answers?.goal || [])
          ).run();
        } catch (err) {
          console.error('DB error:', err);
        }
      }

      return jsonResponse({ success: true });
    }

    // ── Everything else: serve static assets ──
    return env.ASSETS.fetch(request);
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function corsOk() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
