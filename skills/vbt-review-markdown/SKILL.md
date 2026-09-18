---
name: vbt-review-markdown
description: Open markdown files for reviewing and editing in OP-markdown-viewer, running locally in the browser. Use when the user invokes /vbt-review-markdown, or asks to "review these markdown files", "open my essays in the editor", "edit these .md files in the viewer", "load the markdown tool", or wants to walk through a folder of .md files one by one. Asks which files or folder to load (or lets the user drop files in themselves), picks a port nobody else is using, starts the local companion with those files, opens the browser, and hands over. Saves land on disk with backups. NOT for reading or summarizing markdown in chat (just read the files), and NOT for deploying the tool.
---

# Review markdown in OP-markdown-viewer

Starts the tool locally with the user's files loaded, in the browser, on a port that is guaranteed free.

The tool lives at https://github.com/vb-tyagi/OP-markdown-viewer. Locally it is expected at
`~/v-my-apps/OP-markdown-viewer` (override with the `OP_MARKDOWN_VIEWER_DIR` environment variable).

## Step 0: find the tool

```bash
TOOL_DIR="${OP_MARKDOWN_VIEWER_DIR:-$HOME/v-my-apps/OP-markdown-viewer}"
[ -f "$TOOL_DIR/server.js" ] || git clone https://github.com/vb-tyagi/OP-markdown-viewer.git "$TOOL_DIR"
```

Nothing to install: the app has no runtime dependencies. Node 18 or newer is required.

## Step 1: ask what to review

If the user has not already said, ask one question with three choices:

1. **a folder** (every `.md` and `.markdown` file at its top level)
2. **specific files** (one or more paths; `@file` mentions count)
3. **nothing yet**: they will open, drag or drop files themselves in the browser

Check that the paths exist and are markdown before going on. Never guess a path the user did not
name, and never widen a file list into its whole folder without asking.

## Step 2: pick a port that is free (mandatory, every time)

Never assume a port is free, and never hard-code one. Ports like 3000, 5173 and 8000 are almost
always taken on a developer machine, and this user runs several servers in parallel. The tool ships
the check:

```bash
PORT=$(node "$TOOL_DIR/scripts/free-port.mjs")
```

It reads the machine's listening sockets (`lsof -iTCP -sTCP:LISTEN -P -n`), skips every port in use,
and confirms the candidate by binding to it, walking upward from 4545. The server repeats the same
check when it starts, so even a race with another process cannot produce a clash: if the requested
port is busy it moves to the next free one and prints the port it actually took.

## Step 3: start the companion with the files

Run it in the background and keep the log:

```bash
cd "$TOOL_DIR" && PORT=$PORT node server.js --dir "/path/to/folder"        # a folder
cd "$TOOL_DIR" && PORT=$PORT node server.js --files "/path/a.md" "/path/b.md"   # specific files
cd "$TOOL_DIR" && PORT=$PORT node server.js                                     # nothing preloaded
```

Wait for the log line that begins with `open http://127.0.0.1:` and take the URL from that line, not
from the `PORT` you requested: it is the port the server really bound. The `files` line lists what was
loaded. If the server exits with `no .md or .markdown files found`, tell the user and go back to Step 1.

## Step 4: open it in the browser

- In the Claude desktop app: `preview_start` with `{url: "<the URL from the log>"}`.
- In a terminal session: `open "<URL>"` on macOS, `xdg-open` on Linux, or paste the URL for the user.

The page detects the session and opens the files at once; "change" on the header returns to the start
screen, where "open files from your terminal" brings them back. The user can still open, drag or drop
other files at any time; those follow files mode (saving writes a copy).

## Step 5: hand over

Tell the user, briefly: the URL, which files are loaded, that saves write straight back to those files
with a backup copy in `.op-markdown-viewer-backups/` next to them, and that saying "done" stops the
server. Then stop talking; the editing happens in the browser, not in chat.

If the user asks you to review the content, read the files directly and give feedback in chat. Do not
edit files the user is editing in the tool unless they ask; if they do, they should save first, and you
should tell them to reload the file in the tool afterwards (the tool notices a changed file before
overwriting it, but it does not auto-reload).

## Step 6: stop when asked

Kill the background server process and confirm the port is released. Leave the backups alone.

## Guardrails

- The server only ever serves the files named on its command line; that is the whole safety story.
  Do not add paths the user did not ask for.
- One server per review session. If a previous one is still running, reuse it or stop it first.
- Port choice is never optional. Always run the free-port check before starting, even if a port
  "should" be free.
- The AI reviewer inside the tool is opt-in and off by default; do not switch it on for the user.
