# Novità

Le versioni di Platypus (fino alla 2.7 si chiamava Agent Office), dalla più recente.

*English version: [CHANGELOG.md](CHANGELOG.md).*

## 2.10: workflow e squadre, mappe con lo zoom, un giro sulla sicurezza

Platypus ora mostra i Workflow e i team di agenti di Claude Code, ti lascia ingrandire i grafici della mappa della realtà, riempie le lavagne anche nell'uso vero e ha avuto un giro di sicurezza su tutta l'app.

- **Workflow e squadre** (nuovo pannello **SQUADRE**, tasto **W** o il pulsante sulla bacheca del piano):
  - gli agenti di un Workflow ora compaiono in ufficio, in una stanza per ogni esecuzione e fase, con il nome della loro etichetta, e i loro token entrano nel costo, dal vivo, in archivio e nei replay (prima mancavano);
  - il pannello elenca ogni esecuzione con stato, agenti al lavoro, tempo trascorso, costo, token e chiamate agli strumenti, e per ogni fase una barra di avanzamento, il costo e la durata; gli agenti falliti sono elencati per nome, e quando l'esecuzione finisce trovi una breve analisi (fase più lunga e più costosa, agente più lento, fallimenti, compiti rifatti) più il riassunto di Claude Code;
  - mostra anche squadre e reparti (chi lavora, aspetta, è fermo o ha finito) e i messaggi che gli agenti si scambiano;
  - un'etichetta «n WF» nell'atrio e nell'archivio indica dove girano o sono girati dei workflow;
  - nella demo, il piano 3 ha un workflow che avanza da solo e uno concluso con la sua analisi.
- **Zoom sui grafici della mappa** (territorio, bolla del contesto, traiettoria, sismografo):
  - la rotella del mouse ingrandisce attorno al cursore, fino a 8x; trascinando sposti la vista; un doppio clic o la targhetta «×2.0 · 1:1» torna alla vista intera;
  - sul territorio i quadratini vengono ridisegnati più grandi, così i nomi dei file compaiono man mano che ingrandisci;
  - i due grafici 3D continuano a ruotare quando trascini, quindi si spostano con Maiusc o con il tasto destro, e mentre sono ingranditi smettono di ruotare da soli;
  - il sismografo ingrandisce solo il tempo, tiene la colonna dei nomi degli agenti e mostra l'intervallo di tempo visibile.
- **Lavagne**:
  - i piani arrivano di nuovo alla lavagna: l'attuale Claude Code scrive il piano in un file invece di passarlo, e Platypus ora lo segue, sia dal terminale sia dall'app desktop di Claude;
  - anche le liste di cose da fare dell'app desktop di Claude riempiono la lavagna del capo, e vengono spuntate quando il turno finisce;
  - le lavagne stanno ora subito sotto l'ufficio del capo, quindi nei piani affollati non devi più scorrere per trovarle, e la lavagna dei piani vuota dice che il piano comparirà lì in modalità piano;
  - il titolo della lavagna non è più tagliato e i passi lunghi del piano finiscono con i puntini di sospensione.
- **Il Nonno si fa vedere**:
  - prima parlava solo se il comando era identico a quello della lezione; ora `cd app && CI=1 npm test 2>&1 | tail -30` corrisponde a una lezione su `npm test`, e così lo stesso comando con altri argomenti;
  - il Libro della bottega rilegge da solo le sessioni passate di un progetto, in background, finché il progetto ha una sessione aperta (prima lo faceva solo il pulsante manuale).
- **Fumetti**: non coprono più la faccia dei personaggi, non stanno più sopra la scheda di un agente, e un fumetto di Bash senza descrizione mostra il comando vero invece del `cd cartella &&` che lo precede.
- **Icona sulla barra delle applicazioni di Windows**: è tornata l'icona anni '80 di Platypus al posto dell'atomo e del nome di Electron.
- **Interfaccia**:
  - **Barra in alto**: prima i numeri che chiedono un'azione (attesa, avvisi, costo, al lavoro, poi agenti, fatti, sessioni, in diretta), e quello che non entra sparisce intero invece di essere tagliato a metà parola; il pulsante «?» resta visibile nelle finestre strette;
  - **Opzioni**: sei sezioni al posto di un lungo elenco, la barra SALVA sempre visibile che dice quando ci sono modifiche non salvate, e un avviso prima di chiudere e perderle; «Notifiche di Windows» diventa «Notifiche del sistema»;
  - **Aiuto**: scorre nelle finestre piccole (metà era irraggiungibile) e copre le viste MAPPA E TERRITORIO e SORPRESA E CAUSE, il Libro della bottega e il pannello SQUADRE;
  - **Mappa della realtà**: le quattro schede delle viste mostrano il nome intero nelle finestre piccole.
