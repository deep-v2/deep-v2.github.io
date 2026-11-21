/**
 * KbauBlocks live collaboration: the sync engine that runs inside the editor.
 *
 * How it works
 * - The server room (kbaucode/server/src/core/collab-room.js) puts every batch of edits in one order and
 *   relays it, so everyone applies the same edits in the same order.
 * - Block edits travel as Blockly events (the same events the editor already feeds the VM). Remote events
 *   are replayed on the workspace when that sprite is open (so they appear smoothly, without reloading the
 *   workspace or touching your undo history), or straight into the VM when it isn't.
 * - Sprites, costumes, sounds, sprite order and extensions are synced by comparing small per-sprite
 *   signatures a few times a second; sprite properties (x, y, size...) are captured where the editor sets them.
 * - Costumes and sounds go to a shared store named by MD5 (like Scratch's asset server): each file is
 *   uploaded once and cached forever, and joining reuses files the editor already has.
 * - Joining loads a gzipped snapshot plus the edits since; a dropped connection resumes without reloading.
 * - Every client reports a checksum of its project now and then; if two edits ever raced, whoever disagrees
 *   reloads from the server's copy, so everyone always converges.
 *
 * Part of the KbauBlocks patch set, GPL-3.0.
 */
import AddonHooks from '../../addons/hooks.js';
import JSZip from '@turbowarp/jszip';
import {getApiBase, getToken} from '../kbau-cloud.js';

const REMOTE_GROUP = 'kbau-remote-';
const BATCH_DELAY_MS = 25;
const STRUCTURE_CHECK_MS = 300;
const SUM_EVERY_MS = 20 * 1000;
const AUTOSAVE_MS = 3 * 60 * 1000;
const IDLE_LEAVE_MS = 30 * 60 * 1000;
const MAX_INLINE_OP = 600 * 1024;
const MAX_BATCH = 800 * 1024;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Blockly fires the events of a workspace reload on a timer; switching sprites again before they fire would
// let the VM file them under the wrong sprite. Wait for them before switching back.
const settle = () => sleep(50);
const randomId = () => Math.random().toString(36)
    .slice(2, 10);

// Stable ids for costume and sound objects (kept in a WeakMap, so copies made with Object.assign get new ones).
const assetIds = new WeakMap();
const idOf = obj => {
    let id = assetIds.get(obj);
    if (!id) {
        id = randomId();
        assetIds.set(obj, id);
    }
    return id;
};
const md5extOf = item => `${item.assetId}.${item.dataFormat}`;

// cyrb53: fast 53-bit string hash for state checksums.
const hashString = str => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

const gzip = async text => {
    if (typeof CompressionStream === 'undefined') return {body: text, type: 'application/json'};
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return {body: await new Response(stream).blob(), type: 'application/gzip'};
};
const gunzipResponse = async res => {
    if ((res.headers.get('content-type') || '').includes('gzip')) {
        return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return res.text();
};

/** Run async jobs with limited concurrency. */
const pool = async (items, limit, fn) => {
    let i = 0;
    const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
        while (i < items.length) {
            const item = items[i++];
            await fn(item);
        }
    });
    await Promise.all(workers);
};

export class CollabEngine {
    constructor (vm) {
        this.vm = vm;
        this.runtime = vm.runtime;
        this.listeners = new Set();
        this.status = 'off'; // off | connecting | waiting | seeding | loading | live | reconnecting | error
        this.message = '';
        this.progress = '';
        this.projectId = null;
        this.members = new Map();
        this.you = null;
        this.host = null;
        this.session = null;
        this.lastSeq = 0;
        this.clientKey = randomId() + randomId();
        this.batchCounter = 0;
        this.outbox = [];
        this.inflight = new Map();
        this.queue = [];
        this.processing = false;
        this.remoteDepth = 0;
        this.wsLoading = false;
        this.loadingProject = false;
        this.known = new Map(); // local target id -> {name, cos, snd}
        this.knownOrder = '';
        this.assetData = new Map(); // md5ext -> Uint8Array
        this.uploaded = new Map(); // md5ext -> Promise
        this.lastSavedAt = 0;
        this.dirtySinceSave = false;
        this.lastActivity = Date.now();
        this.lastSumSeq = -1;
        this.cursor = null;
        this.lastTg = undefined;
        this.wantStop = false;
        this.reconnectDelay = 1000;
        this.installed = false;
    }

