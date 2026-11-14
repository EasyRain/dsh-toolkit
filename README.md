# dsh-toolkit

> A **host-side plugin** for the [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) desktop app: **15 tools in 7 families** — table diff, AST search/rewrite, session logs, checkpoint/rewind, download, a Windows bash executor, and file read/write/**diff** — plus on-demand help.
>
> 给 DSH 桌面端用的自有宿主插件：一个插件，七族 15 个工具。[中文说明 →](README.zh-CN.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-40%20suites%20passing-brightgreen.svg)](#development)

## What it is for

| Your problem | Use |
|---|---|
| Two tables / packs / exports differ (glossaries, localization terms, configs, CSV, SQLite) | `table_diff` (peek first with `table_peek`) |
| Find code by **syntax structure**, or rewrite it structurally | `ast_search` (read-only) / `ast_edit` (rewrite: preview → apply) |
| "How did we decide this last time?" / diff two past sessions | `session_list` / `session_read` / `session_diff` / `session_export` |
| Snapshot before a risky change, roll back if it breaks | checkpoint (create → diff → restore, preview by default) |
| "How do I use this plugin / what are the gotchas?" | `toolkit_help` (fetched on demand, zero standing context cost) |

**Two things this plugin cares about most**

1. **Never a nested loop.** Table diffs are always a hash join, `O(N+M)`. (Origin story: an early Python script compared glossary tables with nested loops — 37 million comparisons — and only a SQLite rewrite saved the day.)
2. **A silent wrong answer costs more than a crash.** Whenever a result could be misread, the tool says so out loud: an empty side prints a top-line `⚠⚠` and the summary reads *"not comparable — this is NOT 'no differences'"*; corrupt zstd frames, downgraded copy budgets, truncation caps, ambiguous checkpoint ids and cross-workspace operations are all surfaced, never guessed.

## The 15 tools

- **Table diff (2)** — `table_diff` / `table_peek`: auto-detects Lua / JSON / JSONL / CSV / TSV / PO / properties / YAML / TOML / zip-jar / mappings / SQLite (`node:sqlite`, supports `path#table` and custom SQL); `a`/`b`/`mapA`/`mapB` accept globs (all matches merge into one key space); key/value projection supports dotted paths and `+` joins; record mode compares field by field after canonicalization.
- **AST (4)** — `ast_search` / `ast_dump_tree` / `ast_test_rule` / `ast_edit`. Rewrites run **in-process** via `@ast-grep/napi` (no external binary), with preview → apply, staleness checks and atomic writes.
- **Session logs (4)** — `session_list` (`kind:"sessions"` logs on disk / `"subagents"` catalog registrations) / `session_read` (give `pattern` to grep events, omit it for the last `tail` events) / `session_diff` / `session_export`: decode multi-frame zstd logs frame by frame; `session_diff` uses hash alignment, not LCS.
- **Download (1)** — `download`, one tool with `action`: `start` (default; `probe:true` first), `probe` (measure only, writes nothing), `status` (progress/speed/chunk health, including "the worker died but the `.part` is still there" ⇒ resumable) and `cancel` (keeps the `.part` by default). Zero-dependency multi-connection engine: Range chunks + resume + sha256 + system-proxy detection (Windows registry → PAC → env vars → common local proxy ports; **no proxy software required**, and `proxy:"direct"` forces a direct connection).
- **Bash (1)** — `bash` (Windows only): runs the bash runtime this plugin installs (Niubash) through the host `ctx.subprocess` (termination escalation, output budgets and spill owned by the host). Honours `sandboxPolicy` / `sandbox.confine`, supports per-call `sandbox_permissions` escalation through host approval (nothing runs unless granted), promotes foreground commands to background jobs on timeout, and `run_in_background` (host name) has **no default execution timeout**. Output follows the host terminal-card contract (real exit code / signal name).
- **File (1)** — `file` with ten actions: `read` (encoding detection, multi-file/ranges, OOXML text), `stat`, **`diff`** (file vs proposed content: one trimmed hunk, paged, old/new sha256, read-only), `write` (atomic, CAS), `edit`, `replace`, `copy`, `move`, `remove`, `mkdir`.
- **Checkpoint / rewind (1)** — `checkpoint`, one tool with seven actions: `create` (snapshot; `estimate:true` only walks and reports), `list`, `diff`, `restore` (preview by default — `confirm:true` to write), `prune`, `journal` (automatic pre-images) and `journal_restore` (roll a single file back), plus the `/checkpoint` and `/rewind` commands and three host hooks (`fs/write-intent`, `fs/edit-intent`, `tools/pre-execute`) that keep a pre-image of any file about to be written.
- **Help (1)** — `toolkit_help` with topics (the family notes) **and the vendored ast-grep rule guide** (MIT): `overview` / `table-diff` / `checkpoint` / `session` / `ast` / `ast-rules` / `gotchas` / `full`.

## Install

This is a **host** plugin (it injects nothing into the web UI). Install it into a DSH profile.
The commands are the same everywhere; the comments give the Windows form of the paths:

```bash
# 1) add it to the profile (run this inside the profile directory)
cd ~/.dsh/profiles/<your-profile>                 # Windows: cd $env:USERPROFILE\.dsh\profiles\<your-profile>
pnpm add github:EasyRain/dsh-toolkit              # from GitHub (works today)
pnpm add dsh-toolkit                              # from npm, once published
pnpm add file:<path>/to/dsh-toolkit               # from a local checkout (Windows: file:D:\path\to\dsh-toolkit)
# add --registry=https://registry.npmmirror.com if the default registry is slow on your network

# 2) add "dsh-toolkit" to dsh.profile.bundles in that profile's package.json
#    (write the JSON back WITHOUT a BOM — DSH parses it strictly)

# 3) restart DSH, then open Settings → 工具集 (tool families) and switch on what you need
#    Every family is OFF by default; toolkit_help is always on and cannot be disabled.
```

> ⚠️ **After editing the source you must copy it into the installed copy and restart.** `pnpm add/install file:...`
> does **not** refresh `profiles\<name>\node_modules\dsh-toolkit` when the lockfile entry is unchanged, so the host
> keeps loading the old code otherwise.

## Development

```bash
# Day to day: **test what you changed** (the default here; a full run costs 130 s, a targeted one a few)
node scripts/test-changed.mjs            # suites affected since the last all-green run + fast global gates
node scripts/test-changed.mjs --list     # print the plan only
node scripts/test-changed.mjs --all      # force the full 31-suite run
node scripts/test-changed.mjs --rebaseline   # record the baseline after a full green run (runs nothing)
# It (1) maps **changed files** to affected suites, (2) always runs a set of **second-scale global gates**
#   (docs-claims published-surface claims / toolkit-help's schema budget gate / output-contract's pinned
#   parameter surface / bin/check-package), and (3) syncs the source into the profile copy first.
# **The state file is only updated when everything is green**, so a red batch keeps running next time.

node test/ast-edit-selftest.mjs         # needs @ast-grep/napi; resolves it from the source tree or a profile copy
node test/diff-engine-selftest.mjs
node test/checkpoint-guards-selftest.mjs
# 40 *-selftest.mjs suites in total — every one should print ALL PASS
# full run with a verifiable total (for shared/published surfaces, or when wrapping up):
#   node test/run-all.mjs   ->  TOTAL: 31 files, ~1150 passed, 0 failed, 0 non-zero exit
# **Parallel by default** (2–8 workers scaled to the core count; each suite uses its own mkdtemp sandbox):
# 31 s on a 32-core box vs 138 s serial. `--serial` for debugging, `--jobs N`, `--one <name>`
# (either `glob` or `glob-selftest.mjs`). The summary prints **per-suite duration** and the slowest three.
# ⚠️ Two suites must stay exclusive (they are): `tablediff-perf` (measures throughput) and
# `robustness` (spawns its own lock-contending children).
# Slow suite? `node test/_timing-wrap.mjs ./<name>-selftest.mjs` prefixes every line with elapsed
# seconds, so you can see which section is the expensive one (that is how the 28 s tail-boost wait was found).
# NOTE: run it from the plugin root; the suites are location-independent (they pick a real
# workspace from ~/.dsh/sessions and skip session assertions if there are none). The assertion
# total floats by +/-1 (it depends on whether the newest session has catalog registrations);
# the STABLE criteria are "0 failed" and "0 non-zero exit".
```

**Platform**: **both Windows and Linux have been run for real** (`node test/run-all.mjs` → 0 failed):
Windows 31 suites / 1247 assertions, Linux (WSL2 Ubuntu 24.04 + Node 22.20) 31 suites / 1205 — the difference is entirely
platform-aware branches (symlinks, read-only injection, whether local session logs exist). **macOS is still unverified.**
The first real Linux run only caught tests that had mistaken *Windows properties* for universal truths (`taskkill`,
`env.TEMP`, `env.USERPROFILE`, `attrib +R`, case-insensitive paths, plus one symlink-branch assertion that had never
executed), and one genuine product issue: passing a case-mismatched plain path to `table_diff` threw a bare `Error`
(it is now a guided `ToolError`). `.github/workflows/ci.yml` still ships an **ubuntu job (observational,
`continue-on-error`)** — clean checkout + `npm install` makes the suites import from the **source tree** and really run;
drop the observational flag once it is green a few times in a row.

The suites **do not need the host**: session logs, checkpoint, table diff and the diff engine are plain `node:` code and run offline.

### Layout

```
lib/
  index.js            plugin entry (per-section try/catch; one failing section never takes the others down; writes a beacon log)
  ast/edit.js         ast_edit: in-process @ast-grep/napi rewrite engine (preview → apply, atomic write)
  ast/lang.js         extension → Lang mapping + dynamic language registration
  ast/help-topics.js  section table for the ast-grep rule topics (drift-checked against docs/TOOLKIT.md)
  glob.js             file collection (glob + a gitignore subset; ours, zero dependencies)
  checkpoint/         checkpoint/rewind core + our own unified diff
  session/            session logs (multi-frame zstd, decoded frame by frame)
  tablediff/          table diff (adapters → projection → hash join)
  help/               toolkit_help (lazily reads docs/TOOLKIT.md)
  deps.js / errors.js
docs/TOOLKIT.md       the on-demand help text (never injected into standing context)
test/                 31 self-test suites
```

## License and attribution

- Released under **MIT** ([`LICENSE`](LICENSE)).
- The repo **bundles one piece of upstream code**: `lib/search.js`, taken from `dsh-ast-grep@0.1.0` (MIT). We modified it in three ways (lazy-loading of the help document, graceful degradation when a help section is missing, everything else unchanged).
- The `## ast-rules` section of `docs/TOOLKIT.md` is a **Chinese translation** of the [`ast-grep-mcp`](https://github.com/ast-grep/ast-grep-mcp) rule guide (MIT). Code blocks, property names and YAML examples are kept verbatim; where the translation is ambiguous, the upstream original wins.
- Provenance, our modifications, the **verbatim third-party license texts** and the dependency license list are consolidated in **[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)**.

## Notes

- Built primarily for **personal, day-to-day use**: localization/glossary diffing, session archaeology, and "make it possible to roll back". Interfaces may change as needs change.
- Runs **host-side only**; it injects nothing into the web UI. Checkpoints live in `~/.dsh/checkpoints/dsh-toolkit/` (a **global** store with a single index shared across workspaces).
- **All five families ship off by default.** Turn them on per profile in *Settings → 工具集*; the switches apply **live** (no restart). `toolkit_help` is always available, so the model can ask which families are enabled before reaching for a tool.
- Optional environment knobs: `DSH_TOOLKIT_BEACON_DIR` (where the load log `_toolkit-load.log` is written; defaults to `$DSH_HOME/dsh-toolkit` and the system temp dir), `DSH_TOOLKIT_CHECKPOINTS` (snapshot store), `DSH_TOOLKIT_CONFIG_FILES` (extra config files to include in a snapshot, `;`-separated) and `DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES=1` (operator-only switch for `checkpoint` writes outside the workspace).
- Declares its DSH compatibility range as **`engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"`**. DSH 0.2.1+ gates plugin **activation** on `engines.dsh` when present (it then decides alone); without it, only `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer dependencies are checked — an unmet requirement blocks activation, with a user-granted version exemption as the escape hatch.
