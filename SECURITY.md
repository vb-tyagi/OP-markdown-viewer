# Security

## What this tool is

A static web page. There is no server, no account, no database, and no analytics. By default the page opens markdown files you pick, with no permission grant of any kind, and saves edited copies where you choose. Two features are opt-in and off by default: writing straight back into a folder you grant access to (File System Access API), and an AI reviewer. Nothing leaves your machine unless you turn the reviewer on.

## Data flows

| Data | Where it goes |
|---|---|
| Your markdown files (files mode, default) | Read in your browser. Never written to, never uploaded. Saving writes a copy to a location you pick in a save dialog, or to your downloads. |
| Your markdown files (direct mode, opt-in) | Read and written in place, inside the one folder you granted. Never uploaded. |
| Backups (direct mode only) | Written into a hidden folder inside the folder you opened. |
| "Done" marks, settings | `localStorage` of this site in your browser. |
| Anthropic API key (optional) | `sessionStorage` by default; plaintext `localStorage` of this site if you tick "remember" (readable by browser extensions with access to the site). Sent only to `https://api.anthropic.com`. |
| During an AI review (optional) | The file name, the original and edited text, and your style notes are sent to `https://api.anthropic.com` with your key, or to the local companion on `127.0.0.1` if you run `npm start`. |
| Images referenced by a document (default on) | Fetched over https from the image's host when the file opens, so that host sees your browser's request. The "show images from the web" setting turns this off; images then appear as click-to-load placeholders. |

The Content Security Policy (`connect-src 'self' https://api.anthropic.com`, `img-src 'self' data: blob: https:`) makes any other network destination impossible for page scripts; images are the only content that can be fetched from arbitrary https hosts, and only when a document references them.

## Hardening in place

- Strict CSP: no inline scripts or styles, no third-party scripts, no frames, no workers. Remote images are allowed over https only, and can be switched to click-to-load in settings. Vendored scripts carry Subresource Integrity hashes.
- The document is rendered by the editor from a fixed schema (text, headings, lists, links, images, code), never from the file's HTML. Raw HTML blocks and tables are shown through DOMPurify with `id`, `name`, `class` and `style` attributes stripped, pasted HTML goes through the same sanitizer before the editor parses it, and link and image URLs are limited to http, https, mailto, tel and relative paths. A hostile `.md` file therefore cannot run script, read the stored key, clobber the app's own element lookups, or impersonate its buttons and panels.
- Both optional features are off by default and explained in the app with an (i) button before you turn them on.
- In direct mode the page only ever opens existing `.md` and `.markdown` files at the top level of the folder you choose and never creates new files outside its backup folder.
- Writes are atomic (`createWritable` swap file) and verified byte for byte after writing. A backup of the previous version is written first.
- Vendored files are pinned by SHA-256 in `public/vendor/HASHES.txt` (`npm run verify-vendor`). DOMPurify is copied unmodified from its npm tarball. The editor bundle (ProseMirror, markdown-it) is built by `scripts/build-editor.mjs` from exact-pinned `devDependencies` with a committed lockfile, and CI rebuilds it on every push and fails if the committed file differs.
- No runtime dependencies and no build step to serve the app; the dev dependencies exist only to rebuild that one bundle and to run the tests.
- GitHub Actions in this repository are pinned to commit SHAs.

## The local companion (`npm start`)

`server.js` serves the same static files on `127.0.0.1` and adds one endpoint that runs the `claude` CLI as the reviewer. It binds to loopback only, accepts the review endpoint only from its own origin (Host must name this exact listener, Origin and Sec-Fetch-Site must be same-origin, JSON content type is required, bodies over 2 MB are refused), runs the CLI with a fixed argument list and no shell, with the built-in tools removed (`--tools ''`), no MCP servers (`--strict-mcp-config`), no CLAUDE.md, hooks, plugins or skills (`--safe-mode`), no settings files, and nothing persisted. One review runs at a time, it is killed if the browser cancels, and it times out after two minutes. The server never reads or writes your essay files; the browser does that.

## Known limits

- The AI reviewer sends the text of the file being reviewed to Anthropic. Do not enable it for files you cannot share with that service.
- A hostile markdown file could try to talk the AI reviewer into a wrong verdict. The deterministic guard is independent of the model and still runs.
- Browser storage is per browser profile. Clearing site data forgets the key, the settings and the "done" marks.
- Safari and Firefox have no save dialog API and no direct folder saving; there, saving downloads a copy.
- On GitHub Pages the protections that need HTTP headers (`frame-ancestors`, `X-Frame-Options`, `nosniff`, COOP, CORP) are absent because Pages cannot set headers; the meta CSP still applies. Vercel sends the full set.
- Files with mixed line endings are normalized to LF on save; the editor says so in a banner before you save.
- Backups accumulate inside the folder you edit (the newest 30 per file are kept). If that folder is a git repository, add the backup folder to its `.gitignore`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability") rather than a public issue. Private reporting is enabled for this repository.