    // ---------- small helpers ----------
    on (fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    emit () {
        for (const fn of this.listeners) {
            try {
                fn(this);
            } catch (e) {
                console.error(e);
            }
        }
    }
    setStatus (status, message = '') {
        this.status = status;
        this.message = message;
        if (status !== 'seeding' && status !== 'loading') this.progress = '';
        this.emit();
    }
    get live () {
        return this.status === 'live';
    }
    get capturing () {
        // Local edits are recorded while seeding too (they come after the snapshot) and while reconnecting.
        return (this.status === 'live' || this.status === 'seeding' || this.status === 'reconnecting') &&
            !this.loadingProject && this.remoteDepth === 0;
    }
    get workspace () {
        return AddonHooks.blocklyWorkspace;
    }
    get Blockly () {
        return AddonHooks.blockly;
    }
    keyOf (target) {
        return target.isStage ? null : target.getName();
    }
    targetByKey (key) {
        if (key === null || key === undefined) return this.runtime.getTargetForStage();
        return this.runtime.targets.find(t => t.isOriginal && !t.isStage && t.getName() === key) || null;
    }
    originals () {
        return this.runtime.targets.filter(t => t.isOriginal);
    }
    async api (path, options = {}) {
        const base = await getApiBase();
        const res = await fetch(`${base}${path}`, {
            ...options,
            headers: {Authorization: `Bearer ${getToken()}`, ...(options.headers || {})}
        });
        if (!res.ok) {
            let error = `Server responded with ${res.status}`;
            try {
                error = (await res.json()).error || error;
            } catch (e) {
                // ignore
            }
            throw new Error(error);
        }
        return res;
    }

    // ---------- hooks into the editor (installed once) ----------
    install () {
        if (this.installed) return;
        this.installed = true;
        const vm = this.vm;

        // Ignore the flood of create/delete events the GUI makes when it reloads the workspace (switching sprites).
        vm.prependListener('workspaceUpdate', () => {
            this.wsLoading = true;
        });
        vm.on('workspaceUpdate', () => {
            setTimeout(() => {
                this.wsLoading = false;
            }, 0);
        });

        // Structure changes (sprites, costumes, sounds, order) are found by comparing signatures, throttled.
        const schedule = () => this.scheduleStructureCheck();
        vm.on('targetsUpdate', schedule);
        this.runtime.on('PROJECT_CHANGED', schedule);

        // Sprite properties (x, y, size, direction, visible, draggable, rotation style), incl. live stage dragging.
        const postSpriteInfo = vm.postSpriteInfo;
        vm.postSpriteInfo = data => {
            const target = vm._dragTarget || vm.editingTarget;
            const result = postSpriteInfo.call(vm, data);
            if (this.capturing && target && data) {
                const d = {};
                for (const k of ['x', 'y', 'direction', 'size', 'visible', 'draggable', 'rotationStyle']) {
                    if (Object.prototype.hasOwnProperty.call(data, k)) d[k] = data[k];
                }
                if (Object.keys(d).length) this.push({k: 'info', tg: this.keyOf(target), d});
            }
            return result;
        };

        // Extensions someone adds get loaded for everyone (before any of their blocks arrive).
        const em = vm.extensionManager;
        const loadExtensionURL = em.loadExtensionURL;
        this.remoteExtensions = new Set();
        em.loadExtensionURL = async url => {
            const result = await loadExtensionURL.call(em, url);
            if (this.capturing && !this.remoteExtensions.has(url)) this.push({k: 'ext', url});
            return result;
        };

        // Dragging scripts onto another sprite copies them in the VM, outside the workspace.
        const shareBlocksToTarget = vm.shareBlocksToTarget;
        vm.shareBlocksToTarget = (blocks, targetId, fromTargetId) => {
            const target = this.runtime.getTargetById(targetId);
            const capture = this.capturing && target;
            const recorded = [];
            let restore = null;
            if (capture) {
                const tb = target.blocks;
                const createBlock = tb.createBlock;
                tb.createBlock = function (block) {
                    recorded.push(JSON.parse(JSON.stringify(block)));
                    return createBlock.call(this, block);
                };
                restore = () => {
                    tb.createBlock = createBlock;
                };
            }
            return Promise.resolve(shareBlocksToTarget.call(vm, blocks, targetId, fromTargetId)).finally(() => {
                if (restore) restore();
                if (capture && recorded.length) this.push({k: 'vb', tg: this.keyOf(target), blocks: recorded});
            });
        };

        // Activity (for leaving idle sessions) and cursors.
        const activity = () => {
            this.lastActivity = Date.now();
        };
        document.addEventListener('keydown', activity, true);
        document.addEventListener('pointerdown', activity, true);
        this.attachWorkspace();
    }

    attachWorkspace () {
        const ws = this.workspace;
        if (!ws) {
            if (!this.attachTimer) {
                this.attachTimer = setTimeout(() => {
                    this.attachTimer = null;
                    this.attachWorkspace();
                }, 500);
            }
            return;
        }
        if (this.attachedWorkspace === ws) return;
        this.attachedWorkspace = ws;
        ws.addChangeListener(e => this.onWorkspaceEvent(e));
        const div = ws.getInjectionDiv();
        let last = 0;
        div.addEventListener('pointermove', e => {
            this.lastActivity = Date.now();
            const now = performance.now();
            if (!this.live || now - last < 60) return;
            last = now;
            const p = this.screenToWorkspace(e.clientX, e.clientY);
            if (p) this.sendPresence({x: Math.round(p.x), y: Math.round(p.y)});
        });
        div.addEventListener('pointerleave', () => {
            if (this.live) this.sendPresence({x: null, y: null});
        });
    }

    /** Workspace coordinates <-> screen, using the canvas transform (handles scroll and zoom). */
    canvasMatrix () {
        const ws = this.workspace;
        if (!ws || !ws.getCanvas) return null;
        const m = ws.getCanvas().getCTM();
        const rect = ws.getParentSvg().getBoundingClientRect();
        return m && {a: m.a, e: m.e, f: m.f, left: rect.left, top: rect.top, width: rect.width, height: rect.height};
    }
    screenToWorkspace (clientX, clientY) {
        const m = this.canvasMatrix();
        if (!m || !m.a) return null;
        return {x: (clientX - m.left - m.e) / m.a, y: (clientY - m.top - m.f) / m.a};
    }

    // ---------- capturing local block edits ----------
    onWorkspaceEvent (e) {
        if (!this.capturing || this.wsLoading || !e || e.workspaceId !== (this.workspace && this.workspace.id)) return;
        if (e.group && String(e.group).startsWith(REMOTE_GROUP)) return;
        const target = this.vm.editingTarget;
        if (!target) return;
        const tg = this.keyOf(target);
        switch (e.type) {
        case 'create':
        case 'delete':
        case 'var_create':
        case 'var_rename':
        case 'var_delete':
            this.push({k: 'b', tg, e: e.toJson()});
            break;
        case 'move':
        case 'change':
            if (e.isNull && e.isNull()) return;
            if (e.type === 'change' && e.element === 'stackclick') return;
            this.push({k: 'b', tg, e: e.toJson()});
            break;
        case 'comment_create':
            this.push({k: 'c', tg, e: {
                type: e.type, commentId: e.commentId, blockId: e.blockId || null, text: e.text,
                x: e.xy ? e.xy.x : 0, y: e.xy ? e.xy.y : 0, w: e.width, h: e.height, m: !!e.minimized
            }});
            break;
        case 'comment_change':
            this.push({k: 'c', tg, e: {type: e.type, commentId: e.commentId, c: e.newContents_}});
            break;
        case 'comment_move':
            if (e.isNull && e.isNull()) return;
            this.push({k: 'c', tg, e: {type: e.type, commentId: e.commentId, x: e.newCoordinate_.x, y: e.newCoordinate_.y}});
            break;
        case 'comment_delete':
            this.push({k: 'c', tg, e: {type: e.type, commentId: e.commentId, blockId: e.blockId || null}});
            break;
        default:
        }
    }

    // ---------- outgoing ----------
    /**
     * Queue an op. `ready` (optional) is a promise that must finish first (e.g. uploading its assets).
     */
    push (op, ready = null) {
        this.dirtySinceSave = true;
        // An edit that names a sprite must come after that sprite's pending rename/add, so detect those now.
        if (op.tg !== undefined && this.structureTimer) {
            clearTimeout(this.structureTimer);
            this.structureTimer = null;
            this.checkStructure();
        }
        // Consecutive property updates of one sprite (stage dragging) collapse into one.
        if (op.k === 'info') {
            const last = this.outbox[this.outbox.length - 1];
            if (last && !last.ready && last.op.k === 'info' && last.op.tg === op.tg) {
                Object.assign(last.op.d, op.d);
                this.scheduleFlush();
                return;
            }
        }
        const entry = {op, ready, done: !ready};
        if (!ready && (op.k === 'b' || op.k === 'vb' || op.k === 'spr+')) {
            const size = JSON.stringify(op).length;
            if (size > MAX_INLINE_OP) {
                // Too big for one WebSocket message: store it like an asset and send a reference.
                entry.done = false;
                entry.ready = this.uploadJson(op).then(asset => {
                    entry.op = {k: 'ref', a: asset};
                });
            }
        }
        if (entry.ready) {
            entry.ready.then(() => {
                entry.done = true;
                this.scheduleFlush();
            }, error => {
                console.error('[collab] could not prepare an edit', error);
                entry.done = true;
                entry.failed = true;
                this.scheduleFlush();
            });
        }
        this.outbox.push(entry);
        this.scheduleFlush();
    }
    scheduleFlush () {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, BATCH_DELAY_MS);
    }
    flush () {
        if (!this.live || !this.ws || this.ws.readyState !== 1) return;
        let ops = [];
        let size = 0;
        const send = () => {
            if (!ops.length) return;
            const c = String(++this.batchCounter);
            this.inflight.set(c, ops);
            this.ws.send(JSON.stringify({t: 'op', c, ops}));
            ops = [];
            size = 0;
        };
        while (this.outbox.length && this.outbox[0].done) {
            const entry = this.outbox.shift();
            if (entry.failed) continue;
            const json = JSON.stringify(entry.op);
            if (size + json.length > MAX_BATCH) send();
            ops.push(entry.op);
            size += json.length;
        }
        send();
        this.emit();
    }
    sendPresence (p) {
        if (!this.live || !this.ws || this.ws.readyState !== 1) return;
        const tg = this.vm.editingTarget ? this.keyOf(this.vm.editingTarget) : null;
        this.lastTg = tg;
        this.ws.send(JSON.stringify({t: 'p', tg, ...p}));
    }

