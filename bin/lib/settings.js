// claude-context-size-guard — JSONC-tolerant settings.json reader/writer + hook
// merge helpers.
//
// Claude Code accepts `//` and `/* */` comments in settings.json. `JSON.parse`
// does not. If we crash on a commented settings.json the installer looks
// broken to any user who added a comment. Strip comments before parsing;
// preserving formatting on write is a non-goal (settings.json edits are rare).

const fs = require('fs');
const path = require('path');

// Strip JS-style comments while respecting string literals.
function stripJsonComments(input) {
  let out = '';
  let i = 0;
  const n = input.length;
  let inStr = false;
  let strCh = null;
  while (i < n) {
    const c = input[i];
    const next = input[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += input[i + 1]; i += 2; continue; }
      if (c === strCh) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  // Strip trailing commas in objects/arrays.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch (e) {
    throw new Error(
      `claude-context-size-guard: cannot parse ${settingsPath}: ${e.message}\n` +
      '  Fix the JSON by hand, then re-run. Nothing was changed.'
    );
  }
}

// Write via a temp file + rename so an interrupted install cannot leave a
// truncated settings.json behind. A .bak is kept, never clobbered.
function writeSettings(settingsPath, obj) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (fs.existsSync(settingsPath)) {
    let bak = settingsPath + '.bak';
    let n = 0;
    while (fs.existsSync(bak)) { n++; bak = `${settingsPath}.bak${n}`; }
    fs.copyFileSync(settingsPath, bak);
  }
  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, settingsPath);
}

// Every merged hook entry embeds this substring in its command so the
// uninstaller can strip our entries without touching entries other plugins
// have added. Changing this string orphans entries written by an earlier
// version — treat it as a stable identifier, not a cosmetic name.
const MARKER = 'context-size-guard';

function stripOurHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const eventName of Object.keys(settings.hooks)) {
    const groups = settings.hooks[eventName];
    if (!Array.isArray(groups)) continue;
    const filtered = groups
      .map(group => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const remaining = group.hooks.filter(
          h => !(h && typeof h.command === 'string' && h.command.includes(MARKER))
        );
        if (remaining.length === 0) return null;
        return Object.assign({}, group, { hooks: remaining });
      })
      .filter(g => g !== null);
    if (filtered.length === 0) delete settings.hooks[eventName];
    else settings.hooks[eventName] = filtered;
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return settings;
}

function ensureHook(settings, eventName, hookEntry) {
  settings.hooks = settings.hooks || {};
  settings.hooks[eventName] = settings.hooks[eventName] || [];
  // Idempotent: if a hook with the same command already exists, replace it.
  for (const group of settings.hooks[eventName]) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (let i = 0; i < group.hooks.length; i++) {
      if (group.hooks[i] && group.hooks[i].command === hookEntry.command) {
        group.hooks[i] = hookEntry;
        return;
      }
    }
  }
  settings.hooks[eventName].push({ hooks: [hookEntry] });
}

module.exports = { readSettings, writeSettings, stripJsonComments, stripOurHooks, ensureHook, MARKER };
