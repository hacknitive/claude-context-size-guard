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

const LIMIT = 75000;

function hookPath() {
  if (process.argv.includes('--installed')) {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(base, 'hooks', 'claude-context-size-guard', 'context-size-guard.js');
  }
  return path.resolve(__dirname, '..', 'src', 'hooks', 'context-size-guard.js');
}

const HOOK = hookPath();
const results = [];

function run(prompt, transcript) {
  const payload = JSON.stringify({ prompt, transcript_path: String(transcript) });
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      input: payload,
      encoding: 'utf8',
      // Config layering is tested separately; keep the environment neutral so a
      // developer's own CONTEXT_GUARD_* vars cannot flip a case.
      env: Object.assign({}, process.env, {
        CONTEXT_GUARD_LIMIT: '',
        CONTEXT_GUARD_MODE: '',
        CONTEXT_GUARD_BYPASS: '',
        CONTEXT_GUARD_MIN_RECORDS: '',
      }),
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: String(e.stdout || '').trim() };
  }
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
  const t2 = path.join(tmp, 'over.jsonl');
  writeLines(t2, Array.from({ length: 50 }, () => userRecord(10000)));
  r = run('hello', t2);
  let directive = '';
  let ok = r.code === 0 && r.out !== '';
  if (ok) {
    try {
      directive = JSON.parse(r.out).hookSpecificOutput.additionalContext;
    } catch (e) { ok = false; directive = 'parse error: ' + e.message; }
  }
  ok = ok && directive.includes('CONTEXT GUARD TRIPPED');
  check('over limit: warn directive emitted', ok, directive.slice(0, 90));

  // 3. over limit but under minRecords -> deadlock guard
  const t3 = path.join(tmp, 'few.jsonl');
  writeLines(t3, [userRecord(200000), userRecord(200000)]);
  r = run('hello', t3);
  check('over limit, <3 records: deadlock guard silent', r.code === 0 && r.out === '', r.out.slice(0, 80));

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
  const t7 = path.join(tmp, 'usage-over.jsonl');
  writeLines(t7, [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'user', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: { input_tokens: 20, cache_read_input_tokens: 95780, cache_creation_input_tokens: 1038 },
      },
    },
  ]);
  r = run('hello', t7);
  check('usage beats chars/4 (96,838 real tokens)', r.out.includes('96,838'), r.out.slice(0, 90));

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
  writeLines(t9, [
    { type: 'attachment', content: 'x'.repeat(120000) },
    { type: 'attachment', content: 'x'.repeat(120000) },
    { type: 'attachment', content: 'x'.repeat(120000) },
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ]);
  r = run('hello', t9);
  check('fallback counts attachment records', r.out.includes('CONTEXT GUARD TRIPPED'), r.out.slice(0, 90));

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
        input: JSON.stringify({ prompt: 'hello', transcript_path: t1 }),
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CONTEXT_GUARD_LIMIT: '100' }),
      });
      return out.trim();
    } catch (e) { return ''; }
  })();
  check('CONTEXT_GUARD_LIMIT env override fires the guard',
    envRun.includes('CONTEXT GUARD TRIPPED'), envRun.slice(0, 90));

  fs.rmSync(tmp, { recursive: true, force: true });

  const passed = results.filter(Boolean).length;
  process.stdout.write(`\n${passed}/${results.length} passed\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
