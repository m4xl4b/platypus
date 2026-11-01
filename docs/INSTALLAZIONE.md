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
- [Problemi frequenti](#problemi-frequenti)

## Requisiti

| | |
|---|---|
| **Node.js** | 22.12 o più recente (LTS consigliata). Con versioni più vecchie (Node.js 20 non riceve più aggiornamenti di sicurezza) il lanciatore apre solo la modalità browser. |
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

1. Installa Node.js 22.12+ e Git. Le versioni nei repository delle distribuzioni sono spesso vecchie: conviene [nvm](https://github.com/nvm-sh/nvm) oppure i pacchetti di [NodeSource](https://github.com/nodesource/distributions).
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

1. controlla la versione di Node.js;
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

## Modalità browser

```sh
npm run web          # oppure: node scripts/launch.js --web
npm run web:demo
```

Usa solo Node.js, senza Electron e senza `npm install`: è il modo più leggero, utile anche su un secondo monitor o su un computer dove non vuoi installare nulla. Si apre `http://127.0.0.1:47800/`. Mancano solo l'icona nella barra di sistema e le notifiche del sistema operativo.

## Aggiornare e disinstallare

**Aggiornare**: `git pull` nella cartella del repository, poi rilancia. Le dipendenze si riallineano da sole.

**Disinstallare**:
1. `npm run hooks:uninstall`;
2. togli la spunta *Avvia all'accesso al computer* dal menu dell'icona;
3. cancella la cartella del repository;
4. se vuoi, cancella anche:
   - impostazioni, statistiche e Libro della bottega: `~/.platypus`;
   - preferenze della finestra: `%APPDATA%\Platypus`, `~/Library/Application Support/Platypus` oppure `~/.config/Platypus`;
   - i collegamenti creati con `npm run shortcut`.

### Il Libro della bottega

Le lezioni che Platypus deduce dalle tue sessioni stanno in `~/.platypus/bottega`, un file JSON per cartella di progetto (il nome del file è una chiave calcolata dalla cartella). Niente esce dal computer.

Il libro impara dalle sessioni aperte una volta al minuto e, quando un progetto ha una sessione aperta, rilegge da sé in background le sue sessioni passate (al massimo ogni 6 ore; una sessione già letta e non cambiata si salta).

- Per dimenticare una lezione: apri il Libro (LIBRO sul tabellone del piano, oppure BOTTEGA nell'atrio) e premi DIMENTICA.
- Per dimenticare il libro di un progetto, o tutti: chiudi Platypus e cancella il suo file, oppure l'intera cartella `~/.platypus/bottega`.
- Per non farlo più imparare: OPZ → *Il Libro della bottega impara dalle sessioni*. Il Nonno ha un suo interruttore lì accanto.
- Se hai aggiunto la sezione del libro al `CLAUDE.md` di un progetto, sta tra `<!-- platypus:bottega:start -->` e `<!-- platypus:bottega:end -->`: cancella quelle righe per toglierla. La versione precedente del file è in `CLAUDE.md.platypus-backup`.

## Casi particolari

### WSL (Claude Code dentro Linux su Windows)

Se lanci Claude Code dentro WSL, i suoi transcript stanno nella distribuzione Linux, non in `%USERPROFILE%\.claude`. Platypus per Windows segue da solo le distribuzioni WSL **accese** (`\\wsl.localhost\<distribuzione>\home\<utente>\.claude`). Gli hook installati dentro WSL però non raggiungono `127.0.0.1` di Windows, a meno di attivare la [rete in modalità mirrored](https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking). Senza, l'ufficio funziona leggendo i transcript.

In alternativa puoi avviare Platypus direttamente dentro WSL (`./start.sh`): con WSLg la finestra compare su Windows.

### Più cartelle `.claude`

In **OPZ → Altre cartelle di Claude Code** (o con la variabile `PLATYPUS_CLAUDE_DIRS`, separate da `;`) puoi aggiungere altre configurazioni da seguire, per esempio un secondo utente o una cartella condivisa.

### Cowork

Le sessioni Cowork dell'app desktop Claude vengono cercate nella cartella dell'app (`%APPDATA%\Claude`, `~/Library/Application Support/Claude`, `~/.config/Claude`). Le sessioni Cowork avviate nel cloud (dal telefono o dal web) girano sui server di Anthropic e non lasciano file sul computer: quelle non si possono vedere. In **OPZ** trovi cosa è stato trovato e puoi aggiungere altre cartelle.

### Proxy aziendale

npm e il download di Electron passano dal proxy se lo configuri:

```sh
npm config set proxy http://proxy.azienda:8080
npm config set https-proxy http://proxy.azienda:8080
```

Se GitHub è bloccato, Electron si può scaricare da un mirror interno: `ELECTRON_MIRROR=https://mirror.azienda/electron/ npm ci`. In ogni caso la modalità browser (`npm run web`) non scarica nulla.

### Repository privato

Se il repository è privato, git chiede di autenticarti. Il modo più semplice è [GitHub CLI](https://cli.github.com): `gh auth login`, poi `gh repo clone <proprietario>/platypus`. In alternativa usa una chiave SSH o un token personale.

## Problemi frequenti

| Problema | Soluzione |
|---|---|
| `node` non trovato | Installa Node.js e riapri il terminale. Su macOS con nvm: `start.sh` carica nvm da solo; se usi un altro gestore, assicurati che `node` sia nel PATH. |
| Il primo avvio si ferma durante `npm ci` | Rete o proxy: vedi [Proxy aziendale](#proxy-aziendale). Intanto puoi usare `npm run web`. |
| Linux: "The SUID sandbox helper binary was found, but is not configured correctly" | Su alcune distribuzioni (es. Ubuntu 24.04) la sandbox di Electron scaricato da npm è bloccata. Il lanciatore riparte da solo con `--no-sandbox`; per farlo sempre: `PLATYPUS_NO_SANDBOX=1 ./start.sh`. |
| Linux: niente icona nella barra | GNOME ha bisogno dell'estensione *AppIndicator and KStatusNotifierItem Support*. La finestra funziona comunque. |
| Linux: "VAI ALLA FINESTRA" non fa nulla | Su X11 installa `xdotool` o `wmctrl`. Su Wayland funziona con KDE Plasma (tramite KWin, serve `gdbus`), Hyprland e Sway; GNOME non lo permette. |
| Linux (Wayland): il `PIN` non tiene la finestra sopra / non si riapre dov'era | Wayland non lo permette: usa la *Compatibilità XWayland* (vedi [Wayland](#wayland)). |
| "La porta 47800 è già occupata" | Platypus è già aperto (anche in modalità browser), oppure un altro programma usa la porta: `PLATYPUS_PORT=47810 npm start` e reinstalla gli hook. |
| Windows: niente notifiche | Avvia l'app almeno una volta dal lanciatore, così crea la voce nel menu Start (Windows mostra le notifiche solo per le app che ne hanno una), e controlla *Impostazioni → Sistema → Notifiche*. |
| Non vedo le mie sessioni | Controlla che Claude Code scriva in `~/.claude` (o nella cartella di `CLAUDE_CONFIG_DIR`). Le sessioni vengono mostrate se attive negli ultimi 25 minuti; le altre sono nell'archivio (tasto `A`). |

I messaggi della finestra desktop finiscono in `~/.platypus/launch.log`.
