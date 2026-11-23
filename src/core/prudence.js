'use strict';
// La prudenza (2.14, R2): prima di un'azione rischiosa, l'agente ha fatto qualcosa per non farsi male?
//   assess({ risk, action, steps, prompt }) → { score 0–1, present, missing, probable }
//     risk    il risultato di risk.classify() per l'azione
//     action  { tool, input } dell'azione
//     steps   i passi recenti di quell'agente (quelli di worldmap.js: { t, tool, act, target, sig, err, clean }), il più recente per ultimo
//     prompt  l'ultimo messaggio dell'utente: si legge qui e basta, non viene mai conservato
//     hints   altri nomi del bersaglio che il comando non scrive (il branch corrente di un "git push")
// Legge soltanto, come il classificatore: niente comandi, niente file, niente rete.
// Contano solo le prudenze che la regola dichiara (risk.prudence): per "sudo" conta solo che l'utente l'abbia chiesto.
//   looked  ha guardato prima: git status/diff/log, ls o lettura del bersaglio, terraform plan, un SELECT sulla stessa tabella
//   backup  una copia di sicurezza: commit, stash, branch, tag, copia del bersaglio, dump del database
//   dryrun  l'ha provata a vuoto: lo stesso comando con --dry-run, -n, --what-if, oppure plan/preview
//   clean   l'albero di lavoro è pulito: l'ultimo git status lo diceva e da allora non ha modificato file
//   asked   l'ha chiesto l'utente: il verbo e il bersaglio stanno nel suo ultimo messaggio (lessicale: è solo "probabile")
// Il punteggio: ogni prudenza presente porta il suo peso, fino a 1. Guardare da solo non basta (0,3):
// una paura mancata è un'azione di livello 2 o più con meno di 0,5.

const WINDOW = 12; // quante azioni indietro si guarda
const WEIGHT = { looked: 0.3, backup: 0.6, dryrun: 0.6, clean: 0.7, asked: 0.6 };
const MISSED_BELOW = 0.5;

const cmdOf = s => { const g = String((s && s.sig) || ''); return g.startsWith('run:') ? g.slice(4) : ''; };
const lower = s => String(s || '').toLowerCase();
const baseOf = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// i comandi di una riga, senza "cd …" e variabili davanti
const segments = cmd => String(cmd).split(/&&|\|\||;|\n|\|/).map(x => x.trim().replace(/^(sudo|time|nohup|env)\s+/, '').replace(/^([A-Za-z_]\w*=\S*\s+)+/, '')).filter(Boolean);

