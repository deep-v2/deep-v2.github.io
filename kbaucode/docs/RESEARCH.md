# KbauBlocks — Ecosystem research

Research date: 2026-11-16. License facts were read from each repository's LICENSE file / GitHub license API on that date.

## 1. Projects studied

| Project | What it is | Key repos | License (verified) |
|---|---|---|---|
| **Scratch (official)** | The reference editor. Since late 2024 the editor packages live in the `scratchfoundation/scratch-editor` monorepo (scratch-gui, scratch-vm, scratch-render, …). | scratch-editor, scratch-blocks, scratch-www | **AGPL-3.0-only** (scratch-editor, scratch-www). Relicensed from BSD-3 in Nov 2024 ("chore!: set license to AGPL-3.0-only"). |
| **TurboWarp** | Performance-focused Scratch mod: JS compiler, interpolation, custom FPS, removable limits, integrated Scratch Addons, custom extensions with a security manager, packager. | TurboWarp/scratch-gui, scratch-vm, scratch-render, scratch-blocks, extensions, desktop, packager | scratch-gui **GPL-3.0**; scratch-vm **MPL-2.0**; scratch-render **MPL-2.0**; scratch-blocks **GPL-3.0**; extensions repo **MIT** (each extension also carries its own license header). |
| **TurboWarp Desktop** | Electron wrapper, offline, file-system integration. | TurboWarp/desktop | GPL-3.0 |
| **PenguinMod** | Fork of TurboWarp with many extra built-in blocks/categories, a large extension gallery, its own sharing site and backend. | penguinmod.github.io (GUI), PenguinMod-Vm, PenguinMod-Blocks, PenguinMod-Render, PenguinMod-Paint, PenguinMod-ExtensionsGallery, PenguinMod-BackendApi | GUI **GPL-3.0**; VM **MPL-2.0**; Blocks **GPL-3.0**; Render **BSD-3-Clause**; Paint **GPL-3.0**; BackendApi **MIT**; ExtensionsGallery: no repo-level license (per-extension). |
| **Scratch Addons** | Browser extension adding ~150 addons to scratch.mit.edu and the editor. TurboWarp vendors a curated subset into `src/addons`. | ScratchAddons/ScratchAddons | **GPL-3.0** |

## 2. Architecture notes

### Scratch 3 core

* **scratch-vm**: runtime, threads/sequencer, block primitives (`src/blocks/*`), extension manager, serialization (`sb3.js`), cloud-variable hooks (`runtime.ioDevices.cloud`).
* **scratch-render**: WebGL renderer (skins, drawables, pen layer, touching/color collision).
* **scratch-blocks**: Blockly fork that renders the block UI and toolbox XML.
* **scratch-gui**: React/Redux app that wires VM, renderer, blocks, paint editor, sound editor, libraries.
* **scratch-storage**: asset loading (project JSON + assets by md5 from asset servers).
* **scratch-www**: the community website frontend (open source). **The REST API it talks to (api.scratch.mit.edu, projects.scratch.mit.edu, cloud data, sessions) is closed source**; only its *shape* is publicly observable. So everything server-side had to be implemented independently.

### TurboWarp

* **Compiler** (`scratch-vm/src/compiler`): scripts → intermediate representation → generated JS, with type inference and warp-timer handling. Drop-in compatible with project semantics; falls back to the interpreter on unsupported blocks.
* **Runtime options**: `setFramerate`, `setInterpolation`, `setRuntimeOptions({maxClones, miscLimits, fencing})`, `setCompilerOptions`, turbo mode, stage size.
* **Addons** (`src/addons`): a build-time copy of Scratch Addons adapted to run without the browser extension (addon API shim, settings stored in localStorage). Toggleable in "Addons" settings.
* **Custom extensions**: `vm.extensionManager.loadExtensionURL(url)`; sandboxed (worker/iframe) or unsandboxed with a **security manager** prompt; URLs from extensions.turbowarp.org are trusted. `?extension=URL` loads at startup.
* **Project loading**: `#<id>` (from Scratch servers), `?project_url=`, file system access API, restore points.
* **Theme system** (`src/lib/themes`): GUI theme × accent × block theme, persisted in localStorage.

