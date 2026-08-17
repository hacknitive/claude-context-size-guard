#!/usr/bin/env node
// claude-context-size-guard — UserPromptSubmit hook.
//
// Measures the live context since the last compact boundary and, once it
// passes the configured limit, stops the turn with a short notice telling you
// to run /compact instead of burning a full expensive turn on a context that
// should have been compacted three prompts ago.
//
// stdin  : {"prompt": "...", "transcript_path": "/abs/path/to/session.jsonl"}
// stdout : nothing (under the limit), or a hook JSON object (over the limit)
//
// Never exits non-zero and never throws: a failing UserPromptSubmit hook puts
// a red banner on every prompt. On any error the guard stays silent and the
// prompt goes through untouched.

const fs = require('fs');
const path = require('path');
const { resolveConfig } = require('./guard-config');

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

function blockPayload(tokens, config, prompt) {
  // A blocked prompt would otherwise be lost, so park it where it can be
  // recovered. Best-effort: a failed write must not stop the block.
  let stash = null;
  try {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    stash = path.join(root, 'tmp', 'blocked-prompt.txt');
    fs.mkdirSync(path.dirname(stash), { recursive: true });
    fs.writeFileSync(stash, prompt);
  } catch (e) {
    stash = null;
  }
  const recover = stash ? ` (saved to ${stash})` : '';
  return {
    decision: 'block',
    reason:
      `BLOCKED: context is ~${group(tokens)} tokens, over the ${group(config.limit)} limit.\n` +
      `  1. Run /compact\n` +
      `  2. Resend your prompt${recover}\n` +
      `  Bypass once: prefix the prompt with '${config.bypass}'`,
    systemMessage: `Context guard: ~${group(tokens)} tokens > ${group(config.limit)}. Run /compact.`,
  };
}

function warnPayload(tokens, config) {
  const directive =
    `CONTEXT GUARD TRIPPED: context is ~${group(tokens)} tokens, over the ` +
    `${group(config.limit)} limit.\n` +
    'Do NOT answer the user\'s prompt. Do NOT call any tool. Your entire reply ' +
    'must be a short notice, worded roughly as:\n' +
    `  "Context guard: ~${group(tokens)} tokens, over the ${group(config.limit)} limit. ` +
    `Run /compact, then resend. Bypass once by prefixing the prompt with ${config.bypass}."\n` +
    'Then stop.';
  return {
    systemMessage: `Context guard: ~${group(tokens)} tokens > ${group(config.limit)}. Run /compact.`,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: directive,
    },
  };
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
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';

  if (prompt.replace(/^\s+/, '').startsWith(config.bypass)) return 0;

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

  const payload =
    config.mode === 'block'
      ? blockPayload(measurement.tokens, config, prompt)
      : warnPayload(measurement.tokens, config);
  process.stdout.write(JSON.stringify(payload));
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
