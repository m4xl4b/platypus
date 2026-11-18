# Architettura

*English version: [ARCHITECTURE.md](ARCHITECTURE.md).*

Platypus è diviso in tre strati indipendenti. È quello che permette di farlo girare uguale su Windows, macOS e Linux, e un domani di cambiare il guscio (per esempio con Tauri) senza rifare né il motore né la grafica.

```
┌────────────────────────────────────────────────────────────┐
│ Guscio desktop        src/main.js + src/preload.js         │  Electron: finestra, icona nella barra,
│ (sostituibile)        src/autostart.js                     │  notifiche, avvio all'accesso
├────────────────────────────────────────────────────────────┤
│ Interfaccia           renderer/  (HTML, CSS, JS, canvas)    │  la stessa pagina nella finestra
│                                                            │  e nel browser
├────────────────────────────────────────────────────────────┤
│ Motore                src/core/  (Node.js, nessuna         │  legge i dati di Claude Code, tiene lo
│                       dipendenza esterna)                  │  stato, serve pagina e API su HTTP
└────────────────────────────────────────────────────────────┘
        ▲ transcript e registro (~/.claude)      ▲ hook (curl → 127.0.0.1:47800)
                                                 ▲▼ hook di feedback (http → /platypus-hook/feedback, facoltativi)
```

## Motore (`src/core`)

Solo moduli di Node.js, nessun pacchetto npm: per questo la modalità browser parte senza `npm install`.

| File | Ruolo |
|---|---|
| `index.js` | avvio, server HTTP solo su 127.0.0.1, SSE, API, permessi in sospeso |
| `sources.js` | lettura dei transcript (`projects/**/*.jsonl`, compresi gli agenti dei Workflow in `<sessione>/subagents/workflows/<runId>/` con il loro `journal.jsonl`, e i riepiloghi in `<sessione>/workflows/<runId>.json`) e del registro delle sessioni, ricerca delle cartelle Cowork |
| `state.js` | stato di sessioni, agenti e sottoagenti, costi, avvisi, lavagne, rilasci, esecuzioni dei Workflow (fasi, costo e tempi per agente) e messaggi tra agenti |
| `hooks.js` | installazione e rimozione degli hook in `settings.json`; quelli di feedback a parte, con un loro marcatore |
| `archive.js` | archivio e replay con orologio virtuale |
| `osint.js` | integrazione con il sistema: finestra in primo piano, riprendi sessione, apri cartella (Windows / macOS / Linux) |
| `stats.js` | statistiche per giorno e settimana, report |
| `worldmap.js` | mappa della realtà: territorio, frontiera, traiettoria a 7 dimensioni |
| `semantic.js` | bolla del contesto e stella polare (TF-IDF, PCA, gruppi, allineamento), con vettori di qualsiasi lunghezza e di qualsiasi fonte ("spazi di significato") |
| `drift-rule.js` | la regola della deriva della stella polare e le sue soglie per fonte, scritte una volta sola: le usano il motore, il feedback "ritorno al compito" e, come `/drift-rule.js`, la mappa |
| `embed/` | significato neurale (facoltativo): `index.js` (catena dei provider, cache, coda), `ollama.js` (Ollama in locale, solo loopback), `onnx.js` (carica il modulo ONNX facoltativo), `fake.js` (provider dei sinonimi, solo per la demo) |
| `grounding.js` | mappa contro territorio: ricordi scaduti (mtime sul disco con una cache di 10 s, e modifiche degli altri agenti), modifiche alla cieca, percorsi inventati, affermazioni nelle risposte e le loro prove |
| `surprise.js` | classificazione dei fallimenti (Jest, pytest, go, cargo, npm, tsc, Node, Python, PowerShell…), estratti degli errori e file citati, sorpresa, reazioni (si corregge/insiste/si ferma) e catene causali |
| `bottega.js` | Libro della bottega: lezioni per progetto dedotte dai fatti qui sopra, peso che si dimezza in 30 giorni, apprendimento dal vivo e dall'archivio, suggerimenti del Nonno, sezione per il `CLAUDE.md` |
| `claudemd.js` | scrittura prudente della sezione nel `CLAUDE.md` di un progetto: tra i marcatori, copia di sicurezza prima, il resto byte per byte, scrittura atomica |
| `feedback.js` | feedback agli agenti: dall'input di un hook alla risposta per Claude Code, come funzioni pure; i tre modi di ogni funzione, i limiti di frequenza (`Gate`), i progetti zittiti |
| `feedback-rules.js` | che cosa dice Platypus: una regola per funzione (lezioni a inizio sessione, Nonno, giro in tondo, modifica sopra il cambiamento di un altro agente, affermazioni senza prove, ritorno al compito), ogni testo costruito in inglese per l'agente e nella lingua dell'ufficio per il registro |
| `outcomes.js` | che cosa ha fatto un agente dopo un messaggio: probabilmente utile, ignorato o non si può dire, dai suoi passi successivi |
| `feedbacklog.js` | il registro dei messaggi, un file per progetto, solo aggiunte in coda; la demo usa una versione in memoria con la stessa interfaccia |
| `weather.js`, `releases.js`, `describe.js`, `demo.js`, `demoworld.js` | meteo, rilasci git/gh, descrizioni degli strumenti, demo |
| `../i18n` | traduzioni (chiave = testo italiano, `locales/<lingua>/*.json`) |

