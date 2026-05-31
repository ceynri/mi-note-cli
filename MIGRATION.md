English | [简体中文](./MIGRATION.zh-CN.md)

# Migrating from mi-note-export to mi-note-cli

`mi-note-cli` is a full-featured, independent CLI for Xiaomi Cloud Notes. If you previously used `mi-note-export` (export-only), this guide helps you switch.

> mi-note-cli is a standalone tool. It does **not** depend on, read, or modify mi-note-export in any way. This document is the only place that mentions the old tool.

## What's different

| | mi-note-export | mi-note-cli |
|---|---|---|
| Scope | Export only (cloud → local) | Full read/write + folders + image upload + export + **two-way sync** |
| Commands | single command | `login` / `list` / `get` / `search` / `create` / `update` / `delete` / `move` / `pin` / `folders` / `upload-image` / `export` / `sync` |
| AI-friendly | — | global `--json`, fail-fast in non-interactive contexts |
| Local↔cloud | one-way snapshot | `export` (one-way) + `sync` (bidirectional with conflict modes) |

## Command mapping

| mi-note-export | mi-note-cli |
|---|---|
| `mi-note` (incremental export) | `mi-note-cli export -o <dir>` |
| `mi-note --force` | `mi-note-cli export -o <dir> --force` |
| `mi-note --delete-id <id>` | `mi-note-cli delete <id>` |
| `mi-note --login` | `mi-note-cli login` |
| `mi-note --clear-cache` | `mi-note-cli logout` |

New capabilities with no old equivalent: `sync` (two-way), `create`, `update`, `move`, `pin`, folder management, `upload-image`, `search`.

## Login

Sessions are **not** carried over. Run `mi-note-cli login` once to authenticate (opens a browser). mi-note-cli keeps its own cookie cache, fully separate from the old tool.

## Configuration & state

- Old: `.mi-note-export.json` in the working dir + `.sync-state.json` inside the output dir.
- New: a single JSON file in the OS config dir, holding global config + per-directory sync state:
  - macOS: `~/Library/Application Support/mi-note-cli/config.json`
  - Linux: `~/.config/mi-note-cli/config.json`
  - Windows: `%APPDATA%\mi-note-cli\config.json`

There is no automatic import of the old config. To replicate your old setup:

```bash
# Old: { "output": "./my-notes" }
# New: just pass -o, or set a default sync mode via init
mi-note-cli export -o ./my-notes      # one-way, same as before
mi-note-cli sync init                  # optional: set a default sync mode
```

## Recommended path

1. `mi-note-cli login`
2. If you only want backups (old behavior): `mi-note-cli export -o ./my-notes`
3. If you want local edits to flow back to cloud: `mi-note-cli sync -o ./my-notes --mode two-way`

Your old `mi-note-export` install and its data remain untouched; you can keep or remove it independently.
