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
| `stats.js` | statistiche per giorno e settimana, report; tenute nella collezione `daily` dell'archivio |
| `notify.js` | quando c'è qualcosa da notificare (un agente che aspetta, un avviso nuovo, il report del giorno), uguale per tutti i gusci; lo stream `/api/shell/events` |
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
| `feedbacklog.js` | il registro dei messaggi, nella collezione `feedback` dell'archivio, con l'esito aggiunto sul messaggio; la demo usa una versione in memoria con la stessa interfaccia |
| `store/` | l'archivio di documenti (vedi *Storico* più sotto): `index.js` (`openStore`, `openStoreSafe`, le classi `Store` e `Collection`), `common.js` (linguaggio dei filtri, ULID), `memory.js` e `sqlite.js` (i due backend), `migrations.js`, `privacy.js` (campi dichiarati, `relPath`, `scrub`), `collections.js` (le otto collezioni), `project-key.js`, `legacy.js` (import dei file della 2.12), `sqlite-load.js` |
| `history.js` | il lato del motore: apre l'archivio, importa una volta i file della 2.12, la coda di scrittura di passi e riassunti delle sessioni, conservazione, limite di dimensione, dimentica, compatta, esporta |
| `retention.js`, `history-query.js`, `search.js`, `experiments.js` | conservazione e limite di dimensione; metriche per giorno o settimana e la loro tendenza; ricerca nei passi salvati; gruppi dell'esperimento e le loro statistiche |
| `demo-history.js` | tre mesi di storico finto per la demo, in un archivio in memoria tutto suo |
| `weather.js`, `releases.js`, `describe.js`, `demo.js`, `demoworld.js` | meteo, rilasci git/gh, descrizioni degli strumenti, demo |
| `../i18n` | traduzioni (chiave = testo italiano, `locales/<lingua>/*.json`) |

Tutto ciò che dipende dal sistema operativo sta in tre punti: `osint.js`, `sources.js` (percorsi di Cowork e WSL) e `hooks.js` (`curl` / `curl.exe`).

### API (tutte su `http://127.0.0.1:<porta>`)

| Metodo e percorso | Cosa fa |
|---|---|
| `GET /events` | stream SSE dello stato (e dei fotogrammi del replay) |
| `GET /api/shell/events` | stream SSE per un guscio che fa girare il motore in un processo a parte: solo `counts` (sessioni, agenti, al lavoro, in attesa) e `notify` (`{kind, title, body, sid, key}`); non conta come una finestra dell'ufficio aperta |
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
| `GET /api/feedback/experiment` | i modi delle funzioni di feedback e i risultati dell'esperimento per gruppo, per un progetto (`sid`, `cwd` o `key`) e per tutti |
| `GET /api/history` | metriche per giorno o settimana (`metric`, `from`, `to`, `bucket`, progetto per `sid`, `cwd` o `key`), ognuna con la sua tendenza; `metric=all` per tutte |
| `GET /api/history/search` | i passi salvati per `file`, `command` o `error` (e `outcome`, `from`, `to`, `limit`), con un tempo massimo di 150 ms |
| `GET`/`POST /api/store` | lo stato dell'archivio (backend, dimensione, conservazione, avviso); `compact`, `export`, `forget` (solo con `confirm: true`), conservazione e limite di dimensione |

Il server rifiuta le richieste con un `Host` o un `Origin` diversi da `127.0.0.1`/`localhost` (protezione dal DNS rebinding e dai siti web).

### Feedback agli agenti

`POST /platypus-hook/feedback` risponde entro 300 ms, usando solo quello che è già in memoria (lo stato, i libri, il registro). Una risposta più lenta, o qualunque errore, diventa un `204` vuoto e Claude Code prosegue come se Platypus non ci fosse. Le risposte usano solo questi formati degli hook:

| Evento | Risposta |
|---|---|
| `SessionStart`, `PostToolUse`, `PostToolUseFailure` | `{"hookSpecificOutput": {"hookEventName": …, "additionalContext": "Platypus: …"}}` |
| `Stop`, `SubagentStop` | `{"decision": "block", "reason": "Platypus: …"}`, mai quando `stop_hook_active` è vero; nella 2.11 l'unica funzione che lo userebbe (le affermazioni) si ferma all'ombra, quindi non parte mai |