    // ---------- assets ----------
    rememberLocalAssets () {
        for (const t of this.originals()) {
            for (const item of [...t.getCostumes(), ...t.getSounds()]) {
                if (item.asset && item.asset.data) this.assetData.set(md5extOf(item), item.asset.data);
            }
        }
    }
    uploadAsset (md5ext, data) {
        if (!this.uploaded.has(md5ext)) {
            const promise = this.api(`/collab/assets/${md5ext}?project=${this.projectId}`, {method: 'PUT', body: data})
                .catch(error => {
                    this.uploaded.delete(md5ext);
                    throw error;
                });
            this.uploaded.set(md5ext, promise);
        }
        return this.uploaded.get(md5ext);
    }
    uploadItems (items) {
        const jobs = [];
        for (const item of items) {
            if (!item.asset || !item.asset.data) continue;
            const md5ext = md5extOf(item);
            this.assetData.set(md5ext, item.asset.data);
            jobs.push(this.uploadAsset(md5ext, item.asset.data));
        }
        return Promise.all(jobs);
    }
    async uploadJson (value) {
        const storage = this.runtime.storage;
        const data = new TextEncoder().encode(JSON.stringify(value));
        const asset = storage.createAsset(storage.AssetType.Project, storage.DataFormat.JSON, data, null, true);
        const md5ext = `${asset.assetId}.json`;
        await this.uploadAsset(md5ext, data);
        return md5ext;
    }
    async fetchAsset (md5ext) {
        if (this.assetData.has(md5ext)) return this.assetData.get(md5ext);
        const base = await getApiBase();
        const res = await fetch(`${base}/collab/assets/${md5ext}`);
        if (!res.ok) throw new Error(`Missing asset ${md5ext}`);
        const data = new Uint8Array(await res.arrayBuffer());
        this.assetData.set(md5ext, data);
        return data;
    }
    createAsset (md5ext, data, kind) {
        const storage = this.runtime.storage;
        const [assetId, ext] = md5ext.split('.');
        let type = storage.AssetType.Sound;
        if (kind === 'costume') type = ext === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
        return storage.createAsset(type, ext, data, assetId, false);
    }

    // ---------- structure (sprites, costumes, sounds, order) ----------
    costumeList (t) {
        return t.getCostumes().map(c => ({
            id: idOf(c), n: c.name, a: md5extOf(c), x: c.rotationCenterX, y: c.rotationCenterY, r: c.bitmapResolution || 1
        }));
    }
    soundList (t) {
        return t.getSounds().map(s => ({id: idOf(s), n: s.name, a: md5extOf(s), rate: s.rate, sc: s.sampleCount, f: s.format || ''}));
    }
    sigOf (list) {
        return list.map(i => `${i.id}:${i.n}:${i.a}:${i.x === undefined ? '' : `${i.x},${i.y},${i.r}`}`).join('|');
    }
    spriteOrder () {
        return this.runtime.targets.filter(t => t.isOriginal && !t.isStage).map(t => t.getName());
    }
    /** Record the current structure as already in sync (after loading, seeding or applying remote edits). */
    resetBaseline (targets = this.originals()) {
        for (const t of targets) {
            this.known.set(t.id, {name: this.keyOf(t), cos: this.sigOf(this.costumeList(t)), snd: this.sigOf(this.soundList(t))});
        }
        const alive = new Set(this.originals().map(t => t.id));
        for (const id of this.known.keys()) if (!alive.has(id)) this.known.delete(id);
        this.knownOrder = this.spriteOrder().join('\u0000');
    }
    scheduleStructureCheck () {
        if (this.structureTimer) return;
        this.structureTimer = setTimeout(() => {
            this.structureTimer = null;
            this.checkStructure();
        }, STRUCTURE_CHECK_MS);
    }
    checkStructure () {
        if (!this.capturing) {
            if (this.status !== 'off') this.scheduleStructureCheck();
            return;
        }
        // Presence: which sprite you're on.
        const tg = this.vm.editingTarget ? this.keyOf(this.vm.editingTarget) : null;
        if (this.live && tg !== this.lastTg) this.sendPresence({x: null, y: null});

        const seen = new Set();
        for (const t of this.originals()) {
            seen.add(t.id);
            const prev = this.known.get(t.id);
            const name = this.keyOf(t);
            const cos = this.costumeList(t);
            const snd = this.soundList(t);
            const now = {name, cos: this.sigOf(cos), snd: this.sigOf(snd)};
            if (!prev) {
                this.known.set(t.id, now);
                if (!t.isStage) this.pushSpriteAdd(t);
                continue;
            }
            if (prev.name !== name) this.push({k: 'sprn', from: prev.name, to: name});
            if (prev.cos !== now.cos) {
                const items = t.getCostumes();
                this.push({k: 'cos', tg: name, list: cos}, this.uploadItems(items));
            }
            if (prev.snd !== now.snd) {
                const items = t.getSounds();
                this.push({k: 'snd', tg: name, list: snd}, this.uploadItems(items));
            }
            this.known.set(t.id, now);
        }
        for (const [id, prev] of this.known) {
            if (!seen.has(id)) {
                this.known.delete(id);
                if (prev.name !== null) this.push({k: 'spr-', name: prev.name});
            }
        }
        const order = this.spriteOrder();
        const orderKey = order.join('\u0000');
        if (orderKey !== this.knownOrder) {
            this.knownOrder = orderKey;
            this.push({k: 'ord', names: order});
        }
    }
    pushSpriteAdd (t) {
        const json = this.vm.toJSON(t.id);
        const op = {k: 'spr+', name: t.getName(), json, ids: {c: t.getCostumes().map(idOf), s: t.getSounds().map(idOf)}};
        this.push(op, this.uploadItems([...t.getCostumes(), ...t.getSounds()]));
    }

