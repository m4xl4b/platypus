'use strict';
// Le regole del rischio (2.14, R1): una tabella di dati, niente logica. Chi le riconosce è risk.js.
// Ogni regola ha:
//   level     1 attenzione · 2 pericolo · 3 irreversibile
//   category  git · files · sql · infra · publish · system · mcp · deps · config · secrets
//   reach     fin dove arriva il danno: file < project < machine < remote
//   shape     la forma del comando con gli argomenti sostituiti: è l'unica cosa del comando che finisce nello storico.
//             In inglese, come i comandi: è un dato salvato (e la chiave delle cicatrici), non un testo da tradurre
//   text      perché è rischiosa, in una riga
//   undo      come si torna indietro, oppure null quando non si può
//   prudence  quali prudenze contano per questa regola (le calcola prudence.js, R2):
//             looked  ha guardato prima (git status, git diff, ls, lettura del bersaglio, plan, SELECT)
//             backup  c'è una copia di sicurezza (commit, stash, branch, copia del bersaglio)
//             dryrun  l'ha provata a vuoto (--dry-run, -n, --what-if, plan)
//             clean   l'albero di lavoro è pulito
//             asked   l'ha chiesto l'utente
// I testi passano da tr(): l'italiano è la chiave, l'inglese sta in src/i18n/locales/en/fear.json.

const { tr } = require('../i18n');

const rule = (level, category, reach, shape, text, undo, prudence) => ({ level, category, reach, shape, text, undo, prudence });