Tutto ciò che dipende dal sistema operativo sta in tre punti: `osint.js`, `sources.js` (percorsi di Cowork e WSL) e `hooks.js` (`curl` / `curl.exe`).

### API (tutte su `http://127.0.0.1:<porta>`)

| Metodo e percorso | Cosa fa |
|---|---|
| `GET /events` | stream SSE dello stato (e dei fotogrammi del replay) |
| `GET /api/state`, `/api/settings` | stato e opzioni |
| `POST /api/settings` | salva le opzioni |
| `POST /platypus-hook` | eventi degli hook (asincroni) |
| `POST /platypus-hook/permission` | hook sincrono dei permessi: resta in attesa della risposta dall'ufficio |
| `POST /api/approve` | risposta a un permesso: `allow`, `always`, `deny` |
| `GET /api/agentmap`, `/api/agentmind` | mappa della realtà, bolla e stella polare (`/api/agentmind` dice anche la fonte dei vettori `src`, le sue soglie `th`, `pending`, `refining` e `fallback`) |
| `GET /api/embed`, `POST /api/embed` | il motore del significato: fonte in uso, stato di ogni fonte, cache; `{action: 'probe'}` controlla le fonti, `{action: 'clear'}` svuota la cache |
| `GET /drift-rule.js` | la regola della deriva per la pagina (lo stesso file del motore) |
| `GET /api/archive`, `POST /api/replay` | archivio e replay |
| `POST /api/focus`, `/api/resume`, `/api/open-folder` | finestra, ripresa, cartella |
| `GET /api/stats/costs`, `/api/stats/honors`, `/api/report` | statistiche e report |
| `POST /api/demo`, `/api/cowork`, `/api/cowork-scan` | demo, ala Cowork, ricerca Cowork |
| `GET /i18n.js` | traduzioni per la pagina |
| `GET /api/grounding` | mappa contro territorio e sorprese di un agente o della sessione (`sid`, `aid`, `replay`) |
| `GET /api/bottega`, `/api/bottega/list`, `/api/bottega/hints` | il libro di un progetto (`sid`, `cwd` o `key`), i progetti con un libro, cosa direbbe adesso il Nonno |
| `POST /api/bottega`, `/api/bottega/learn` | fissa/ignora/ripristina/dimentica una lezione; impara dall'archivio del progetto in background |
| `GET`/`POST /api/bottega/claudemd` | anteprima della sezione per il `CLAUDE.md`; scriverla (solo con `confirm: true`) |
| `POST /platypus-hook/feedback` | hook di feedback sincrono: la risposta per Claude Code, oppure un `204` vuoto |
| `GET`/`POST /api/feedback/hooks` | se gli hook di feedback sono installati e le righe esatte; installarli o toglierli (solo con `confirm: true`) |
| `GET /api/feedback/log`, `/api/feedback/counts` | i messaggi agli agenti di un progetto con i loro esiti (`sid`, `cwd` o `key`); quanti per funzione negli ultimi 7 giorni |

Il server rifiuta le richieste con un `Host` o un `Origin` diversi da `127.0.0.1`/`localhost` (protezione dal DNS rebinding e dai siti web).

### Feedback agli agenti

`POST /platypus-hook/feedback` risponde entro 300 ms, usando solo quello che è già in memoria (lo stato, i libri, il registro). Una risposta più lenta, o qualunque errore, diventa un `204` vuoto e Claude Code prosegue come se Platypus non ci fosse. Le risposte usano solo questi formati degli hook:

