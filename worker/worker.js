/**
 * Lina Proxy Worker
 * ------------------
 * Kleiner Cloudflare-Worker, der als sicherer Vermittler zwischen der
 * Lina-Website und der Google Gemini API dient. Der API-Key bleibt hier auf
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

const GEMINI_MODEL = 'gemini-2.0-flash';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Wandelt ein Frontend-Content-Feld (String oder Anthropic-Style Content-Blocks
// mit optionalem Bild) in Gemini "parts" um.
function contentToParts(content) {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'image') {
        return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
      }
      return { text: block.text || '' };
    });
  }
  return [{ text: '' }];
}

function toGeminiContents(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: contentToParts(m.content),
  }));
}

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
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    const contents = toGeminiContents(body.messages || []);

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: { maxOutputTokens: 1024 },
          }),
        }
      );

      const data = await geminiRes.json();

      if (!geminiRes.ok) {
        return jsonResponse({ error: data.error?.message || 'Gemini API error' }, geminiRes.status);
      }

      const parts = data.candidates?.[0]?.content?.parts || [];
      const reply = parts.map(p => p.text || '').join('').trim() || '(keine Antwort)';

      return jsonResponse({ reply });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};
