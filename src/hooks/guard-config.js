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

// Which hook event each mode fires on. The guard is wired on both events; this
// table is what decides which one actually produces output, so switching modes
// never requires re-running the installer.
//
// The two channels behave differently and that difference is the whole point:
//   systemMessage    — Claude Code prints the line itself. Costs nothing, and
//                      the model never learns the guard exists.
//   additionalContext — appended to the model's context. The model acts on it,
//                      which costs a model turn.
const MODE_EVENTS = {
  // Disabled. The hook still runs and still returns silently.
  'off': null,
  // Before the prompt: a directive tells the model to refuse and recite the
  // notice. Your prompt goes unanswered and the turn is spent on the warning.
  'warn': 'UserPromptSubmit',
  // Before the prompt: the same warning line, printed by Claude Code. The
  // prompt is answered normally and no turn is spent.
  'notice': 'UserPromptSubmit',
  // After the answer: warning printed under the finished reply. Free, and the
  // only mode with no measurement lag — Stop runs after the turn it measures.
  'after': 'Stop',
  // After the answer: the model speaks the notice. Costs a turn. Must respect
  // `stop_hook_active` or the conversation restarts forever.
  'after-nudge': 'Stop',
};

const MODES = Object.keys(MODE_EVENTS);

const DEFAULTS = {
  // One of MODES above. "warn" is the historical default and is kept as the
  // default so an upgrade does not silently change anyone's behaviour.
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
    if (MODES.includes(layer.mode)) config.mode = layer.mode;
    const limit = toPositiveInt(layer.limit);
    if (limit !== null) config.limit = limit;
    if (typeof layer.bypass === 'string' && layer.bypass) config.bypass = layer.bypass;
    const minRecords = toPositiveInt(layer.minRecords);
    if (minRecords !== null) config.minRecords = minRecords;
  }

  const envMode = process.env.CONTEXT_GUARD_MODE;
  if (MODES.includes(envMode)) config.mode = envMode;
  const envLimit = toPositiveInt(process.env.CONTEXT_GUARD_LIMIT);
  if (envLimit !== null) config.limit = envLimit;
  if (process.env.CONTEXT_GUARD_BYPASS) config.bypass = process.env.CONTEXT_GUARD_BYPASS;
  const envMin = toPositiveInt(process.env.CONTEXT_GUARD_MIN_RECORDS);
  if (envMin !== null) config.minRecords = envMin;

  return config;
}

module.exports = { DEFAULTS, MODES, MODE_EVENTS, resolveConfig, userConfigPath };
