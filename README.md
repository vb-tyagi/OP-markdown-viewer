# OP-markdown-viewer

Edit markdown files in your browser, in the readable view itself. Open files, write and format like in a document, and save copies wherever you like, with a formatting guard that catches accidental damage on every save. Nothing is uploaded, and nothing asks for permission. Two features are there if you want them, and off until you do: saving straight back into a folder, and an AI reviewer.

**Live:** https://op-markdown-viewer.vercel.app · **Try it:** open the live page and click "try the demo".

## What it does

- **Open files** (or drop them on the page). No permission prompt, works in every browser. The page lists them and shows each one as a readable document that you edit directly. Walk through them one by one (`⌘[` / `⌘]`), marking each as done.
- **Format as you write.** A toolbar and shortcuts cover paragraph styles and headings, bold, italic, strikethrough, inline code, links, bulleted and numbered lists, quotes, code blocks, dividers, images by URL, clear formatting, undo and redo. Markdown habits work too: typing `## ` or `- ` at the start of a line converts it. A "read only" switch turns editing off when you only want to read.
- **The markdown source is one click away.** The "markdown" button (`⌘/`) opens the raw source in a pane on the right. It is editable, and both views stay in sync.
- `⌘S` **saves a copy**. In Chromium browsers a save dialog lets you choose where each copy goes (pick the original if you want to overwrite it); elsewhere the copy is downloaded. Your originals are never modified behind your back.
- Before every save, a **formatting guard** compares the structure of what you loaded with what you are saving. A clean edit saves instantly. Warnings or damage are shown with the exact issue, and you decide.

Two optional features, each with an (i) explainer in the app and off until you choose them:

- **Direct folder saving.** Open a folder instead of files. The browser asks once for permission to read and write inside that one folder, and saves then go straight back into the original files, with a backup copy first. Chromium browsers only.
- **AI reviewer.** A second opinion on formatting only, never on the prose. It runs with your own Anthropic API key, or through your local `claude` CLI when you run the companion server. Enable it in settings.

## How editing keeps your markdown intact

