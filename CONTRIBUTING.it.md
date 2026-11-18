# Contribuire

*English version: [CONTRIBUTING.md](CONTRIBUTING.md).*

```sh
git clone https://github.com/m4xl4b/platypus.git && cd platypus
PLATYPUS_DATA_DIR="$(mktemp -d)" npm test   # prove veloci, non servono dipendenze
npm run start:demo   # finestra con la demo (al primo avvio installa Electron)
npm run web:demo     # lo stesso nel browser
```

## Regole della casa

- **Il motore (`src/core`) non ha dipendenze npm**: solo moduli di Node.js. È ciò che permette la modalità browser senza installazione e un eventuale passaggio ad altri gusci (vedi [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md)).
- **Tutto ciò che dipende dal sistema operativo** va in `src/core/osint.js`, `src/core/sources.js`, `src/core/hooks.js`, `src/autostart.js` o `scripts/`, e deve avere un comportamento per Windows, macOS e Linux (anche solo un messaggio chiaro).
- **Testi**: ogni testo visibile passa da `tr('testo italiano', { segnaposto })` o `trn(singolare, plurale, n)`. Non usare `t()`: è il nome della variabile del tempo. Dopo aver aggiunto testi esegui `npm run i18n:check` e completa `src/i18n/locales/en/*.json`.
- **Privacy**: niente chiamate di rete oltre al meteo (facoltativo). Il server ascolta solo su 127.0.0.1.
- **Le prove non toccano mai i tuoi dati veri**: si rifiutano di partire se `PLATYPUS_DATA_DIR` non punta dentro una cartella temporanea (`os.tmpdir()`, oppure `RUNNER_TEMP` nelle GitHub Actions). In PowerShell: `$env:PLATYPUS_DATA_DIR = Join-Path $env:TEMP "pl-testdata"; npm test`.
- Prima di aprire una pull request: `npm test` deve passare. Le GitHub Actions lo eseguono su Windows, macOS e Linux.

## Aggiungere una lingua

1. Copia `src/i18n/locales/en` in `src/i18n/locales/<codice>` (es. `es`).
2. Traduci i valori: le chiavi sono il testo italiano e i segnaposto `{nome}` restano uguali.
3. Aggiungi la lingua a `LANGS` e `LOCALE_TAG` in `src/i18n/index.js`.
4. `npm run i18n:check` dice cosa manca.
