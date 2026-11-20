# KbauBlocks — HANDOFF

Last updated: 2026-11-16. Read this first when continuing development.

## Where things are

* Live (static): `https://kbau.lol/kbaucode/` (repo `deep-v2/deep-v2.github.io`, folder `kbaucode/`, GitHub Pages with CNAME kbau.lol).
* Editor: `kbaucode/editor/` is **generated** by `.github/workflows/kbaucode-editor.yml` from `kbaucode/editor-src/`. Edit the patch script/overlay, push, and the workflow rebuilds and commits the editor (~5 min).
* Backend: **live on Cloudflare** at `https://kbaublocks-api.kbaudasher.workers.dev/kbau-api` (Worker + D1 + R2 + Durable Objects). Source `kbaucode/server/`; deploy/admin/backup steps in `docs/HOSTING.md`. Self-host with `npm start` (Node ≥ 22.13).
* Docs: `docs/RESEARCH.md` (ecosystem + licensing), `docs/ARCHITECTURE.md` (design + API), `docs/ROADMAP.md` (phases).

## Done and verified

| Area | Status | How it was verified |
|---|---|---|
| Editor based on TurboWarp (compiler, addons, custom extensions, sb3 load/save) | ✅ | Built by CI from pinned TurboWarp commit `7738389a`; opened and used in a browser. |
| KbauBlocks identity: name, logo, dark grey default theme, solid black top bar, white accent (Mint still selectable) | ✅ | Checked in the live editor (accent-filled buttons show black text/icons). |
| Save to KbauBlocks (create → version 2 on resave → remix as another user with attribution) | ✅ | Browser end-to-end against local server. |
| `?kbau_project=<id>` loading (incl. unshared projects for owners) | ✅ | Embedded player on project page renders the project. |
| Unified extension catalog (TurboWarp 105 + PenguinMod 73 + custom URL) | ✅ | Loaded both lists; Box2D opened in editor with its category. |
| Backend on Cloudflare (D1, R2, Durable Objects) and Node from one shared core | ✅ | Same test suite passes against Node and a local Worker; production deploy answers health and login checks. |
| Backend: accounts, profiles, avatars, projects, versions, share/unshare, loves, favorites, views, remixes, comments+replies, explore (trending/popular/recent), search, collections, reports, moderation, roles, cloud variables, follows/friends, verified tick, typed search | ✅ | `server/test/api.test.js`: 16 end-to-end tests, all passing. |
| Website pages: home, explore/search, project, profile, My Stuff, collection, sign in/join, settings (profile/account/appearance/server), moderation, extensions | ✅ | Each page loaded against the local server with no JS errors; core actions exercised. |
| Follow / friends (mutual follows), verified tick (admin-granted; automatic for staff), search dropdown (exact user, Search users, Search projects) | ✅ | API tests plus browser check on a local server: follow back → friends, Friends tab, tick, dropdown keyboard navigation. |
| Admin page: overview stats, reports, user search (name, ban reason, IP), bans with reasons, IP bans (exact or prefix*), activity log (sign-ups, sign-ins, bans, roles, ticks, filter blocks, moderation), word filter (built-in list + admin-added words + tester), pinned comments, comment upvotes/downvotes with Newest/Top sort | ✅ | API tests (16/16) plus browser check on a local server; live API migrated and the filter checked on production. |
| Static-hosting fallback (no server) | ✅ | Served with a plain static server: honest "server not connected" notice, editor still works. |

## Not done / not verified (next steps, in priority order)

1. **Make an admin account**: sign up on kbau.lol, then add that username to `KBAU_ADMINS` in `server/wrangler.jsonc` and `npm run deploy` (first-user-admin is off in production).
2. **Cloud variables in the editor**: server side is tested on both backends; the site passes `cloud_host=.../cloud/<id>` + `kbau_project`, but a real two-tab cloud project was **not** tested end-to-end in the browser yet. TurboWarp only connects cloud when the project is "showing with id"; verify, and patch `cloud-manager-hoc.jsx` if needed.
3. **Editor UX for saving**: uses `window.confirm/alert`. Replace with a proper modal (title/description/share toggle) inside the GUI.
4. **PenguinMod blocks as a KbauBlocks extension** (see ROADMAP phase 3), plus a PenguinMod API compatibility shim for gallery extensions.
5. In-editor extension catalog (reuse `SOURCES` from `js/pages/extensions.js`).
6. Translations for KbauBlocks-specific strings (menu item and dialogs are English only).
7. Email verification / password reset (needs an email provider), account deletion, notifications ("someone commented on your project").
8. Dockerfile for Node self-hosting. (Cloudflare backups: D1 Time Travel, see HOSTING.md.)

## Gotchas

* The local Windows machine is low on disk and has path-length limits: build the editor on CI, and clone to a short path (e.g. `C:\kb\site`) with `core.longpaths=true`.
* `apply-kbau.mjs` asserts every anchor. When bumping `TURBOWARP_COMMIT`, run it against a fresh checkout and fix any reported anchors.
* Do not hand-edit `kbaucode/editor/` — the next build overwrites it.
* GitHub Pages runs Jekyll; the workflow fails if the build contains paths starting with `_`.
* The editor's own theme setting key is `kbau:theme`; the website's is `kbau:site-theme`; auth is `kbau:token` / `kbau:user`; API override is `kbau:api`. Editor and site must stay on the same origin to share auth.