Mai `permissionDecision`, `updatedInput` o `updatedToolOutput`: Platypus aggiunge contesto, non decide al posto tuo. Ogni funzione è `off`, `shadow` oppure `on` (`fbSessionLessons`, `fbElder`, `fbLoop`, `fbStale`, `fbClaims`, `fbDrift` nelle opzioni; le ultime tre nella 2.11 arrivano al massimo a `shadow`). Limiti: un messaggio ogni 2 minuti per agente, 6 all'ora per sessione, la stessa lezione una volta sola per agente; i messaggi in ombra contano come quelli mandati. La demo chiama la stessa funzione senza passare dalla rete, con i suoi modi e un registro in memoria.

### Significato (embedding)

La bolla e la stella polare misurano di che cosa parla un agente con dei vettori. La fonte lessicale (TF-IDF, sempre presente) confronta le parole; una fonte neurale capisce anche i sinonimi ("login" e "autenticazione"). L'opzione `embedEngine` sceglie: `auto` (quella di base: Ollama se risponde, poi ONNX se installato, altrimenti TF-IDF; solo fonti calibrate, vedi sotto), `tfidf` (solo lessicale), `ollama` o `onnx` (quella, oppure il TF-IDF dicendo perché). Con `auto` e senza Ollama, il motore riprova al massimo una volta al minuto, e solo mentre una bolla o la regola della deriva chiedono vettori.