const RULES = {
  // ------------------------------------------------------------------ 1 · attenzione
  'many-files': rule(1, 'files', 'project', '', () => tr('più di 20 file modificati in un solo turno'), () => tr('git diff mostra tutto; git checkout rimette i file tracciati'), ['backup', 'clean']),
  'lockfile': rule(1, 'deps', 'project', '', () => tr('riscrive un lockfile delle dipendenze'), () => tr('git checkout del lockfile, poi reinstallare'), ['backup', 'asked']),
  'deps-added': rule(1, 'deps', 'project', '<manager> install <package>', () => tr('aggiunge una dipendenza'), () => tr('togliere il pacchetto e rimettere il lockfile di prima'), ['asked']),
  'ci-config': rule(1, 'config', 'project', '', () => tr('cambia la configurazione del progetto o della CI'), () => tr('git checkout del file'), ['looked', 'asked']),
  'env-file': rule(1, 'secrets', 'project', '', () => tr('tocca un file .env'), null, ['looked', 'backup', 'asked']),
  'git-discard-file': rule(1, 'git', 'file', 'git checkout -- <file>', () => tr('butta le modifiche non salvate di un file'), null, ['looked', 'backup', 'asked']),
  'git-push-force-feature': rule(1, 'git', 'remote', 'git push --force <branch>', () => tr('riscrive un branch remoto di lavoro'), () => tr('chi ha i commit vecchi può rispingerli; git reflog li conserva qui'), ['looked', 'asked']),

  // ------------------------------------------------------------------ 2 · pericolo
  'git-reset-hard': rule(2, 'git', 'project', 'git reset --hard <ref>', () => tr('butta tutte le modifiche non salvate in un commit'), () => tr('i commit si ritrovano con git reflog; le modifiche mai salvate no'), ['looked', 'backup', 'clean', 'asked']),
  'git-discard': rule(2, 'git', 'project', 'git checkout -- <paths>', () => tr('butta le modifiche non salvate di più file'), null, ['looked', 'backup', 'clean', 'asked']),
  'git-clean': rule(2, 'git', 'project', 'git clean -fd', () => tr('cancella i file che git non conosce'), null, ['looked', 'dryrun', 'backup', 'asked']),
  'git-stash-drop': rule(2, 'git', 'project', 'git stash drop', () => tr('butta via del lavoro messo da parte'), () => tr('per poco si ritrova con git fsck --lost-found'), ['looked', 'asked']),
  'git-rebase': rule(2, 'git', 'project', 'git rebase <ref>', () => tr('riscrive la storia dei commit'), () => tr('git rebase --abort a metà; dopo, git reflog'), ['looked', 'backup', 'clean', 'asked']),
  'git-branch-delete': rule(2, 'git', 'project', 'git branch -D <branch>', () => tr('cancella un branch anche se non è fuso'), () => tr('git reflog conserva la punta del branch per un po\''), ['looked', 'asked']),
  'git-rewrite': rule(2, 'git', 'project', 'git <history rewrite>', () => tr('riscrive o cancella la storia di git'), null, ['backup', 'asked']),
  'git-push-force': rule(2, 'git', 'remote', 'git push --force', () => tr('riscrive un branch remoto, e non si sa quale'), () => tr('chi ha i commit vecchi può rispingerli'), ['looked', 'asked']),
  'git-push-delete': rule(2, 'git', 'remote', 'git push --delete <branch>', () => tr('cancella un branch remoto'), () => tr('rispingere il branch, se qualcuno lo ha ancora'), ['looked', 'asked']),
  'rm-recursive': rule(2, 'files', 'project', 'rm -r <path>', () => tr('cancella una cartella che git forse non conosce'), null, ['looked', 'backup', 'asked']),
  'rm-outside-file': rule(2, 'files', 'machine', 'rm <file outside the project>', () => tr('cancella un file fuori dal progetto'), null, ['looked', 'asked']),
  'find-delete': rule(2, 'files', 'project', 'find <path> -delete', () => tr('cancella tutto quello che find trova'), null, ['looked', 'dryrun', 'backup', 'asked']),
  'overwrite-untracked': rule(2, 'files', 'file', '', () => tr('scrive sopra un file che git non conosce'), null, ['looked', 'backup', 'asked']),
  'sudo': rule(2, 'system', 'machine', 'sudo <command>', () => tr('gira come amministratore'), null, ['asked']),
  'chmod-recursive': rule(2, 'system', 'project', 'chmod -R <mode> <path>', () => tr('cambia permessi o proprietario di una cartella intera'), null, ['looked', 'asked']),
  'pipe-to-shell': rule(2, 'system', 'machine', 'curl <url> | sh', () => tr('esegue uno script appena scaricato dalla rete'), null, ['looked', 'asked']),

  // ------------------------------------------------------------------ 3 · irreversibile
  'git-push-main': rule(3, 'git', 'remote', 'git push <remote> main', () => tr('spinge sul branch principale'), () => tr('un commit di revert; quello che è partito resta partito'), ['looked', 'asked']),
  'git-push-force-shared': rule(3, 'git', 'remote', 'git push --force <shared branch>', () => tr('riscrive un branch condiviso con altri'), null, ['looked', 'backup', 'asked']),
  'rm-home-root': rule(3, 'files', 'machine', 'rm -rf <home or root>', () => tr('cancella la home, la radice o una cartella che contiene il progetto'), null, ['asked']),
  'rm-outside': rule(3, 'files', 'machine', 'rm -rf <path outside the project>', () => tr('cancella una cartella fuori dal progetto'), null, ['looked', 'backup', 'asked']),
  'rm-project-root': rule(3, 'files', 'project', 'rm -rf <the project>', () => tr('cancella il progetto intero o la sua storia git'), null, ['backup', 'asked']),
  'write-outside': rule(3, 'files', 'machine', '', () => tr('scrive fuori dalla cartella di lavoro'), null, ['looked', 'asked']),
  'disk-write': rule(3, 'system', 'machine', 'dd of=<disk>', () => tr('scrive direttamente su un disco'), null, ['asked']),
  'sql-drop': rule(3, 'sql', 'remote', 'DROP <object>', () => tr('cancella tabelle o database interi'), () => tr('solo da un backup del database'), ['looked', 'backup', 'asked']),
  'sql-truncate': rule(3, 'sql', 'remote', 'TRUNCATE <table>', () => tr('svuota una tabella'), () => tr('solo da un backup del database'), ['looked', 'backup', 'asked']),
  'sql-delete-all': rule(3, 'sql', 'remote', 'DELETE FROM <table>', () => tr('cancella tutte le righe: manca il WHERE'), () => tr('solo da un backup del database'), ['looked', 'backup', 'asked']),
  'sql-update-all': rule(3, 'sql', 'remote', 'UPDATE <table> SET …', () => tr('cambia tutte le righe: manca il WHERE'), () => tr('solo da un backup del database'), ['looked', 'backup', 'asked']),
  'db-reset': rule(3, 'sql', 'remote', '<tool> db reset', () => tr('azzera un database'), () => tr('solo da un backup del database'), ['backup', 'asked']),
  'terraform-apply': rule(3, 'infra', 'remote', 'terraform apply', () => tr('cambia o distrugge infrastruttura vera'), null, ['dryrun', 'looked', 'asked']),
  'kubectl-delete': rule(3, 'infra', 'remote', 'kubectl delete <resource>', () => tr('cancella risorse da un cluster'), null, ['looked', 'dryrun', 'asked']),
  'helm-uninstall': rule(3, 'infra', 'remote', 'helm uninstall <release>', () => tr('toglie un\'applicazione da un cluster'), null, ['looked', 'dryrun', 'asked']),
  'docker-prune': rule(3, 'infra', 'machine', 'docker system prune -a', () => tr('cancella immagini, container e cache di Docker'), null, ['looked', 'asked']),
  'docker-volume-rm': rule(3, 'infra', 'machine', 'docker volume rm <volume>', () => tr('cancella volumi di Docker con i loro dati'), null, ['looked', 'backup', 'asked']),
  'cloud-delete': rule(3, 'infra', 'remote', '<cloud> delete <resource>', () => tr('cancella risorse nel cloud'), null, ['looked', 'dryrun', 'asked']),
  'publish': rule(3, 'publish', 'remote', '<tool> publish', () => tr('pubblica: quello che esce non si ritira'), null, ['dryrun', 'looked', 'asked']),
  'deploy': rule(3, 'publish', 'remote', '<tool> deploy', () => tr('mette in produzione'), () => tr('rimettere in produzione la versione di prima'), ['dryrun', 'looked', 'asked']),
  'gh-delete': rule(3, 'publish', 'remote', 'gh <what> delete', () => tr('cancella un repository o una release su GitHub'), null, ['looked', 'asked']),
  'mcp-external': rule(3, 'mcp', 'remote', '', () => tr('uno strumento esterno che manda, pubblica, paga o cancella'), null, ['asked']),
  'secret-then-network': rule(3, 'secrets', 'remote', '', () => tr('ha letto dei segreti e ora chiama la rete'), null, ['asked']),
};