    // ---------- applying remote edits ----------
    enqueue (item) {
        this.queue.push(item);
        if (!this.processing) this.process();
    }
    async waitUntilSafe () {
        // Don't change blocks under someone's mouse: wait for drags to finish and the workspace to settle.
        for (let i = 0; i < 400; i++) {
            const ws = this.workspace;
            const dragging = ws && ((ws.isDragging && ws.isDragging()) || (ws.currentGesture_ && ws.currentGesture_.isDraggingBlock_));
            if (!dragging && !this.wsLoading && !this.loadingProject) return;
            await sleep(40);
        }
    }
    async process () {
        this.processing = true;
        try {
            while (this.queue.length) {
                await this.waitUntilSafe();
                const item = this.queue.shift();
                if (item.t === 'ack') {
                    this.inflight.delete(item.c);
                    this.lastSeq = Math.max(this.lastSeq, item.s);
                    continue;
                }
                if (item.s <= this.lastSeq) continue;
                // Send local structure changes the throttled check hasn't caught yet, so they aren't mistaken for synced.
                if (this.capturing) this.checkStructure();
                this.remoteDepth++;
                const touched = new Set();
                try {
                    for (const op of item.ops) {
                        try {
                            await this.applyOp(op, touched);
                        } catch (e) {
                            console.error('[collab] could not apply an edit', op, e);
                            this.needsResync = true;
                        }
                    }
                } finally {
                    this.remoteDepth--;
                }
                this.lastSeq = item.s;
                this.dirtySinceSave = true;
                // What we just applied is in sync by definition ('*' = sprites were added, removed or reordered).
                if (touched.has('*')) this.resetBaseline();
                else if (touched.size) this.resetBaseline([...touched]);
            }
        } finally {
            this.processing = false;
        }
        if (this.needsResync && this.live) {
            this.needsResync = false;
            this.requestResync('An edit could not be applied');
        }
        this.emit();
    }

    async applyOp (op, touched) {
        switch (op.k) {
        case 'b': return this.applyBlockEvent(op);
        case 'c': return this.applyCommentEvent(op);
        case 'vb': {
            const target = this.targetByKey(op.tg);
            if (!target) return;
            for (const block of op.blocks) target.blocks.createBlock(JSON.parse(JSON.stringify(block)));
            target.blocks.updateTargetSpecificBlocks(target.isStage);
            if (target === this.vm.editingTarget) this.refreshWorkspaceSoon();
            return;
        }
        case 'info': {
            const target = this.targetByKey(op.tg);
            if (!target || !target.postSpriteInfo) return;
            target.postSpriteInfo({...op.d, force: true});
            if (target === this.vm.editingTarget) this.vm.emitTargetsUpdate(false);
            return;
        }
        case 'ext': {
            if (this.vm.extensionManager.isExtensionURLLoaded && this.vm.extensionManager.isExtensionURLLoaded(op.url)) return;
            this.remoteExtensions.add(op.url);
            try {
                await this.vm.extensionManager.loadExtensionURL(op.url);
            } finally {
                this.remoteExtensions.delete(op.url);
            }
            return;
        }
        case 'sprn': {
            const target = this.targetByKey(op.from);
            if (!target) return;
            this.vm.renameSprite(target.id, op.to);
            touched.add(target);
            return;
        }
        case 'spr-': {
            const target = this.targetByKey(op.name);
            if (!target) return;
            this.vm.deleteSprite(target.id);
            touched.add('*');
            return;
        }
        case 'spr+': return this.applySpriteAdd(op, touched);
        case 'ord': {
            const names = op.names;
            for (let i = 0; i < names.length; i++) {
                const targets = this.runtime.targets;
                const from = targets.findIndex(t => t.isOriginal && !t.isStage && t.getName() === names[i]);
                const sprites = targets.filter(t => t.isOriginal && !t.isStage);
                if (from < 0 || sprites[i] === targets[from]) continue;
                const to = targets.indexOf(sprites[i]);
                if (to >= 0) this.vm.reorderTarget(from, to);
            }
            touched.add('*');
            return;
        }
        case 'cos': {
            const target = this.targetByKey(op.tg);
            if (!target) return;
            await this.applyCostumes(target, op.list);
            touched.add(target);
            return;
        }
        case 'snd': {
            const target = this.targetByKey(op.tg);
            if (!target) return;
            await this.applySounds(target, op.list);
            touched.add(target);
            return;
        }
        case 'ref': {
            const data = await this.fetchAsset(op.a);
            const inner = JSON.parse(new TextDecoder().decode(data));
            return this.applyOp(inner, touched);
        }
        default:
        }
    }

