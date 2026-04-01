// 30x30 Challenge — Cloudflare Pages Function (API proxy)
// Lives at /api — same domain as the frontend, no CORS needed.
// Redeploy trigger: 2026-04-02
//
// SETUP: In Cloudflare Pages → Settings → Environment Variables
// Add secret: ANTHROPIC_API_KEY = sk-ant-...

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1000;

export async function onRequestPost(context) {
  const { request, env } = context;

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return new Response('Missing messages array', { status: 400 });
  }

  // Call Claude
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: body.messages
      })
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Claude unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const data = await claudeRes.json();

  return new Response(JSON.stringify(data), {
    status: claudeRes.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Block non-POST
export async function onRequestGet() {
  return new Response('Method not allowed', { status: 405 });
}
