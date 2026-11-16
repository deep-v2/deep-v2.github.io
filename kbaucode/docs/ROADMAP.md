# KbauBlocks — Phased plan

## Phase 1 — MVP ✅ (2026-11-16)
1. Editor on an open-source foundation (TurboWarp scratch-gui, pinned, patched, built in CI).
2. Unified extension system: one runtime (TurboWarp extension manager + security manager) and one catalog over TurboWarp + PenguinMod galleries + custom URLs.
3. Import / edit / run / export .sb3 (inherited) + save/load from KbauBlocks.
4. Independent backend (accounts, projects, versions, social, moderation, cloud vars).
5. Accounts and publishing straight from the editor.
6. Project-sharing website.

## Phase 2 — Make it live and polished
* Deploy the backend with HTTPS + backups; point `config.json` at it.
* In-editor publish modal (title, instructions, notes, share) replacing browser dialogs.
* Verify/fix cloud variables in the editor for KbauBlocks projects.
* Notifications, account deletion, password reset via email.
* Localize KbauBlocks strings.

## Phase 3 — Creative power (PenguinMod-style)
* "KbauBlocks+" built-in extension: reimplement the most-used PenguinMod extra blocks (JSON/array operators, more looks/sound/control blocks) as an extension, so projects stay loadable in vanilla Scratch with the extension listed.
* PenguinMod compatibility shim for gallery extensions that call PenguinMod-only VM APIs.
* Custom block categories and a searchable block library (builds on the Scratch Addons "block search"/"find bar" addons).

## Phase 4 — Editor quality of life
* In-editor extension manager (enable/disable, versions, per-project list).
* Better asset management (bulk import, folders — extend the Scratch Addons "folders" addon), sprite/costume/sound search.
* Variable monitor panel + debugger improvements; runtime settings presets per project.
* Layout presets (small stage, wide stage, focus mode) stored per user.

## Phase 5 — Ecosystem
* Self-hosting kit (Dockerfile, docker-compose, admin docs), federation-friendly project URLs.
* Desktop app (Electron, based on TurboWarp Desktop, GPL-3.0).
* Studios/collaboration on collections, project embedding with oEmbed.
