# KbauBlocks — Hosting

## Production (current)

| Piece | Where |
|---|---|
| Website + editor (static) | GitHub Pages: `https://kbau.lol/` |
| API | Cloudflare Worker `kbaublocks-api`: `https://kbaublocks-api.kbaudasher.workers.dev/kbau-api` |
| Database | Cloudflare D1 `kbaublocks` (id in `server/wrangler.jsonc`) |
| Project files, thumbnails, avatars | Cloudflare R2 bucket `kbaublocks-files` |
| Cloud variables | Durable Object `CloudRoom`, one per project (`/kbau-api/cloud/<projectId>`) |

`kbaucode/config.json` points the site and editor at the API. CORS is open because auth uses bearer tokens, not cookies.

### Admins
On the public deployment `KBAU_FIRST_USER_ADMIN` is `0` (so a stranger can't claim admin by signing up first). Admins are listed in `KBAU_ADMINS` (comma-separated usernames) in `server/wrangler.jsonc` → `vars`. The role is applied the next time that user signs in. After that, admins can grant roles from the Moderation page.

### Deploying changes
```bash
cd kbaucode/server
npm install                      # installs wrangler (dev dependency) only
npm run migrate:remote           # only when migrations/ changed
npm run deploy
```
Database schema changes: add a new `migrations/000N_name.sql`; the Node server applies it automatically on start, D1 via `npm run migrate:remote`.

### Testing the Worker locally
```bash
npx wrangler d1 migrations apply kbaublocks --local --persist-to .wrangler/test
npx wrangler dev --port 8788 --persist-to .wrangler/test --var KBAU_ADMINS:alice
KBAU_TEST_BASE=http://127.0.0.1:8788/kbau-api npm test     # same suite as the Node server
```
Use a fresh `--persist-to` folder for each run (the suite expects an empty database).

### Backups and limits
* D1 Time Travel restores the database to any minute in the last 30 days (`wrangler d1 time-travel restore kbaublocks --timestamp=...`).
* R2 objects are immutable per version (`projects/<id>/<n>.sb3`), so overwrites never lose data; only thumbnails/avatars are replaced in place.
* Password hashing is PBKDF2-SHA256 at 100,000 iterations (the Workers maximum). It runs within the Workers CPU limit (verified on production).
* Free-plan Workers allow 100k requests/day. If traffic grows past that, switch the account to Workers Paid.

### Custom domain (optional)
`api.kbau.lol` would need kbau.lol's DNS on Cloudflare (it's currently GitHub's A records). After that, add a route or custom domain to the Worker and update `config.json`.

## Self-hosting with Node

```bash
cd kbaucode/server
npm start          # http://localhost:8787 — serves the website, editor and API on one origin
```
Data lives in `server/data/` (SQLite + `blobs/`). Put it behind HTTPS (e.g. Caddy) and back up the `data/` folder. Environment variables are listed in `ARCHITECTURE.md`.
