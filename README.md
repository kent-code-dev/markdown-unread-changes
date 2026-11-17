# Markdown Unread Changes

Highlights what changed in your Markdown files since you last read them — right in VS Code's built-in Markdown preview.

Useful when an AI assistant (or a teammate) rewrites your notes and you want to see exactly what changed, without using Git.

## Features

- **Colors in the built-in preview**
  - Yellow: modified blocks
  - Green: added blocks
  - Red: deleted content (shown with strikethrough)
- **Previous text**: hover a modified block to see what it said before, or click it to expand the previous text in place.
- **Tables**: only the changed rows are colored. Column or alignment changes mark the whole table.
- **Status bar**
  - `変更 3件` (3 changes): the number of change locations in the current file. Click to mark the file as read.
  - `未読 2ファイル` (2 unread files): click to pick an unread file. It opens in the Markdown preview by default.
  - `未読なし`: nothing unread.
- **Commands**: `Mark Current File as Read`, `Mark All Files as Read`, `Show Unread Files`.

On first start, every Markdown file in the workspace is imported as "read". After that, any change becomes "unread" until you mark it as read.

## Settings

| Setting | Default | Description |
|---|---|---|
| `markdownUnreadChanges.include` | `["**/*.md"]` | Glob patterns of files to track |
| `markdownUnreadChanges.exclude` | `node_modules`, `.git`, `dist`, `out`, `build`, `vendor` | Glob patterns to exclude (`files.exclude` is applied too) |
| `markdownUnreadChanges.maxFiles` | `2000` | When exceeded, only files you open are tracked |
| `markdownUnreadChanges.maxFileSize` | `1024` (KB) | Larger files are not tracked |
| `markdownUnreadChanges.openUnreadFileIn` | `preview` | Where to open a file picked from the unread list: `preview` (brings an existing preview of the file to the front) or `editor` |

## Privacy

This extension **never connects to the internet**.

- No telemetry, no analytics, no error reporting, no remote resources. The preview CSS and script are bundled with the extension.
- The only data it stores is a snapshot of each tracked Markdown file at the moment you marked it as read. Snapshots are saved in VS Code's per-workspace local storage folder (`ExtensionContext.storageUri`) and are not synced.
- The extension has no runtime dependencies.

This is enforced by lint rules that forbid network APIs in the source code.

## License

[MIT](LICENSE)
