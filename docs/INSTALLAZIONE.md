# Installazione di Platypus

Platypus si usa direttamente dai sorgenti: si clona il repository e si lancia. Non ci sono installer né programmi già compilati da firmare: la finestra desktop è [Electron](https://www.electronjs.org), che npm scarica già pronto per il tuo sistema al primo avvio.

*English version: [INSTALL.md](INSTALL.md).*

- [Requisiti](#requisiti)
- [Windows](#windows) · [macOS](#macos) · [Linux](#linux)
- [Primo avvio](#primo-avvio)
- [Collegare Claude Code](#collegare-claude-code)
- [Modalità browser](#modalità-browser)
- [Aggiornare e disinstallare](#aggiornare-e-disinstallare)
- [Casi particolari](#casi-particolari): WSL, più cartelle `.claude`, Cowork, proxy aziendale
- [Testato su](#testato-su)
- [Problemi frequenti](#problemi-frequenti)

## Requisiti

| | |
|---|---|
| **Node.js** | 22.13 o più recente (LTS consigliata). È la prima versione con il SQLite incorporato che il motore usa, quindi serve in ogni modalità: finestra, modalità browser e guscio Tauri. Con una più vecchia Platypus non parte e scrive il comando per aggiornare (`winget install OpenJS.NodeJS.LTS`, `brew install node` oppure `nvm install --lts`). |
| **Git** | per clonare e aggiornare. |
| **Claude Code** | quello che l'ufficio osserva: terminale, VS Code/JetBrains, app desktop. |
| **Spazio** | circa 300 MB nella cartella `node_modules` (Electron). |
| **Sistemi** | Windows 10/11 (x64, arm64), macOS 12 o più recente (Intel e Apple Silicon), Linux x64/arm64 con un desktop grafico. |

Per controllare cosa hai già: `node -v` e `git --version`.

## Windows

1. Installa Node.js e Git, dal sito oppure da PowerShell con winget:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   Chiudi e riapri il terminale, così i nuovi comandi entrano nel PATH.
2. Clona il repository (vedi [Repository privato](#repository-privato) se chiede le credenziali):
   ```powershell
   git clone https://github.com/m4xl4b/platypus.git $HOME\platypus
   cd $HOME\platypus
   ```
3. Avvia: doppio clic su **`start.cmd`** in Esplora file, oppure `npm start` dal terminale.
4. Facoltativo: `npm run shortcut` mette un'icona sul Desktop. La voce nel **menu Start** la crea l'app da sola al primo avvio; serve anche per le notifiche di Windows.

## macOS

1. Installa Node.js e Git. Con [Homebrew](https://brew.sh):
   ```sh
   brew install node git
   ```
   In alternativa scarica Node.js da nodejs.org; Git arriva anche con gli strumenti a riga di comando di Xcode (`xcode-select --install`).
2. Clona il repository:
   ```sh
   git clone https://github.com/m4xl4b/platypus.git ~/platypus
   cd ~/platypus
   ```
3. Avvia: doppio clic su **`start.command`** nel Finder, oppure `./start.sh` dal Terminale.
4. Facoltativo: `npm run shortcut` crea **Platypus.app** nella cartella Applicazioni del tuo utente (`~/Applications`), da aprire dal Finder o da trascinare nel Dock.

Note:
- La prima volta macOS potrebbe chiederti il permesso di mostrare le notifiche: concedilo per gli avvisi dei permessi.
- Dai sorgenti, nel Dock e nelle notifiche l'app può comparire come "Electron": è normale, è il programma che la esegue.
- Se il doppio clic su `start.command` dice che non può essere aperto, dai il permesso di esecuzione: `chmod +x start.command start.sh`.

## Linux

1. Installa Node.js 22.13+ e Git. Le versioni nei repository delle distribuzioni sono spesso vecchie: conviene [nvm](https://github.com/nvm-sh/nvm) oppure i pacchetti di [NodeSource](https://github.com/nodesource/distributions).
   ```sh
   # con nvm (qualsiasi distribuzione)
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   nvm install --lts
   # Git
   sudo apt install git        # Debian, Ubuntu
   sudo dnf install git        # Fedora
   sudo pacman -S git          # Arch
   ```
2. Clona e avvia:
   ```sh
   git clone https://github.com/m4xl4b/platypus.git ~/platypus
   cd ~/platypus
   ./start.sh
   ```
3. Facoltativo: `npm run shortcut` aggiunge **Platypus** al menu delle applicazioni.

Electron ha bisogno delle librerie grafiche che i desktop hanno quasi sempre già installate. Se manca qualcosa, su Debian/Ubuntu:
```sh
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1 libnotify4
```
(su versioni meno recenti `libasound2` al posto di `libasound2t64`).

### Wayland

In una sessione Wayland (GNOME, KDE Plasma, Hyprland, Sway…) la finestra gira come app **Wayland nativa**: nitida con qualsiasi scala e con l'icona giusta nella barra delle applicazioni. Wayland però non permette alle app di restare sopra le altre finestre né di scegliere la propria posizione:

| Funzione | Wayland nativo | Compatibilità XWayland |
|---|---|---|
| Sempre in primo piano (`PIN`, mini mode) | non disponibile | sì |
| Posizione ricordata, striscia mini nell'angolo | decide il compositor | sì |
| Dimensioni ricordate | sì | sì |
| "VAI ALLA FINESTRA" | KDE Plasma, Hyprland, Sway (GNOME no) | KDE Plasma, Hyprland, Sway (GNOME: finestre X11 con `xdotool`/`wmctrl`) |

Per riavere il primo piano premi `PIN` (Platypus propone di riavviarsi) oppure spunta *Compatibilità XWayland* nel menu dell'icona. La scelta viene ricordata; per forzarla a un singolo avvio: `PLATYPUS_X11=1 ./start.sh` (o `PLATYPUS_X11=0` per Wayland nativo).

## Primo avvio

Il lanciatore (`scripts/launch.js`, chiamato da `start.cmd`, `start.command` e `start.sh`):

1. controlla la versione di Node.js (22.13 o più recente; altrimenti si ferma e scrive il comando per aggiornare);
2. installa le dipendenze con `npm ci`. L'unica è Electron, nella versione giusta per sistema e processore. Lo fa solo la prima volta o quando un aggiornamento le cambia;
3. apre la finestra dell'ufficio e ti restituisce il terminale, che puoi chiudere;
4. se la finestra non può partire (nessuno schermo, librerie mancanti), apre l'ufficio nel browser.

Opzioni utili: `npm run start:demo` apre con la demo accesa. Al primo avvio l'app chiede se collegarsi a Claude Code.

L'icona nella barra di sistema (vicino all'orologio su Windows e Linux, in alto a destra su macOS) ha il menu con:
- notifiche e Cowork;
- collegamento a Claude Code;
- report di oggi;
- apertura nel browser;
- **Avvia all'accesso al computer**.

## Collegare Claude Code

Senza hook l'ufficio funziona lo stesso, leggendo i transcript, ma con qualche secondo di ritardo e senza i permessi dal fumetto. Con gli hook:

```sh
npm run hooks:install     # oppure: menu dell'icona → Collega a Claude Code
npm run hooks:status
npm run hooks:uninstall
```

Gli hook sono comandi `curl` verso `127.0.0.1:47800`, aggiunti a `~/.claude/settings.json` accanto alle tue impostazioni, che restano intatte (copia di sicurezza in `settings.json.platypus-backup`). `curl` c'è già su Windows 10/11, macOS e quasi tutte le distribuzioni Linux. Valgono per le sessioni di Claude Code aperte dopo l'installazione.

Se usi `CLAUDE_CONFIG_DIR`, avvia l'ufficio con la stessa variabile. Se cambi porta con `PLATYPUS_PORT`, reinstalla gli hook.

### Feedback agli agenti

Sono altri hook, che si installano e si tolgono per conto loro: permettono a Platypus di aggiungere un breve messaggio a quello che un agente legge dopo uno strumento, a inizio sessione o a fine turno.

```sh
npm run hooks:install -- --feedback      # oppure: OPZ → Feedback agli agenti → INSTALLA GLI HOOK DI FEEDBACK…
npm run hooks:status -- --feedback
npm run hooks:uninstall -- --feedback
```

- Sono hook `http` verso `http://127.0.0.1:47800/platypus-hook/feedback` su `SessionStart`, `PostToolUse`, `PostToolUseFailure`, `Stop` e `SubagentStop`, con un tempo massimo di 3 secondi. Se il tuo Claude Code è troppo vecchio per gli hook `http`, aggiungi `--curl` per installarli come comandi `curl`.
- Installarli da solo non cambia niente: in OPZ → *Feedback agli agenti* ogni funzione parte *spenta*. *Ombra* registra che cosa Platypus avrebbe detto, senza dirlo; *accesa* lo dice. In questa versione tre funzioni si fermano all'ombra. Le tre che si possono accendere hanno anche *esperimento*: ogni sessione finisce a caso, metà e metà, in *accesa* o in *ombra*, e la scheda FEEDBACK del Libro confronta i due gruppi (con un intervallo al 95%, e "dati insufficienti" finché ci sono meno di 10 casi per gruppo).
- Se Platypus è chiuso, o ci mette più di 300 ms a rispondere, Claude Code prosegue come sempre. Platypus non risponde mai al posto tuo a un permesso e non cambia mai l'input o l'output di uno strumento.
- Per lasciare fuori un progetto: nel suo Libro spunta *Non parlare agli agenti di questo progetto*.

Ogni messaggio, mandato o in ombra, finisce nel database dello storico, `~/.platypus/platypus.db`, sotto la chiave del progetto (la stessa del Libro della bottega), con che cosa è stato detto, a quale agente e che cosa ha fatto l'agente dopo. Il testo passa dal filtro dei segreti prima di essere tenuto, e i messaggi più vecchi di 365 giorni si cancellano. Niente esce dal computer. La scheda FEEDBACK del Libro mostra lo stesso registro; per cancellarlo usa *Dimentica questo progetto* (vedi *Lo storico* più sotto).

## Significato più preciso (facoltativo)

La bolla del contesto e la stella polare nella mappa della realtà misurano di che cosa parla un agente. Confrontando le parole (lessicale, TF-IDF), "aggiusta il login" e "correggi l'autenticazione" sembrano lontane; un modello neurale capisce anche i sinonimi. Platypus ne usa uno da solo se c'è un Ollama locale acceso con un modello di embedding, altrimenti resta lessicale. **Opzioni → Motore del significato** mostra che cosa è in uso e permette di scegliere ("solo lessicale" lo spegne); tutto resta sul tuo computer.

- **Ollama** (se lo usi già): avvia Ollama e scarica un modello di embedding, per esempio `ollama pull qwen3-embedding:0.6b` (circa 0,6 GB, multilingue, il migliore misurato su italiano e inglese). Platypus gli parla solo su `http://127.0.0.1:11434` (o un altro indirizzo di questo computer: gli altri host vengono rifiutati) e non scarica mai modelli da solo; se manca un modello le opzioni mostrano il comando.
- **Modello ONNX** (senza Ollama): `npm run embed:onnx:install` installa i pacchetti npm di `optional/embed-onnx` (circa 380 MB) e scarica `onnx-community/Qwen3-Embedding-0.6B-ONNX` (circa 585 MB) in `~/.platypus/models/`. Dice quanto pesa e chiede conferma prima di scaricare. Questo scaricamento, da registry.npmjs.org e huggingface.co, è l'unica chiamata di rete della funzione; poi il modello gira in locale, in un thread a parte. È lo stesso modello Qwen3 di Ollama, in una versione più piccola e quantizzata: un po' più debole che su Ollama, ma nettamente meglio del lessicale, per questo in automatico si usa quando Ollama non è acceso. Se con la 2.12 avevi installato il vecchio modello ONNX (e5-small), rilancia il comando: il vecchio modello non si usa più.
- **Cosa resta in locale:** gli estratti del testo degli agenti vanno solo al modello locale e non finiscono mai su disco; la cache (`~/.platypus/embed-cache/`, al massimo 50 MB per modello, si svuota dalle opzioni) tiene solo vettori e hash.
- Un modello neurale giudica la deriva solo dopo essere stato calibrato (`node scripts/embed-eval.js --source ollama --model <nome>`); sei modelli di Ollama lo sono già (qwen3-embedding 0.6b e 4b, embeddinggemma-2, snowflake-arctic-embed2, nomic-embed-text-v2-moe, bge-m3). Per gli altri la stella polare dice "non misurabile" invece di tirare a indovinare.

## Modalità browser

```sh
npm run web          # oppure: node scripts/launch.js --web
npm run web:demo
```

Usa solo Node.js, senza Electron e senza `npm install`: è il modo più leggero, utile anche su un secondo monitor o su un computer dove non vuoi installare nulla. Si apre `http://127.0.0.1:47800/`. Mancano solo l'icona nella barra di sistema e le notifiche del sistema operativo.

## Guscio Tauri (facoltativo, sperimentale)

Il guscio predefinito resta Electron, che non ha bisogno di niente di tutto questo. Il guscio Tauri in `shells/tauri/` serve a confrontare dimensioni, memoria e tempo di avvio; per compilarlo dai sorgenti servono, oltre a Node.js:

- **Rust** 1.90 o più recente, con [rustup](https://rustup.rs).
- **Windows:** i Microsoft C++ Build Tools con "Sviluppo di applicazioni desktop con C++", e `rustup default stable-msvc`. WebView2 c'è già in Windows 10 (dalla 1803) e in Windows 11.
- **macOS:** gli Xcode Command Line Tools (`xcode-select --install`), macOS 10.15 o più recente.
- **Debian / Ubuntu:** `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **Fedora:** `sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel` e `sudo dnf group install "c-development"`
- **Arch:** `sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool`

Poi una volta `npm run tauri:build` (la prima compilazione richiede alcuni minuti) e `node scripts/launch.js --shell tauri`. Senza una compilazione, il lanciatore spiega come farla e apre Electron.

## Aggiornare e disinstallare

**Aggiornare**: `git pull` nella cartella del repository, poi rilancia. Le dipendenze si riallineano da sole.

**Disinstallare**:
1. `npm run hooks:uninstall`, e `npm run hooks:uninstall -- --feedback` se hai installato gli hook di feedback;
2. togli la spunta *Avvia all'accesso al computer* dal menu dell'icona;
3. cancella la cartella del repository;
4. se vuoi, cancella anche:
   - `~/.platypus`: le impostazioni e il database dello storico `platypus.db` (Libro della bottega, statistiche, messaggi agli agenti, passi e riassunti delle sessioni), con le sue copie di sicurezza;
   - preferenze della finestra: `%APPDATA%\Platypus`, `~/Library/Application Support/Platypus` oppure `~/.config/Platypus`;
   - i collegamenti creati con `npm run shortcut`.

### Il Libro della bottega

Le lezioni che Platypus deduce dalle tue sessioni stanno nel database dello storico, `~/.platypus/platypus.db`, sotto una chiave del progetto: il remote `origin` del suo repository git senza credenziali, oppure la cartella se non c'è un remote. Due copie dello stesso repository hanno un libro solo. Il database non tiene mai la cartella del progetto, il testo delle tue richieste né l'uscita dei comandi. Niente esce dal computer.

Il libro impara dalle sessioni aperte una volta al minuto e, quando un progetto ha una sessione aperta, rilegge da sé in background le sue sessioni passate (al massimo ogni 6 ore; una sessione già letta e non cambiata si salta).

- Per dimenticare una lezione: apri il Libro (LIBRO sul tabellone del piano, oppure BOTTEGA nell'atrio) e premi DIMENTICA.
- Per dimenticare tutti i libri, e il resto dello storico: chiudi Platypus e cancella `~/.platypus/platypus.db` (con `platypus.db-wal` e `platypus.db-shm` accanto, se ci sono). Fino alla 2.12 i libri erano file in `~/.platypus/bottega`: la 2.13 non li legge né li scrive più.
- Per non farlo più imparare: OPZ → *Il Libro della bottega impara dalle sessioni*. Il Nonno ha un suo interruttore lì accanto.
- Se hai aggiunto la sezione del libro al `CLAUDE.md` di un progetto, sta tra `<!-- platypus:bottega:start -->` e `<!-- platypus:bottega:end -->`: cancella quelle righe per toglierla. La versione precedente del file è in `CLAUDE.md.platypus-backup`.

### Lo storico

Dalla 2.13 Platypus tiene uno storico delle tue sessioni in `~/.platypus/platypus.db`, un database SQLite che è già dentro Node.js (nessun programma in più). Tiene solo fatti ricavati dalle sessioni: per ogni azione lo strumento, il file relativo al progetto, com'è finita, la forma dell'errore e le prime parole di un comando; per ogni sessione i conteggi (azioni, errori, giri in tondo, fasi bloccate, affermazioni senza prove), il modello, il costo e gli orari. Mai il testo delle tue richieste, le risposte degli agenti, l'uscita dei comandi, il contenuto dei file, credenziali o indirizzi e-mail; i percorsi assoluti fuori dal progetto diventano un hash con il nome del file. Niente esce dal computer.

- **Che cosa vedi:** la scheda STORIA del Libro (righe settimana per settimana per progetto, una frase come "giri in tondo: meno di un mese fa", sempre con il numero di sessioni dietro, e una ricerca nei passi salvati per file, comando o errore), la riga della tendenza nel report giornaliero e i risultati dell'esperimento nella scheda FEEDBACK.
- **Quanto si tiene:** passi 90 giorni, riassunti delle sessioni e messaggi agli agenti 365 giorni, lezioni con peso basso 180 giorni, statistiche giornaliere per sempre. Ognuno si cambia in OPZ → *ARCHIVIO*, con un limite di dimensione (200 MB di base: oltre, se ne vanno per primi i passi più vecchi).
- **OPZ → *ARCHIVIO*** ha anche COMPATTA (restituisce al disco lo spazio liberato), ESPORTA… (un file JSONL per collezione, di base in `Scaricati/platypus-export-<data>`) e DIMENTICA UN PROGETTO…. *Dimentica questo progetto* c'è anche in ogni Libro: toglie tutto quello che riguarda il progetto dal database, dalle sue copie di sicurezza e dai file della 2.12.
- **Se il database non si può usare** (rovinato, scritto da una Platypus più nuova, cartella in sola lettura), Platypus continua a funzionare senza storico e lo dice in una barra gialla; un file rovinato viene messo da parte come `platypus.db.broken-<data>` e al giro dopo se ne crea uno nuovo. Prima di ogni cambio di schema resta una copia `platypus.db.bak-<versione>` (le ultime due).
- **Per cancellare tutto:** chiudi Platypus e cancella `platypus.db` con `platypus.db-wal` e `platypus.db-shm`, e accanto `platypus.db.bak-*`, `platypus.db.broken-*` e `legacy-<data>/`.

### Tornare alla 2.12

Dalla 2.13 il Libro della bottega, le statistiche e il registro dei messaggi agli agenti stanno in un solo database, `~/.platypus/platypus.db`. La prima volta che la 2.13 parte, li copia lì dai file che usava la 2.12 (`bottega/`, `stats.json`, `feedback/`). Quei file non vengono né cambiati né cancellati, e una seconda copia resta in `~/.platypus/legacy-<data>/`.

Quindi tornare indietro funziona: rimetti la 2.12 e avviala, e rilegge i suoi file com'erano quando la 2.13 è partita la prima volta. Quello che la 2.13 ha imparato dopo resta nel database, dove la 2.12 non guarda. Se poi torni alla 2.13, riprende dal suo database: i vecchi file si importano una volta sola.

Un'eccezione: quando nella 2.13 usi *Dimentica questo progetto*, il progetto viene tolto anche da quei file della 2.12 e le copie di sicurezza accanto al database (`platypus.db.bak-*`, `platypus.db.broken-*`, `legacy-<data>/`) vengono cancellate, quindi nemmeno la 2.12 lo mostrerà più.

## Casi particolari

### WSL (Claude Code dentro Linux su Windows)

Se lanci Claude Code dentro WSL, i suoi transcript stanno nella distribuzione Linux, non in `%USERPROFILE%\.claude`. Platypus per Windows segue da solo le distribuzioni WSL **accese** (`\\wsl.localhost\<distribuzione>\home\<utente>\.claude`). Gli hook installati dentro WSL però non raggiungono `127.0.0.1` di Windows, a meno di attivare la [rete in modalità mirrored](https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking). Senza, l'ufficio funziona leggendo i transcript.

In alternativa puoi avviare Platypus direttamente dentro WSL (`./start.sh`): con WSLg la finestra compare su Windows.

### Più cartelle `.claude`

In **OPZ → Altre cartelle di Claude Code** (o con la variabile `PLATYPUS_CLAUDE_DIRS`, separate da `;`) puoi aggiungere altre configurazioni da seguire, per esempio un secondo utente o una cartella condivisa.

### Cowork

Le sessioni Cowork dell'app desktop Claude vengono cercate nella cartella dell'app (`%APPDATA%\Claude`, `~/Library/Application Support/Claude`, `~/.config/Claude`); su Windows il percorso è `%APPDATA%\Claude\local-agent-mode-sessions`, la scheda mostra il titolo scelto nell'app e le sessioni archiviate nell'app non vengono seguite. Le sessioni Cowork avviate nel cloud (dal telefono o dal web) girano sui server di Anthropic e non lasciano file sul computer: quelle non si possono vedere. In **OPZ** trovi cosa è stato trovato e puoi aggiungere altre cartelle.

### Proxy aziendale

npm e il download di Electron passano dal proxy se lo configuri:

```sh
npm config set proxy http://proxy.azienda:8080
npm config set https-proxy http://proxy.azienda:8080
```

Se GitHub è bloccato, Electron si può scaricare da un mirror interno: `ELECTRON_MIRROR=https://mirror.azienda/electron/ npm ci`. In ogni caso la modalità browser (`npm run web`) non scarica nulla.

### Repository privato

Se il repository è privato, git chiede di autenticarti. Il modo più semplice è [GitHub CLI](https://cli.github.com): `gh auth login`, poi `gh repo clone <proprietario>/platypus`. In alternativa usa una chiave SSH o un token personale.

## Testato su

Cosa è stato provato su sistemi veri e cosa no. Le date sono quelle delle prove; la struttura delle altre app (Claude Code, l'app desktop Claude) può cambiare dopo.

| Sistema | Versione | Data | Cosa funziona | Limiti |
|---|---|---|---|---|
| Windows 11 Pro (x64) | build 26200, Node.js 24, Windows Terminal | 2026-11-18 | clone pulito in una cartella con lo spazio, `start.cmd`, aggiornamento dopo un `git pull`, modalità browser senza Electron, voce nel menu Start, notifiche (il clic apre il piano giusto), menu dell'icona, *Avvia all'accesso*, `npm run shortcut`, modalità mini su tre schermi, permessi dal fumetto (SÌ / SEMPRE / NO, due insieme, tempo scaduto, Platypus chiuso) con Claude Code 2.1.11, hook di feedback, ricerca delle sessioni Cowork dell'app Claude (versione Microsoft Store 6.6395; provata sulle sue cartelle e su una copia finta, non su una sessione in corso) | non provati: Windows 10, arm64, VS Code, JetBrains, WSL, una sessione Cowork in corso in quel momento. *VAI ALLA FINESTRA* sceglie la finestra del terminale per nome e titolo: con più finestre di Windows Terminal può scegliere quella sbagliata |
| macOS (Intel) | runner macOS 15 su GitHub Actions, Node.js 22 | 2026-11-18 | tutti i test del motore, la finestra con la demo, la modalità mini, la mappa della realtà, il collegamento (`Platypus.app`, `Info.plist` valido, icona), il file di avvio all'accesso | provato solo dai controlli automatici, non da una persona: niente notifiche, icona nella barra, permessi o Cowork. Apple Silicon non provato |
| Linux (Ubuntu) | runner Ubuntu su GitHub Actions, Node.js 22 e 24, schermo virtuale X | 2026-11-18 | test del motore, la finestra con la demo, la voce nel menu delle applicazioni e il file di avvio all'accesso | provato solo dai controlli automatici: niente icona nella barra, notifiche, *VAI ALLA FINESTRA*, Wayland o Cowork (l'app desktop Claude ufficiale per Linux è in beta, la struttura delle sue cartelle non è confermata) |

## Problemi frequenti

| Problema | Soluzione |
|---|---|
| `node` non trovato | Installa Node.js e riapri il terminale. Su macOS con nvm: `start.sh` carica nvm da solo; se usi un altro gestore, assicurati che `node` sia nel PATH. |
| «Serve Node.js 22.13 o più recente» | Aggiorna Node.js con il comando scritto nel messaggio (`winget install OpenJS.NodeJS.LTS` su Windows, `brew install node` su macOS, `nvm install --lts` con nvm) e riapri il terminale. Serve anche alla modalità browser. Il guscio Tauri usa il `node` che trova nel `PATH`, oppure quello indicato in `PLATYPUS_NODE`. |
| Windows: `start.cmd` «non è riconosciuto» in PowerShell | PowerShell non lancia i file della cartella corrente per nome: scrivi `.\start.cmd`, oppure fai doppio clic. |
| Windows: *Avvia all'accesso* si spegne o si accende da solo | Windows tiene una sola voce di avvio, chiamata `com.platypus.desktop`, per tutte le copie di Platypus sul computer (un clone, una versione impacchettata). Accendila dalla copia che vuoi tenere. |
| Il primo avvio si ferma durante `npm ci` | Rete o proxy: vedi [Proxy aziendale](#proxy-aziendale). Intanto puoi usare `npm run web`. |
| Linux: "The SUID sandbox helper binary was found, but is not configured correctly" | Su alcune distribuzioni (es. Ubuntu 24.04) la sandbox di Electron scaricato da npm è bloccata. Il lanciatore riparte da solo con `--no-sandbox`; per farlo sempre: `PLATYPUS_NO_SANDBOX=1 ./start.sh`. |
| Linux: niente icona nella barra | GNOME ha bisogno dell'estensione *AppIndicator and KStatusNotifierItem Support*. La finestra funziona comunque. |
| Linux: "VAI ALLA FINESTRA" non fa nulla | Su X11 installa `xdotool` o `wmctrl`. Su Wayland funziona con KDE Plasma (tramite KWin, serve `gdbus`), Hyprland e Sway; GNOME non lo permette. |
| Linux (Wayland): il `PIN` non tiene la finestra sopra / non si riapre dov'era | Wayland non lo permette: usa la *Compatibilità XWayland* (vedi [Wayland](#wayland)). |
| "La porta 47800 è già occupata" | Platypus è già aperto (anche in modalità browser), oppure un altro programma usa la porta: `PLATYPUS_PORT=47810 npm start` e reinstalla gli hook. |
| Windows: niente notifiche | Avvia l'app almeno una volta dal lanciatore, così crea la voce nel menu Start (Windows mostra le notifiche solo per le app che ne hanno una), e controlla *Impostazioni → Sistema → Notifiche*. |
| Non vedo le mie sessioni | Controlla che Claude Code scriva in `~/.claude` (o nella cartella di `CLAUDE_CONFIG_DIR`). Le sessioni vengono mostrate se attive negli ultimi 25 minuti; le altre sono nell'archivio (tasto `A`). |

I messaggi della finestra desktop finiscono in `~/.platypus/launch.log`.