// cartelle e file che tornano con un comando: cancellarli non è un rischio
const REGENERABLE = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv', 'tmp', 'temp', '.tmp', '.gradle', '.angular', '.svelte-kit',
  'storybook-static', '.eslintcache', '.nyc_output', 'obj', '.platypus-dev', '.ds_store', 'thumbs.db']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'cargo.lock', 'poetry.lock',
  'pipfile.lock', 'uv.lock', 'gemfile.lock', 'composer.lock', 'go.sum', 'packages.lock.json', 'flake.lock']);
// configurazione del progetto e della CI (nomi di file, tutti minuscoli) e cartelle
const CONFIG_FILES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'cargo.toml', 'go.mod', 'gemfile', 'composer.json', 'makefile',
  'dockerfile', 'jenkinsfile', '.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'tsconfig.json', '.npmrc', '.gitattributes',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'vercel.json', 'netlify.toml', 'fly.toml', 'wrangler.toml']);
const CONFIG_DIRS = ['.github/', '.circleci/', '.gitlab/', '.husky/', '.devcontainer/'];
const SHARED_BRANCHES = /^(main|master|develop|development|dev|trunk|staging|stage|production|prod|release|stable)$|^(release|hotfix)[/-]/i;
const MAIN_BRANCHES = /^(main|master)$/i;
// strumenti MCP: il nome dice un effetto fuori (R1); un verbo di lettura davanti lo esclude ("get_post", "list_shares")
const MCP_EFFECT = new Set(['send', 'post', 'delete', 'pay', 'transfer', 'publish', 'share']);
const MCP_READ = new Set(['get', 'list', 'read', 'search', 'fetch', 'find', 'view', 'show', 'describe', 'query', 'count', 'check', 'preview', 'draft']);

const REACH = ['file', 'project', 'machine', 'remote'];

module.exports = { RULES, REGENERABLE, LOCKFILES, CONFIG_FILES, CONFIG_DIRS, SHARED_BRANCHES, MAIN_BRANCHES, MCP_EFFECT, MCP_READ, REACH };
