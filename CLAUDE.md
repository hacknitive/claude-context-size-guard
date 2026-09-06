# CLAUDE.md — claude-context-size-guard

Maintainer notes for anyone (or any AI agent) editing this repo.

## Single source of truth

| File | Owns |
|------|------|
| `src/hooks/context-size-guard.js` | Measurement and decision logic, plus one payload builder per mode. The only place that reads a transcript or decides to fire. |
| `src/hooks/guard-config.js` | Config resolution (env → repo → user → defaults), the default values, and `MODE_EVENTS` — the registry mapping each mode to the hook event it fires on. Never hardcode a threshold or a mode name anywhere else. |
| `.claude-plugin/plugin.json` | Plugin manifest. Points at `${CLAUDE_PLUGIN_ROOT}/src/hooks/context-size-guard.js`. |
| `bin/install.js` + `bin/lib/settings.js` | Standalone installer. Merges the hook into `settings.json` (JSONC-tolerant), embeds the `context-size-guard` marker in the command so `--uninstall` strips cleanly. |
| `test/selftest.js` | The behavioral contract. Any change to measurement logic needs a case here. |

## Design constraints

- **The hook must never exit non-zero and never throw.** A failing `UserPromptSubmit` hook puts a red banner on every prompt in the session. Every filesystem and parse error path returns silently and lets the prompt through. `main()` is wrapped in a `try` for the same reason.
- **`MARKER` in `bin/lib/settings.js` is a stable identifier, not a name.** It is currently `context-size-guard`, which matches the hook's filename. Changing it orphans hook entries written by an earlier version — `--uninstall` would no longer match them, leaving a dead entry pointing at a deleted file.
- **Measure the whole record in the fallback, not `record.message`.** Counting only `message` drops `attachment` and `system` records, which on a real transcript are the largest single bucket. That bug under-reported by ~2.5× and is the reason the fallback exists in its current shape. Case 9 in the self-test guards it.
- **Respect `CLAUDE_CONFIG_DIR`.** Never hardcode `~/.claude` — multi-account setups depend on the env var.
- **Bookkeeping record types must stay in sync** with what Claude Code actually writes to the transcript but does not send to the model. The current set is in `BOOKKEEPING_TYPES`. Adding a type that *does* reach the model would make the guard under-report.
- **`minRecords` is a deadlock guard, not a tuning knob.** Firing right after a compact traps the session with no way forward but the bypass prefix.

## Hook contract quick reference

`UserPromptSubmit` stdin is JSON: `{ prompt: string, transcript_path?: string, cwd?: string, ... }`.

Stdout, if a JSON object with `hookSpecificOutput.additionalContext`, is appended to the model's context for that turn and costs a model turn. A top-level `systemMessage` is printed by Claude Code itself and costs nothing. `Stop` stdin additionally carries `stop_hook_active`, set on re-entry — a `Stop` hook that returns `additionalContext` without checking it loops the session forever.

Non-JSON stdout is ignored. Exit non-zero and Claude Code surfaces a red hook-error banner.

## Testing manually

```bash
# Full behavioral suite against the repo copy
node test/selftest.js

# Standalone install into a scratch config dir
./install.sh --dry-run --config-dir /tmp/fake-claude-dir
./install.sh --config-dir /tmp/fake-claude-dir
cat /tmp/fake-claude-dir/settings.json
CLAUDE_CONFIG_DIR=/tmp/fake-claude-dir node test/selftest.js --installed
./install.sh --uninstall --config-dir /tmp/fake-claude-dir

# Single-shot hook smoke test
echo '{"prompt":"hi","transcript_path":"/path/to/session.jsonl"}' | node src/hooks/context-size-guard.js
```

Regression checks that matter when touching the installer: install over a `settings.json` that already contains a foreign hook (it must survive), install twice (exactly one guard entry), install over a `settings.json` containing `//` comments (must parse), install over broken JSON (must refuse and change nothing), install over a `settings.json` that is a **symlink** to a shared file (the symlink must survive — multi-account setups share one file across `~/.claude-<account>/` dirs, and `writeSettings` resolves with `realpathSync` before its temp-file rename for exactly this reason).

## Version bumps

Keep `package.json` `version` and `.claude-plugin/plugin.json` `version` in step, and add a `CHANGELOG.md` entry.

## Adding a mode

1. Add it to `MODE_EVENTS` in `guard-config.js`, naming the event it fires on.
2. Add a payload builder to `PAYLOADS` in `context-size-guard.js`, keyed by the same name.
3. Add a self-test case that it fires on its own event and stays silent on the other.

The installer derives its wired events from `MODE_EVENTS`, so a mode on a new event is wired automatically — but `stripOurHooks` only finds entries carrying the marker, so never write a hook entry whose command omits it.

## License

MIT. Keep `LICENSE` at repo root.
