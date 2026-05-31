English | [简体中文](./README.zh-CN.md)

# mi-note-cli

A full-featured CLI for Xiaomi Cloud Notes (i.mi.com) — read, create, update, delete, move, and pin notes, manage folders, upload images, export, and **two-way sync**. **Designed for AI / scripting** (unified `--json` output, fail-fast in non-interactive mode).

> Migrating from the old mi-note-export? See [MIGRATION.md](./MIGRATION.md).

## Features

- **Auth**: interactive browser login with cookie caching
- **Read**: list notes, view a note (as Markdown), keyword search, list folders
- **Write**: create / update / delete / move / pin notes
- **Folders**: create / rename / delete
- **Images**: upload a local image, get an embeddable reference
- **Export `export`**: one-way cloud → local Markdown (attachments, folder layout), never touches the cloud
- **Sync `sync`**: bidirectional local↔cloud with 3-way diff and conflict modes
- **AI-friendly**: global `--json`; never pops a browser in non-interactive contexts — fails fast instead

## Install

```bash
pnpm install
pnpm build
node dist/cli.js --help
# or link globally: npm link → use `mi-note-cli`
```

> Playwright is only used to open a browser at login time, preferring system Chrome.

## Quick Start

```bash
mi-note-cli login                       # 1. Log in (opens a browser)
mi-note-cli list --limit 20             # 2. List notes
mi-note-cli get <noteId>                # 3. View a note
mi-note-cli create --title "Title" --content "# Body"   # 4. Create
mi-note-cli sync -o ./notes --mode two-way              # 5. Two-way sync with a local dir
```

## Commands

| Command | Description |
|---|---|
| `login` / `logout` / `whoami` | Log in / clear session / show status |
| `list [--folder <id>] [--limit <n>]` | List notes |
| `get <id> [--raw]` | View a note (Markdown by default, `--raw` for XML) |
| `search <keyword> [--limit <n>]` | Search titles and snippets |
| `create [--title] [--folder] [--content/--file]` | Create a note (content can come from stdin) |
| `update <id> [--title] [--folder] [--content/--file]` | Update a note |
| `delete <id> [--purge] [-y]` | Delete (trash by default, `--purge` permanent) |
| `move <id> <folderId>` | Move a note to a folder |
| `pin <id>` / `unpin <id>` | Pin / unpin |
| `folders` / `folder create\|rename\|delete` | Folder management |
| `upload-image <path>` | Upload an image, returns `minote://image/{fileId}` |
| `export [-o <dir>] [-f]` | One-way export to Markdown |
| `sync [-o <dir>] [--mode M] [--dry-run] [-y]` | Bidirectional sync |
| `sync init` / `sync status` | Set default mode / show config |

All commands support the global `--json` flag, producing `{ ok, data }` / `{ ok: false, error }`.

## Export vs Sync

- **`export`**: one-way cloud → local snapshot, **never modifies the cloud**. For "I just want backups". Local edits are not pushed back.
- **`sync`**: bidirectional, based on a 3-way comparison (last-sync base / current remote / current local), resolving diffs and conflicts per mode.

### Sync modes (`--mode`)

| Mode | Behavior |
|---|---|
| `download` | Cloud wins: cloud overwrites local; local changes never uploaded |
| `mirror` | Local mirror: download only; local changes detected but not uploaded |
| `upload` | Local wins: everything uploaded to cloud |
| `two-way` | Auto bidirectional: one-sided changes sync automatically; only real conflicts pause |
| `manual` (default) | Interactive: every divergence is listed and asked one by one |

Conflicts (both-changed / one-side-deleted-other-changed): `download/mirror/upload` resolve automatically by their declared winner; `two-way/manual` ask interactively, or in non-interactive contexts skip and report — **never deleting data on their own**.

Use `sync init` to set a default mode interactively; then `sync` can omit `--mode`. `sync --dry-run` previews without executing.

## Embedding Images

```bash
mi-note-cli upload-image ./photo.png    # → ![图片](minote://image/xxxxxx)
mi-note-cli create --title "With image" --content "See:

![图片](minote://image/xxxxxx)"
```

The tool auto-converts `minote://image/{fileId}` into Xiaomi's image markup.

## Data Directories

- **Session cache** (macOS): `~/Library/Caches/mi-note-cli/` (`cookie` + `browser-data/`; may be cleared by the system/user as cache — just log in again).
- **Config & sync state** (persistent, not treated as cache):
  - macOS: `~/Library/Application Support/mi-note-cli/config.json`
  - Linux: `~/.config/mi-note-cli/config.json`
  - Windows: `%APPDATA%\mi-note-cli\config.json`
  - A single file holding the global default mode + per-sync-directory state (keyed by absolute path).

## Known Limitations

- **Trash listing / restore**: no public API; deleted notes can only be restored within 30 days via the [i.mi.com](https://i.mi.com) web UI.
- **Private notes / dedicated to-do type / mind maps**: no stable write API; best-effort on export, no editing.
- **User tags**: Xiaomi Notes has no user-tag system (the `tag` field is a sync version).
- **Cookie lifetime**: sessions are short-lived; re-run `login` after expiry.

## Notes for AI Callers

1. Always pass `--json` for parseable output.
2. In non-interactive contexts (no TTY), an unauthenticated call fails immediately instead of hanging on browser login — have a human run `login` once first.
3. For destructive actions pass `-y`; in non-interactive sync, real conflicts are skipped without touching data.

## Development

```bash
pnpm build              # compile
pnpm test               # unit tests (no network)
pnpm test:integration   # real-API integration tests (needs login; writes self-clean)
```

## License

MIT