    /** Replay a Blockly event: on the workspace if that sprite is open, else straight into the VM. */
    applyBlockEvent (op) {
        const target = this.targetByKey(op.tg);
        if (!target) return;
        const json = op.e;
        const stage = this.runtime.getTargetForStage();
        const isVar = json.type.startsWith('var_');
        const isGlobalVar = isVar && (json.type === 'var_create' ? !json.isLocal : !!stage.variables[json.varId]);
        const ws = this.workspace;
        const onWorkspace = ws && ws.isVisible && ws.isVisible() && (target === this.vm.editingTarget || isGlobalVar);
        if (onWorkspace) {
            if (json.type === 'create' && ws.getBlockById(json.blockId)) return;
            if (json.type === 'var_create' && ws.getVariableById(json.varId)) return;
            if (this.runOnWorkspace(json)) return;
        }
        this.applyBlockEventToVm(target, json);
        if (target === this.vm.editingTarget || isGlobalVar) this.refreshWorkspaceSoon();
    }
    runOnWorkspace (json) {
        const Blockly = this.Blockly;
        const ws = this.workspace;
        const Events = Blockly.Events;
        const recordUndo = Events.recordUndo;
        Events.setGroup(`${REMOTE_GROUP}${randomId()}`);
        Events.recordUndo = false;
        try {
            Events.fromJson(json, ws).run(true);
            return true;
        } catch (e) {
            console.warn('[collab] workspace replay failed, applying to the VM instead', e);
            return false;
        } finally {
            Events.recordUndo = recordUndo;
            Events.setGroup(false);
        }
    }
    applyBlockEventToVm (target, json) {
        const blocks = target.blocks;
        const stage = this.runtime.getTargetForStage();
        switch (json.type) {
        case 'create':
            if (blocks.getBlock(json.blockId)) return;
            blocks.blocklyListen({type: 'create', blockId: json.blockId, xml: {outerHTML: json.xml}});
            return;
        case 'delete':
            blocks.blocklyListen({type: 'delete', blockId: json.blockId});
            return;
        case 'change':
            blocks.blocklyListen({type: 'change', blockId: json.blockId, element: json.element, name: json.name, newValue: json.newValue});
            return;
        case 'move': {
            const block = blocks.getBlock(json.blockId);
            if (!block) return;
            // Blockly's JSON leaves out where the block came from; the VM needs it to detach it.
            let oldInput;
            const parent = block.parent ? blocks.getBlock(block.parent) : null;
            if (parent) {
                for (const name of Object.keys(parent.inputs)) {
                    if (parent.inputs[name].block === json.blockId) oldInput = name;
                }
            }
            let newCoordinate;
            if (json.newCoordinate) {
                const [x, y] = json.newCoordinate.split(',').map(Number);
                newCoordinate = {x, y};
            }
            blocks.moveBlock({
                id: json.blockId,
                oldParent: block.parent || undefined,
                oldInput,
                newParent: json.newParentId,
                newInput: json.newInputName,
                newCoordinate
            });
            return;
        }
        case 'var_create':
            if (json.isLocal && !target.isStage) {
                if (!target.lookupVariableById(json.varId)) target.createVariable(json.varId, json.varName, json.varType);
            } else if (!stage.lookupVariableById(json.varId)) {
                stage.createVariable(json.varId, json.varName, json.varType, json.isCloud);
            }
            return;
        case 'var_rename':
            if (Object.prototype.hasOwnProperty.call(target.variables, json.varId)) {
                target.renameVariable(json.varId, json.newName);
                target.blocks.updateBlocksAfterVarRename(json.varId, json.newName);
            } else {
                stage.renameVariable(json.varId, json.newName);
                for (const t of this.runtime.targets) t.blocks.updateBlocksAfterVarRename(json.varId, json.newName);
            }
            return;
        case 'var_delete': {
            const owner = Object.prototype.hasOwnProperty.call(target.variables, json.varId) ? target : stage;
            owner.deleteVariable(json.varId);
            return;
        }
        default:
        }
    }
    applyCommentEvent (op) {
        const target = this.targetByKey(op.tg);
        if (!target) return;
        const e = op.e;
        const comments = target.comments;
        if (e.type === 'comment_create') {
            if (!comments[e.commentId]) target.createComment(e.commentId, e.blockId, e.text, e.x, e.y, e.w, e.h, e.m);
        } else if (e.type === 'comment_change') {
            const c = comments[e.commentId];
            if (!c || !e.c) return;
            if (Object.prototype.hasOwnProperty.call(e.c, 'minimized')) c.minimized = e.c.minimized;
            if (Object.prototype.hasOwnProperty.call(e.c, 'width')) {
                c.width = e.c.width;
                c.height = e.c.height;
            }
            if (Object.prototype.hasOwnProperty.call(e.c, 'text')) c.text = e.c.text;
        } else if (e.type === 'comment_move') {
            const c = comments[e.commentId];
            if (!c) return;
            c.x = e.x;
            c.y = e.y;
        } else if (e.type === 'comment_delete') {
            if (!comments[e.commentId]) return;
            delete comments[e.commentId];
            if (e.blockId) {
                const block = target.blocks.getBlock(e.blockId);
                if (block) block.comment = null;
            }
        }
        // Comments aren't replayable as Blockly events (scratch-blocks' JSON for them is lossy): reload the workspace.
        if (target === this.vm.editingTarget) this.refreshWorkspaceSoon();
    }
    refreshWorkspaceSoon () {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(async () => {
            await this.waitUntilSafe();
            const ws = this.workspace;
            if (ws && ws.isVisible && !ws.isVisible()) {
                // Hidden (costumes/sounds tab): reload when the code tab comes back.
                this.pendingRefresh = true;
                this.watchVisible();
                return;
            }
            if (this.vm.editingTarget) this.vm.emitWorkspaceUpdate();
        }, 250);
    }
    watchVisible () {
        if (this.visibleTimer) return;
        this.visibleTimer = setInterval(() => {
            const ws = this.workspace;
            if (!this.pendingRefresh) {
                clearInterval(this.visibleTimer);
                this.visibleTimer = null;
            } else if (ws && ws.isVisible && ws.isVisible()) {
                this.pendingRefresh = false;
                this.vm.emitWorkspaceUpdate();
            }
        }, 400);
    }

