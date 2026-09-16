# Security

## What this tool is

A static web page. There is no server, no account, no database, and no analytics. The page edits markdown files in a folder you pick, using the browser's File System Access API, and stays entirely on your machine unless you turn on the AI reviewer.

## Data flows

| Data | Where it goes |
|---|---|
| Your markdown files | Read and written by the page in your browser. Never uploaded. |
| Backups | Written into a hidden folder inside the folder you opened. |
| "Done" marks, settings | `localStorage` of this site in your browser. |
| Anthropic API key (optional) | `sessionStorage` by default; plaintext `localStorage` of this site if you tick "remember" (readable by browser extensions with access to the site). Sent only to `https://api.anthropic.com`. |
| During an AI review (optional) | The file name, the original and edited text, and your style notes are sent to `https://api.anthropic.com` with your key, or to the local companion on `127.0.0.1` if you run `npm start`. |

The Content Security Policy (`connect-src 'self' https://api.anthropic.com`) makes any other network destination impossible for page scripts.

## Hardening in place

- Strict CSP: no inline scripts or styles, no third-party scripts, no frames, no workers, no remote images. Vendored scripts carry Subresource Integrity hashes.
- Markdown preview is sanitized with DOMPurify before it touches the DOM, with `id`, `name`, `class` and `style` attributes stripped, so a hostile `.md` file cannot run script, read the stored key, clobber the app's own element lookups, or impersonate its buttons and panels.
- The page only ever opens existing `.md` files at the top level of the folder you choose and never creates new files outside its backup folder.
- Writes are atomic (`createWritable` swap file) and verified byte for byte after writing. A backup of the previous version is written first.
- Vendored libraries (`marked`, `DOMPurify`) are copied from the npm registry tarballs and pinned by SHA-256 in `public/vendor/HASHES.txt`; `npm run verify-vendor` checks them.
- No dependencies, no build step, no lockfile to poison.
- GitHub Actions in this repository are pinned to commit SHAs.

## The local companion (`npm start`)

`server.js` serves the same static files on `127.0.0.1` and adds one endpoint that runs the `claude` CLI as the reviewer. It binds to loopback only, accepts the review endpoint only from its own origin (Host must name this exact listener, Origin and Sec-Fetch-Site must be same-origin, JSON content type is required, bodies over 2 MB are refused), runs the CLI with a fixed argument list and no shell, with the built-in tools removed (`--tools ''`), no MCP servers (`--strict-mcp-config`), no CLAUDE.md, hooks, plugins or skills (`--safe-mode`), no settings files, and nothing persisted. One review runs at a time, it is killed if the browser cancels, and it times out after two minutes. The server never reads or writes your essay files; the browser does that.

## Known limits

- The AI reviewer sends the text of the file being reviewed to Anthropic. Do not enable it for files you cannot share with that service.
- A hostile markdown file could try to talk the AI reviewer into a wrong verdict. The deterministic guard is independent of the model and still runs.
- Browser storage is per browser profile. Clearing site data forgets the key, the settings and the "done" marks.
- Safari and Firefox cannot write in place; there, saving downloads a copy.
- On GitHub Pages the protections that need HTTP headers (`frame-ancestors`, `X-Frame-Options`, `nosniff`, COOP, CORP) are absent because Pages cannot set headers; the meta CSP still applies. Vercel sends the full set.
- Files with mixed line endings are normalized to LF on save; the editor says so in a banner before you save.
- Backups accumulate inside the folder you edit (the newest 30 per file are kept). If that folder is a git repository, add the backup folder to its `.gitignore`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability") rather than a public issue. Private reporting is enabled for this repository.
