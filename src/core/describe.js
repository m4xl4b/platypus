'use strict';
// Traduce l'uso di uno strumento di Claude Code in una frase breve (nella lingua scelta).

const path = require('path');
const { tr } = require('../i18n');

function base(p) {
  if (!p || typeof p !== 'string') return '';
  return path.basename(p.replace(/\\/g, '/'));
}

function clip(s, n = 60) {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function host(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return clip(u, 30); }
}

function describeTool(name, input) {
  input = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description ? clip(input.description) : tr('Esegue: {cmd}', { cmd: clip(input.command, 50) });
    case 'BashOutput':
      return tr('Controlla un processo in background');
    case 'KillShell':
    case 'KillBash':
      return tr('Ferma un processo');
    case 'Read':
      return tr('Legge {file}', { file: base(input.file_path || input.path) });
    case 'Edit':
    case 'MultiEdit':
      return tr('Modifica {file}', { file: base(input.file_path) });
    case 'Write':
      return tr('Scrive {file}', { file: base(input.file_path) });
    case 'NotebookEdit':
      return tr('Modifica il notebook {file}', { file: base(input.notebook_path) });
    case 'Grep':
      return tr('Cerca "{q}"', { q: clip(input.pattern, 30) });
    case 'Glob':
      return tr('Cerca file {q}', { q: clip(input.pattern, 30) });
    case 'LS':
      return tr('Guarda la cartella {dir}', { dir: base(input.path) });
    case 'WebFetch':
      return tr('Legge dal web: {host}', { host: host(input.url) });
    case 'WebSearch':
      return tr('Cerca sul web: {q}', { q: clip(input.query, 40) });
    case 'Task':
    case 'Agent':
      return tr('Assegna a {who}: {what}', { who: input.subagent_type || tr('un agente'), what: clip(input.description, 40) });
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'mcp__ccd_turn__update_plan':
      return tr('Aggiorna la lista delle cose da fare');
    case 'Skill':
      return tr('Usa la skill {name}', { name: clip(input.skill || input.command, 30) });
    case 'AskUserQuestion':
      return tr('Ti fa una domanda');
    case 'ExitPlanMode':
      return tr('Ti presenta il piano');
    case 'SendUserMessage':
      return tr('Ti scrive un messaggio');
    case 'SendUserFile':
      return tr('Ti manda un file');
    case 'SubagentHandback':
      return tr('Consegna il resoconto');
    case 'mcp__ccd_turn__wrap_up':
      return tr('Chiude il turno con un riepilogo');
    case 'SendMessage':
      return input.to || input.recipient ? tr('Scrive a {who}', { who: clip(String(input.to || input.recipient), 24) }) : tr('Scrive a un collega');
    case 'Workflow':
      return input.description ? tr('Lancia il workflow «{what}»', { what: clip(input.description, 40) }) : tr('Lancia un workflow');
    case 'ToolSearch':
      return tr('Cerca uno strumento');
    default:
      if (name && name.startsWith('mcp__')) {
        const parts = name.split('__');
        return tr('Usa {tool}: {what}', { tool: parts[1] || 'MCP', what: clip((parts.slice(2).join(' ') || '').replace(/_/g, ' '), 30) });
      }
      return tr('Usa {tool}', { tool: name || tr('uno strumento') });
  }
}

module.exports = { describeTool, clip, base };
