# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-09-06

### Added

- **Five modes instead of two.** `mode` now selects both *when* the guard
  speaks and *what it costs*:

  | `mode` | Fires | Prompt answered | Costs a turn |
  |---|---|---|---|
  | `off` | never | yes | no |
  | `warn` | before the prompt | no | yes |
  | `notice` | before the prompt | yes | no |
  | `after` | after the answer | yes | no |
  | `after-nudge` | after the answer | yes | yes |

  `warn` is unchanged and remains the default, so an upgrade does not alter
  anyone's behaviour without an explicit config change.
- The guard is now wired on `Stop` as well as `UserPromptSubmit`. Both entries
  are written on every install; `mode` decides which one produces output, so
  changing mode is a config edit and never a reinstall.
- `after` and `after-nudge` have **no measurement lag** — `Stop` runs after the
  turn it measures, where the `UserPromptSubmit` modes read the previous turn's
  accounting and are one turn stale.
- `install.sh --mode M` writes the mode to the user config, alongside `--limit`.

### Removed

- **`mode: "block"` (breaking).** It discarded the prompt outright, and its
  documented rationale no longer held: Claude Code does render `reason` for a
  blocked `UserPromptSubmit`, and echoes the original prompt back. That made
  the `tmp/blocked-prompt.txt` stash redundant, and left `block` as a harsher
  duplicate of modes that communicate better. A config still naming `"block"`
  now falls back to the default rather than erroring.

### Fixed

- Documentation claimed a blocked prompt "disappears with no explanation on
  screen". Verified false against Claude Code 2.1.260.

## [1.2.0] — 2026-08-17

### Changed

- **Default `minRecords` raised from 3 to 5.** The deadlock guard now needs five
  records since the last compact boundary before the guard may fire, giving a
  freshly compacted session more room before it can be told to compact again.

### Fixed

- **The self-test no longer reads the developer's own user config.** It
  neutralised `CONTEXT_GUARD_*` env vars but still let
  `~/.config/claude-context-size-guard/config.json` (and `%APPDATA%` on Windows)
  through, so cases asserting against the built-in defaults failed on any
  machine that had a real user config — while passing in CI, which has none.
  `XDG_CONFIG_HOME`/`APPDATA` now point at an empty temp dir for the duration of
  the run, and `cwd` is set to that same dir so the repo-local layer cannot
  interfere either.
- Cases 3, 7, and 9 size their record counts off `minRecords` instead of
  hardcoding 3 or 4, so a future change to that default cannot silence them into
  a false pass.

## [1.1.0] — 2026-08-17

### Changed

- **Default `limit` raised from 75,000 to 100,000 tokens.** 75,000 fired at
  around 37% of a 200k window, early enough to be noise on sessions that were
  never going to need a compact. 100,000 fires at half full, which still leaves
  `/compact` plenty of room. Anyone who wants the old threshold can set
  `{"limit": 75000}` in a user or repo-local config, or `CONTEXT_GUARD_LIMIT`.
- The self-test now reads the default off the `guard-config.js` sitting beside
  the hook under test instead of hardcoding it, so a changed default cannot
  silently desync from the cases.

## [1.0.1] — 2026-08-17

### Fixed

- **Installing over a symlinked `settings.json` no longer breaks the symlink.**
  `writeSettings` renamed a temp file over the settings path. Where that path is
  a symlink — the standard layout for multi-account setups that share one
  `~/.claude/settings.json` across every `~/.claude-<account>/` dir — the rename
  replaced the link with a regular file and silently un-shared that account's
  config. The path is now resolved with `realpathSync` before the backup and the
  rename. Covered by self-test case 13.

### Added

- CI: self-test on ubuntu/macos/windows × Node 18/20/22, plus end-to-end
  installer runs on both POSIX and PowerShell. `install.ps1` had never been
  executed before this.
- Logo, wide banner, and a 1280×640 social preview under `assets/`.
- This changelog.

## [1.0.0] — 2026-08-17

Initial public release. Node port of the original Python guard.

- `UserPromptSubmit` hook that measures live context on every prompt and, past a
  configurable threshold (default 75,000 tokens), has Claude answer with a
  one-line notice to run `/compact` instead of burning a full turn.
- Measurement from the API's own `message.usage` accounting, with a
  whole-record `chars / 4` fallback; both reset at the last compact boundary.
- Config layering: env → repo-local → user config → defaults.
- Standalone installer (`install.sh` / `install.ps1`) that merges into an
  existing `settings.json`, tolerates `//` comments, is idempotent, and strips
  cleanly with `--uninstall`.
- Claude Code plugin manifest.

[2.0.0]: https://github.com/hacknitive/claude-context-size-guard/compare/v1.2.0...v2.0.0
[1.0.1]: https://github.com/hacknitive/claude-context-size-guard/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/hacknitive/claude-context-size-guard/releases/tag/v1.0.0
