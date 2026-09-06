#!/usr/bin/env node
// claude-context-size-guard — self-test.
//
// Feeds synthetic transcripts to the hook and checks every decision path.
// Touches nothing outside a temp directory.
//
//   node test/selftest.js                 # test the repo copy
//   node test/selftest.js --installed     # test the copy in $CLAUDE_CONFIG_DIR

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function hookPath() {
  if (process.argv.includes('--installed')) {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(base, 'hooks', 'claude-context-size-guard', 'context-size-guard.js');
  }
  return path.resolve(__dirname, '..', 'src', 'hooks', 'context-size-guard.js');
}

const HOOK = hookPath();
// Read the defaults straight off the config module that sits beside the hook
// under test, so a changed default cannot silently desync from these cases.
const DEFAULTS = require(path.join(path.dirname(HOOK), 'guard-config.js')).DEFAULTS;
const LIMIT = DEFAULTS.limit;
const MIN_RECORDS = DEFAULTS.minRecords;
const results = [];

// Every case below asserts against DEFAULTS, so the hook must not see any
// config layer above them: not the developer's CONTEXT_GUARD_* vars, and not
// their user config file either. Pointing XDG_CONFIG_HOME (POSIX) and APPDATA
// (Windows) at an empty temp dir is what makes the run reproducible on a
// machine that has a real ~/.config/claude-context-size-guard/config.json.
// The repo-local layer is neutralised by passing that same dir as `cwd`.
const CONFIG_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'context-size-guard-cfg-'));
const NEUTRAL_ENV = Object.assign({}, process.env, {
  CONTEXT_GUARD_LIMIT: '',
  CONTEXT_GUARD_MODE: '',
  CONTEXT_GUARD_BYPASS: '',
  CONTEXT_GUARD_MIN_RECORDS: '',
  XDG_CONFIG_HOME: CONFIG_SANDBOX,
  APPDATA: CONFIG_SANDBOX,
});

// opts: { event, mode, stopHookActive } — all optional. Omitting `event`
// exercises the pre-modes stdin shape, which must still behave as
// UserPromptSubmit.
function run(prompt, transcript, opts) {
  const o = opts || {};
  const stdin = {
    prompt,
    transcript_path: String(transcript),
    cwd: CONFIG_SANDBOX,
  };
  if (o.event) stdin.hook_event_name = o.event;
  if (o.stopHookActive) stdin.stop_hook_active = true;

  const env = Object.assign({}, NEUTRAL_ENV);
  if (o.mode) env.CONTEXT_GUARD_MODE = o.mode;

  try {
    const out = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(stdin),
      encoding: 'utf8',
      env,
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: String(e.stdout || '').trim() };
  }
}

// Parsed payload, or null when the hook stayed silent.
function payloadOf(r) {
  if (!r.out) return null;
  try { return JSON.parse(r.out); } catch (e) { return null; }
}

