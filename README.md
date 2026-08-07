# Lina - Setup-Anleitung

Zwei Teile: der **Worker** (versteckt deinen API-Key) und die **Website**
(die du als App aufs Handy holst). Beides ist kostenlos.

## Teil 1: Cloudflare Worker (API-Key-Proxy)

Der Worker nutzt **Google Gemini** (kostenloses Kontingent, keine Kreditkarte nötig).

1. Gehe auf [dash.cloudflare.com](https://dash.cloudflare.com) und erstelle ein kostenloses Konto (falls noch nicht vorhanden).
2. Im Dashboard: **Workers & Pages** → **Create** → **Workers**-Reiter → Vorlage **"Hello World"** → Namen vergeben (z. B. `lina-proxy`) → **Deploy** (erstmal mit dem Standard-Code).
3. Klicke danach auf **Edit code**, lösche den Beispielcode und füge den Inhalt von `worker/worker.js` (aus diesem Ordner) ein. Speichern & **Deploy**.
4. Hol dir einen kostenlosen Gemini-API-Key: [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → mit Google-Konto einloggen → **Create API key**. Keine Kreditkarte nötig für das kostenlose Kontingent.
5. Gehe zu **Settings → Variables and Secrets** deines Workers, füge eine neue Variable hinzu:
   - Name: `GEMINI_API_KEY`
   - Wert: dein Key von aistudio.google.com
   - Typ: **Secret** (verschlüsselt)
6. Speichern. Deine Worker-URL steht oben auf der Worker-Übersichtsseite, z. B.
   `https://lina-proxy.<dein-cloudflare-name>.workers.dev`

Das kostenlose Kontingent von Gemini reicht für normale, alltägliche PA-Nutzung locker aus. Falls du später doch lieber Claude/Anthropic nutzen willst, sag einfach Bescheid — der Worker lässt sich zurückbauen.

## Teil 2: Website auf GitHub Pages

1. Auf [github.com](https://github.com) → **New repository** → Name z. B. `lina-pa`, Sichtbarkeit **Public**, "Add a README" NICHT anhaken.
2. Im neuen Repo: **Add file → Upload files**, und lade `index.html`, `manifest.json`, `icon-192.png`, `icon-512.png` aus diesem Ordner hoch (den `worker`-Unterordner NICHT mit hochladen — der bleibt privat/lokal).
3. Commit direkt auf `main`.
4. Im Repo: **Settings → Pages** → unter "Build and deployment" → Branch `main`, Ordner `/ (root)` → **Save**.
5. Nach ca. 1 Minute ist die Seite live unter:
   `https://<dein-github-name>.github.io/lina-pa/`

## Teil 3: Verbinden

1. Öffne `index.html` (die hochgeladene Version bearbeiten, oder lokal ändern und neu hochladen) und ersetze in der Zeile

   ```js
   const WORKER_URL = "PASTE_YOUR_WORKER_URL_HERE";
   ```

   die Platzhalter-URL durch deine echte Worker-URL aus Teil 1.
2. Datei speichern, in GitHub erneut hochladen (überschreiben).

## Teil 4: Als App aufs Handy

1. Öffne die GitHub-Pages-URL auf deinem Handy im Browser (Safari/Chrome).
2. **Teilen-Symbol** → **Zum Home-Bildschirm hinzufügen**.
3. Fertig — das Icon (Lina-Avatar) liegt jetzt wie eine App auf deinem Homescreen, öffnet sich im Vollbild ohne Browser-Leiste.

## Wichtig zu wissen

- Diese Web-Version von Lina hat **keinen Zugriff** auf dein travix.ai-Projekt oder deinen Reclaim/Outlook-Kalender — das funktioniert nur in der Claude/Cowork-App, wo die entsprechenden Connectors laufen. Die Web-Lina ist eine eigenständige, einfachere Variante zum Reden/Fragen, mit echten KI-Antworten (Google Gemini) und gesprochener Stimme.
- Der API-Key wird ausschließlich im Cloudflare Worker gespeichert (serverseitig, verschlüsselt) — niemals im öffentlichen Website-Code.
- Gemini hat ein kostenloses Kontingent, das für normale PA-Nutzung ausreicht. Cloudflare Worker und GitHub Pages sind in diesem Umfang ebenfalls kostenlos.
