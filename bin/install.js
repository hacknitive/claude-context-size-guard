#!/usr/bin/env node
// claude-context-size-guard — standalone Claude Code installer.
//
// Two install modes:
//   1. Plugin install (recommended): Claude Code's plugin loader reads
//      .claude-plugin/plugin.json directly. Nothing for this script to do.
//   2. Standalone install (this script): copies the hook into
//      $CLAUDE_CONFIG_DIR and merges UserPromptSubmit + Stop entries into
//      settings.json. Use when the plugin loader is unavailable, or when you
//      want a single-account, plugin-free wiring.
//
// Flags:
//   --dry-run       show planned changes, write nothing
//   --uninstall     strip our hook entry + delete our files
//   --config-dir P  install into P instead of $CLAUDE_CONFIG_DIR / ~/.claude
//   --all-accounts  install into every ~/.claude-* directory that looks like a
//                   Claude Code config dir. Convenience for multi-account setups.
//   --limit N       write {"limit": N} into the guard's config file
//   --mode M        write {"mode": M} into the guard's config file
//   --user-config P write those to P instead of the default config path.
//                   Required alongside --config-dir: that flag scopes the
//                   Claude config dir, not the guard's own config file, so
//                   without this a scoped install would still overwrite the
//                   real one.
//   --help          print usage

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readSettings, writeSettings, stripOurHooks, ensureHook } = require('./lib/settings');
const { userConfigPath, MODES, MODE_EVENTS } = require('../src/hooks/guard-config');

// Every event any mode can fire on. Derived from the mode registry so a new
// mode on a new event cannot be added without the installer wiring it.
const HOOK_EVENTS = [...new Set(Object.values(MODE_EVENTS).filter(Boolean))];

function log(msg) { process.stdout.write(msg + '\n'); }

function usage() {
  log('Usage: node bin/install.js [--dry-run] [--uninstall] [--config-dir PATH] [--all-accounts] [--limit N] [--mode M] [--user-config PATH]');
  log(`       modes: ${MODES.join(', ')}`);
}

function parseArgs(argv) {
  const args = { dryRun: false, uninstall: false, configDir: null, allAccounts: false, limit: null, mode: null, userConfig: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--uninstall') args.uninstall = true;
    else if (a === '--all-accounts') args.allAccounts = true;
    else if (a === '--config-dir') { args.configDir = argv[++i]; }
    else if (a === '--limit') { args.limit = parseInt(argv[++i], 10); }
    else if (a === '--mode') { args.mode = argv[++i]; }
    else if (a === '--user-config') { args.userConfig = argv[++i]; }
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { log(`unknown flag: ${a}`); usage(); process.exit(2); }
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    log('--limit must be a positive integer');
    process.exit(2);
  }
  if (args.mode !== null && !MODES.includes(args.mode)) {
    log(`--mode must be one of: ${MODES.join(', ')}`);
    process.exit(2);
  }
  // --config-dir scopes where the hook and settings.json go. The guard's own
  // config file lives outside that dir (XDG on POSIX, %APPDATA% on Windows),
  // so writing --limit/--mode during a scoped install would silently modify
  // the real user config -- which is never what someone installing into a
  // scratch dir wants. Refuse instead of guessing.
  if (args.configDir && args.userConfig === null && (args.limit !== null || args.mode !== null)) {
    log('--limit/--mode with --config-dir would write to the real user config:');
    log(`  ${userConfigPath()}`);
    log('Pass --user-config PATH to scope it, or drop --limit/--mode.');
    process.exit(2);
  }
  return args;
}

function resolveTargets(args) {
  if (args.configDir) return [path.resolve(args.configDir)];
  if (args.allAccounts) {
    const home = os.homedir();
    const primary = path.join(home, '.claude');
    const extras = fs.readdirSync(home)
      .filter(name => name.startsWith('.claude-'))
      .map(name => path.join(home, name))
      .filter(p => {
        try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
      });
    return [primary, ...extras].filter(p => fs.existsSync(p));
  }
  return [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')];
}

function copyTree(src, dst, dryRun) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (!dryRun) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dst, entry), dryRun);
    }
  } else {
    if (dryRun) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function removeTree(target, dryRun) {
  if (!fs.existsSync(target) || dryRun) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function writeUserConfig(key, value, dryRun, target) {
  const file = target || userConfigPath();
  let existing = {};
  try {
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) { existing = {}; }
  existing[key] = value;
  log(`  ${(key + ':').padEnd(12)} ${value} -> ${file}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
}

function install(target, args) {
  const repoRoot = path.resolve(__dirname, '..');
  const hooksSrc = path.join(repoRoot, 'src', 'hooks');
  const hooksDst = path.join(target, 'hooks', 'claude-context-size-guard');
  const settingsPath = path.join(target, 'settings.json');

  log(`[${target}] installing (dry-run=${args.dryRun})`);
  log(`  copy hooks:  ${hooksSrc} -> ${hooksDst}`);
  copyTree(hooksSrc, hooksDst, args.dryRun);

  let settings;
  try { settings = readSettings(settingsPath); }
  catch (e) { log(`  ! ${e.message}`); return; }

  // Both events are wired every time, whatever the configured mode. The hook
  // itself decides which one produces output, so switching mode later is a
  // config edit and never a reinstall. The marker (`context-size-guard`) is
  // part of the script path, so the uninstaller can strip both entries without
  // touching anyone else's hooks.
  const entry = {
    type: 'command',
    command: `node "${path.join(hooksDst, 'context-size-guard.js')}"`,
    timeout: 10,
    statusMessage: 'Checking context size...',
  };
  for (const event of HOOK_EVENTS) ensureHook(settings, event, entry);

  if (!args.dryRun) writeSettings(settingsPath, settings);
  log(`  merged hook into ${settingsPath} (${HOOK_EVENTS.join(', ')})`);
  if (args.limit !== null) writeUserConfig('limit', args.limit, args.dryRun, args.userConfig);
  if (args.mode !== null) writeUserConfig('mode', args.mode, args.dryRun, args.userConfig);
  log(`[${target}] done`);
}

function uninstall(target, args) {
  const hooksDst = path.join(target, 'hooks', 'claude-context-size-guard');
  const settingsPath = path.join(target, 'settings.json');

  log(`[${target}] uninstalling (dry-run=${args.dryRun})`);
  removeTree(hooksDst, args.dryRun);
  log(`  removed ${hooksDst}`);

  if (fs.existsSync(settingsPath)) {
    let settings;
    try { settings = readSettings(settingsPath); }
    catch (e) { log(`  ! ${e.message}`); return; }
    stripOurHooks(settings);
    if (!args.dryRun) writeSettings(settingsPath, settings);
    log(`  stripped hook from ${settingsPath}`);
  }
  log(`[${target}] done`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(args);
  if (targets.length === 0) {
    log('no Claude Code config dirs found');
    process.exit(1);
  }
  for (const t of targets) {
    if (args.uninstall) uninstall(t, args);
    else install(t, args);
  }
  log('');
  log('The change takes effect on your next prompt — no restart needed.');
}

main();
