# OP-markdown-viewer

Edit markdown files in your browser. Open files, make your changes, and save copies wherever you like, with a formatting guard that catches accidental damage on every save. Nothing is uploaded, and nothing asks for permission. Two features are there if you want them, and off until you do: saving straight back into a folder, and an AI reviewer.

**Live:** https://op-markdown-viewer.vercel.app · **Try it:** open the live page and click "try the demo".

## What it does

- **Open files** (or drop them on the page). No permission prompt, works in every browser. The page lists them, shows the raw markdown next to a rendered preview, and lets you walk through them one by one (`⌘[` / `⌘]`), marking each as done.
- `⌘S` **saves a copy**. In Chromium browsers a save dialog lets you choose where each copy goes (pick the original if you want to overwrite it); elsewhere the copy is downloaded. Your originals are never modified behind your back.
- Before every save, a **formatting guard** compares the structure of what you loaded with what you are saving. A clean edit saves instantly. Warnings or damage are shown with the exact issue, and you decide.

Two optional features, each with an (i) explainer in the app and off until you choose them:

- **Direct folder saving.** Open a folder instead of files. The browser asks once for permission to read and write inside that one folder, and saves then go straight back into the original files, with a backup copy first. Chromium browsers only.
- **AI reviewer.** A second opinion on formatting only, never on the prose. It runs with your own Anthropic API key, or through your local `claude` CLI when you run the companion server. Enable it in settings.

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

Then open http://127.0.0.1:4545. No dependencies to install. Node 18 or newer.

## Deploy your own

It is a static site. The `public/` folder is the whole thing.

- **Vercel** (what the live link uses): import the repository; `vercel.json` sets the output directory and the security headers. Every push to `main` deploys.
- **GitHub Pages:** enable Pages with source "GitHub Actions", then run the `pages` workflow from the Actions tab (`.github/workflows/pages.yml`, manual trigger). Pages cannot send HTTP headers, so only the in-page security policy applies there.

`.github/workflows/ci.yml` runs the tests and the vendor hash check on every push and pull request.

## Privacy and security

No accounts, no analytics, no cookies, no third-party scripts, no remote fonts. The only network destination the page can reach is `api.anthropic.com`, and only when you enable the AI reviewer. A strict Content Security Policy is set both in the page and in the hosting headers (on GitHub Pages only the in-page policy applies, since Pages cannot send headers). The markdown preview is sanitized with DOMPurify. Vendored libraries are pinned by SHA-256 and loaded with Subresource Integrity (`npm run verify-vendor`). See [SECURITY.md](SECURITY.md) for the data flows and the threat model.

## Layout

```
public/            the app (deploy this folder)
  index.html       markup, CSP meta tag
  app.js           UI and save flow
  guard.js         formatting guard (pure function, also used by the tests)
  fs.js            folder providers: real folder, demo sandbox, download fallback
  review.js        AI reviewer providers (Anthropic API, local CLI)
  review-core.js   reviewer prompt and reply parser, shared with the server
  samples/         sample essays for the demo
  vendor/          marked and DOMPurify, pinned by hash
server.js          optional local companion (static files + CLI reviewer)
test-guard.mjs     tests (npm test)
scripts/           vendor hash verification
```

## License

MIT.
