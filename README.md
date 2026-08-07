# Lina - Setup-Anleitung

Zwei Teile: der **Worker** (versteckt deinen API-Key) und die **Website**
(die du als App aufs Handy holst). Beides ist kostenlos.

## Teil 1: Cloudflare Worker (API-Key-Proxy)

Der Worker nutzt **Groq** (kostenloses Kontingent, keine Kreditkarte nötig, sehr schnell).

1. Gehe auf [dash.cloudflare.com](https://dash.cloudflare.com) und erstelle ein kostenloses Konto (falls noch nicht vorhanden).
2. Im Dashboard: **Workers & Pages** → **Create** → **Workers**-Reiter → Vorlage **"Hello World"** → Namen vergeben (z. B. `lina-proxy`) → **Deploy** (erstmal mit dem Standard-Code).
3. Klicke danach auf **Edit code**, lösche den Beispielcode und füge den Inhalt von `worker/worker.js` (aus diesem Ordner) ein. Speichern & **Deploy**.
4. Hol dir einen kostenlosen Groq-API-Key: [console.groq.com/keys](https://console.groq.com/keys) → Konto anlegen/einloggen → **Create API Key**. Keine Kreditkarte nötig.
5. Gehe zu **Settings → Variables and Secrets** deines Workers, füge eine neue Variable hinzu:
   - Name: `GROQ_API_KEY`
   - Wert: dein Key von console.groq.com
   - Typ: **Secret** (verschlüsselt)
6. Optional, aber empfohlen — Zugangscode, damit nicht jeder mit dem Link chatten kann: noch eine Variable hinzufügen:
   - Name: `ACCESS_CODE`
   - Wert: ein Code deiner Wahl (den fragt die Website beim ersten Öffnen ab)
   - Typ: **Secret**
7. Speichern. Deine Worker-URL steht oben auf der Worker-Übersichtsseite, z. B.
   `https://lina-proxy.<dein-cloudflare-name>.workers.dev`

Das kostenlose Kontingent von Groq (14.400 Anfragen/Tag) reicht für normale, alltägliche PA-Nutzung locker aus.

## Teil 1b: Kalender-Kontext (optional, experimentell)

Der Worker kann Lina einen groben Ausschnitt aus deinem Reclaim-Kalender mitgeben.
**Wichtig:** Das läuft über einen inoffiziellen, undokumentierten Reclaim-Endpunkt
(Reclaims öffentliche API deckt offiziell nur Tasks/Habits ab, keine Kalender-Events).
Das kann jederzeit ohne Vorwarnung aufhören zu funktionieren — der Worker fängt das
aber ab, dann antwortet Lina einfach ohne Kalenderkontext, nichts bricht dabei ab.

1. Gehe zu [app.reclaim.ai/settings/developer](https://app.reclaim.ai/settings/developer) und erstelle einen API-Key.
2. In Cloudflare, bei deinem Worker unter **Settings → Variables and Secrets**, eine weitere Variable hinzufügen:
   - Name: `RECLAIM_API_KEY`
   - Wert: der Key aus Schritt 1
   - Typ: **Secret**
3. Fertig — Lina bekommt jetzt bei jeder Nachricht automatisch einen Kalenderausschnitt der nächsten ca. 24–30h mitgeliefert (nur lesend, keine Schreibrechte, Zeiten in UTC).

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

- Diese Web-Version von Lina hat **keinen echten Zugriff** auf dein travix.ai-Projekt oder deinen Reclaim/Outlook-Kalender im Sinne von Tools/Aktionen — das funktioniert nur in der Claude/Cowork-App, wo die entsprechenden Connectors laufen. Sie bekommt lediglich optionale, unregelmäßig aktualisierte Momentaufnahmen mitgeliefert (siehe Teil 1b und status.md). Die Web-Lina ist eine eigenständige, einfachere Variante zum Reden/Fragen, mit echten KI-Antworten (Groq) und gesprochener Stimme — kein "Agent" mit Gedächtnis oder Werkzeugen.
- Der API-Key wird ausschließlich im Cloudflare Worker gespeichert (serverseitig, verschlüsselt) — niemals im öffentlichen Website-Code.
- Groq hat ein kostenloses Kontingent, das für normale PA-Nutzung ausreicht. Cloudflare Worker und GitHub Pages sind in diesem Umfang ebenfalls kostenlos.
- Der Zugangscode (`ACCESS_CODE`) verhindert, dass Fremde über den öffentlichen GitHub-Pages-Link mitchatten — er ist optional, aber empfohlen, da die Seite sonst für jeden mit dem Link offen ist.
