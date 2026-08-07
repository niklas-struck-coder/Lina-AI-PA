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
Reclaim-App bzw. die Claude/Cowork-App nutzen soll.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
};

const GROQ_MODEL = 'qwen/qwen3.6-27b'; // multimodal - kann Text und Bilder
const PROJECT_STATUS_URL = 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/status.md';

// Feste Microsoft-Edge-Stimmen pro Person (inoffizieller Zugang zu den
// gleichen Azure-Neural-Stimmen, die Edge im Browser für "Laut vorlesen"
// nutzt - kostenlos, aber undokumentiert/inoffiziell: kann jederzeit ohne
// Vorwarnung aufhören zu funktionieren. Fällt bei Fehlern auf die
// Browser-eigene Stimme zurück, siehe index.html speakFallback().
const EDGE_VOICE_NAMES = {
  lina: 'de-DE-KatjaNeural',
  it: 'de-DE-ConradNeural',
  marketing: 'de-DE-KillianNeural',
  support: 'de-DE-AmalaNeural',
};
const EDGE_TTS_TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_TTS_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_TTS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

async function computeSecMsGec() {
  const WIN_EPOCH = 11644473600;
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 10000000; // 100-ns-Intervalle (Windows FILETIME)
  const strToHash = `${ticks}${EDGE_TTS_TRUSTED_TOKEN}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(strToHash));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function concatUint8Arrays(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Ruft die inoffizielle Microsoft-Edge-TTS-Schnittstelle über eine
// WebSocket-Verbindung auf und gibt die rohen MP3-Bytes zurück.
async function fetchEdgeTTSAudio(text, voiceName) {
  const secMsGec = await computeSecMsGec();
  const connectionId = crypto.randomUUID().replace(/-/g, '');
  const wsUrl =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${EDGE_TTS_TRUSTED_TOKEN}&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=1-131.0.2903.99&ConnectionId=${connectionId}`;

  const upgradeRes = await fetch(wsUrl, {
    headers: {
      'Upgrade': 'websocket',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'Origin': EDGE_TTS_ORIGIN,
      'User-Agent': EDGE_TTS_USER_AGENT,
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const ws = upgradeRes.webSocket;
  if (!ws) throw new Error('Edge-TTS: WebSocket-Handshake fehlgeschlagen');
  ws.accept();

  return new Promise((resolve, reject) => {
    const audioChunks = [];
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('Edge-TTS: Zeitüberschreitung')), 15000);

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          finish(resolve, concatUint8Arrays(audioChunks));
        }
      } else {
        const buf = new Uint8Array(event.data);
        const headerLen = (buf[0] << 8) | buf[1];
        audioChunks.push(buf.slice(2 + headerLen));
      }
    });
    ws.addEventListener('close', () => {
      finish(audioChunks.length ? resolve : reject, audioChunks.length ? concatUint8Arrays(audioChunks) : new Error('Edge-TTS: Verbindung ohne Audio geschlossen'));
    });
    ws.addEventListener('error', () => finish(reject, new Error('Edge-TTS: WebSocket-Fehler')));

    const timestamp = new Date().toUTCString();
    const configMsg =
      `X-Timestamp:${timestamp}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
    ws.send(configMsg);

    const requestId = crypto.randomUUID().replace(/-/g, '');
    const escapedText = String(text || '').slice(0, 2000)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='de-DE'>` +
      `<voice name='${voiceName}'>` +
      `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapedText}</prosody>` +
      `</voice></speak>`;
    const ssmlMsg =
      `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${timestamp}\r\n` +
      `Path:ssml\r\n\r\n` +
      ssml;
    ws.send(ssmlMsg);
  });
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

// Berichte der Abteilungs-Agents (Cloud-Routinen, laufen alle 2 Wochen,
// analysieren travix.ai wirklich und schreiben Vorschläge - kein Live-
// Zugriff, aber echte, aktuelle Arbeit statt nur Chat-Antworten).
const REPORT_URLS = {
  it: 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/reports/it-chef.md',
  marketing: 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/reports/marketing-chef.md',
  support: 'https://raw.githubusercontent.com/niklas-struck-coder/travix.ai/main/reports/support-chef.md',
};

async function fetchDepartmentReport(persona) {
  const url = REPORT_URLS[persona];
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (!text) return null;
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

    // Sprachausgabe (inoffizielle Microsoft-Edge-Stimmen) - separater Zweig,
    // gleicher Endpunkt. Bei jedem Fehler springt das Frontend automatisch
    // auf die Browser-eigene Stimme zurück (speakFallback in index.html).
    if (body.action === 'speak') {
      const voicePersona = EDGE_VOICE_NAMES[body.persona] ? body.persona : 'lina';
      const voiceName = EDGE_VOICE_NAMES[voicePersona];
      try {
        const audioBytes = await fetchEdgeTTSAudio(body.text, voiceName);
        if (!audioBytes || audioBytes.length === 0) {
          return jsonResponse({ error: 'Edge-TTS: kein Audio erhalten' }, 502);
        }
        return jsonResponse({ audio: arrayBufferToBase64(audioBytes.buffer), mime: 'audio/mpeg' });
      } catch (err) {
        return jsonResponse({ error: err.message }, 502);
      }
    }

    const persona = SYSTEM_PROMPTS[body.persona] ? body.persona : 'lina';

    const [calendarContext, projectContext, departmentReport] = await Promise.all([
      fetchCalendarContext(env),
      fetchProjectStatusContext(),
      fetchDepartmentReport(persona),
    ]);

    const systemText = [SYSTEM_PROMPTS[persona], CONTEXT_NOTE, calendarContext, projectContext, departmentReport]
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
        }),
      });

      const data = await groqRes.json();

      if (!groqRes.ok) {
        return jsonResponse({ error: data.error?.message || 'Groq API error' }, groqRes.status);
      }

      let reply = data.choices?.[0]?.message?.content || '';
      // qwen3.6 ist ein "Denk"-Modell und packt seinen Gedankengang in <think>-Tags
      // vor die eigentliche Antwort - das soll der Nutzer nie sehen.
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || '(keine Antwort)';

      return jsonResponse({ reply });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};
