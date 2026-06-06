English | [简体中文](./README.md)

# mi-note-cli

A full-featured CLI for Xiaomi Cloud Notes (i.mi.com) — read, create, update, delete, move, and pin notes, manage folders, upload images, export, and **two-way sync**. **Designed for AI / scripting** (unified `--json` output, fail-fast in non-interactive mode).

> Migrating from the old mi-note-export? See [MIGRATION.md](./MIGRATION.md) (Chinese only).

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

### As a CLI tool

```bash
npm install -g mi-note-cli
```

> Requires Node.js >= 18. Playwright is only used to open a browser at login time, preferring system Chrome.

### As an AI Skill

Install the bundled skill via [`npx skills`](https://github.com/agentc-app/skills) to give your AI agent knowledge of this tool:

```bash
npx -y skills add ceynri/mi-note-cli --all
```

Or choose which agents to install to:

```bash
npx skills add ceynri/mi-note-cli
```

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
- **User config**: `.mi-note-cli/config.json` at the project root, holding user preferences (sync mode / default output dir / filename template). The CLI reads/writes inside the directory you run it from. Safe to commit so a team can share the same preferences.
- **Default output**: when neither user config nor CLI `-o` provides one, it falls back to `.mi-note-cli/output/` so things work zero-config.
- **Sync state**: `<output>/.mi-note-cli.state.json`, holding the sync baseline (per-note content hash, `filePath`, last-synced remote modify time). Travels with the output directory — moving the whole output dir keeps sync working. Not for version control: just add the output dir to `.gitignore` and the state file is ignored along with it.

### Customizing sync behavior (optional)

Add any of the following fields to `.mi-note-cli/config.json`:

```json
{
  "mode": "mirror",
  "output": "./mi-notes",
  "fileNameTemplate": "${YYYY}-${MM}-${DD}_${HH}-${mm}-${ss}[_${title}]"
}
```

- `mode`: default sync mode, used when `sync` runs without `--mode`
- `output`: default sync/export directory, used when `sync` / `export` runs without `-o` (relative paths resolve against the project root)
- `fileNameTemplate`: filename format for `sync` / `export` (the `.md` extension is appended automatically)

With this template, exported filenames look like:

- Note with a title → `2026-06-06_14-03-00_reading-notes.md`
- Note without a title → `2026-06-06_14-03-00.md`

**Placeholders**

| Placeholder | Meaning |
|---|---|
| `${YYYY}` / `${YY}` | 4-digit / 2-digit year |
| `${MM}` `${DD}` | Month / day (zero-padded) |
| `${HH}` `${mm}` `${ss}` | Hour / minute / second (24-hour, zero-padded) |
| `${title}` | The note's real title. **Empty** when the user didn't set one |
| `${subject}` | A non-empty subject: real title if set, otherwise the first content line or the creation timestamp |
| `${id}` | Note ID |

Time fields are based on the note's **creation time** in the local timezone.

**Conditional segments `[...]`**

A bracketed segment is rendered only when **all** of its `${var}` placeholders are non-empty; otherwise the whole segment (including its separators) disappears. The most common use is wrapping the optional title segment:

```
${YYYY}-${MM}-${DD}[_${title}]
```

- With title → `2026-06-06_reading-notes`
- Without title → `2026-06-06`

Use `\[` / `\]` to write literal brackets.

**Default behavior**

When `fileNameTemplate` is unset, the behavior is equivalent to `${subject}` — always a non-empty filename. Templates **do not support `/`** — folder hierarchy is always derived from the cloud-side folder; the template only produces the basename.

## Known Limitations

### Service capabilities

- **Trash listing / restore**: no public API; deleted notes can only be restored within 30 days via the [i.mi.com](https://i.mi.com) web UI.
- **Private notes / dedicated to-do type / mind maps**: no stable write API; best-effort on export, no editing.
- **User tags**: Xiaomi Notes has no user-tag system (the `tag` field is a sync version).
- **Cookie lifetime**: when the short-lived `serviceToken` expires, the CLI silently refreshes it using the persisted long-lived session — usually no need to `login` again; you only need to re-run `login` once the long-lived session itself expires.

### Markdown coverage (experimental)

> The project is in early stages with limited real-world usage, and the converter may have known or unknown gaps. Validate on a small subset first for important notes, and keep manual backups of critical content — feedback on incorrect conversions is very welcome.

**Stably supported** (covered by both unit and integration round-trip tests): headings (H1–H3), ordered / unordered lists (including multi-level nesting and paragraph-broken numbering), checkboxes, blockquotes, horizontal rules, bold `**bold**` / italic `*italic*` / strikethrough `~~strike~~` / underline `<u>...</u>`, links, inline code, paragraphs, image attachments.

**Currently unsupported**: tables, footnotes, definition lists, fenced code-block language tags, Setext-style headings (`===` / `---`), inline HTML other than `<u>`. These will be silently dropped or kept as literal text during conversion.

**Two-way sync caveat**: the 3-way diff compares in Markdown space — if the conversion isn't lossless, the diff treats the drift as "remote-side change" and may overwrite. If you rely heavily on syntax outside the whitelist above, or notice your local markdown style being rewritten after sync, prefer `manual` / `two-way` mode (which pauses on disagreement) over `mirror`.

---

## Contributing & Feedback

The project is in early stages — for any conversion oddities, missing features, new placeholder ideas — please [open an issue](https://github.com/ceynri/mi-note-cli/issues) or PR. The smaller the repro, the better.

---

## Notes for AI Callers

1. Always pass `--json` for parseable output.
2. In non-interactive contexts (no TTY), an unauthenticated call fails immediately instead of hanging on browser login — have a human run `login` once first.
3. For destructive actions pass `-y`; in non-interactive sync, real conflicts are skipped without touching data.

---

## Development

```bash
git clone https://github.com/ceynri/mi-note-cli.git
cd mi-note-cli
pnpm install
pnpm build              # compile
pnpm dev                # watch mode
pnpm test               # unit tests (no network)
pnpm test:integration   # real-API integration tests (needs login; writes self-clean)
```

## License

MIT