- **Sicurezza**:
  - Platypus ora gira su Electron 44, una versione supportata (quella vecchia non riceveva più correzioni di sicurezza);
  - un'altra pagina aperta nel tuo browser non può più chiamare il server locale dell'ufficio (per esempio un server di sviluppo su un'altra porta), né caricare l'ufficio in una cornice nascosta per farti cliccare SÌ su un fumetto di permesso;
  - un indirizzo malformato non può più mandare in crash il server;
  - la finestra resta sull'ufficio e manda al browser solo i link web;
  - su Linux e macOS la cartella `~/.platypus` (nomi dei progetti, comandi, estratti degli errori) è leggibile solo da te;
  - «Riprendi» su Windows con Windows Terminal non esegue più come comando parte del nome di una cartella che contiene `;`.
- **Piccole correzioni**:
  - **Testo**: le lettere accentate non risultano più rovinate quando Platypus legge una riga mentre Claude Code la sta ancora scrivendo;
  - **Archivio**: una sessione con un primo messaggio molto grande (per esempio un'immagine incollata) mantiene data di inizio, durata, titolo e cartella;
  - **Statistiche**: una sessione Cowork che riceve il titolo in un secondo momento, o viene rinominata, non è più contata come due progetti;
  - **Ti aspetta**: mentre Claude ti fa una domanda o aspetta che approvi un piano, l'agente risulta in attesa di te, con un avviso, invece che «al lavoro»;
  - **Mappa della realtà**: `sed -i` segna il file come modificato, `cp` e `mv` non segnano più come modificato il file d'origine, e le espressioni di sed come `s/old/new/` non compaiono più come cartelle;
  - **Libro della bottega su Windows**: il nome del progetto conserva le maiuscole, anche nella sezione di `CLAUDE.md`;
  - **Scorciatoie**: con la mappa della realtà, il Libro della bottega o il pannello SQUADRE aperti, i tasti non agiscono più sull'ufficio nascosto dietro;
  - **Lavagne**: le etichette sotto non si sovrappongono più alle gambe, e il fumetto del Nonno resta vicino a lui.
- **Prima di aggiornare**: Electron 44 non supporta più macOS 12, Windows a 32 bit e Linux armv7l. La finestra del desktop richiede Node.js 22.12 o successivo; con Node.js 20 Platypus funziona ancora nel browser con `npm run web`.

## 2.9.1: correzioni

Correzioni dei bug trovati con un giro di debug su tutta l'app, ognuna con una prova automatica.

- **Il server non cade più** con un indirizzo malformato (come `/%`), che poteva mandare qualsiasi pagina web aperta nel browser.
- **Sottoagenti**:
  - chi pensa a lungo (per esempio mentre scrive un file grande) non esce più dall'ufficio come finito per rientrare come agente nuovo: il suo compito si conta una volta sola;
  - chi viene ripreso dopo una lunga pausa (con SendMessage o in un team) ricompare in ufficio, con i suoi token nuovi.
- **Archivio**: durata e titolo giusti per le sessioni il cui file sta fra 64 e 256 KB.
- **Mappa della realtà su Windows**:
  - i file raggiunti dai comandi di Git Bash (`cd /d/dev/...`) ora stanno nel progetto, negli stessi luoghi di Read;
  - in una cartella con uno spazio nel nome (come `C:\Users\Mario Rossi\...`) la mappa segue la shell fino alla cartella giusta.
- **Libro della bottega**: una lezione dimenticata non torna più da sola dopo un minuto; la fanno ripartire solo casi nuovi.
- **Windows**: una cartella del progetto con `&` nel nome (come `R&D`) non rompe più la riapertura dell'IDE, e un nome preparato apposta non può più eseguire un comando.
- **Finestra**: se l'ultima volta stava su un monitor che ora non c'è, si apre al centro dello schermo invece che fuori.

## 2.9: mappa e territorio, sorpresa e cause, il Libro della bottega

Platypus non può guardare dentro la testa del modello, ma vede sia la mappa dell'agente (quello che ha letto, detto e fatto) sia il territorio (il disco, gli esiti dei comandi). Questa versione misura la distanza tra le due cose. Tutto è ricostruito dai fatti, resta sul computer, e i giudizi incerti si mostrano come tali.

- **Mappa contro territorio** (nuova vista **MAPPA E TERRITORIO** nella mappa della realtà):
  - **ricordi scaduti**: un file che l'agente ha letto è poi cambiato (da un altro agente, fuori dalla sessione, o è stato cancellato) e lui non l'ha riletto; **modifiche alla cieca** quando lo modifica lo stesso, o Claude Code lo ferma;
  - **percorsi inventati**: file che prova ad aprire, che i comandi non trovano o che cita nelle risposte, e che non esistono; «poi creato» quando erano un'intenzione;
  - **affermazioni** nelle risposte («i test passano», «ho verificato», «ho corretto X», «ho creato X», «fatto», in italiano e inglese) confrontate con i suoi passi nello stesso turno: ancorate, senza prove o smentite; l'**indice di ancoraggio** è la quota di quelle ancorate;
  - in ufficio un orologio accanto alla testa di chi ha un ricordo scaduto, e un fumetto tratteggiato «senza prove: «…»»; **avvisi di ancoraggio** facoltativi in OPZ.
- **Sorpresa e cause** (nuova vista **SORPRESA E CAUSE**):
  - ogni fallimento ha una **sorpresa** da 0 a 1, dal tipo di fallimento (test, comandi, file mancanti, permessi, tempi scaduti, sintassi, modifiche fallite, riconosciuti per Jest, Vitest, pytest, Go, cargo, npm, tsc, Node, Python, PowerShell) e dalla sua storia: di più se prima funzionava, di meno al primo tentativo o per un test appena scritto;
  - cosa fa dopo l'agente: **si corregge, insiste o si ferma**, con il tempo di recupero;
  - se **segue la traccia**: i file e le righe citati dall'errore contro le sue prime modifiche, e la **catena causale** errore → file citato → modifica → conferma;
  - un **sismografo** con una riga per agente; in ufficio un «!?» tremolante per una sorpresa forte e una nuvoletta grigia per chi insiste.
- **Libro della bottega e il Nonno**:
  - ogni progetto ha un **libro** di lezioni dedotte dalle sue sessioni: comandi instabili, file fragili, correzioni note, trappole, file contesi, percorsi inventati, passi lenti. Il peso di una lezione cresce con i casi e le sessioni e si dimezza ogni 30 giorni; un caso solo è solo un'osservazione;
  - il libro impara dal vivo e, con **Impara dall'archivio**, dalle sessioni passate; sta in `~/.platypus/bottega` e l'apprendimento si spegne in OPZ;
  - il **Nonno**, un anziano con il cardigan e il libro sotto il braccio, va alla scrivania di chi sta per ripetere un errore già visto e racconta la lezione, al massimo una volta ogni 3 minuti per piano;
  - il **Libro** (LIBRO sul tabellone del piano, BOTTEGA nell'atrio, o un clic sul Nonno): lezioni con le prove, fissa/ignora/dimentica, replay da una prova, e **Proponi per CLAUDE.md**: una sezione breve per il `CLAUDE.md` del progetto, da copiare o da scrivere tra i marcatori di Platypus con una copia di sicurezza, solo dopo la tua conferma (mai per la demo, Cowork o cartelle in sola lettura).
- **Demo**: il piano 1 mette in scena tutto nel primo minuto e mezzo, con un libro finto che non finisce mai sul disco.

## 2.8: si chiama Platypus

- **Nuovo nome**: Agent Office diventa **Platypus**, nell'app, nei menu, nei collegamenti e nei documenti.
- **Si passa senza perdere nulla**:
  - opzioni e statistiche vengono copiate una volta da `~/.agent-office` in `~/.platypus`, come le preferenze della finestra;
  - gli hook già installati in Claude Code vengono riconosciuti e aggiornati al nuovo indirizzo da soli;
  - le variabili `AGENT_OFFICE_*` valgono ancora come `PLATYPUS_*`;
  - il vecchio collegamento nel menu Start e le vecchie voci di avvio all'accesso vengono tolti.

## 2.7: ovunque, dai sorgenti

- Gira su **Windows, macOS e Linux** dallo stesso repository: si clona e si lancia, senza programmi già compilati né firme.
- **Un solo requisito**: Node.js 20 o più recente. Al primo avvio il lanciatore installa da solo Electron, la versione giusta per il sistema e il processore (x64 o arm64); dopo ogni `git pull` lo aggiorna se serve.
- Lanciatori con doppio clic: `start.cmd` (Windows), `start.command` (macOS), `start.sh` (Linux e macOS). Se la finestra desktop non può partire (nessuno schermo, librerie mancanti) l'ufficio si apre nel browser.
- `npm run shortcut` crea l'icona sul Desktop (Windows), *Agent Office.app* in Applicazioni (macOS) o la voce nel menu delle applicazioni (Linux).
- **Avvio all'accesso** su tutti e tre i sistemi, anche dai sorgenti; su Windows il menu Start e le notifiche funzionano anche senza installer.
- macOS: menu dell'app con le scorciatoie standard, icona nel Dock, attivazione della finestra giusta risalendo i processi (Terminal, iTerm, VS Code, Claude...).
- Linux: finestra della sessione in primo piano con xdotool o wmctrl (X11), ripresa delle sessioni nel primo terminale disponibile (GNOME Terminal, Konsole, kitty, Alacritty, WezTerm, xterm...), riavvio automatico con `--no-sandbox` dove la sandbox di Electron è bloccata.
- **WSL**: su Windows segue anche il Claude Code installato nelle distribuzioni WSL accese; nelle opzioni si possono aggiungere altre cartelle `.claude`.
- Prove automatiche (`npm test`) e GitHub Actions che le eseguono su Windows, macOS e Linux a ogni push.

## 2.6 (sperimentale): bolla del contesto e stella polare

Nella mappa della realtà c'è una seconda vista, **BOLLA E STELLA POLARE**.

- **Bolla del contesto**: ogni punto è un pezzo di quello che l'agente ha davanti (il compito, i file letti, gli output dei comandi, i risultati delle ricerche, le sue risposte, i rapporti dei sottoagenti). Pezzi che parlano delle stesse cose stanno vicini, la grandezza dice quanti token occupano. La bolla si gonfia man mano che il contesto si riempie, verde, poi giallo, poi rosso. Quando Claude compatta il contesto la bolla si sgonfia: i pezzi dimenticati escono fuori come polvere grigia e il riassunto resta dentro. Accanto, **di cosa è fatto il contesto**: i temi principali con la loro quota, e cosa si è perso nell'ultima compattazione.
- **Stella polare**: il compito (la tua richiesta, o il prompt di un sottoagente) è una stella nella bolla. Il grafico dice quanto ogni azione parla delle stesse cose del compito, rispetto alle prime azioni: **sulla rotta**, **si allontana**, **alla deriva** (sotto il 35% per 6 azioni di fila). Ogni nuova richiesta sposta la stella; anche i messaggi che mandi mentre lavora contano. Se le parole del compito non compaiono mai nel lavoro, dice **non misurabile** invece di inventare un giudizio. Sotto: le azioni più vicine al compito e le più lontane delle ultime.
- **Motore lessicale**: confronta le parole importanti (TF-IDF, anche dentro nomi di file e identificatori), con un piccolo vocabolario italiano → inglese del software, così "autenticazione" incontra `auth/`. L'obiettivo si "allarga" con le prime azioni che gli somigliano di più. È veloce, non scarica nulla e non manda niente fuori dal computer, ma non capisce i sinonimi come un modello neurale: per questo è segnato come sperimentale.
- Funziona dal vivo, nel replay dell'archivio e con la linea del tempo; ora la mappa legge anche la parte vecchia dei transcript (esiti, richieste, compattazioni), non solo l'ultimo pezzo.

Nella demo il PLAN del piano 1 a un certo punto si perde tra i componenti grafici: si vede la deriva dalla sua stella.

## 2.5: la mappa della realtà

Dalla scheda di un agente (pulsante **MAPPA DELLA REALTÀ**) o con il tasto **G** si apre la sua mappa, in grafica vettoriale verde come i vecchi cabinati. Si può guardare un agente alla volta o **tutta la sessione** insieme, dal vivo o nel replay dell'archivio.

- **Territorio, con la nebbia di guerra**: ogni quadratino è un file del progetto (letto dal disco) o un luogo incontrato fuori (siti web, comandi del terminale, sottoagenti, file fuori dalla cartella). La nebbia è ciò che l'agente non ha mai visto; blu scuro è la **frontiera** (file citati da un import, da un link o da una ricerca, ma mai aperti); azzurro è ciò che ha letto, più chiaro se ci torna spesso; giallo ciò che ha modificato, verde ciò che ha creato. Una scia unisce gli ultimi posti visitati e il quadrato che lampeggia è dove si trova adesso. In alto: quanta parte del progetto conosce, quanti file sono sulla frontiera, quanti ne ha modificati.
- **Traiettoria nello spazio degli stati**: a ogni azione l'agente è un punto in uno spazio a **7 dimensioni**, calcolate sulle sue ultime 8 azioni: esplora, costruisce, verifica, novità, errori, ripetizioni, contesto. La vista 3D (trascinala per ruotarla) usa di base tre assi leggibili: esplora ↔ costruisce, novità, attrito; si possono cambiare. Il radar mostra le 7 dimensioni del momento. Una scia che si stringe vuol dire che sta convergendo, un groviglio fitto che gira in tondo.
- **Fase di lavoro**: esplora, studia, costruisce, verifica, in difficoltà, in loop, si orienta. La fascia colorata sotto è la storia delle fasi; con la barra e il tasto ▶ si rivede come si è formata la sua idea del problema.

La mappa è ricostruita da quello che l'agente fa (file, comandi, ricerche, esiti), non da quello che pensa: i suoi pensieri non sono visibili. Tutto resta sul computer.

### Idee in cantiere per la mappa

- **Le mappe a confronto**: cosa sa il capo e cosa il sottoagente, quanto si perde nel passaggio di consegne, quali zone non ha guardato nessun revisore.
- **Motore neurale per la bolla e la stella**: embedding calcolati in locale con un piccolo modello multilingue, al posto del motore lessicale, per riconoscere anche i sinonimi.

## 2.4

- **Modello ed effort di ogni agente**: nella scheda dell'agente vedi il modello (es. Opus 5,5, Haiku 4,5) e il livello di effort. E si vedono anche a occhio:
  - **l'età dice quanto è vecchio il modello** rispetto al più recente: giovane, maturo (tempie grigie), anziano (capelli grigi e occhiali), vecchietto (capelli bianchi, baffi, bastone e passo lento);
  - **l'effort dice quanto è super**: alto = mantello, altissimo = mantello e stemma sul petto, massimo = costume completo con maschera e scintille. L'età resta la stessa: un Haiku vecchio con effort massimo è un vecchietto vestito da supereroe.
  Modello ed effort si leggono dalle risposte scritte da Claude Code nei transcript; le versioni di Claude Code che non scrivono l'effort lasciano gli agenti in abiti normali.
- **Multilingua**: italiano e inglese. In **OPZ** → Lingua scegli Automatica (quella di Windows), Italiano o English; la pagina si ricarica da sola. Le traduzioni stanno in `src/i18n/locales/<lingua>/*.json` e la chiave di ogni testo è il testo italiano. Per aggiungere una lingua basta copiare la cartella `en`, tradurre i valori e aggiungerla in `src/i18n/index.js`; `npm run i18n:check` dice cosa manca. I testi già scritti (registro, rilasci, report dei giorni passati) restano nella lingua in cui sono nati.
- **Correzioni**: il fumetto del collega fastidioso non resta più a galla quando lui se ne va o cambi piano, ed è più leggibile (giallo, testo nero, va a capo invece di tagliare).

## 2.3

- **Permessi dal fumetto**: quando un agente chiede un permesso, il suo fumetto ha i pulsanti **SÌ**, **SEMPRE** (consenti e non chiedere più in questa sessione) e **NO**. Ci sono anche nella striscia della modalità mini. Al primo avvio la 2.3 aggiorna da sola gli hook già installati: quello dei permessi diventa "sincrono" e aspetta la risposta dell'ufficio. Se l'ufficio è chiuso, o non rispondi entro il tempo scelto nelle opzioni (predefinito: 120 secondi), decide il terminale come sempre. Si spegne in **OPZ**.
- **Vestiti per feste, stagioni e meteo**: cappelli da Babbo Natale e corna da renna con l'albero nell'atrio, cappellini a Capodanno, maschere e cappelli da giullare a Carnevale, cuoricini a San Valentino, mimose l'8 marzo, il pesce di carta sulla schiena il 1° aprile, orecchie da coniglio a Pasqua, la bandierina il 25 aprile, il 1° maggio e il 2 giugno, camicie a fiori a Ferragosto, streghe, zucche e vampiri ad Halloween. Con il freddo sciarpe e berretti, con il caldo occhiali da sole, con la pioggia o la neve gli ombrelli. Il meteo arriva da Open-Meteo per la città scelta nelle opzioni (predefinita: Roma; vuota = niente meteo) e si vede anche dalle finestre: pioggia, neve, nebbia e temporali.
- **Sessioni Cowork dell'app desktop**: l'ufficio cerca le cartelle delle sessioni Cowork dentro la cartella dell'app Claude (`%APPDATA%\Claude`, `%LOCALAPPDATA%\Claude` e l'installazione da Microsoft Store) e segue quelle usate nelle ultime 36 ore. In **OPZ** vedi cosa ha trovato, puoi rifare la ricerca e aggiungere altre cartelle. Le sessioni Cowork avviate nel cloud (dal telefono o dal web) girano sui server di Anthropic e non lasciano file sul computer: quelle non si possono vedere.
- **Correzione**: se le sale si spostano (arriva un nuovo reparto o ridimensioni la finestra), chi stava camminando verso una scrivania o una lavagna ricompare al posto giusto invece di entrare in una stanza che non c'è più. Lo stesso vale per il gatto, il collega fastidioso e le pulizie.

Per provare i vestiti senza aspettare la festa: modalità browser con `?festa=natale` (o `halloween`, `carnevale`, `pasqua`, `pesce`...) e `&meteo=rain` (o `snow`, `hot`, `cold`, `fog`, `storm`).

## 2.2: vita d'ufficio

Un po' The Office, un po' IT Crowd, ma ogni gag è legata a qualcosa di vero:

- **Il gatto dell'ufficio** dorme sul pouf della sala creativa. Quando un agente resta fermo su un comando troppo a lungo, il gatto va a sdraiarsi sulla sua tastiera.
- **Il collega fastidioso** gira per i piani, si ferma accanto alle scrivanie e chiacchiera a vuoto ("hai visto la mail di stamattina?"). Il nome si cambia in **OPZ** → "Nome del collega fastidioso" (predefinito: Ugo Pignolo). Si può anche spegnere.
- **Festa di fine lavoro**: per un commit, una PR aperta o unita, un tag o una suite di test che torna verde, al piano partono i coriandoli e gli agenti alzano le braccia. Se sei su un altro piano arriva un avviso in basso. I test verdi fanno festa solo se prima erano rossi o se non si festeggiava da 15 minuti.
- **Notte in ufficio**: dopo le 20 e prima delle 7 le finestre mostrano la città di notte, restano accese solo le lampade di chi lavora e passa l'addetto alle pulizie.
- **Bacheca dei rilasci** appesa alla parete di ogni piano: gli ultimi commit, push, PR e test verdi di quella sessione.
- **Costi nel tempo**: nel tabellone dell'atrio, scheda **COSTI**, un grafico degli ultimi 14 giorni diviso per progetto.
- **Dipendente della settimana**: scheda **ONORI** e ritratto appeso nell'atrio. Vince il tipo di agente che chiude più compiti con meno errori; ci sono anche il premio caffè (il più costoso), lo stacanovista e "mani di burro" (più errori).
- **Report giornaliero**: pulsante **REPORT DI OGGI** nell'atrio o voce nel menu dell'icona. Costi, token, sessioni, progetti, rilasci e onori del giorno, con stampa/PDF, copia del testo e invio per mail. All'ora scelta nelle opzioni (predefinita: le 18) arriva una notifica di Windows, una volta al giorno e solo se c'è stata attività.
- **Ricerca** (`/` o **CERCA**): trova agenti, compiti e progetti su tutti i piani e ti porta lì.
- **Modalità mini** (`M` o **MINI**): la finestra diventa una piccola striscia sempre in primo piano nell'angolo dello schermo, con contatori, costo e richieste in attesa. **APRI** la riporta com'era.

Le statistiche per giorno restano salvate in `%USERPROFILE%\.agent-office\stats.json` e partono da quando l'ufficio è aperto.

## 2.1: la sala creativa

Ogni piano ha una **SALA CREATIVA** con due lavagne su ruote:

- **Lavagna del capo**: quando Claude aggiorna la sua lista di cose da fare (TodoWrite o Task), va alla lavagna e la riscrive. Quello che è finito diventa verde e barrato, quello in corso arancione.
- **Lavagna libera**: quando Claude esce dalla modalità piano, ci disegna il piano a riquadri e frecce. Chi finisce un compito lascia spesso un disegnino firmato prima di andarsene (un gatto, un razzo, "SHIP IT!", un grafico che sale...), e il capo ci scarabocchia mentre ti aspetta.
- **Frustrazione**: un agente che sbaglia lo stesso strumento 3 volte di fila, o il capo quando lo interrompi, va alla lavagna e la butta per terra con un bel "#@!%&!!". Resta lì finché non si è calmato, poi qualcuno passa a rimetterla in piedi.

## 2.0

- **Costi e token**: ogni piano mostra in bacheca il costo della sessione, i token usati e una barra rispetto al tuo budget (verde, arancione oltre l'80%, rossa oltre il 100%). Il costo arriva da Claude Code stesso: nel transcript scrive il costo calcolato (`cost-state`) e l'ufficio lo usa come riferimento. Da lì ripartisce il costo su ogni sala e ogni agente in base ai loro token, e lo aggiorna con i token successivi. Finché Claude Code non ha scritto il suo costo, il valore è una **stima** (indicata come tale) basata su un prezzo che puoi cambiare nelle opzioni. Il tabellone dell'atrio ha la colonna COSTO e la barra in alto il totale.
- **Avvisi intelligenti**: un **!** arancione sull'agente, nella bacheca, nel tabellone e sul pulsante dell'ascensore quando:
  - un agente aspetta il tuo permesso da più di 3 minuti;
  - uno strumento (es. un comando) non risponde da più di 10 minuti;
  - lo stesso strumento fallisce 3 volte di fila;
  - Claude ha finito e ti aspetta da più di 15 minuti;
  - la sessione supera il budget.
  Le soglie si cambiano in **OPZ** (tasto `O`); con l'app arrivano anche come notifiche di Windows.
- **Archivio e replay** (tasto `A`, piano **-1**): l'elenco delle sessioni passate, ricostruito dai transcript. **REPLAY** rimette in scena la sessione nel seminterrato a velocità 10×–600×, con l'organigramma che si forma minuto per minuto e le pause lunghe saltate. C'è una barra da registratore per pausa, velocità e posizione. **RIPRENDI** apre un nuovo terminale con `claude --resume` nella cartella giusta (Windows Terminal se c'è, altrimenti il prompt dei comandi). **CARTELLA** la apre in Esplora risorse.
- **Rispondi dall'ufficio**: **FINESTRA** (nella bacheca o nella scheda di un agente) porta in primo piano il terminale, l'IDE o l'app Claude di quella sessione. Su Windows risale dal processo di Claude Code alla sua finestra; se non la trova, porta avanti l'app più probabile (VS Code, Claude, Windows Terminal) e te lo dice. Con più schede aperte in Windows Terminal arriva in primo piano la finestra giusta, ma la scheda la scegli tu.
