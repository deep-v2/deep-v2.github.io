# Live collaboration

Several people edit one project at the same time, in the KbauBlocks editor. Blocks, sprites, costumes,
sounds, variables, comments, sprite properties and extensions sync live; everyone sees each other's
cursor on the code area and which sprite they're on.

## Who can join

The project owner invites people (project page → *Edit together*, or the editor's *Collaborate* panel).
Invited people find the project in *My Stuff → Shared with me*. Owner and collaborators can open, edit
and save the project; only the owner can share, rename, delete or manage collaborators.

## Pieces

| Piece | File | Job |
|---|---|---|
| Room | `server/src/core/collab-room.js` | One per project. Orders every batch of edits (seq), acks it to the sender, relays it to everyone else. Keeps the log since the last snapshot. Runs in a Durable Object (`CollabRoomDO`) on Cloudflare and in-process on Node. |
| HTTP | `server/src/core/collab.js` | Collaborators, the shared asset store, session snapshots, live status for the editor. |
| Engine | `editor-src/overlay/src/lib/kbau-collab/engine.js` | Captures local edits, applies remote ones, snapshots, checksums, autosave. |
| UI | `editor-src/overlay/src/lib/kbau-collab/ui.js` | Menu bar button, panel, live cursors, toasts. |

## Protocol (WebSocket `<api>/collab/<projectId>`)

Client → room: `hello {token, key, resume}`, `op {c, ops}`, `p` (presence), `seed`, `snap {rev}`, `sum {s, h}`, `rejoin`.
Room → client: `welcome {mode: seed|load|resume}`, `wait`, `seeded`, `ops {s, u, ops}`, `ack {c, s}`, `join`, `leave`, `host`, `p`, `snapreq`, `resync`, `error`.

- **Starting:** the first person in gets `welcome mode:seed`, uploads a snapshot (gzipped project.json + ids)
  and any missing assets, then sends `seed`. People who arrive meanwhile `wait`.
- **Joining:** `welcome mode:load` names the latest snapshot; the room then replays the log after it. The editor
  loads the snapshot (building an sb3 in memory from assets it already has plus the shared store) and applies the replay.
- **Edits:** batched every 25 ms. The room numbers each batch; clients apply batches in that order.
- **Dropped connection:** the client reconnects with `resume {session, last}` and gets only what it missed;
  unacknowledged batches are resent (the room ignores duplicates by `key:c`).
- **Compaction:** after 3000 batches or 1.5 MB, the host is asked for a fresh snapshot; the room keeps the log since
  the previous snapshot (for people still loading it) and deletes older snapshot files.
- **Self-healing:** every client sends a checksum of its project every ~20 s when idle. If clients disagree at the
  same seq, the minority (or everyone, on a tie) reloads from snapshot + log.
- **Saving:** the host (longest-connected person) saves to KbauBlocks every 3 minutes while there are changes;
  anyone can *Save now*; the last person leaving saves first. The session (and its snapshots) ends when everyone leaves.

## Ops

| `k` | What | Applied |
|---|---|---|
| `b` | Blockly event (create, delete, move, change, var_*) | Replayed on the workspace if that sprite is open (smooth, not in your undo history), else into the VM |
| `c` | Comment event | Into the VM, then the open workspace reloads (scratch-blocks' comment JSON is lossy) |
| `vb` | Blocks copied to another sprite by drag-and-drop | `blocks.createBlock` |
| `spr+` / `spr-` / `sprn` / `ord` | Sprite added (sprite3 JSON + ids) / deleted / renamed / reordered | VM, keeping your selected sprite |
| `cos` / `snd` | A sprite's full costume / sound list (ids, names, md5, centers) | Reconciled: add, edit, rename (updates blocks that mention it), delete, reorder |
| `info` | x, y, size, direction, visibility, draggable, rotation style | `postSpriteInfo` (stage dragging streams live) |
| `ext` | Extension loaded | `loadExtensionURL` |
| `ref` | Any op too big for one message, stored in the asset store | Fetched, then applied |

Sprites are named by their (unique) names on the wire; costumes and sounds by random ids kept in a WeakMap.
Assets (costumes, sounds) live in a shared store named by MD5 like Scratch's: uploaded once, verified on upload,
cached forever.

## Not synced

Running the project (each person runs their own copy), monitors' positions, stage size/settings, the selected costume.
