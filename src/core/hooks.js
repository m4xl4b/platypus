'use strict';
// Installa / rimuove gli hook di Platypus in <config>/settings.json di Claude Code.
// Gli hook sono "async": non rallentano mai Claude Code. Se l'ufficio è chiuso, curl fallisce in silenzio.

const fs = require('fs');
const path = require('path');
const { claudeDir } = require('./sources');

const MARK = '/platypus-hook';
const LEGACY = '/agent-office-hook'; // hook installati quando l'app si chiamava Agent Office
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact',
];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

const PERM = MARK + '/permission';
function hookCommand(port, sync) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  // "@-" tra virgolette: funziona in Git Bash, cmd e PowerShell.
  // L'hook dei permessi è sincrono: l'ufficio può rispondere "consenti" o "rifiuta" al posto del terminale.
  return sync
    ? `${curl} -s -m 600 -X POST -H "Content-Type: application/json" --data-binary "@-" http://127.0.0.1:${port}${PERM}`
    : `${curl} -s -m 2 -X POST -H "Content-Type: application/json" --data-binary "@-" http://127.0.0.1:${port}${MARK}`;
}

function settingsPath(base) { return path.join(base || claudeDir(), 'settings.json'); }

function load(p) {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // se il file è JSON non valido meglio fermarsi che rovinarlo
}

// ---- hook di feedback (2.11): sincroni, dicono qualcosa all'agente. Si installano e si tolgono a parte da quelli
// che osservano, e solo con una conferma esplicita: per questo hanno un loro marcatore e non contano come "nostri" qui sotto.
const FEEDBACK = MARK + '/feedback';
const FEEDBACK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop'];
const FEEDBACK_TOOLS = 'Bash|PowerShell|Read|Glob|Grep|Edit|Write|MultiEdit';
// prima di un'azione (2.14, la paura): anche NotebookEdit e gli strumenti MCP, che possono mandare, pubblicare o cancellare
const FEAR_TOOLS = FEEDBACK_TOOLS + '|NotebookEdit|mcp__.*';
function isFeedback(h) { return !!h && [h.url, h.command].some(x => typeof x === 'string' && x.includes(FEEDBACK)); }

function isOurs(h) { return h && typeof h.command === 'string' && (h.command.includes(MARK) || h.command.includes(LEGACY)) && !isFeedback(h); }

function strip(settings, ours = isOurs) {
  if (!settings.hooks) return settings;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = [];
    for (const g of groups) {
      const hooks = (g.hooks || []).filter(h => !ours(h));
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const b = p + '.platypus-backup';
  if (fs.existsSync(p + '.agent-office-backup')) return p + '.agent-office-backup'; // copia originale già fatta dalla versione precedente
  if (!fs.existsSync(b)) fs.copyFileSync(p, b);
  return b;
}

function install({ port = 47800, base } = {}) {
  const p = settingsPath(base);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const settings = strip(load(p));
  const bk = backup(p);
  settings.hooks = settings.hooks || {};
  const cmd = hookCommand(port);
  for (const ev of EVENTS) {
    const group = ev === 'PermissionRequest'
      ? { hooks: [{ type: 'command', command: hookCommand(port, true), timeout: 610 }] }
      : { hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = '*';
    settings.hooks[ev] = [...(settings.hooks[ev] || []), group];
  }
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  return { path: p, backup: bk, events: EVENTS.length };
}

function uninstall({ base } = {}) {
  const p = settingsPath(base);
  if (!fs.existsSync(p)) return { path: p, removed: false };
  const settings = strip(load(p));
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  return { path: p, removed: true };
}

function status({ base } = {}) {
  try {
    const s = load(settingsPath(base));
    return !!(s.hooks && Object.values(s.hooks).some(gs => (gs || []).some(g => (g.hooks || []).some(isOurs))));
  } catch { return false; }
}

// installati da una versione precedente, senza l'hook sincrono dei permessi
function outdated({ base } = {}) {
  try {
    const s = load(settingsPath(base));
    const groups = (s.hooks && s.hooks.PermissionRequest) || [];
    const legacy = Object.values(s.hooks || {}).some(gs => (gs || []).some(g => (g.hooks || []).some(h => typeof h.command === 'string' && h.command.includes(LEGACY))));
    return legacy || !groups.some(g => (g.hooks || []).some(h => isOurs(h) && h.command.includes(PERM)));
  } catch { return false; }
}

// ---- hook di feedback: quello che si scrive, e niente altro
// Di base sono hook "http" (Claude Code manda da solo la richiesta, e se Platypus è chiuso prosegue); con curl: true
// lo stesso comando degli hook che osservano, per le versioni di Claude Code senza hook http.
function feedbackGroups({ port = 47800, curl = false } = {}) {
  const url = `http://127.0.0.1:${port}${FEEDBACK}`;
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const hook = curl
    ? { type: 'command', command: `${exe} -s -m 2 -X POST -H "Content-Type: application/json" --data-binary "@-" ${url}`, timeout: 3 }
    : { type: 'http', url, timeout: 3 };
  const out = {};
  for (const ev of FEEDBACK_EVENTS) out[ev] = TOOL_EVENTS.has(ev) ? { matcher: ev === 'PreToolUse' ? FEAR_TOOLS : FEEDBACK_TOOLS, hooks: [hook] } : { hooks: [hook] };
  return out;
}

// le righe che l'installazione aggiunge, da mostrare prima di chiedere la conferma
function feedbackPreview(opts = {}) {
  const groups = feedbackGroups(opts);
  return { path: settingsPath(opts.base), events: FEEDBACK_EVENTS.length, text: JSON.stringify({ hooks: Object.fromEntries(Object.entries(groups).map(([ev, g]) => [ev, [g]])) }, null, 2) };
}

function installFeedback({ port = 47800, base, curl = false } = {}) {
  const p = settingsPath(base);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const settings = strip(load(p), isFeedback); // due installazioni di fila non raddoppiano
  const bk = backup(p);
  settings.hooks = settings.hooks || {};
  for (const [ev, g] of Object.entries(feedbackGroups({ port, curl }))) settings.hooks[ev] = [...(settings.hooks[ev] || []), g];
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  return { path: p, backup: bk, events: FEEDBACK_EVENTS.length };
}

function uninstallFeedback({ base } = {}) {
  const p = settingsPath(base);
  if (!fs.existsSync(p)) return { path: p, removed: false };
  const before = load(p);
  const had = feedbackIn(before);
  if (had) fs.writeFileSync(p, JSON.stringify(strip(before, isFeedback), null, 2) + '\n');
  return { path: p, removed: had };
}

const feedbackIn = s => !!(s.hooks && Object.values(s.hooks).some(gs => (gs || []).some(g => (g.hooks || []).some(isFeedback))));
function feedbackStatus({ base } = {}) {
  try { return feedbackIn(load(settingsPath(base))); } catch { return false; }
}
// installati prima della 2.14: senza PreToolUse la paura non arriva all'agente (nemmeno in ombra). Si reinstallano dalle opzioni
function feedbackOutdated({ base } = {}) {
  try {
    const s = load(settingsPath(base));
    return feedbackIn(s) && !((s.hooks && s.hooks.PreToolUse) || []).some(g => (g.hooks || []).some(isFeedback));
  } catch { return false; }
}

module.exports = {
  install, uninstall, status, outdated, hookCommand, MARK, LEGACY, PERM, EVENTS,
  installFeedback, uninstallFeedback, feedbackStatus, feedbackOutdated, feedbackPreview, FEEDBACK, FEEDBACK_EVENTS, FEEDBACK_TOOLS, FEAR_TOOLS,
};
