# KbauBlocks — Technical architecture

```
                         ┌──────────────────────── same origin (e.g. kbau.lol/) ─────────────────────────┐
  Browser                │                                                                                         │
                         │  Website (static HTML + ES modules)          Editor (built TurboWarp GUI + KbauBlocks patches)│
                         │  index / explore / project / user / ...      editor.html, embed.html, addons.html            │
                         │  js/api.js  ── localStorage "kbau:token" ──  src/lib/kbau-cloud.js                          │
                         └──────────────┬───────────────────────────────────────────────┬──────────────────────────┘
                                        │ HTTPS JSON + multipart (Bearer token)         │ WebSocket (cloud vars)
                                        ▼                                               ▼
                         ┌──────────── shared core: server/src/core (api.js, auth.js, cloud.js) ────────────────────┐
                         │  Production: Cloudflare Worker  — D1 (SQL) · R2 (files) · Durable Object per project room │
                         │  Self-host:  Node server        — node:sqlite · data/blobs/ · in-process rooms + static   │
                         └──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Repository layout (`kbaucode/`)

| Path | Purpose |
|---|---|
| `editor-src/` | KbauBlocks editor **source**: `TURBOWARP_COMMIT` (pinned upstream), `apply-kbau.mjs` (asserted patch script), `overlay/` (new files). |
| `editor/` | **Built** editor, produced by `.github/workflows/kbaucode-editor.yml`. Never edit by hand. |
| `index.html`, `explore.html`, `project.html`, `user.html`, `mystuff.html`, `collection.html`, `login.html`, `settings.html`, `admin.html`, `extensions.html` | Website pages (thin HTML shells). |
| `js/api.js` | API client, session storage, API base discovery. |
| `js/ui.js` | Header/footer, cards, modal, toast, theme, helpers. |
| `js/pages/*.js` | One module per page. |
| `css/kbau.css` | Design system (tokens, components). |
| `config.json` | `{"apiBase": ...}` — where the site/editor find the API. `null` = no server (static hosting). The Node server overrides this file when it serves the site. |
| `server/` | Backend: `src/core/` (platform-neutral API), `src/worker/` (Cloudflare), `src/server.js` + `src/node/` (Node), `migrations/` (shared SQL), `test/api.test.js` (runs against either). |
| `docs/` | Research, architecture, roadmap. |

## Editor build pipeline

1. Push to `kbaucode/editor-src/**` on `main` triggers *KbauBlocks editor build*.
2. Workflow checks out `TurboWarp/scratch-gui` at the pinned commit, `npm ci`, runs `apply-kbau.mjs`, then `webpack` (production).
3. `gui/build/` is copied to `kbaucode/editor/` and committed by the workflow (`[skip ci]`).

Why patches instead of a full fork: TurboWarp's GUI is ~3,000 files and 1.5 GB of dependencies. A small, asserted patch set keeps our changes reviewable, makes upgrading TurboWarp a one-line change (bump `TURBOWARP_COMMIT`, re-run; any drifted anchor fails loudly), and builds on GitHub's runners instead of a local machine.

### Current patch set
* Branding: app name **KbauBlocks**, logo + wordmark in the menu bar linking to the site, credits notice, feedback links → our issue tracker, tab title.
* Theme: default **dark** GUI with near-black greys (`#0e0e0e`/`#161616`/`#262626`), **solid black top bar** (`#000`) in every theme/accent, default **White** accent (black text and icons on accent-filled buttons, via `--kbau-on-accent` / `--kbau-accent-icon-filter`), with **Mint** as an extra choice.
* Community: **File → Save to KbauBlocks** (create or new version, thumbnail from the stage, remix attribution via `kbau_remix`), `?kbau_project=<id>` loading with the user's token, cloud handshake uses the KbauBlocks project id.

## Unified extension architecture

All extensions go through **one** mechanism: the Scratch extension API as implemented by TurboWarp's `extensionManager` (built-ins, sandboxed URL extensions, unsandboxed extensions behind the security manager). On top of that:

* **Catalog** (`extensions.html`): merges sources (TurboWarp gallery JSON, PenguinMod gallery list, custom URL) into one UI. Every entry resolves to a URL, opened as `editor.html?extension=<url>`. Adding a new source = one entry in `SOURCES` with a `load()` returning `{name, description, by, url, image}`.
* **Compatibility tiers** shown to users: TurboWarp gallery (fully compatible), PenguinMod gallery (may need PenguinMod-only APIs), custom (unknown).
* **Next step** (roadmap): a KbauBlocks compatibility shim exposing the PenguinMod-specific VM APIs most gallery extensions use, and an in-editor catalog modal reusing the same source definitions.

## Backend

* **Shared core**: `src/core/api.js` takes a standard `Request` and returns a `Response`, with injected `db` (async get/all/run) and `blobs` (put/get) adapters. The same routes run on Cloudflare Workers (D1 + R2) and Node (node:sqlite + files), and the same test suite verifies both.
* **Auth**: PBKDF2-SHA256 password hashes (Web Crypto, 100k iterations); random 256-bit bearer tokens, only SHA-256 hashes stored; 30-day sliding sessions; password change revokes other sessions. First registered user (or `KBAU_ADMINS`) is admin.
* **Data model** (`server/src/db.js`): users, sessions, projects (+ counters), project_versions, loves, favorites, views (dedup per viewer per day), comments (one level of replies), collections, collection_projects, reports, cloud_variables. Migrations: `migrations/*.sql`, tracked in `d1_migrations` on both backends.
* **Storage**: every save is a new immutable version object `projects/<id>/<n>.sb3` (R2 or `data/blobs/`); restore creates a new version. Thumbnails and avatars validated by magic bytes.
* **Visibility**: shared && !hidden && !deleted is public; owners and moderators see the rest.
* **Discovery**: recent; popular (weighted all-time counters); trending (weighted activity in the last 7 days + new-share boost); search over titles, descriptions and usernames.
* **Moderation**: reports on projects/comments/users; mods can hide content, ban (revokes sessions), dismiss; admins assign roles.
* **Cloud variables**: `/kbau-api/cloud/<projectId>` (one Durable Object per project on Cloudflare) speaks TurboWarp's protocol (`handshake`, `set`, `create`, `delete`, `rename`, newline-delimited JSON), rooms per project, values persisted, 40 vars/project, rate-limited.
* **Rate limits**: fixed windows stored in the `rate_limits` table (works across Worker isolates) for register, login, create, save, comment, report.

### API summary (prefix `/kbau-api`)

`GET /health` · `POST /auth/register|login|logout` · `GET /auth/me` ·
`GET /users/:u` · `GET /users/:u/projects[?all=1]|favorites|collections|avatar` · `PATCH /users/me` · `POST /users/me/avatar|password` ·
`POST /projects` · `GET|PATCH|DELETE /projects/:id` · `PUT /projects/:id/content` · `GET /projects/:id/sb3[?version=]|thumbnail|versions|remixes` · `POST /projects/:id/thumbnail|share|unshare|view|versions/:v/restore` · `POST|DELETE /projects/:id/love|favorite` ·
`GET|POST /projects/:id/comments` · `DELETE /comments/:id` ·
`GET /explore?sort=trending|popular|recent` · `GET /search?q=` · `GET /stats` ·
`POST /collections` · `GET|PATCH|DELETE /collections/:id` · `POST /collections/:id/projects` · `DELETE /collections/:id/projects/:pid` ·
`POST /reports` · `GET /admin/reports` · `POST /admin/reports/:id/resolve` · `POST /admin/projects/:id/hide|unhide` · `POST /admin/comments/:id/hide` · `POST /admin/users/:u/ban|unban|role` · `WS /cloud`

## Deployment options

1. **Current production**: GitHub Pages (site + editor) + Cloudflare Worker API. See [HOSTING.md](HOSTING.md).
2. **Self-hosted all-in-one**: `node kbaucode/server/src/server.js` serves the website, the editor and the API on one origin (shared auth works automatically).
3. **Split**: Pages for static files, server elsewhere; set `config.json` → `{"apiBase": "https://api.example.com/kbau-api"}`. CORS is open (`*`) because auth uses bearer tokens, not cookies.

Environment variables: `PORT` (8787), `HOST`, `KBAU_DATA_DIR`, `KBAU_SITE_DIR`, `KBAU_API_PREFIX` (`/kbau-api`), `KBAU_SERVE_SITE` (`0` to disable static), `KBAU_ADMINS` (comma list), `KBAU_FIRST_USER_ADMIN` (`0` to disable), `KBAU_TRUST_PROXY` (`1` behind a reverse proxy).
