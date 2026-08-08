/**
 * Lina Proxy Worker
 * ------------------
 * Kleiner Cloudflare-Worker, der als sicherer Vermittler zwischen der
 * Lina-Website und der Groq API dient. Der API-Key bleibt hier auf
 * dem Server (als "Secret") und wird NIE an den Browser geschickt.
 * Groq: kostenlos, keine Kreditkarte nötig (console.groq.com).
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

const SYSTEM_PROMPTS = {
  lina: `Du bist Lina, die persönliche Assistentin (PA) von Ni.
Ton: warm, direkt, per du, Deutsch, keine Floskeln, keine Aufzählungspunkte
in normalen Antworten. Halte Antworten kurz und alltagstauglich, außer der
Nutzer bittet ausdrücklich um mehr Details.`,

  it: `Du bist der IT-Chef im Team von Ni (neben Lina, Marketing-Chef und
Support-Chef). Fokus: Technik, Code, Architektur, Debugging, travix.ai als
Software-Projekt. Ton: sachlich, präzise, lösungsorientiert, per du,
Deutsch. Keine langen Vorträge, außer ausdrücklich gewünscht.`,

  marketing: `Du bist der Marketing-Chef im Team von Ni (neben Lina, IT-Chef
und Support-Chef). Fokus: Positionierung, Zielgruppen, Kampagnen-Ideen,
Markenauftritt für travix.ai. Ton: kreativ, ideenreich, aber konkret und
umsetzbar, per du, Deutsch.`,

  support: `Du bist der Support-Chef im Team von Ni (neben Lina, IT-Chef und
Marketing-Chef). Fokus: Kundenerfahrung, Support-Prozesse, häufige
Nutzerprobleme bei travix.ai. Ton: empathisch, klar, lösungsorientiert, per
du, Deutsch.`,

  team: `Du repräsentierst das gesamte Team von Ni in einem Team-Meeting:
Lina (persönliche Assistentin), IT-Chef (Technik), Marketing-Chef
(Marketing), Support-Chef (Kundenservice).

Antworte NUR als die Person(en), die zur Frage wirklich etwas beizutragen
haben - meist reicht eine, manchmal zwei. Nicht alle vier müssen immer
sprechen.

Format ist PFLICHT: Jede Wortmeldung beginnt in einer eigenen Zeile exakt
mit "Name: " (z.B. "Lina: ..." oder "IT-Chef: ..." oder "Marketing-Chef: ..."
oder "Support-Chef: ..."), gefolgt vom Text dieser Person. Kein Vorspann,
keine Zusammenfassung danach, keine Moderation.`,
};

const CONTEXT_NOTE = `Kontext-Hinweis: Falls unten ein Kalenderausschnitt
und/oder ein travix.ai-Projektstatus mitgeschickt wurden, dürft ihr die
verwenden, wenn Ni danach fragt. Beides ist nur eine unregelmäßig
aktualisierte Momentaufnahme (kein Live-Zugriff, keine Schreibrechte, keine
Garantie auf Vollständigkeit) - wenn etwas fehlt, unklar ist, oder Ni
Termine anlegen/ändern will, weist freundlich darauf hin, dass er dafür die
Reclaim-App bzw. die Claude/Cowork-App nutzen soll.

Falls oben ein Abschnitt "Was zuletzt privat besprochen wurde" steht: das
sind kurze Auszüge aus Nis Einzelgesprächen mit den anderen Personen -
nutzt das nur als Hintergrundwissen, wenn es zur Frage passt, referenziert
es nicht ungefragt im Detail.`;

// Erlaubt Lina/IT-Chef/Marketing-Chef/Support-Chef, auf ausdrücklichen
// Wunsch von Ni eine kurze Nachricht ins gemeinsame Team-Meeting zu posten
// (z.B. "sag das auch dem Team" / "schreib das ins Team-Meeting"). Nicht für
// 'team' selbst - da kann eh direkt jeder antworten.
const SHARE_WITH_TEAM_TOOL = {
  type: 'function',
  function: {
    name: 'share_with_team',
    description: 'Postet eine kurze Nachricht im gemeinsamen Team-Meeting-Chat, sichtbar für Lina, IT-Chef, Marketing-Chef und Support-Chef. NUR aufrufen, wenn Ni ausdrücklich darum bittet (z.B. "sag das dem Team", "schreib das ins Team-Meeting", "teile das mit allen").',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Die Nachricht für den Team-Chat, klar und kurz formuliert.' },
      },
      required: ['message'],
    },
  },
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
};

const GROQ_MODEL = 'qwen/qwen3.6-27b'; // multimodal - kann Text und Bilder
const PROJECT_STATUS_URL = 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/status.md';

// Groq-TTS-Stimme (Orpheus, offizielle Groq-API - kostenlos, zuverlässig,
// aber nur Englisch. Der Chat-Text bleibt Deutsch; die Stimme liest ihn mit
// englischer Aussprache vor). Alle Personas nutzen bewusst dieselbe Stimme
// wie Lina (Ni möchte eine einheitliche Stimme statt pro Person eine
// eigene).
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english';
const GROQ_VOICE_NAME = 'hannah';

async function fetchGroqTTSAudio(text, voiceName, env) {
  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_TTS_MODEL,
      input: String(text || '').slice(0, 2000),
      voice: voiceName,
      response_format: 'wav',
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq TTS error (${res.status}): ${errText.slice(0, 300)}`);
  }
  return res.arrayBuffer();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function contentToGroqContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'image') {
        return {
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        };
      }
      return { type: 'text', text: block.text || '' };
    });
  }
  return '';
}

function toGroqMessages(messages, systemText) {
  const out = [{ role: 'system', content: systemText }];
  messages.forEach(m => {
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: contentToGroqContent(m.content),
    });
  });
  return out;
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
function toReclaimDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function fetchCalendarContext(env) {
  if (!env.RECLAIM_API_KEY) return null;
  try {
    const now = Date.now();
    // Reclaim akzeptiert nur ein reines Datum (YYYY-MM-DD), keine Uhrzeit.
    const start = toReclaimDate(new Date(now - 6 * 3600 * 1000));
    const end = toReclaimDate(new Date(now + 30 * 3600 * 1000));
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

// Berichte der Abteilungs-Agents (Cloud-Routinen, laufen alle 2 Wochen,
// analysieren travix.ai wirklich und schreiben Vorschläge - kein Live-
// Zugriff, aber echte, aktuelle Arbeit statt nur Chat-Antworten).
const REPORT_URLS = {
  it: 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/reports/it-chef.md',
  marketing: 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/reports/marketing-chef.md',
  support: 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/reports/support-chef.md',
};

// Auf ~800 Zeichen gekürzt, um das Groq-Tokenbudget (8000 TPM im Gratis-
// Tarif) nicht bei jeder einzelnen Nachricht unnötig zu belasten.
const MAX_REPORT_CHARS = 800;

async function fetchDepartmentReport(persona) {
  const url = REPORT_URLS[persona];
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    let text = (await res.text()).trim();
    if (!text) return null;
    if (text.length > MAX_REPORT_CHARS) {
      text = text.slice(0, MAX_REPORT_CHARS) + '\n[…gekürzt, vollständiger Bericht liegt im Repo unter reports/]';
    }
    return `Dein letzter eigener Arbeitsbericht (automatischer Lauf alle 2 Wochen, echte Analyse/Vorschläge, kein Live-Stand):\n${text}`;
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

    // Zugangscode-Sperre: nur aktiv, wenn ACCESS_CODE als Secret gesetzt ist.
    if (env.ACCESS_CODE && request.headers.get('X-Access-Code') !== env.ACCESS_CODE) {
      return jsonResponse({ error: 'Falscher oder fehlender Zugangscode' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    // Temporäre Diagnose für den Reclaim-Kalender-Zugriff - zeigt den
    // rohen Fehler, ohne den Key selbst preiszugeben. Kann später wieder
    // entfernt werden.
    if (body.action === 'debug-calendar') {
      if (!env.RECLAIM_API_KEY) {
        return jsonResponse({ hasKey: false, note: 'RECLAIM_API_KEY ist nicht gesetzt' });
      }
      const now = Date.now();
      const startDate = new Date(now - 6 * 3600 * 1000);
      const endDate = new Date(now + 30 * 3600 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const dateOnly = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      const isoNoMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const formats = {
        isoWithMs: [startDate.toISOString(), endDate.toISOString()],
        isoNoMs: [isoNoMs(startDate), isoNoMs(endDate)],
        dateOnly: [dateOnly(startDate), dateOnly(endDate)],
        unixSeconds: [String(Math.floor(startDate.getTime() / 1000)), String(Math.floor(endDate.getTime() / 1000))],
        unixMillis: [String(startDate.getTime()), String(endDate.getTime())],
      };
      const results = {};
      for (const [name, [s, e]] of Object.entries(formats)) {
        try {
          const res = await fetch(
            `https://api.app.reclaim.ai/api/events/personal?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`,
            { headers: { Authorization: `Bearer ${env.RECLAIM_API_KEY}` } }
          );
          const bodyText = await res.text();
          results[name] = { sent: { start: s, end: e }, status: res.status, ok: res.ok, bodyPreview: bodyText.slice(0, 300) };
        } catch (err) {
          results[name] = { sent: { start: s, end: e }, error: err.message };
        }
      }
      return jsonResponse({ hasKey: true, keyLength: env.RECLAIM_API_KEY.length, results });
    }

    // Sprachausgabe (Groq TTS, Englisch) - separater Zweig, gleicher
    // Endpunkt. Bei jedem Fehler springt das Frontend automatisch auf die
    // Browser-eigene Stimme zurück (speakFallback in index.html).
    if (body.action === 'speak') {
      try {
        const audioBuffer = await fetchGroqTTSAudio(body.text, GROQ_VOICE_NAME, env);
        if (!audioBuffer || audioBuffer.byteLength === 0) {
          return jsonResponse({ error: 'Groq TTS: kein Audio erhalten' }, 502);
        }
        return jsonResponse({ audio: arrayBufferToBase64(audioBuffer), mime: 'audio/wav' });
      } catch (err) {
        return jsonResponse({ error: err.message }, 502);
      }
    }

    const persona = SYSTEM_PROMPTS[body.persona] ? body.persona : 'lina';

    // Kurze Auszüge aus Nis privaten Einzelgesprächen - nur wenn das Team
    // gefragt wird, vom Frontend mitgeschickt (privateDigest), auf eine
    // sinnvolle Länge gedeckelt.
    const privateDigest = persona === 'team' && typeof body.privateDigest === 'string' && body.privateDigest.trim()
      ? `Was zuletzt privat besprochen wurde:\n${body.privateDigest.trim().slice(0, 2000)}`
      : null;

    const [calendarContext, projectContext, departmentReport] = await Promise.all([
      fetchCalendarContext(env),
      fetchProjectStatusContext(),
      fetchDepartmentReport(persona),
    ]);

    const systemText = [SYSTEM_PROMPTS[persona], CONTEXT_NOTE, calendarContext, projectContext, departmentReport, privateDigest]
      .filter(Boolean)
      .join('\n\n');

    const messages = toGroqMessages(body.messages || [], systemText);

    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: 2048, // qwen3.6 verbraucht Tokens fürs "Denken" vor der eigentlichen Antwort
          reasoning_format: 'hidden', // Denkteil serverseitig unterdrücken statt nachträglich rausfiltern
          ...(persona !== 'team' ? { tools: [SHARE_WITH_TEAM_TOOL], tool_choice: 'auto' } : {}),
        }),
      });

      const data = await groqRes.json();

      if (!groqRes.ok) {
        return jsonResponse({ error: data.error?.message || 'Groq API error' }, groqRes.status);
      }

      const message = data.choices?.[0]?.message;

      let shareWithTeam = null;
      const toolCall = message?.tool_calls?.find(c => c.function?.name === 'share_with_team');
      if (toolCall) {
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          if (args.message) shareWithTeam = String(args.message).trim().slice(0, 1000);
        } catch {}
      }

      let reply = message?.content || '';
      // Sicherheitsnetz: falls reasoning_format ignoriert wird oder der
      // Denkteil vor dem schließenden Tag abgeschnitten wird (Modell rennt
      // ins Token-Limit), nie rohen Gedankengang an den Nutzer weitergeben.
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (!reply && shareWithTeam) {
        reply = 'Alles klar, hab ich ins Team-Meeting geschrieben.';
      } else if (!reply || reply.includes('<think>')) {
        reply = 'Sorry, meine Antwort ist mir zu lang/komplex geraten und wurde abgeschnitten. Magst du die Frage nochmal kürzer stellen?';
      }

      return jsonResponse({ reply, shareWithTeam });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};