    async applySpriteAdd (op, touched) {
        if (this.targetByKey(op.name)) return;
        const sprite = JSON.parse(op.json);
        const files = new Map();
        const items = [...(sprite.costumes || []), ...(sprite.sounds || [])];
        await pool(items, 6, async item => {
            const md5ext = item.md5ext || `${item.assetId}.${item.dataFormat}`;
            files.set(md5ext, await this.fetchAsset(md5ext));
        });
        const zip = new JSZip();
        zip.file('sprite.json', op.json);
        for (const [name, data] of files) zip.file(name, data);
        const buffer = await zip.generateAsync({type: 'arraybuffer', compression: 'STORE'});
        const previous = this.vm.editingTarget && this.vm.editingTarget.id;
        await this.vm.addSprite(buffer);
        const added = this.vm.editingTarget;
        if (added && !added.isStage) {
            if (added.getName() !== op.name) this.vm.renameSprite(added.id, op.name);
            added.getCostumes().forEach((c, i) => op.ids.c[i] && assetIds.set(c, op.ids.c[i]));
            added.getSounds().forEach((s, i) => op.ids.s[i] && assetIds.set(s, op.ids.s[i]));
            touched.add(added);
        }
        // Adding a sprite selects it; put the person back where they were (after the reload's events have fired).
        await settle();
        if (previous && this.runtime.getTargetById(previous) && this.vm.editingTarget && this.vm.editingTarget.id !== previous) {
            this.vm.setEditingTarget(previous);
            await settle();
        }
        touched.add('*');
    }

    /** Make a sprite's costume list match `list` (adds, edits, renames, deletes, order), keeping your selection. */
    async applyCostumes (target, list) {
        const current = target.getCostumes();
        const selectedId = current[target.currentCostume] ? idOf(current[target.currentCostume]) : null;
        const byId = new Map(current.map(c => [idOf(c), c]));
        const wanted = new Set(list.map(i => i.id));
        const replaced = [];
        // 1. New and edited costumes (added at the end with a temporary name).
        for (const item of list) {
            const existing = byId.get(item.id);
            if (existing && md5extOf(existing) === item.a) continue;
            const data = await this.fetchAsset(item.a);
            const [assetId, dataFormat] = item.a.split('.');
            const costume = {
                name: `${item.n}\u0000${randomId()}`, assetId, dataFormat, md5: item.a,
                rotationCenterX: item.x, rotationCenterY: item.y, bitmapResolution: item.r,
                asset: this.createAsset(item.a, data, 'costume')
            };
            await this.vm.addCostume(item.a, costume, target.id);
            const added = target.getCostumes()[target.getCostumes().length - 1];
            if (existing) replaced.push(existing);
            assetIds.set(added, item.id);
        }
        // 2. Deleted and replaced costumes.
        const removeObjs = target.getCostumes().filter(c => (replaced.includes(c) || !wanted.has(idOf(c))));
        for (const c of removeObjs) {
            const index = target.getCostumes().indexOf(c);
            if (index >= 0 && target.getCostumes().length > 1) target.deleteCostume(index);
        }
        // 3. Names: real renames update blocks that mention the costume; temporary names are just set.
        for (const item of list) {
            const costumes = target.getCostumes();
            const index = costumes.findIndex(c => idOf(c) === item.id);
            if (index < 0 || costumes[index].name === item.n) continue;
            if (costumes[index].name.includes('\u0000')) costumes[index].name = item.n;
            else target.renameCostume(index, item.n);
            if (costumes[index].name !== item.n) costumes[index].name = item.n;
        }
        // 4. Order.
        list.forEach((item, i) => {
            const index = target.getCostumes().findIndex(c => idOf(c) === item.id);
            if (index >= 0 && index !== i) target.reorderCostume(index, i);
        });
        const keep = target.getCostumes().findIndex(c => idOf(c) === selectedId);
        target.setCostume(keep >= 0 ? keep : Math.min(target.currentCostume, target.getCostumes().length - 1));
        this.vm.emitTargetsUpdate(false);
    }
    async applySounds (target, list) {
        const current = target.getSounds();
        const byId = new Map(current.map(s => [idOf(s), s]));
        const wanted = new Set(list.map(i => i.id));
        const replaced = [];
        for (const item of list) {
            const existing = byId.get(item.id);
            if (existing && md5extOf(existing) === item.a) continue;
            const data = await this.fetchAsset(item.a);
            const [assetId, dataFormat] = item.a.split('.');
            const sound = {
                name: `${item.n}\u0000${randomId()}`, assetId, dataFormat, format: item.f, md5: item.a,
                rate: item.rate, sampleCount: item.sc, asset: this.createAsset(item.a, data, 'sound')
            };
            await this.vm.addSound(sound, target.id);
            const added = target.getSounds()[target.getSounds().length - 1];
            if (existing) replaced.push(existing);
            assetIds.set(added, item.id);
        }
        for (const s of target.getSounds().filter(x => replaced.includes(x) || !wanted.has(idOf(x)))) {
            const index = target.getSounds().indexOf(s);
            if (index >= 0) target.deleteSound(index);
        }
        for (const item of list) {
            const sounds = target.getSounds();
            const index = sounds.findIndex(s => idOf(s) === item.id);
            if (index < 0 || sounds[index].name === item.n) continue;
            if (sounds[index].name.includes('\u0000')) sounds[index].name = item.n;
            else target.renameSound(index, item.n);
            if (sounds[index].name !== item.n) sounds[index].name = item.n;
        }
        list.forEach((item, i) => {
            const index = target.getSounds().findIndex(s => idOf(s) === item.id);
            if (index >= 0 && index !== i) target.reorderSound(index, i);
        });
        this.vm.emitTargetsUpdate(false);
    }

