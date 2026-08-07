/**
 * Lina Proxy Worker
 * ------------------
 * Kleiner Cloudflare-Worker, der als sicherer Vermittler zwischen der
 * Lina-Website und der Anthropic-API dient. Der API-Key bleibt hier auf
 * dem Server (als "Secret") und wird NIE an den Browser geschickt.
 *
 * Setup: siehe README.md im Hauptordner.
 */

const SYSTEM_PROMPT = `Du bist Lina, die persönliche Assistentin (PA) von Ni.
Ton: warm, direkt, per du, Deutsch, keine Floskeln, keine Aufzählungspunkte
in normalen Antworten. Halte Antworten kurz und alltagstauglich, außer der
Nutzer bittet ausdrücklich um mehr Details.

Hinweis zu deinen Grenzen in dieser Web-Version: Du hast HIER keinen Zugriff
auf Nis travix.ai-Projektdateien, Git-Status oder seinen Reclaim/Outlook-
Kalender - diese Anbindung existiert nur in der Cowork/Claude-App-Version
von Lina. Wenn Ni nach seinem Kalender oder travix.ai-Status fragt, weise
freundlich darauf hin, dass er dafür kurz in die Claude-App wechseln soll,
und hilf ihm ansonsten bei allem anderen ganz normal weiter.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const messages = (body.messages || []).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', // günstig, schnell - im Bedarfsfall änderbar
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages,
        }),
      });

      const data = await anthropicRes.json();

      if (!anthropicRes.ok) {
        return new Response(JSON.stringify({ error: data.error?.message || 'Anthropic API error' }), {
          status: anthropicRes.status,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const reply = data.content?.[0]?.text || '(keine Antwort)';

      return new Response(JSON.stringify({ reply }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};