The document is parsed into blocks that remember their exact source text. When you save, every block you did not touch is written back from that original text, byte for byte, along with the blank lines around it. Only the blocks you changed are rewritten, and those follow the conventions detected in the file itself: `*` or `_` for emphasis, `**` or `__` for strong, `-`, `*` or `+` for bullets, two-space or backslash line breaks, ``` or ~~~ fences.

A rewritten paragraph comes out on one line, and characters that would otherwise change meaning (`*`, `[`, a backtick) are escaped. Front matter is shown as a small editable card above the document. Things the editor does not model, such as tables and raw HTML blocks, are shown read-only and pass through untouched; edit them in the markdown pane. Inline HTML such as `<u>…</u>` renders and round-trips as written, although the toolbar deliberately has no underline button, since markdown has none.

## Formatting shortcuts

| Action | Shortcut |
|---|---|
| bold, italic, strikethrough, inline code | `⌘B`, `⌘I`, `⌘⇧S`, `⌘E` |
| link | `⌘K` |
| bulleted list, numbered list, quote | `⌘⇧8`, `⌘⇧7`, `⌘⇧9` |
| paragraph, heading 1, 2, 3 | `⌘⌥0`, `⌘⌥1`, `⌘⌥2`, `⌘⌥3` |
| code block | `⌘⌥C` |
| line break inside a paragraph | `⇧⏎` |
| indent or outdent a list item | `⇥`, `⇧⇥` |
| undo, redo | `⌘Z`, `⌘⇧Z` |
| markdown pane | `⌘/` |
| save, previous file, next file | `⌘S`, `⌘[`, `⌘]` |

On Windows and Linux, use `Ctrl` for `⌘` and `Alt` for `⌥`.

## Browser support

| Browser | Files mode (default) | Direct folder saving (opt-in) |
|---|---|---|
| Chrome, Edge, Brave, Arc, Opera (Chromium) | Open, edit, save a copy through a save dialog | Yes |
| Safari, Firefox | Open, edit, download the edited copy | Not available |

Direct saving uses the [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_Access_API). The browser asks once per folder for permission to read and write, shows the grant in the address bar, and forgets it when the tab closes. Only `.md` and `.markdown` files at the top level of the folder are touched.

## How saves are protected

In every mode:

1. The exact text in the editor is written. Nothing is reformatted. A file's BOM is preserved, and so are its line endings when they are consistently LF or CRLF. A file with mixed line endings is shown with a banner and saved with LF throughout. Files that are not valid UTF-8 open read-only.
2. Files written through the browser's file APIs are read back and compared byte for byte.

In files mode, the original file is never written to by the page. The copy goes wherever you point the save dialog, or to your downloads.

In direct mode, additionally:

3. Before every save, the previous version is copied to `.op-markdown-viewer-backups/<file>/<timestamp>.md` inside the folder (the newest 30 per file are kept; can be turned off in settings). If the folder is a git repository, add that backup folder to its `.gitignore`.
4. The write goes through the browser's atomic swap-file mechanism.
5. If the file changed on disk since you opened it, the save stops and asks whether to overwrite.

## The formatting guard

`public/guard.js` fingerprints both versions and flags:

- front matter missing, `---` broken, keys removed, `tags` no longer an array, title no longer matching the H1
- H1 count not 1, heading count or level changes, malformed markers like `##heading`
- unclosed code fences, lost blockquote lines, lost links or images
- unbalanced `**` / `__`, possibly unbalanced `*` / `_`
- doubled blank lines, paragraph count dropping sharply, file shrinking by more than half
- CRLF, tabs, trailing whitespace, lost final newline (with a one-click **apply safe fixes** that leaves code blocks and two-space hard line breaks alone)
- straight `"` quotes where the original used curly “ ”, curly apostrophes where the original used straight `'`
- editing artifacts: TODO, FIXME, XXX, TBD, `[[`, `{{`, merge markers
- informational: capitalized sentence starts, paragraph and list count changes

Every rule is relative to the original file, so the guard adapts to each file's own conventions. `npm test` runs it against 22 damage scenarios.

## The AI reviewer

Off by default. Turn it on in settings (or from the start screen), then pick a provider; "automatic" uses whichever is available:

- **Your Anthropic API key.** Enter it in settings. It is kept in `sessionStorage` (forgotten when the tab closes) unless you tick "remember". The page's Content Security Policy only allows requests to `api.anthropic.com`, so the key cannot go anywhere else. Default model is Claude Opus 5; Sonnet 5 and Haiku 4.5 are available. A review costs a few cents and takes a few seconds.
- **Local `claude` CLI.** Run `npm start` and the page detects the companion, which runs reviews through the CLI on your machine with no API key. The CLI is started with its tools, MCP servers, hooks, memory and settings all switched off.

What gets sent, in either case: the file name, the original text, the edited text, and your style notes. Nothing else.

You can add style notes (for example "all-lowercase prose, curly quotes, straight apostrophes") that the reviewer treats as the house style.

## Run it locally

```bash
git clone https://github.com/vb-tyagi/OP-markdown-viewer.git
cd OP-markdown-viewer
npm start
```

Then open http://127.0.0.1:4545. Nothing to install for running it; Node 18 or newer.

The editor engine (ProseMirror and markdown-it) ships as one committed file, `public/vendor/editor-bundle.js`, built from the pinned `devDependencies` by `npm run build:editor`. You only need `npm ci` if you want to rebuild that bundle or run the test suite.

## Deploy your own

It is a static site. The `public/` folder is the whole thing.

- **Vercel** (what the live link uses): import the repository; `vercel.json` sets the output directory and the security headers. Every push to `main` deploys.
- **GitHub Pages:** enable Pages with source "GitHub Actions", then run the `pages` workflow from the Actions tab (`.github/workflows/pages.yml`, manual trigger). Pages cannot send HTTP headers, so only the in-page security policy applies there.

`.github/workflows/ci.yml` runs the tests and the vendor hash check on every push and pull request.

## Privacy and security

No accounts, no analytics, no cookies, no third-party scripts, no remote fonts. A strict Content Security Policy is set both in the page and in the hosting headers. Pasted HTML and passthrough blocks are sanitized with DOMPurify, and links are limited to http, https, mailto and tel. Vendored files are pinned by SHA-256 (`npm run verify-vendor`), and CI rebuilds the editor bundle from the pinned packages to prove the committed file matches. See [SECURITY.md](SECURITY.md) for the data flows and the threat model.

## Layout

```
public/            the app (deploy this folder)
  index.html       markup, CSP meta tag
  app.js           UI, modes and save flow
  mdeditor.js      the rich editor (ProseMirror view, toolbar commands, shortcuts)
  mdcore.js        markdown schema, parser, serializer and the block splicer
  guard.js         formatting guard (pure function, also used by the tests)
  fs.js            folder providers: files mode, real folder, demo sandbox
  review.js        AI reviewer providers (Anthropic API, local CLI)
  review-core.js   reviewer prompt and reply parser, shared with the server
  samples/         sample essays for the demo
  vendor/          DOMPurify and the built editor bundle, pinned by hash
server.js          optional local companion (static files + CLI reviewer)
test-guard.mjs     guard tests, test-editor.mjs editor fidelity tests (npm test)
scripts/           editor bundle build, vendor hash verification
```

## License

MIT.
