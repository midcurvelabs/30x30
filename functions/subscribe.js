// 30x30 — /subscribe Pages Function
// Saves name, email, and quiz answers to D1
// Bound to D1 database "30x30-subscribers" via Pages settings

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const { name, email, answers } = body;

  if (!name || !email || !email.includes('@')) {
    return json({ error: 'Missing name or email' }, 400);
  }

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

    return json({ success: true });
  } catch (err) {
    console.error('DB error:', err);
    return json({ error: 'Failed to save' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
