/**
 * Lina Proxy Worker
 * ------------------
 * Kleiner Cloudflare-Worker, der als sicherer Vermittler zwischen der
 * Lina-Website und der Google Gemini API dient. Der API-Key bleibt hier auf
 * dem Server (als "Secret") und wird NIE an den Browser geschickt.
 *
 * Optional reichert er den Kontext mit zwei Momentaufnahmen an:
 *  - Nis Kalender (Reclaim) über einen inoffiziellen, undokumentierten
 *    Endpunkt - kann jederzeit ohne Vorwarnung aufhören zu funktionieren.
 *    Fehler dabei werden abgefangen, der Chat läuft dann einfach ohne
 *    Kalenderkontext weiter.
 *  - travix.ai-Projektstatus (status.md im travix.ai-Repo, öffentlich
 *    lesbar über raw.githubusercontent.com) - keine Live-Daten, nur was
 *    zuletzt manuell aktualisiert wurde.
 *
 * Setup: siehe README.md im Hauptordner.
 */

const SYSTEM_PROMPT = `Du bist Lina, die persönliche Assistentin (PA) von Ni.
Ton: warm, direkt, per du, Deutsch, keine Floskeln, keine Aufzählungspunkte
in normalen Antworten. Halte Antworten kurz und alltagstauglich, außer der
Nutzer bittet ausdrücklich um mehr Details.

Kontext-Hinweis: Falls unten ein Kalenderausschnitt und/oder ein travix.ai-
Projektstatus mitgeschickt wurden, darfst du die verwenden, wenn Ni danach
fragt. Beides ist nur eine unregelmäßig aktualisierte Momentaufnahme (kein
Live-Zugriff, keine Schreibrechte, keine Garantie auf Vollständigkeit) -
wenn etwas fehlt, unklar ist, oder Ni Termine anlegen/ändern will, weise
freundlich darauf hin, dass er dafür die Reclaim-App bzw. die Claude/
Cowork-App nutzen soll.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const GEMINI_MODEL = 'gemini-2.0-flash';
const PROJECT_STATUS_URL = 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/status.md';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

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

function formatEventTime(value) {
  const d = value ? new Date(value) : null;
  if (!d || isNaN(d.getTime())) return '';
  return d.toISOString().slice(11, 16) + ' UTC';
}

function formatEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const lines = events.slice(0, 15).map(ev => {
    const title = ev.title || ev.summary || ev.eventTitle || '(ohne Titel)';
    const start = ev.eventStart || ev.start?.dateTime || ev.start || '';
    const end = ev.eventEnd || ev.end?.dateTime || ev.end || '';
    const startT = formatEventTime(start);
    const endT = formatEventTime(end);
    const time = startT && endT ? `${startT}–${endT}` : (startT || '');
    return `- ${time ? time + ' ' : ''}${title}`.trim();
  });
  return lines.join('\n');
}

// Undokumentierter Reclaim-Endpunkt - bewusst defensiv: jeder Fehler führt
// nur dazu, dass der Kalenderkontext fehlt, nie zu einem kompletten Ausfall.
async function fetchCalendarContext(env) {
  if (!env.RECLAIM_API_KEY) return null;
  try {
    const now = Date.now();
    const start = new Date(now - 6 * 3600 * 1000).toISOString();
    const end = new Date(now + 30 * 3600 * 1000).toISOString();
    const res = await fetch(
      `https://api.app.reclaim.ai/api/events/personal?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      { headers: { Authorization: `Bearer ${env.RECLAIM_API_KEY}` } }
    );
    if (!res.ok) return null;
    const events = await res.json();
    const formatted = formatEvents(events);
    if (!formatted) return null;
    return `Kalenderausschnitt von Ni (ungefähr die nächsten ~24-30h, Zeiten in UTC, kann leicht von seiner lokalen Zeitzone abweichen):\n${formatted}`;
  } catch {
    return null;
  }
}

async function fetchProjectStatusContext() {
  try {
    const res = await fetch(PROJECT_STATUS_URL);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (!text) return null;
    return `Aktueller Stand des travix.ai-Projekts (Momentaufnahme, ggf. nicht mehr ganz aktuell):\n${text}`;
  } catch {
    return null;
  }
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

    const [calendarContext, projectContext] = await Promise.all([
      fetchCalendarContext(env),
      fetchProjectStatusContext(),
    ]);

    const systemText = [SYSTEM_PROMPT, calendarContext, projectContext]
      .filter(Boolean)
      .join('\n\n');

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
            systemInstruction: { parts: [{ text: systemText }] },
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