| Evento | Risposta |
|---|---|
| `SessionStart`, `PostToolUse`, `PostToolUseFailure` | `{"hookSpecificOutput": {"hookEventName": …, "additionalContext": "Platypus: …"}}` |
| `Stop`, `SubagentStop` | `{"decision": "block", "reason": "Platypus: …"}`, mai quando `stop_hook_active` è vero; nella 2.11 l'unica funzione che lo userebbe (le affermazioni) si ferma all'ombra, quindi non parte mai |

Mai `permissionDecision`, `updatedInput` o `updatedToolOutput`: Platypus aggiunge contesto, non decide al posto tuo. Ogni funzione è `off`, `shadow` oppure `on` (`fbSessionLessons`, `fbElder`, `fbLoop`, `fbStale`, `fbClaims`, `fbDrift` nelle opzioni; le ultime tre nella 2.11 arrivano al massimo a `shadow`). Limiti: un messaggio ogni 2 minuti per agente, 6 all'ora per sessione, la stessa lezione una volta sola per agente; i messaggi in ombra contano come quelli mandati. La demo chiama la stessa funzione senza passare dalla rete, con i suoi modi e un registro in memoria.

### Significato (embedding)

La bolla e la stella polare misurano di che cosa parla un agente con dei vettori. La fonte lessicale (TF-IDF, sempre presente) confronta le parole; una fonte neurale capisce anche i sinonimi ("login" e "autenticazione"). L'opzione `embedEngine` sceglie: `auto` (quella di base: Ollama se risponde, poi ONNX se installato, altrimenti TF-IDF), `tfidf` (solo lessicale), `ollama` o `onnx` (quella, oppure il TF-IDF dicendo perché). Con `auto` e senza Ollama, il motore riprova al massimo una volta al minuto, e solo mentre una bolla o la regola della deriva chiedono vettori.