// guardare: che cosa conta per ogni categoria di rischio
const LOOK = {
  git: /^git\s+(-C\s+\S+\s+)?(status|diff|log|show|stash\s+(list|show)|branch(\s+(-a|-v|-vv|--list|-r))*\s*$|remote\s+-v|reflog|ls-files|fetch\b.*--dry-run)/,
  files: /^(ls|ll|dir|tree|du|stat|find(?!.*\s-(delete|exec))|get-childitem|gci|test-path|cat|head|tail|less|wc|file|git\s+(status|ls-files|clean\s+-[a-z]*n))\b/i,
  sql: /\bselect\b[\s\S]*\bfrom\b|\\d[t+]?\b|\bshow\s+(tables|databases|create)\b|\bdescribe\b|\bexplain\b|\.tables|\.schema|\bcount\s*\(/i,
  infra: /^(terraform|tofu|terragrunt)\s+(plan|show|state\s+list)|^pulumi\s+preview|^(kubectl|oc|k)\s+(get|describe|diff|config\s+current-context)|^helm\s+(list|ls|status|get|diff)|^(docker|podman)\s+(ps|images|volume\s+(ls|inspect)|system\s+df|compose\s+ps)|^aws\s+\S+\s+(ls|describe|list|get)|^(gcloud|az)\b.*\b(list|describe|show)\b/i,
  publish: /^(npm|pnpm|yarn)\s+(pack|view|info|whoami)|^git\s+(status|log|diff|tag)|^gh\s+(release|pr|repo)\s+(list|view|status)|^(cargo)\s+(package|publish\s+--dry-run)|^(vercel|netlify|fly)\s+(ls|list|status|inspect)/i,
  system: /^(ls|stat|id|whoami|cat|head|less|get-acl|icacls\s+\S+\s*$)\b/i,
  deps: /^(npm|pnpm|yarn)\s+(ls|list|outdated|view|info)|^pip\s+(show|list)|^git\s+(status|diff)/i,
  config: /^git\s+(status|diff)|^(cat|head|less)\b/i,
  secrets: /^git\s+(status|diff)|^(ls|cat|head)\b/i,
};
const BACKUP = /^git\s+(-C\s+\S+\s+)?(commit\b(?!.*--amend)|stash(\s+(push|save|-u|-a|--include-untracked|-m\b.*))?\s*$|stash\s+(push|save)\b|branch\s+(?!-)[\w./-]+|checkout\s+-b\b|switch\s+-c\b|tag\s+(?!-d\b|-l\b|--list\b)[\w./-]+|bundle\s+create|worktree\s+add)/;
const DUMP = /^(pg_dump|pg_dumpall|mysqldump|mongodump|sqlite3\b.*\.(backup|dump)|redis-cli\b.*\b(save|bgsave)\b)/i;
const COPY = /^(cp\s+-[a-zA-Z]*[rRa]|cp\b|tar\s+-?[a-zA-Z]*c|zip\b|rsync\b(?!.*--delete)|copy-item|cpi\b|robocopy\b(?!.*\/(mir|purge))|xcopy\b|compress-archive)/i;
const DRY = /(^|\s)(--dry-run(=\S+)?|--dryrun|--what-if|-whatif|--check|--simulate|--no-act|-n)(\s|$)/i;
const PLAN = /^(terraform|tofu|terragrunt)\s+plan\b|^pulumi\s+preview\b|^git\s+clean\s+-[a-zA-Z]*n|^(kubectl|oc|k)\s+diff\b|^helm\s+diff\b/i;

// i verbi con cui una persona chiede quell'azione, in italiano e in inglese
const VERBS = {
  git: /\b(reset|hard|ripristin\w*|scart\w*|discard\w*|butt\w*|annull\w*|undo|revert\w*|rebase|ribas\w*|clean|pulisc\w*|puli\w*|drop|stash|force\w*|forz\w*|push\w*|spin\w*|cancell\w*|elimin\w*|delete|remove|rimuov\w*|togli\w*|riscriv\w*|rewrite)\b/i,
  files: /\b(rm|remove|delete|cancell\w*|elimin\w*|rimuov\w*|togli\w*|pulisc\w*|puli\w*|clean\w*|svuot\w*|wipe|sovrascriv\w*|overwrite|scriv\w*|write|sposta\w*|move|copia\w*|copy)\b/i,
  sql: /\b(drop|truncate|delete|update|cancell\w*|elimin\w*|svuot\w*|azzer\w*|reset|aggiorn\w*|rimuov\w*|wipe|flush)\b/i,
  infra: /\b(apply|applic\w*|destroy|distrugg\w*|delete|cancell\w*|elimin\w*|uninstall|disinstall\w*|rimuov\w*|prune|pulisc\w*|teardown|smont\w*|termin\w*)\b/i,
  publish: /\b(publish\w*|pubblic\w*|release|rilasci\w*|deploy\w*|produzione|production|prod|ship|push\w*|spin\w*|upload|caric\w*|delete|cancell\w*|elimin\w*)\b/i,
  system: /\b(sudo|root|admin\w*|amministrator\w*|chmod|chown|permess\w*|permission\w*|install\w*|esegui\w*|run|lancia\w*|script)\b/i,
  deps: /\b(install\w*|add|aggiung\w*|dipendenz\w*|dependenc\w*|package|pacchett\w*|lockfile|aggiorn\w*|update|upgrade)\b/i,
  config: /\b(config\w*|ci|workflow|pipeline|modific\w*|cambia\w*|change|edit|aggiorn\w*|update|fix|sistem\w*)\b/i,
  secrets: /\b(env|segret\w*|secret\w*|chiav\w*|key|token|variabil\w*|variable\w*|manda\w*|invia\w*|send|upload|caric\w*)\b/i,
  mcp: /\b(send|manda\w*|invia\w*|spedisc\w*|post\w*|pubblic\w*|publish\w*|share|condivid\w*|pay|paga\w*|transfer\w*|trasfer\w*|delete|cancell\w*|elimin\w*)\b/i,
};
// parole del comando che non dicono niente sul bersaglio
const NOISE = new Set(['git', 'sudo', 'origin', 'upstream', 'head', 'rm', 'the', 'and', 'psql', 'mysql', 'from', 'table', 'set', 'where', 'into', 'bash', 'sh', 'cmd', 'true', 'false', 'null', 'npm', 'npx', 'docker', 'aws', 'echo', 'cat', 'yes']);

function commandText(action) {
  const inp = (action && action.input) || {};
  return String(inp.command || inp.sql || inp.query || inp.file_path || '');
}
// le parole del comando che una persona nominerebbe: il branch, la tabella, la cartella, lo strumento
function targetWords(action, risk) {
  const out = new Set();
  for (const t of (risk.targets || [])) { out.add(lower(baseOf(t))); out.add(lower(t)); }
  const text = commandText(action);
  for (const w of text.split(/[\s"'`;|&()=<>,]+/)) {
    if (!w || w.startsWith('-') || w.length < 3 || /[$%]/.test(w)) continue;
    const b = lower(baseOf(w).replace(/^[+:]/, '').replace(/\.(js|ts|json|md|sql|yml|yaml)$/, m => m));
    if (b.length >= 3 && !NOISE.has(b)) out.add(b);
  }
  if (action && /^mcp__/.test(String(action.tool))) for (const w of String(action.tool).split(/__|_/)) if (w.length >= 3 && w !== 'mcp') out.add(lower(w));
  return [...out].filter(Boolean);
}

function assess({ risk, action, steps, prompt, hints } = {}) {
  const none = { score: 0, present: [], missing: [], probable: [] };
  if (!risk || !risk.level) return { ...none, score: 1 };
  const counts = Array.isArray(risk.prudence) ? risk.prudence : [];
  if (!counts.length) return none;
  const recent = (Array.isArray(steps) ? steps : []).slice(-WINDOW).filter(s => s && s.err !== true);
  const cmds = recent.map(s => ({ s, segs: segments(cmdOf(s)) }));
  const text = commandText(action);
  const mine = segments(text);
  const head = lower((mine.find(x => !/^(cd|pushd)\b/.test(x)) || '').split(/\s+/)[0]).replace(/^.*[\\/]/, '');
  // hints: altri nomi del bersaglio che il comando non scrive (il branch corrente di un "git push")
  const targets = targetWords(action, risk).concat((Array.isArray(hints) ? hints : []).map(x => lower(x)).filter(x => x.length >= 3));
  const mentions = str => { const l = lower(str); return (risk.targets || []).some(t => { const b = lower(baseOf(t)); return b && (l.includes(lower(t)) || new RegExp('(^|[\\s/\\\\"\'])' + esc(b) + '($|[\\s/\\\\"\'])').test(l)); }); };
  const present = new Set();

  // guardato prima
  if (counts.includes('looked')) {
    const re = LOOK[risk.category];
    const hasTargets = (risk.targets || []).length > 0;
    const table = (/\b(?:from|update|table|truncate)\s+(?:table\s+)?(?:if\s+exists\s+)?["`]?([\w.]+)/i.exec(text) || [])[1];
    for (const { s, segs } of cmds) {
      // leggere o cercare proprio il bersaglio vale sempre
      if ((s.act === 'read' || s.act === 'search') && s.target && mentions(s.target)) { present.add('looked'); break; }
      if (!re) continue;
      const hit = segs.find(x => re.test(x));
      if (!hit) continue;
      if (risk.category === 'sql') { if (!table || lower(hit).includes(lower(table)) || !/\bselect\b/i.test(hit)) { present.add('looked'); break; } continue; }
      // sui file: guardare un'altra cartella non conta, ma un "ls" o "git status" senza percorso sì
      if (risk.category === 'files' && hasTargets && !/^git\s/.test(hit) && hit.split(/\s+/).filter(w => !w.startsWith('-')).length > 1 && !mentions(hit)) continue;
      present.add('looked'); break;
    }
  }
  // copia di sicurezza
  if (counts.includes('backup')) {
    for (const { segs } of cmds) {
      if (segs.some(x => BACKUP.test(x))) { if (risk.category !== 'sql' && risk.category !== 'infra') { present.add('backup'); break; } }
      if (segs.some(x => DUMP.test(x)) && risk.category === 'sql') { present.add('backup'); break; }
      if (segs.some(x => COPY.test(x) && ((risk.targets || []).length ? mentions(x) : risk.category === 'files'))) { present.add('backup'); break; }
    }
  }
  // provata a vuoto
  if (counts.includes('dryrun')) {
    for (const { segs } of cmds) {
      if (segs.some(x => { const h = lower(x.split(/\s+/)[0]).replace(/^.*[\\/]/, ''); return h === head && (PLAN.test(x) || (DRY.test(x) && !/^git\s+(?!clean|push)/.test(x))); })) { present.add('dryrun'); break; }
    }
  }
  // albero pulito: l'ultimo git status lo diceva, e dopo non ha modificato niente
  if (counts.includes('clean')) {
    let clean = null;
    for (const s of recent) {
      if (typeof s.clean === 'boolean') clean = s.clean;
      else if (clean === true && (s.act === 'edit' || /^git\s+(merge|pull|cherry-pick|apply|am|stash\s+(pop|apply))\b/.test(segments(cmdOf(s))[0] || ''))) clean = false;
    }
    if (clean === true) present.add('clean');
  }
  // l'ha chiesto l'utente (lessicale)
  const probable = [];
  if (counts.includes('asked') && prompt) {
    const p = lower(String(prompt).slice(0, 4000));
    const verbs = VERBS[risk.category];
    const literal = mine.some(x => { const w = lower(x).split(/\s+/).filter(Boolean); return w.length >= 2 && p.includes(w.slice(0, 2).join(' ')) && !/^(cd|echo)\b/.test(w[0]); });
    const named = targets.some(t => new RegExp('(^|[^\\w])' + esc(t) + '($|[^\\w])').test(p));
    // per uno strumento esterno basta il verbo: il suo nome tecnico ("gmail", "message") l'utente non lo scrive
    if (literal || (verbs && verbs.test(p) && (named || !targets.length || risk.category === 'mcp'))) { present.add('asked'); probable.push('asked'); }
  }

  const here = counts.filter(k => present.has(k));
  const score = Math.min(1, Math.round(here.reduce((n, k) => n + WEIGHT[k], 0) * 100) / 100);
  return { score, present: here, missing: counts.filter(k => !present.has(k)), probable };
}

// le prudenze mancanti dette in parole, nella lingua di adesso ("fai un commit o una copia")
function adviceFor(kinds) {
  const { tr } = require('../i18n');
  const text = {
    looked: () => tr('guarda che cosa c\'è'), backup: () => tr('fai un commit o una copia'), dryrun: () => tr('provala a vuoto'),
    clean: () => tr('parti da un albero di lavoro pulito'), asked: () => tr('chiedi all\'utente'),
  };
  return (Array.isArray(kinds) ? kinds : String(kinds || '').split(',')).map(k => String(k).trim()).filter(k => text[k]).map(k => text[k]());
}

// paura mancata: un'azione di livello 2 o più senza abbastanza prudenza
const missedFear = (risk, prudence) => !!risk && risk.level >= 2 && (!prudence || prudence.score < MISSED_BELOW);

// quello che dice l'output di "git status": true pulito, false sporco, null non si capisce
function gitStatusClean(cmd, text) {
  if (!/(^|&&|;|\n)\s*git\s+(-C\s+\S+\s+)?status\b/.test(String(cmd))) return null;
  const t = String(text || '');
  if (/nothing to commit|working tree clean|nessuna modifica da committare/i.test(t)) return !/untracked files|file non tracciati/i.test(t);
  if (/\s(--porcelain|-s|--short)\b/.test(cmd) && !/\|/.test(cmd)) return t.trim() === '' || /^##[^\n]*$/.test(t.trim());
  if (/changes not staged|changes to be committed|untracked files|modified:|deleted:/i.test(t)) return false;
  return null;
}

module.exports = { assess, missedFear, gitStatusClean, adviceFor, WEIGHT, WINDOW, MISSED_BELOW };