function check(name, condition, detail) {
  results.push(condition);
  process.stdout.write(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ' -- ' + detail : ''}\n`);
}

function writeLines(file, objects) {
  fs.writeFileSync(file, objects.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
}

function userRecord(chars) {
  return { type: 'user', message: { role: 'user', content: 'x'.repeat(chars) } };
}

function main() {
  if (!fs.existsSync(HOOK)) {
    process.stdout.write(`FAIL: hook not found at ${HOOK}\n`);
    process.exit(1);
  }
  process.stdout.write(`hook:   ${HOOK}\nnode:   ${process.execPath}\n\n`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'context-size-guard-'));

  // 1. under limit -> silent
  const t1 = path.join(tmp, 'under.jsonl');
  writeLines(t1, Array.from({ length: 10 }, () => userRecord(1000)));
  let r = run('hello', t1);
  check('under limit: silent, exit 0', r.code === 0 && r.out === '', `code=${r.code} out=${r.out.slice(0, 80)}`);

  // 2. over limit -> warn directive
  // Sized off LIMIT, not a fixed byte count: a raised default must not turn
  // this into an under-limit transcript and silence every case that uses it.
  const t2 = path.join(tmp, 'over.jsonl');
  writeLines(t2, Array.from({ length: MIN_RECORDS + 5 }, () => userRecord(LIMIT)));
  r = run('hello', t2, { mode: 'warn' });
  let directive = '';
  let ok = r.code === 0 && r.out !== '';
  if (ok) {
    try {
      directive = JSON.parse(r.out).hookSpecificOutput.additionalContext;
    } catch (e) { ok = false; directive = 'parse error: ' + e.message; }
  }
  ok = ok && directive.includes('CONTEXT GUARD TRIPPED');
  check('mode warn: directive emitted over the limit', ok, directive.slice(0, 90));

  // 3. over limit but under minRecords -> deadlock guard
  const t3 = path.join(tmp, 'few.jsonl');
  // Sized off LIMIT so the case stays "over limit", and one record short of
  // minRecords so it stays "too few" whatever those defaults are.
  writeLines(t3, Array.from({ length: MIN_RECORDS - 1 }, () => userRecord(LIMIT * 4)));
  r = run('hello', t3);
  check(`over limit, <${MIN_RECORDS} records: deadlock guard silent`,
    r.code === 0 && r.out === '', r.out.slice(0, 80));

  // 4. bypass prefix
  r = run('!! run anyway', t2);
  check("bypass '!!': silent", r.code === 0 && r.out === '', r.out.slice(0, 80));

  // 5. compact boundary resets the window
  const t5 = path.join(tmp, 'boundary.jsonl');
  writeLines(t5, [
    userRecord(400000),
    { subtype: 'compact_boundary' },
    ...Array.from({ length: 5 }, () => userRecord(1000)),
  ]);
  r = run('hello', t5);
  check('compact boundary resets estimate', r.code === 0 && r.out === '', r.out.slice(0, 80));

  // 6. missing transcript
  r = run('hello', path.join(tmp, 'nonexistent.jsonl'));
  check('missing transcript: silent, no crash', r.code === 0 && r.out === '', r.out.slice(0, 120));

  // 7. message.usage beats chars/4
  // The leading user records are a few bytes each, so chars/4 is nowhere near
  // the limit: the guard can only fire off the usage accounting. Split across
  // all three usage fields to prove they are summed, sized off LIMIT, and
  // padded to minRecords so the deadlock guard is not what silences it.
  const t7 = path.join(tmp, 'usage-over.jsonl');
  const usage = {
    input_tokens: 20,
    cache_read_input_tokens: LIMIT,
    cache_creation_input_tokens: 1038,
  };
  const usageTotal = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  writeLines(t7, [
    ...Array.from({ length: MIN_RECORDS - 1 }, () => userRecord(2)),
    { type: 'assistant', message: { role: 'assistant', usage } },
  ]);
  r = run('hello', t7);
  const usageLabel = usageTotal.toLocaleString('en-US');
  check(`usage beats chars/4 (${usageLabel} real tokens)`, r.out.includes(usageLabel), r.out.slice(0, 90));

  // 8. usage under limit on a physically large transcript
  const t8 = path.join(tmp, 'usage-under.jsonl');
  writeLines(t8, [
    { type: 'attachment', content: 'x'.repeat(400000) },
    { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 12000 } } },
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ]);
  r = run('hello', t8);
  check('usage under limit despite 400k chars: silent', r.code === 0 && r.out === '', r.out.slice(0, 90));

  // 9. fallback counts attachment records, not just `message`
  const t9 = path.join(tmp, 'fallback.jsonl');
  // Each attachment is LIMIT * 2 chars, so chars/4 over three of them is
  // already 1.5 * LIMIT — over the limit only if attachment records are counted
  // at all. Count also padded to minRecords, so a silent result can only mean
  // the attachments went uncounted.
  const attachments = Math.max(3, MIN_RECORDS - 1);
  writeLines(t9, [
    ...Array.from({ length: attachments }, () => ({
      type: 'attachment',
      content: 'x'.repeat(LIMIT * 2),
    })),
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ]);
  r = run('hello', t9);
  check('fallback counts attachment records', r.out.includes('Context guard'), r.out.slice(0, 90));

  // 10. bookkeeping record types excluded from the fallback
  const t10 = path.join(tmp, 'bookkeeping.jsonl');
  writeLines(t10, [
    { type: 'file-history-snapshot', content: 'x'.repeat(400000) },
    { type: 'ai-title', content: 'x'.repeat(400000) },
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ]);
  r = run('hello', t10);
  check('bookkeeping types excluded from fallback', r.code === 0 && r.out === '', r.out.slice(0, 90));

  // 11. malformed stdin does not crash the hook
  try {
    execFileSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    check('malformed stdin: silent, exit 0', true, '');
  } catch (e) {
    check('malformed stdin: silent, exit 0', false, `code=${e.status}`);
  }

  // 12. env override lowers the limit
  const envRun = (() => {
    try {
      const out = execFileSync(process.execPath, [HOOK], {
        input: JSON.stringify({ prompt: 'hello', transcript_path: t1, cwd: CONFIG_SANDBOX }),
        encoding: 'utf8',
        env: Object.assign({}, NEUTRAL_ENV, { CONTEXT_GUARD_LIMIT: '100' }),
      });
      return out.trim();
    } catch (e) { return ''; }
  })();
  check('CONTEXT_GUARD_LIMIT env override fires the guard',
    envRun.includes('Context guard'), envRun.slice(0, 90));

  // 13. installing over a symlinked settings.json keeps the symlink intact.
  // Multi-account setups share one settings.json across ~/.claude-<account>/
  // dirs by symlink; a rename over the link would silently un-share it.
  const linkRoot = path.join(tmp, 'symlink-case');
  const shared = path.join(linkRoot, 'shared', 'settings.json');
  const account = path.join(linkRoot, 'account');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.mkdirSync(account, { recursive: true });
  fs.writeFileSync(shared, JSON.stringify({ hooks: {}, permissions: { allow: ['Bash(ls:*)'] } }, null, 2));
  fs.symlinkSync(shared, path.join(account, 'settings.json'));
  let symlinkOk = false;
  let symlinkDetail = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'install.js')], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: account }),
    });
    const stillLink = fs.lstatSync(path.join(account, 'settings.json')).isSymbolicLink();
    const merged = JSON.parse(fs.readFileSync(shared, 'utf8'));
    const hasHook = JSON.stringify(merged.hooks || {}).includes('context-size-guard');
    const keptForeign = (merged.permissions || {}).allow?.[0] === 'Bash(ls:*)';
    symlinkOk = stillLink && hasHook && keptForeign;
    symlinkDetail = `link=${stillLink} hook=${hasHook} kept=${keptForeign}`;
  } catch (e) {
    symlinkDetail = String(e.message).slice(0, 90);
  }
  check('install over a symlinked settings.json keeps the symlink', symlinkOk, symlinkDetail);

  // ---- modes -------------------------------------------------------------
  // t2 is over the limit with enough records, so every case below fires or
  // stays silent purely because of the mode/event pairing.

  // 14. mode "off" never fires, on either event
  const offPrompt = run('hello', t2, { mode: 'off', event: 'UserPromptSubmit' });
  const offStop = run('hello', t2, { mode: 'off', event: 'Stop' });
  check('mode off: silent on both events',
    offPrompt.out === '' && offStop.out === '',
    `prompt=${offPrompt.out.slice(0, 40)} stop=${offStop.out.slice(0, 40)}`);

  // 15. mode "notice" prints a systemMessage and adds nothing to the model's
  // context — that absence is the whole difference from "warn".
  const notice = payloadOf(run('hello', t2, { mode: 'notice', event: 'UserPromptSubmit' }));
  check('mode notice: systemMessage only, no additionalContext',
    !!notice && typeof notice.systemMessage === 'string' &&
      notice.systemMessage.includes('Context guard') && !notice.hookSpecificOutput,
    notice ? JSON.stringify(notice).slice(0, 90) : 'silent');

  // 16. a UserPromptSubmit mode must not fire on Stop
  const noticeOnStop = run('hello', t2, { mode: 'notice', event: 'Stop' });
  check('mode notice: silent on the Stop event',
    noticeOnStop.code === 0 && noticeOnStop.out === '', noticeOnStop.out.slice(0, 60));

  // 17. mode "after" fires on Stop, systemMessage only
  const after = payloadOf(run('', t2, { mode: 'after', event: 'Stop' }));
  check('mode after: systemMessage on Stop',
    !!after && typeof after.systemMessage === 'string' &&
      after.systemMessage.includes('Context guard') && !after.hookSpecificOutput,
    after ? JSON.stringify(after).slice(0, 90) : 'silent');

  // 18. a Stop mode must not fire on UserPromptSubmit
  const afterOnPrompt = run('hello', t2, { mode: 'after', event: 'UserPromptSubmit' });
  check('mode after: silent on the UserPromptSubmit event',
    afterOnPrompt.code === 0 && afterOnPrompt.out === '', afterOnPrompt.out.slice(0, 60));

  // 19. mode "after-nudge" hands the notice to the model, tagged for Stop
  const nudge = payloadOf(run('', t2, { mode: 'after-nudge', event: 'Stop' }));
  check('mode after-nudge: additionalContext tagged Stop',
    !!nudge && !!nudge.hookSpecificOutput &&
      nudge.hookSpecificOutput.hookEventName === 'Stop' &&
      String(nudge.hookSpecificOutput.additionalContext).includes('CONTEXT GUARD TRIPPED'),
    nudge ? JSON.stringify(nudge).slice(0, 90) : 'silent');

  // 20. the loop guard. additionalContext on Stop resumes the conversation,
  // which ends, which fires Stop again. Claude Code sets stop_hook_active on
  // the re-entry; ignoring it loops the session until something intervenes.
  const nudgeReentry = run('', t2, { mode: 'after-nudge', event: 'Stop', stopHookActive: true });
  check('mode after-nudge: silent when stop_hook_active (loop guard)',
    nudgeReentry.code === 0 && nudgeReentry.out === '', nudgeReentry.out.slice(0, 60));

  // 21. an unknown mode name falls back to the default rather than firing
  // something arbitrary or crashing.
  const bogus = payloadOf(run('hello', t2, { mode: 'no-such-mode', event: 'UserPromptSubmit' }));
  const asDefault = payloadOf(run('hello', t2, { event: 'UserPromptSubmit' }));
  check('unknown mode falls back to the default',
    !!bogus && JSON.stringify(bogus) === JSON.stringify(asDefault),
    bogus ? JSON.stringify(bogus).slice(0, 60) : 'silent');

  // 22. stdin with no hook_event_name is treated as UserPromptSubmit, so a
  // hook entry written before modes existed keeps working.
  const legacy = run('hello', t2, { mode: 'notice' });
  check('missing hook_event_name defaults to UserPromptSubmit',
    legacy.code === 0 && legacy.out.includes('Context guard'), legacy.out.slice(0, 60));

  // 24. the shipped defaults are the ones the README documents
  check(`shipped defaults: mode=${DEFAULTS.mode}, limit=${LIMIT.toLocaleString('en-US')}`,
    DEFAULTS.mode === 'notice' && LIMIT === 150000,
    `mode=${DEFAULTS.mode} limit=${LIMIT}`);

  // 23. the installer wires every event the mode registry can dispatch to, and
  // uninstall strips all of them.
  const evDir = path.join(tmp, 'events-case');
  fs.mkdirSync(evDir, { recursive: true });
  const evSettings = path.join(evDir, 'settings.json');
  const installer = path.join(__dirname, '..', 'bin', 'install.js');
  const wantedEvents = [...new Set(Object.values(
    require(path.join(path.dirname(HOOK), 'guard-config.js')).MODE_EVENTS
  ).filter(Boolean))];
  let eventsOk = false;
  let strippedOk = false;
  let eventsDetail = '';
  try {
    execFileSync(process.execPath, [installer, '--config-dir', evDir], { encoding: 'utf8' });
    const wired = JSON.parse(fs.readFileSync(evSettings, 'utf8')).hooks || {};
    eventsOk = wantedEvents.every(
      ev => JSON.stringify(wired[ev] || []).includes('context-size-guard')
    );
    eventsDetail = `wired=${Object.keys(wired).join(',')} wanted=${wantedEvents.join(',')}`;

    execFileSync(process.execPath, [installer, '--uninstall', '--config-dir', evDir], { encoding: 'utf8' });
    const after = fs.readFileSync(evSettings, 'utf8');
    strippedOk = !after.includes('context-size-guard');
  } catch (e) {
    eventsDetail = String(e.message).slice(0, 90);
  }
  check('installer wires every mode event', eventsOk, eventsDetail);
  check('uninstall strips every mode event', strippedOk, '');

  fs.rmSync(tmp, { recursive: true, force: true });

  const passed = results.filter(Boolean).length;
  process.stdout.write(`\n${passed}/${results.length} passed\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
