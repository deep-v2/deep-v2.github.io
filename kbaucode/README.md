# KbauBlocks

A universal, open-source, Scratch-compatible creation platform:

* **Editor** — TurboWarp's fast compiler and Scratch Addons built in, with a KbauBlocks identity (dark grey theme, solid black top bar, mint accent) and direct publishing to the KbauBlocks community. Opens and saves standard Scratch 3 `.sb3` files.
* **Unified extension catalog** — the TurboWarp and PenguinMod galleries plus custom URLs in one place, all loading through the same extension system.
* **Community website** — profiles, project pages with an embedded player, loves, favorites, views, comments, remixes with attribution, collections, search, trending/popular/recent, reporting and moderation.
* **Backend** — one API core that runs on Cloudflare Workers (D1, R2, Durable Objects; used in production) or as a zero-dependency Node server for self-hosting.

| | |
|---|---|
| Open the site | `index.html` (on kbau.lol: <https://kbau.lol/kbaucode/>) |
| Open the editor | `editor/editor.html` |
| Run everything locally | `cd server && npm start` → <http://localhost:8787/> |
| Hosting (Cloudflare) | [docs/HOSTING.md](docs/HOSTING.md) |
| Run backend tests | `cd server && npm test` |
| Status / next steps | [HANDOFF.md](HANDOFF.md) |
| Design + API | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Ecosystem research + licensing | [docs/RESEARCH.md](docs/RESEARCH.md) |
| Plan | [docs/ROADMAP.md](docs/ROADMAP.md) |

## Licenses

* `editor/` and `editor-src/`: a modified version of [TurboWarp scratch-gui](https://github.com/TurboWarp/scratch-gui) — **GPL-3.0** ([LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)). The build also contains TurboWarp's scratch-vm and scratch-render (MPL-2.0), scratch-blocks (GPL-3.0) and Scratch Addons code (GPL-3.0). Complete corresponding source: TurboWarp at the commit in `editor-src/TURBOWARP_COMMIT` plus the patch set in `editor-src/`.
* Everything else in this folder (website, `server/`, docs) — **AGPL-3.0-or-later** ([LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)).
* Extensions in the catalog are loaded from their original hosts and keep their own licenses.

KbauBlocks is not affiliated with or endorsed by the Scratch Foundation, MIT, TurboWarp, PenguinMod or Scratch Addons. Scratch is a project of the Scratch Foundation.