    // ---------- snapshots ----------
    idsSnapshot () {
        return this.originals().map(t => ({n: this.keyOf(t), c: t.getCostumes().map(idOf), s: t.getSounds().map(idOf)}));
    }
    async uploadAllAssets () {
        const items = [];
        for (const t of this.originals()) items.push(...t.getCostumes(), ...t.getSounds());
        const byName = new Map();
        for (const item of items) {
            if (item.asset && item.asset.data) byName.set(md5extOf(item), item.asset.data);
        }
        for (const [name, data] of byName) this.assetData.set(name, data);
        const {missing} = await (await this.api('/collab/assets/missing', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({project: this.projectId, assets: [...byName.keys()]})
        })).json();
        for (const name of byName.keys()) if (!missing.includes(name)) this.uploaded.set(name, Promise.resolve());
        let done = 0;
        await pool(missing, 4, async name => {
            await this.uploadAsset(name, byName.get(name));
            done++;
            this.progress = `Uploading files ${done}/${missing.length}`;
            this.emit();
        });
    }
    async uploadSnapshot (rev, {seed = false} = {}) {
        const projectJson = this.vm.toJSON();
        const ids = this.idsSnapshot();
        if (seed) this.resetBaseline();
        await this.uploadAllAssets();
        const {body, type} = await gzip(`{"v":1,"ids":${JSON.stringify(ids)},"project":${projectJson}}`);
        await this.api(`/projects/${this.projectId}/collab/snapshot/${this.session}/${rev}`, {
            method: 'PUT', headers: {'Content-Type': type}, body
        });
    }
    async loadSnapshot (rev) {
        this.loadingProject = true;
        try {
            this.progress = 'Downloading the live project';
            this.emit();
            const res = await this.api(`/projects/${this.projectId}/collab/snapshot/${this.session}/${rev}`);
            const snap = JSON.parse(await gunzipResponse(res));
            const project = snap.project;
            this.rememberLocalAssets();
            const needed = new Set();
            for (const t of project.targets) {
                for (const item of [...(t.costumes || []), ...(t.sounds || [])]) {
                    needed.add(item.md5ext || `${item.assetId}.${item.dataFormat}`);
                }
            }
            const names = [...needed];
            let done = 0;
            const files = new Map();
            await pool(names, 6, async name => {
                files.set(name, await this.fetchAsset(name));
                done++;
                if (!this.assetData.has(name) || done % 5 === 0) {
                    this.progress = `Loading files ${done}/${names.length}`;
                    this.emit();
                }
            });
            const zip = new JSZip();
            zip.file('project.json', JSON.stringify(project));
            for (const [name, data] of files) zip.file(name, data);
            const buffer = await zip.generateAsync({type: 'arraybuffer', compression: 'STORE'});
            const previous = this.vm.editingTarget ? this.keyOf(this.vm.editingTarget) : undefined;
            this.progress = 'Opening the live project';
            this.emit();
            await this.vm.loadProject(buffer);
            for (const entry of snap.ids || []) {
                const t = this.targetByKey(entry.n);
                if (!t) continue;
                t.getCostumes().forEach((c, i) => entry.c[i] && assetIds.set(c, entry.c[i]));
                t.getSounds().forEach((s, i) => entry.s[i] && assetIds.set(s, entry.s[i]));
            }
            await settle();
            if (previous !== undefined) {
                const t = this.targetByKey(previous);
                if (t && t !== this.vm.editingTarget) {
                    this.vm.setEditingTarget(t.id);
                    await settle();
                }
            }
            this.resetBaseline();
        } finally {
            this.loadingProject = false;
        }
    }

    // ---------- checksums ----------
    checksum () {
        const r = n => (typeof n === 'number' ? Math.round(n) : n);
        const parts = [];
        const targets = this.originals().slice()
            .sort((a, b) => (a.isStage ? -1 : b.isStage ? 1 : (a.getName() < b.getName() ? -1 : 1)));
        for (const t of targets) {
            const blocks = t.blocks._blocks;
            const out = [];
            for (const id of Object.keys(blocks).sort()) {
                const b = blocks[id];
                const inputs = Object.keys(b.inputs || {}).sort()
                    .map(k => [k, b.inputs[k].block, b.inputs[k].shadow]);
                const fields = Object.keys(b.fields || {}).sort()
                    .map(k => [k, b.fields[k].value, b.fields[k].id || '']);
                out.push([id, b.opcode, b.next, b.parent, !!b.shadow, !!b.topLevel,
                    b.topLevel ? r(b.x) : '', b.topLevel ? r(b.y) : '', inputs, fields,
                    b.mutation ? JSON.stringify(b.mutation) : '', b.comment || '']);
            }
            const vars = Object.values(t.variables).map(v => [v.id, v.name, v.type])
                .sort((a, b) => (a[0] < b[0] ? -1 : 1));
            const comments = Object.keys(t.comments).sort()
                .map(id => {
                    const c = t.comments[id];
                    return [id, c.blockId || '', c.text, r(c.x), r(c.y), r(c.width), r(c.height), !!c.minimized];
                });
            parts.push([this.keyOf(t), out, vars, comments, this.sigOf(this.costumeList(t)), this.sigOf(this.soundList(t))]);
        }
        parts.push(this.spriteOrder());
        return hashString(JSON.stringify(parts));
    }
    maybeSendChecksum () {
        if (!this.live || this.processing || this.queue.length || this.outbox.length || this.inflight.size ||
            this.lastSeq === this.lastSumSeq) return;
        const ws = this.workspace;
        if (ws && ws.isDragging && ws.isDragging()) return;
        const run = () => {
            if (!this.live || this.processing || this.outbox.length || this.inflight.size) return;
            this.lastSumSeq = this.lastSeq;
            this.ws.send(JSON.stringify({t: 'sum', s: this.lastSeq, h: this.checksum()}));
        };
        if (window.requestIdleCallback) window.requestIdleCallback(run, {timeout: 3000});
        else run();
    }

    // ---------- saving ----------
    /** Save the live project to KbauBlocks (keeps the title). The host does this automatically. */
    async save () {
        const sb3 = await this.vm.saveProjectSb3();
        const form = new FormData();
        form.append('project', sb3, 'project.sb3');
        const thumbnail = await new Promise(resolve => {
            try {
                this.vm.renderer.requestSnapshot(resolve);
            } catch (e) {
                resolve(null);
            }
        });
        if (thumbnail) form.append('thumbnail', await (await fetch(thumbnail)).blob(), 'thumbnail.png');
        this.dirtySinceSave = false;
        await this.api(`/projects/${this.projectId}/content`, {method: 'PUT', body: form});
        this.lastSavedAt = Date.now();
        this.emit();
    }

    // ---------- connection ----------
    async start (projectId) {
        if (this.status !== 'off' && this.status !== 'error') return;
        this.install();
        this.projectId = String(projectId);
        this.wantStop = false;
        this.session = null;
        this.lastSeq = 0;
        this.reconnectDelay = 1000;
        this.connect();
        clearInterval(this.timer);
        this.timer = setInterval(() => this.tick(), 5000);
    }
    stop (message = '') {
        this.wantStop = true;
        clearInterval(this.timer);
        clearTimeout(this.reconnectTimer);
        if (this.ws) {
            try {
                this.ws.close(1000);
            } catch (e) {
                // ignore
            }
        }
        this.ws = null;
        this.outbox = [];
        this.inflight.clear();
        this.queue = [];
        this.members.clear();
        this.session = null;
        this.setStatus('off', message);
    }
    tick () {
        this.attachWorkspace();
        if (!this.live) return;
        if (Date.now() - this.lastActivity > IDLE_LEAVE_MS) {
            this.stop('You were away for a while, so you left the live session.');
            return;
        }
        if (!this.lastSum || Date.now() - this.lastSum > SUM_EVERY_MS) {
            this.lastSum = Date.now();
            this.maybeSendChecksum();
        }
        if (this.host === (this.you && this.you.u) && this.dirtySinceSave &&
            Date.now() - Math.max(this.lastSavedAt, this.liveSince || 0) > AUTOSAVE_MS) {
            this.save().catch(e => console.warn('[collab] autosave failed', e));
        }
    }
    async connect () {
        const base = await getApiBase();
        const token = getToken();
        if (!base || !token) {
            this.setStatus('error', 'Sign in to KbauBlocks to collaborate.');
            return;
        }
        this.setStatus(this.session ? 'reconnecting' : 'connecting');
        const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/collab/${this.projectId}`);
        this.ws = ws;
        ws.onopen = () => {
            ws.send(JSON.stringify({
                t: 'hello', token, key: this.clientKey,
                resume: this.session ? {session: this.session, last: this.lastSeq} : null
            }));
        };
        ws.onmessage = e => {
            let msg;
            try {
                msg = JSON.parse(e.data);
            } catch (err) {
                return;
            }
            this.handle(msg).catch(err => {
                console.error('[collab]', err);
                this.stop(`Live session error: ${err.message}`);
            });
        };
        ws.onclose = e => {
            if (this.ws !== ws) return;
            this.ws = null;
            if (this.wantStop) return;
            if ([4001, 4003, 4004].includes(e.code)) {
                this.setStatus('error', this.message || 'You can\'t join this live session.');
                return;
            }
            // Network hiccup: try again; edits made meanwhile are kept and sent after resuming.
            this.setStatus('reconnecting');
            this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
            this.reconnectDelay = Math.min(15000, this.reconnectDelay * 2);
        };
    }
    async handle (msg) {
        switch (msg.t) {
        case 'welcome': {
            this.reconnectDelay = 1000;
            this.you = msg.you;
            this.members = new Map((msg.members || []).map(m => [m.u, m]));
            if (msg.host !== undefined) this.host = msg.host;
            if (msg.mode === 'seed') {
                this.session = msg.session;
                this.setStatus('seeding');
                this.progress = 'Uploading your project';
                this.emit();
                this.lastSeq = 0;
                await this.uploadSnapshot(0, {seed: true});
                this.ws.send(JSON.stringify({t: 'seed'}));
                return;
            }
            if (msg.mode === 'resume') {
                this.setStatus('live');
                // Resend anything the server may not have received (it ignores duplicates), then the rest.
                for (const [c, ops] of this.inflight) this.ws.send(JSON.stringify({t: 'op', c, ops}));
                this.flush();
                return;
            }
            // Load: replace the editor's project with the live one, then catch up.
            this.session = msg.session;
            this.outbox = [];
            this.inflight.clear();
            this.queue = [];
            this.buffer = [];
            this.setStatus('loading');
            await this.loadSnapshot(msg.snapRev);
            this.lastSeq = msg.snapRev;
            const buffered = this.buffer;
            this.buffer = null;
            for (const item of buffered) this.enqueue(item);
            this.liveSince = Date.now();
            this.setStatus('live');
            this.sendPresence({x: null, y: null});
            return;
        }
        case 'seeded':
            this.host = msg.host;
            this.liveSince = Date.now();
            this.setStatus('live');
            this.flush();
            this.sendPresence({x: null, y: null});
            return;
        case 'wait':
            this.setStatus('waiting', 'Someone is starting the live session…');
            return;
        case 'ops':
            if (this.buffer) this.buffer.push(msg);
            else this.enqueue(msg);
            return;
        case 'ack':
            if (this.buffer) this.buffer.push({t: 'ack', c: msg.c, s: msg.s});
            else this.enqueue({t: 'ack', c: msg.c, s: msg.s});
            return;
        case 'join':
            this.members.set(msg.m.u, msg.m);
            this.notify(`${msg.m.displayName} joined`, msg.m.color);
            this.emit();
            return;
        case 'leave': {
            const m = this.members.get(msg.u);
            this.members.delete(msg.u);
            if (m) this.notify(`${m.displayName} left`, m.color);
            this.emit();
            return;
        }
        case 'host':
            this.host = msg.u;
            this.emit();
            return;
        case 'p': {
            const m = this.members.get(msg.u);
            if (!m) return;
            if (msg.tg !== undefined) m.tg = msg.tg;
            if (msg.x !== undefined) {
                m.cursor = msg.x === null ? null : {x: msg.x, y: msg.y, at: Date.now()};
            }
            this.emitPresence(m);
            return;
        }
        case 'snapreq':
            this.snapshotWhenIdle();
            return;
        case 'resync':
            this.requestResync('Your copy got out of step');
            return;
        case 'error':
            this.message = msg.message || 'Live session error.';
            return;
        default:
        }
    }
    requestResync (reason) {
        console.warn(`[collab] resyncing: ${reason}`);
        this.notify('Syncing with the live project…', '#888');
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({t: 'rejoin'}));
    }
    async snapshotWhenIdle () {
        for (let i = 0; i < 300; i++) {
            if (!this.live) return;
            this.checkStructure();
            if (!this.processing && !this.queue.length && !this.outbox.length && !this.inflight.size) {
                const rev = this.lastSeq;
                try {
                    await this.uploadSnapshot(rev);
                    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({t: 'snap', rev}));
                } catch (e) {
                    console.warn('[collab] snapshot failed', e);
                }
                return;
            }
            await sleep(200);
        }
    }

    // UI hooks (set by the panel).
    notify (text, color) {
        if (this.onNotify) this.onNotify(text, color);
    }
    emitPresence (member) {
        if (this.onPresence) this.onPresence(member);
    }
}

const engines = new WeakMap();
export const getCollabEngine = vm => {
    if (!engines.has(vm)) {
        const engine = new CollabEngine(vm);
        engines.set(vm, engine);
        // Handy from the browser console when debugging a session.
        window.kbauCollab = engine;
    }
    return engines.get(vm);
};
