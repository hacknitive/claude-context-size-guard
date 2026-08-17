// claude-context-size-guard — configuration resolution.
//
// Priority, highest first:
//   1. Environment variables (CONTEXT_GUARD_LIMIT, _MODE, _BYPASS, _MIN_RECORDS)
//   2. Repo-local config, walking up from cwd: ./.context-guard.json
//      or ./.context-guard/config.json
//   3. User config: ~/.config/claude-context-size-guard/config.json
//      (%APPDATA%\claude-context-size-guard\config.json on Windows)
//   4. Built-in defaults below
//
// Config resolution never throws. A malformed config file is ignored rather
// than crashing the hook — a crashing UserPromptSubmit hook shows a red banner
// on every prompt, which is worse than silently using defaults.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  // "warn"  — prompt goes through; a directive is injected telling the
  //           assistant to answer with a short notice instead. Visible.
  // "block" — prompt is discarded via {"decision":"block"}. Claude Code
  //           renders neither `reason` nor `systemMessage` for a blocked
  //           UserPromptSubmit, so the prompt vanishes with no explanation on
  //           screen. Kept for reference; "warn" is the mode that communicates.
  mode: 'warn',
  // Estimated tokens of live context before the guard fires. 100,000 suits a
  // 200k window (fires at half full, early enough that /compact still has
  // room to work). On a 1M window, 200000–400000 is reasonable.
  limit: 100000,
  // Prompt prefix that skips the guard for that one prompt.
  bypass: '!!',
  // Below this many transcript records since the last compact boundary, never
  // fire: there is nothing left to compact, so firing would trap the session.
  minRecords: 5,
};

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function repoConfig(startDir) {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    const found =
      readJsonFile(path.join(dir, '.context-guard.json')) ||
      readJsonFile(path.join(dir, '.context-guard', 'config.json'));
    if (found) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function userConfigPath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'claude-context-size-guard', 'config.json');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'claude-context-size-guard', 'config.json');
}

function toPositiveInt(value) {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolveConfig(cwd) {
  const config = Object.assign({}, DEFAULTS);

  const layers = [readJsonFile(userConfigPath()), repoConfig(cwd || process.cwd())];
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.mode === 'warn' || layer.mode === 'block') config.mode = layer.mode;
    const limit = toPositiveInt(layer.limit);
    if (limit !== null) config.limit = limit;
    if (typeof layer.bypass === 'string' && layer.bypass) config.bypass = layer.bypass;
    const minRecords = toPositiveInt(layer.minRecords);
    if (minRecords !== null) config.minRecords = minRecords;
  }

  const envMode = process.env.CONTEXT_GUARD_MODE;
  if (envMode === 'warn' || envMode === 'block') config.mode = envMode;
  const envLimit = toPositiveInt(process.env.CONTEXT_GUARD_LIMIT);
  if (envLimit !== null) config.limit = envLimit;
  if (process.env.CONTEXT_GUARD_BYPASS) config.bypass = process.env.CONTEXT_GUARD_BYPASS;
  const envMin = toPositiveInt(process.env.CONTEXT_GUARD_MIN_RECORDS);
  if (envMin !== null) config.minRecords = envMin;

  return config;
}

module.exports = { DEFAULTS, resolveConfig, userConfigPath };