### PenguinMod

* Adds many categories and blocks directly into its VM fork (e.g. more operators, JSON/array helpers, extra looks/sound blocks) plus a big extension gallery. Projects using PenguinMod-only blocks are **not loadable** in vanilla Scratch/TurboWarp.
* Its gallery list (`PenguinMod-ExtensionsGallery/src/lib/extensions.js`) is a JS module; extensions are served from extensions.penguinmod.com with CORS enabled. Many are standard Scratch-extension-API code and load in TurboWarp; some reference PenguinMod-specific VM APIs.

## 3. Feature comparison and integration decision

| Feature | Source | Decision in KbauBlocks | Why |
|---|---|---|---|
| JS compiler, interpolation, custom FPS, remove limits, turbo | TurboWarp | **Integrated** (TurboWarp is the base) | GPL/MPL compatible; mature; huge compatibility test history. |
| Scratch Addons editor enhancements (block search, debugger, editor theme 3, etc.) | Scratch Addons via TurboWarp | **Integrated** (inherited, 80+ addons) | Already adapted to run inside the GUI. |
| Custom extensions + security manager | TurboWarp | **Integrated** | Same. |
| TurboWarp extension gallery | TurboWarp | **Integrated** in the KbauBlocks catalog (extensions.html) | Linked/loaded from its origin, not redistributed. |
| PenguinMod extension gallery | PenguinMod | **Integrated** in the same catalog, flagged as "may need PenguinMod features" | Loaded from its origin. List parsed as data (never executed). |
| PenguinMod built-in extra blocks | PenguinMod | **Not yet** — planned as opt-in KbauBlocks extensions | They live inside PenguinMod's VM fork; importing them would make .sb3 files incompatible with Scratch. Must be reimplemented as an extension so projects degrade gracefully. |
| Packager | TurboWarp (Apache-2.0) | Linked (TurboWarp packager menu item remains) | Separate app. |
| Desktop app | TurboWarp Desktop | Not yet | Out of MVP scope. |
| Community website + API | Scratch (frontend only), PenguinMod | **Independently implemented** (kbaucode/server + site) | Scratch's API is closed; PenguinMod's backend is tied to its infra. |
| Cloud variables | Scratch/TurboWarp protocol | **Implemented** (WebSocket server compatible with TurboWarp's client protocol) | Lets unmodified client code talk to our server. |

## 4. Licensing plan

* **Editor (`kbaucode/editor`, `kbaucode/editor-src`)**: a modified TurboWarp scratch-gui → **GPL-3.0**. Built output bundles MPL-2.0 (VM/render) and GPL-3.0 (blocks, addons) code; GPL-3.0 is compatible with MPL-2.0 (MPL §3.3). Source of our modifications is the patch set in `editor-src`, applied to a pinned public TurboWarp commit, which satisfies "corresponding source".
* **We did not use AGPL-only upstream Scratch code** directly; TurboWarp's forks predate the relicense. If future work pulls code from `scratchfoundation/scratch-editor` after Nov 2024, that code is AGPL-3.0 and the combined editor must then be offered under AGPL-3.0.
* **Server + website (`kbaucode/server`, site HTML/CSS/JS)**: original code → **AGPL-3.0-or-later**, so anyone running a modified public instance must publish their changes.
* **Trademarks**: "Scratch", the Scratch Cat, etc. are MIT trademarks (see TurboWarp's TRADEMARK file). TurboWarp asks forks not to use its name/branding as their own. KbauBlocks uses its own name, logo and colors and keeps attribution in credits.
* **Third-party extensions** are loaded from their original hosts and keep their own licenses; nothing from either gallery is copied into this repository.
* **Assets**: the editor's sprite/sound libraries are fetched by TurboWarp's code from Scratch's asset CDN as in TurboWarp; they are not redistributed here.