- **Fonti.** Ollama si chiama con `http` di Node, solo su `127.0.0.1`, `::1` o `localhost` (`ollamaUrl`); il modello è `embedModel` o il primo modello di embedding presente, prima quelli misurati meglio (in testa `qwen3-embedding:0.6b`); Platypus non lancia mai `ollama pull`, mostra il comando. Il provider ONNX sta in `optional/embed-onnx/` con il suo `package.json` e fa girare `Xenova/multilingual-e5-small` in un `worker_thread`; il motore lo carica con `require` solo se `npm run embed:onnx:install` l'ha installato (quel comando chiede prima conferma ed è l'unico che scarica un modello).
- **Mai bloccare.** Una coda per tutto il motore, lotti di al massimo 16 testi, 5 s per richiesta (fino a 60 s mentre si carica un modello non ancora in memoria; poi si chiede a Ollama di tenerlo caricato per 10 minuti), prima gli agenti che si stanno guardando; 3 fallimenti di fila sospendono una fonte per 5 minuti. Un vettore che non c'è ancora semplicemente manca: si vede subito il quadro del TF-IDF ("affino…"), sostituito quando sono arrivati i vettori neurali di ogni compito e di ogni azione. Vettori di fonti diverse non si mescolano mai in un calcolo.
- **Testo e cache.** I pezzi del contesto di un agente tengono un breve estratto del loro testo in memoria (al massimo 320 caratteri, 480 per un'azione con il suo risultato), mai su disco. La cache tiene solo vettori e hash sha1: 5000 vettori in memoria e `embed-cache/<fonte>.bin` su disco, al massimo 50 MB per fonte.
- **Soglie per fonte.** I vettori neurali hanno somiglianze di fondo molto più alte del TF-IDF, per questo la regola della deriva ha una riga per fonte in `drift-rule.js` (fondo, allargamento, `rel`, `run`, `weak`), misurata con `scripts/embed-eval.js` su un insieme etichettato (risultati in `docs/plans/embedding-calibration.md`). Una fonte neurale senza riga è "non calibrata": se ne vede la geometria, ma la regola della deriva dice "non misurabile".

## Interfaccia (`renderer/`)

Pagina statica: `index.html`, `style.css`, `game.js` (palazzo, piani, fumetti), `worldmap.js` (mappa della realtà), `bottega.js` (Libro della bottega), `teams.js` (pannello SQUADRE: workflow, squadre, messaggi), `embed-ui.js` (le opzioni del "motore del significato"), `report.html`, `i18n-runtime.js`, più `/drift-rule.js` servito dal motore. Parla con il motore solo via HTTP e SSE. L'unico punto di contatto con il guscio è l'oggetto facoltativo `window.officeApp` (se manca, si è nel browser).

### Contratto `window.officeApp` (da `src/preload.js`)

| Funzione | Uso |
|---|---|
| `minimize()`, `close()` | pulsanti della barra del titolo |
| `toggleMaximize()`, `isMaximized()`, `onMaximized(cb)` | tutto schermo: il pulsante segue anche gli ingrandimenti fatti fuori dalla pagina |
| `togglePin()`, `getPin()` | sempre in primo piano |
| `setCounts({sessions, agents, busy, waiting})` | aggiorna l'icona nella barra e fa lampeggiare la finestra |
| `setWidget(on)` | modalità mini (finestra piccola sempre in primo piano) |
| `onGoto(cb)` | clic su una notifica → vai al piano della sessione |

## Guscio desktop (`src/main.js`)

Avvia il motore nello stesso processo, apre una finestra senza cornice su `http://127.0.0.1:<porta>/`, gestisce:
- icona e menu nella barra di sistema;
- notifiche (permessi, avvisi, report);
- modalità mini;
- avvio all'accesso (`src/autostart.js`);
- su Windows, voce nel menu Start con l'AppUserModelID per le notifiche;
- su macOS, menu dell'app e icona nel Dock;
- su Linux, app_id/`desktopName` `platypus` (combacia con `platypus.desktop`) e Wayland: in nativo non esistono primo piano e posizione della finestra, quindi `getPin()` restituisce `false` e `PIN` propone di riavviare con `--ozone-platform=x11` (XWayland). La scelta è `x11` nel `config.json` dell'app, letto anche da `scripts/launch.js`.

## Passare a Tauri (o a un altro guscio)

Il motore e l'interfaccia non cambiano. Un guscio Tauri dovrebbe:

1. **avviare il motore**, in due modi possibili:
   - come processo esterno con Node.js (`node src/standalone.js --no-open`), oppure compilato in un eseguibile unico (`node --experimental-sea-config`, Bun o Deno);
   - in alternativa portarlo in Rust un modulo alla volta, mantenendo le stesse API HTTP;
2. **aprire una webview** su `http://127.0.0.1:<porta>/`;
3. **offrire `window.officeApp`** con le stesse funzioni della tabella sopra, implementate come comandi Tauri (`invoke`);
4. **rifare in Rust le parti del guscio**: icona nella barra (`tray`), notifiche (`tauri-plugin-notification`), avvio all'accesso (`tauri-plugin-autostart`), finestra in primo piano e modalità mini.

Il vantaggio sarebbero programmi compilati molto più piccoli (circa 10 MB invece di 150) e meno memoria. Il costo: chi parte dai sorgenti deve installare Rust e le librerie di sistema per compilare. Per questo, finché la distribuzione è "clona e lancia", il guscio resta Electron.

## Dati sul disco

| Percorso | Contenuto |
|---|---|
| `~/.claude/` | di Claude Code: letto, mai modificato, tranne gli hook in `settings.json` se li installi |
| `~/.platypus/settings.json` | opzioni dell'ufficio |
| `~/.platypus/stats.json` | statistiche per giorno e settimana |
| `~/.platypus/bottega/<chiave>.json` | il Libro della bottega di ogni progetto (un file per cartella di progetto) |
| `~/.platypus/feedback/<chiave>.jsonl` | i messaggi agli agenti di ogni progetto, mandati e in ombra, con i loro esiti (oltre 5 MB passa a `<chiave>.1.jsonl`) |
| `~/.platypus/launch.log` | messaggi dell'ultimo avvio della finestra |
| `~/.platypus/embed-cache/<fonte>.bin` | i vettori delle fonti neurali del significato, con lo sha1 del loro testo (mai il testo), al massimo 50 MB per fonte |
| `~/.platypus/models/` | il modello ONNX facoltativo, solo dopo `npm run embed:onnx:install` |
| `$PLATYPUS_DATA_DIR` | se è impostata, si usa al posto di `~/.platypus` (creata vuota, senza copiare la vecchia cartella di Agent Office), e i dati di Electron vanno nella sua sottocartella `electron/`: per le prove e per i loop di sviluppo che girano accanto al tuo Platypus |
| cartella dati di Electron (`Platypus`) | posizione della finestra e preferenze del guscio |
