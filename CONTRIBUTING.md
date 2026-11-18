# Contributing

*Versione italiana: [CONTRIBUTING.it.md](CONTRIBUTING.it.md).*

```sh
git clone https://github.com/m4xl4b/platypus.git && cd platypus
PLATYPUS_DATA_DIR="$(mktemp -d)" npm test   # quick checks, no dependencies needed
npm run start:demo   # window with the demo (installs Electron on first run)
npm run web:demo     # the same in the browser
```

## House rules

- **The engine (`src/core`) has no npm dependencies**: Node.js modules only. That is what makes browser mode work without installing anything, and keeps a future move to other shells possible (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
- **Anything that depends on the operating system** goes in `src/core/osint.js`, `src/core/sources.js`, `src/core/hooks.js`, `src/autostart.js` or `scripts/`, and must have a behavior for Windows, macOS and Linux (even just a clear message).
- **Strings**: every visible string goes through `tr('Italian text', { placeholders })` or `trn(singular, plural, n)`. Don't use `t()`: it is the name of the time variable. After adding strings run `npm run i18n:check` and fill in `src/i18n/locales/en/*.json`.
- **Privacy**: no network calls apart from the (optional) weather. The server only listens on 127.0.0.1.
- **Tests never touch your real data**: they refuse to start unless `PLATYPUS_DATA_DIR` points into a temporary folder (`os.tmpdir()`, or `RUNNER_TEMP` in GitHub Actions). In PowerShell: `$env:PLATYPUS_DATA_DIR = Join-Path $env:TEMP "pl-testdata"; npm test`.
- Before opening a pull request, `npm test` must pass. GitHub Actions runs it on Windows, macOS and Linux.

## Adding a language

1. Copy `src/i18n/locales/en` to `src/i18n/locales/<code>` (e.g. `es`).
2. Translate the values: the keys are the Italian text, and `{name}` placeholders stay the same.
3. Add the language to `LANGS` and `LOCALE_TAG` in `src/i18n/index.js`.
4. `npm run i18n:check` tells you what is missing.
