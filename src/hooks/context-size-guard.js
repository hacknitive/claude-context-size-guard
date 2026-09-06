#!/usr/bin/env node
// claude-context-size-guard — UserPromptSubmit + Stop hook.
//
// Measures the live context since the last compact boundary and, once it
// passes the configured limit, stops the turn with a short notice telling you
// to run /compact instead of burning a full expensive turn on a context that
// should have been compacted three prompts ago.
//
// The same script serves both events. `mode` decides which one produces
// output, so switching modes never means re-running the installer.
//
// stdin  : {"hook_event_name": "...", "prompt": "...", "transcript_path": "..."}
// stdout : nothing (under the limit, or wrong event), or a hook JSON object
//
// Never exits non-zero and never throws: a failing UserPromptSubmit hook puts
// a red banner on every prompt. On any error the guard stays silent and the
// prompt goes through untouched.

const fs = require('fs');
const { resolveConfig, MODE_EVENTS } = require('./guard-config');

// Transcript record types that are bookkeeping only — they are written to the
// .jsonl but never reach the model's context, so they must not be counted.
const BOOKKEEPING_TYPES = new Set([
  'file-history-snapshot',
  'file-history-delta',
  'queue-operation',
  'last-prompt',
  'ai-title',
  'pr-link',
]);

// The three usage fields that together make up the real prompt size.
const USAGE_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

function loadRecords(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      // Partially-flushed final line. Skip it.
    }
  }
  return records;
}

// Live context size since the last compact boundary.
//
// Primary source is the exact accounting the API already wrote into the last
// assistant record's `message.usage`. That is measured, not estimated, and
// lags reality by at most one turn.
//
// Fallback — no assistant turn since the boundary, i.e. right after a compact
// — is chars/4 over the WHOLE record, not just `record.message`. Counting only
// `message` silently drops `attachment` and `system` records, which on a real
// transcript are the largest single bucket.
function estimateTokens(transcriptPath) {
  const records = loadRecords(transcriptPath);

  let start = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec && (rec.isCompactSummary || rec.subtype === 'compact_boundary')) start = i;
  }
  const live = records.slice(start);

  let usage = null;
  for (const rec of live) {
    const candidate = rec && rec.message && rec.message.usage;
    if (candidate && typeof candidate === 'object') usage = candidate;
  }
  if (usage) {
    let measured = 0;
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value)) measured += value;
    }
    if (measured > 0) return { tokens: measured, records: live.length };
  }

  let chars = 0;
  for (const rec of live) {
    if (rec && BOOKKEEPING_TYPES.has(rec.type)) continue;
    chars += JSON.stringify(rec).length;
  }
  return { tokens: Math.floor(chars / 4), records: live.length };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function group(n) {
  return n.toLocaleString('en-US');
}

// The one-line warning every mode shows, in one place so the modes cannot
// drift apart in wording.
function noticeLine(tokens, config) {
  return (
    `Context guard: ~${group(tokens)} tokens, over the ${group(config.limit)} limit. ` +
    `Run /compact, then resend. Bypass once by prefixing the prompt with ${config.bypass}.`
  );
}

// mode "warn" — fires before the prompt. Injects a directive telling the model
// to refuse and recite the notice, so the prompt goes unanswered and a model
// turn is spent on the warning. Historical default.
function warnPayload(tokens, config) {
  const directive =
    `CONTEXT GUARD TRIPPED: context is ~${group(tokens)} tokens, over the ` +
    `${group(config.limit)} limit.\n` +
    'Do NOT answer the user\'s prompt. Do NOT call any tool. Your entire reply ' +
    'must be a short notice, worded roughly as:\n' +
    `  "${noticeLine(tokens, config)}"\n` +
    'Then stop.';
  return {
    systemMessage: `Context guard: ~${group(tokens)} tokens > ${group(config.limit)}. Run /compact.`,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: directive,
    },
  };
}

// mode "notice" — fires before the prompt. Same warning line, printed by
// Claude Code rather than spoken by the model: the prompt is answered normally
// and no turn is spent.
function noticePayload(tokens, config) {
  return { systemMessage: noticeLine(tokens, config) };
}

// mode "after" — fires on Stop, once the answer is delivered. Free, and the
// only mode without measurement lag: Stop runs after the turn it measures,
// whereas every UserPromptSubmit mode reads the previous turn's accounting.
function afterPayload(tokens, config) {
  return { systemMessage: noticeLine(tokens, config) };
}

// mode "after-nudge" — fires on Stop and hands the notice to the model, which
// costs a turn. The caller must have checked `stop_hook_active` first; see
// shouldFire.
function afterNudgePayload(tokens, config) {
  return {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext:
        `CONTEXT GUARD TRIPPED: context is ~${group(tokens)} tokens, over the ` +
        `${group(config.limit)} limit.\n` +
        'Tell the user, in one short line and nothing else, to run /compact. Then stop.',
    },
  };
}

const PAYLOADS = {
  'warn': warnPayload,
  'notice': noticePayload,
  'after': afterPayload,
  'after-nudge': afterNudgePayload,
};

// Which event this invocation is serving. Claude Code puts the name in the
// stdin payload; argv is a fallback for manual wiring, and UserPromptSubmit is
// assumed last so a pre-modes hook entry keeps working unchanged.
function resolveEvent(data) {
  if (data && typeof data.hook_event_name === 'string' && data.hook_event_name) {
    return data.hook_event_name;
  }
  if (typeof process.argv[2] === 'string' && process.argv[2]) return process.argv[2];
  return 'UserPromptSubmit';
}

// Everything that decides "stay silent" other than the measurement itself.
function shouldFire(data, config, event) {
  const wanted = MODE_EVENTS[config.mode];
  if (!wanted) return false;          // mode "off", or an unknown mode name
  if (wanted !== event) return false; // wired on both events; only one fires

  // Stop hooks re-enter: additionalContext resumes the conversation, which
  // ends, which fires Stop again. Claude Code flags the re-entry so a hook can
  // break the cycle. Without this the session loops until something intervenes.
  if (event === 'Stop' && data.stop_hook_active) return false;

  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  if (prompt.replace(/^\s+/, '').startsWith(config.bypass)) return false;

  return true;
}

function main() {
  let data;
  try {
    data = JSON.parse(readStdin());
  } catch (e) {
    return 0;
  }
  if (!data || typeof data !== 'object') return 0;

  const config = resolveConfig(data.cwd || process.cwd());
  if (!shouldFire(data, config, resolveEvent(data))) return 0;

  const transcriptPath = data.transcript_path;
  if (typeof transcriptPath !== 'string' || !transcriptPath) return 0;
  try {
    if (!fs.statSync(transcriptPath).isFile()) return 0;
  } catch (e) {
    return 0;
  }

  let measurement;
  try {
    measurement = estimateTokens(transcriptPath);
  } catch (e) {
    return 0;
  }

  if (measurement.tokens <= config.limit) return 0;
  // Deadlock guard: right after a compact there is nothing left to compact.
  if (measurement.records < config.minRecords) return 0;

  const build = PAYLOADS[config.mode];
  if (!build) return 0;
  process.stdout.write(JSON.stringify(build(measurement.tokens, config)));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.exitCode = 0;
  }
}

module.exports = { estimateTokens, BOOKKEEPING_TYPES };