- **Fonti.** Ollama si chiama con `http` di Node, solo su `127.0.0.1`, `::1` o `localhost` (`ollamaUrl`); il modello è `embedModel` o il primo modello di embedding presente, prima quelli misurati meglio (in testa `qwen3-embedding:0.6b`); Platypus non lancia mai `ollama pull`, mostra il comando. Il provider ONNX sta in `optional/embed-onnx/` con il suo `package.json` e fa girare `onnx-community/Qwen3-Embedding-0.6B-ONNX` (q8, pooling sull'ultimo token) in un `worker_thread`; il motore lo carica con `require` solo se `npm run embed:onnx:install` l'ha installato (quel comando chiede prima conferma ed è l'unico che scarica un modello).
- **Mai bloccare.** Una coda per tutto il motore, lotti di al massimo 16 testi, 5 s per richiesta (fino a 60 s mentre si carica un modello non ancora in memoria; poi si chiede a Ollama di tenerlo caricato per 10 minuti), prima gli agenti che si stanno guardando; 3 fallimenti di fila sospendono una fonte per 5 minuti. Un vettore che non c'è ancora semplicemente manca: si vede subito il quadro del TF-IDF ("affino…"), sostituito quando sono arrivati i vettori neurali di ogni compito e di ogni azione. Vettori di fonti diverse non si mescolano mai in un calcolo.
- **Testo e cache.** I pezzi del contesto di un agente tengono un breve estratto del loro testo in memoria (al massimo 320 caratteri, 480 per un'azione con il suo risultato), mai su disco. La cache tiene solo vettori e hash sha1: 5000 vettori in memoria e `embed-cache/<fonte>.bin` su disco, al massimo 50 MB per fonte.
- **Soglie per fonte.** I vettori neurali hanno somiglianze di fondo molto più alte del TF-IDF, per questo la regola della deriva ha una riga per fonte in `drift-rule.js` (fondo, allargamento, `rel`, `run`, `weak`), misurata con `scripts/embed-eval.js` su un insieme etichettato (risultati in `docs/plans/embedding-calibration.md`). Una fonte neurale senza riga è "non calibrata": `auto` la salta; scelta a mano, se ne vede la geometria, ma la regola della deriva dice "non misurabile". Misurati finora: sei modelli di Ollama e Qwen3-Embedding in ONNX hanno la loro riga; `nomic-embed-text:v1.5` e il vecchio modello ONNX `multilingual-e5-small` (sostituito nella 2.12.1) non battono il TF-IDF.

## Storico (`src/core/store`, `src/core/history.js`)

Dalla 2.13 il motore tiene i suoi dati in un archivio di documenti con un'interfaccia sola e due backend: `sqlite` (il `node:sqlite` già dentro Node, file `platypus.db` nella cartella dei dati; per questo serve Node.js 22.13) e `memory` (le prove, la demo, e il ripiego quando il database non si può usare). Un backend MongoDB per il server della 3.0 si aggiunge con `registerBackend` senza che il motore dipenda da lui; `scripts/store-conformance.js` è la suite che ogni backend deve passare.

- **L'interfaccia.** `store.collection(nome)` con `get`, `put`, `patch`, `delete`, `find(filtro, {sort, limit, skip, fields})`, `count`, `deleteMany`, `append`; `store.transaction`, `declare`, `forgetProject`, `export`/`import`, `getMeta`/`setMeta`, `info`, `flush`, `close`. I filtri sono un sottoinsieme stretto di quelli di MongoDB (uguaglianza, `$in`, `$gt`/`$gte`/`$lt`/`$lte`, `$exists`, `$or`, percorsi con il punto): tutto il resto è un errore, mai ignorato. `_id` è una stringa (un ULID se non è dato), i tempi sono millisecondi. Su questo computer le chiamate sono sincrone.
- **SQLite.** Una tabella per collezione (`_id`, `project`, `t`, `doc` in JSON), indici dichiarati per collezione, filtri tradotti in SQL solo con parametri; `busy_timeout` 3 s, WAL, `synchronous=NORMAL`. Le aggiunte aspettano in una coda e vanno sul disco in una transazione ogni 2 s o a 500 documenti; ogni lettura la svuota prima. Una tabella `meta` tiene la versione dello schema: le migrazioni girano in una transazione `BEGIN IMMEDIATE` dopo una copia `VACUUM INTO platypus.db.bak-<versione>` (si tengono le ultime due). All'avvio `quick_check` gira subito su un database fino a 64 MB, altrimenti in un worker. Un database rovinato, più nuovo o non scrivibile fa ripiegare `openStoreSafe` su `memory`, mette da parte il file come `platypus.db.broken-<data>` se è rovinato, e l'ufficio mostra "storico non disponibile: <motivo>".
- **Collezioni** (`collections.js`), ognuna con i suoi campi dichiarati, gli indici e la conservazione di base: `projects` (chiave, alias, remote senza credenziali, nome della cartella; per sempre), `lessons` (il Libro; peso basso e più vecchie di 180 giorni), `steps` (uno per azione finita; 90 giorni), `sessions` (un riassunto per sessione; 365 giorni), `feedback` (messaggi agli agenti e loro esiti; 365 giorni), `experiments` (il gruppo di una sessione per una funzione; 365 giorni), `daily` (statistiche per giorno e settimana; per sempre). La conservazione gira all'avvio e ogni 6 ore a piccoli gruppi; oltre il limite di dimensione (200 MB di base) se ne vanno per primi i passi più vecchi.
- **Chiave del progetto** (`project-key.js`): i primi 16 caratteri esadecimali dello sha1 del remote `origin` normalizzato (host in minuscolo, niente credenziali, niente porta, niente `.git`, ssh e https uguali); senza remote, la chiave della cartella, come nel Libro della 2.12. Le vecchie chiavi restano come alias. `git` si legge una volta per cartella, mai nel percorso degli eventi.
- **Privacy per costruzione** (`privacy.js`): una collezione accetta solo i campi dichiarati, ognuno con un tipo; una stringa libera è una riga di al massimo 300 caratteri, così una richiesta, una risposta o un'uscita non ci stanno. I percorsi sono relativi al progetto; fuori diventano `ext:<hash>/<nome del file>`. Gli estratti (firme degli errori, righe di prova, titoli dei commit, i messaggi agli agenti) passano da `scrub` (token, chiavi, password, stringhe di connessione, indirizzi e-mail, IBAN). Di un comando restano solo le prime parole semplici (`cmdShape`: `mysql -u root -p…` → `mysql`). I campi non dichiarati si scartano e si segnalano una volta per nome, oppure si rifiutano con `PLATYPUS_STORE_GUARD=reject` (le prove).
- **Il lato del motore** (`history.js`): `state.js` emette `step` quando un'azione finisce; passi e riassunti delle sessioni passano dalla coda di scrittura, che tiene il gruppo quando il database è occupato. Il Libro, le statistiche e il registro del feedback leggono e scrivono attraverso l'archivio. Il primo avvio importa una volta i file della 2.12 (`legacy.js`), lasciandoli dove sono e copiandoli in `legacy-<data>/`. Dimenticare un progetto toglie la sua chiave e i suoi alias da ogni collezione, il suo nome dalle statistiche, le copie di sicurezza e i suoi file della 2.12, poi fa `VACUUM`. Esporta scrive un file JSONL per collezione. La demo non scrive mai nell'archivio: ha un suo archivio in memoria (`demo-history.js`).
- **Leggerlo** (`history-query.js`, `search.js`, `experiments.js`): metriche per giorno o settimana da `sessions`, `steps` e `feedback`, la tendenza delle ultime 4 settimane contro le 4 prima (almeno 5 sessioni per parte, altrimenti "dati insufficienti"); la ricerca in `steps`; e il modo esperimento del feedback, dove ogni sessione va in `on` o in `shadow` dallo sha1 del suo id e della funzione, con un intervallo al 95% di Newcombe per le quote e di Welch per gli errori ogni 100 azioni. Niente di questo gira nel percorso dell'SSE.

## Interfaccia (`renderer/`)

Pagina statica: `index.html`, `style.css`, `game.js` (palazzo, piani, fumetti), `worldmap.js` (mappa della realtà), `bottega.js` (Libro della bottega, con le schede STORIA e FEEDBACK), `store-ui.js` (le opzioni ARCHIVIO), `teams.js` (pannello SQUADRE: workflow, squadre, messaggi), `embed-ui.js` (le opzioni del "motore del significato"), `report.html`, `i18n-runtime.js`, più `/drift-rule.js` servito dal motore. Parla con il motore solo via HTTP e SSE. L'unico punto di contatto con il guscio è l'oggetto facoltativo `window.officeApp` (se manca, si è nel browser).

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
- notifiche (permessi, avvisi, report): quando lo decide il motore (`core.notify`, da `notify.js`), se mostrarle lo decide il guscio (la sua opzione "notifiche", la finestra già in primo piano);
- modalità mini;
- avvio all'accesso (`src/autostart.js`);
- su Windows, voce nel menu Start con l'AppUserModelID per le notifiche;
- su macOS, menu dell'app e icona nel Dock;
- su Linux, app_id/`desktopName` `platypus` (combacia con `platypus.desktop`) e Wayland: in nativo non esistono primo piano e posizione della finestra, quindi `getPin()` restituisce `false` e `PIN` propone di riavviare con `--ozone-platform=x11` (XWayland). La scelta è `x11` nel `config.json` dell'app, letto anche da `scripts/launch.js`.

## Guscio Tauri (sperimentale)

Il guscio predefinito resta Electron. Accanto si sta costruendo un secondo guscio in Tauri 2, in `shells/tauri/`, per misurare dimensioni, memoria e tempo di avvio e poi decidere con i numeri. Il piano, con il suo diario, è [`plans/tauri-shell.md`](plans/tauri-shell.md) (in inglese); questa sezione descrive il progetto deciso lì e si aggiorna man mano che i compiti si chiudono.

**Com'è fatto**

- **Una cartella tutta sua:** `shells/tauri/` ha il suo `package.json` (solo `@tauri-apps/cli`) e il suo `Cargo.toml`. Il `package.json` principale non riceve dipendenze nuove: chi usa Electron non scarica niente di nuovo.
- **Il motore resta Node:** il guscio cerca `node` nel `PATH` e avvia `node src/standalone.js --no-open` come processo figlio sulla porta scelta (`PLATYPUS_PORT`, oppure 47800). Se su quella porta risponde già un Platypus (`GET /api/state`), si collega a quello. All'uscita chiude il motore solo se l'ha avviato lui.
- **La finestra** è una webview di Tauri su `http://127.0.0.1:<porta>/`, senza cornice (la barra dei titoli la disegna la pagina), come quella di Electron. La navigazione resta sulle pagine del motore; i link esterni `http`/`https` si aprono nel browser.
- **`window.officeApp`** ha le stesse funzioni di Electron (tabella sopra). Uno script di inizializzazione, costruito con la porta vera, la definisce sopra `invoke` di Tauri, e solo sull'origine del motore. A quella pagina sono permessi solo i comandi del guscio (un permesso per comando, niente `core:default`, nessun permesso dei plugin); l'API completa `window.__TAURI__` non è esposta. Nessun comando accetta un percorso, un URL o una riga di comando. I messaggi dal guscio alla pagina (`onMaximized`, `onGoto`) sono semplici chiamate nella pagina.
- **Notifiche e contatori** arrivano dallo stream `/api/shell/events` del motore (`notify.js`), quindi i due gusci notificano le stesse cose. Il menu dell'icona ha le stesse voci di Electron; le sue azioni passano dalle API del motore (demo, Cowork, opzioni), e "collega a Claude Code" esegue `node src/hooks-cli.js` dopo una conferma.
- **Plugin:** `single-instance`, `autostart` (con lo stesso nome della voce di Electron, così i due non sono mai attivi insieme), `notification` (macOS e Linux), `opener`, `dialog`. Si chiamano solo da Rust, mai dalla pagina. La posizione della finestra si ricorda con la stessa regola di Electron (`src/bounds.js`); chiudere la finestra chiude l'app, come in Electron.
- **Per avviarlo:** una volta `npm run tauri:build`, poi `node scripts/launch.js --shell tauri` (senza compilazione il lanciatore spiega come farla e apre Electron). `npm run tauri:dev` lo fa partire dai sorgenti con la demo.

**Limiti** (dalla documentazione di Tauri 2; da confermare con le misure e le prove):

- Compilare dai sorgenti richiede Rust 1.90+ e le librerie di sistema: su Windows i Microsoft C++ Build Tools (WebView2 c'è già in Windows 10 1803+ e 11), su Linux `webkit2gtk-4.1` e `libayatana-appindicator`, su macOS gli Xcode Command Line Tools. Node.js serve comunque per il motore.
- Su Windows il guscio mostra le sue notifiche con l'ID `com.platypus.desktop`, registrato per l'utente, così dicono "Platypus" e un clic apre il piano, anche dai sorgenti. Su macOS e Linux il plugin delle notifiche non segnala il clic: il piano dell'ultima notifica si mostra la volta dopo che si apre la finestra.
- Su Linux l'icona nella barra non ha l'evento del clic né il suggerimento: tutto sta nel suo menu.
- Su Wayland WebKitGTK ha gli stessi limiti di Electron (niente primo piano, niente posizione della finestra).

**Misure** ([`plans/tauri-measurements.md`](plans/tauri-measurements.md), in inglese, con il metodo per ripeterle): su Windows il guscio Tauri occupa circa 5 MB sul disco invece di circa 370, mentre la memoria (circa 600 MB con la demo, quasi tutta del Chromium che disegna l'ufficio in tutti e due) e il tempo di avvio (circa 1 s) sono gli stessi. Linux è ancora da misurare.

## Dati sul disco

| Percorso | Contenuto |
|---|---|
| `~/.claude/` | di Claude Code: letto, mai modificato, tranne gli hook in `settings.json` se li installi |
| `~/.platypus/settings.json` | opzioni dell'ufficio |
| `~/.platypus/platypus.db` | lo storico (dalla 2.13): Libro della bottega, statistiche, messaggi agli agenti, passi, riassunti delle sessioni, gruppi dell'esperimento, e piccoli segni come il giorno dell'ultima notifica del report; con `platypus.db-wal` e `platypus.db-shm` mentre è aperto |
| `~/.platypus/platypus.db.bak-<versione>`, `platypus.db.broken-<data>` | la copia fatta prima di una migrazione dello schema (le ultime due); un database rovinato messo da parte |
| `~/.platypus/legacy-<data>/` | una copia dei file della 2.12 fatta dal primo import |
| `~/.platypus/stats.json`, `bottega/`, `feedback/`, `notify.json` | i file della 2.12: letti una volta dal primo avvio della 2.13, poi lasciati come sono (per tornare alla 2.12) |
| `~/.platypus/launch.log` | messaggi dell'ultimo avvio della finestra |
| `~/.platypus/embed-cache/<fonte>.bin` | i vettori delle fonti neurali del significato, con lo sha1 del loro testo (mai il testo), al massimo 50 MB per fonte |
| `~/.platypus/models/` | il modello ONNX facoltativo, solo dopo `npm run embed:onnx:install` |
| `$PLATYPUS_DATA_DIR` | se è impostata, si usa al posto di `~/.platypus` (creata vuota, senza copiare la vecchia cartella di Agent Office), e i dati di Electron vanno nella sua sottocartella `electron/`: per le prove e per i loop di sviluppo che girano accanto al tuo Platypus |
| cartella dati di Electron (`Platypus`) | posizione della finestra e preferenze del guscio |
