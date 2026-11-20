// Name: Claude MCP
// ID: kbauClaudeMcp
// Description: Lets Claude build things in your project through MCP (Model Context Protocol).
// By: KbauBlocks
// License: GPL-3.0
//
// How it works: the KbauBlocks MCP bridge (kbaublocks-mcp.mjs, started by Claude) listens on
// ws://127.0.0.1:61017. This extension connects to it and carries out what Claude asks for:
// reading the project, adding scripts, sprites, costumes and variables, running the project and
// taking stage screenshots. Nothing leaves your computer except through Claude itself.
(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('Claude MCP must run unsandboxed (load it from the Extras list).');
    }

    const vm = Scratch.vm;
    const runtime = vm.runtime;
    const DEFAULT_PORT = 61017;
    const COLOR = '#d97757';
    const SETUP_URL = 'https://kbau.lol/extras#claude-mcp';

    // ---------------------------------------------------------------- connection

    let port = DEFAULT_PORT;
    try {
        const saved = Number(localStorage.getItem('kbau:claude-mcp-port'));
        if (saved > 0 && saved < 65536) port = saved;
    } catch (e) {
        // ignore
    }
    let socket = null;
    let status = 'disconnected';
    let retryTimer = null;
    let stopped = false;
    let lastAction = '';

    const setStatus = s => {
        status = s;
    };
    const send = obj => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
    };
    const scheduleRetry = () => {
        clearTimeout(retryTimer);
        if (!stopped) retryTimer = setTimeout(connect, 4000);
    };
    function connect () {
        clearTimeout(retryTimer);
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
        setStatus('connecting');
        let ws;
        try {
            ws = new WebSocket(`ws://127.0.0.1:${port}`);
        } catch (e) {
            setStatus('disconnected');
            scheduleRetry();
            return;
        }
        socket = ws;
        ws.onopen = () => {
            setStatus('connected');
            send({type: 'hello', editor: 'KbauBlocks', version: 1});
        };
        ws.onmessage = event => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                return;
            }
            if (!msg || typeof msg.id === 'undefined' || typeof msg.method !== 'string') return;
            handle(msg.method, msg.params || {})
                .then(result => send({id: msg.id, result}))
                .catch(error => send({id: msg.id, error: String((error && error.message) || error)}));
        };
        ws.onclose = () => {
            if (socket === ws) socket = null;
            setStatus('disconnected');
            scheduleRetry();
        };
        ws.onerror = () => {
            // onclose follows
        };
    }

    // ---------------------------------------------------------------- helpers

    const stage = () => runtime.getTargetForStage();
    const sprites = () => runtime.targets.filter(t => t.isOriginal && !t.isStage);
    const findTarget = name => {
        if (name === undefined || name === null || name === '' || String(name).toLowerCase() === 'stage' ||
            (stage() && name === stage().getName())) {
            return stage();
        }
        const t = runtime.getSpriteTargetByName(String(name));
        if (!t) {
            const names = sprites().map(s => s.getName());
            throw new Error(`No sprite named "${name}". Sprites: ${names.join(', ') || '(none)'}. Use "Stage" for the stage.`);
        }
        return t;
    };
    const uid = () => {
        const chars = '!#%()*+,-./:;=?@[]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
    };
    const refreshWorkspace = () => {
        try {
            vm.emitWorkspaceUpdate();
        } catch (e) {
            // ignore
        }
        try {
            runtime.emitProjectChanged();
        } catch (e) {
            // ignore
        }
    };
    const varsOf = target => Object.values(target.variables).map(v => ({
        id: v.id,
        name: v.name,
        type: v.type === 'list' ? 'list' : v.type === 'broadcast_msg' ? 'broadcast' : 'variable',
        value: v.type === 'list' ? v.value.slice(0, 50) : v.value,
        ...(v.isCloud ? {cloud: true} : {})
    }));

    const summary = () => ({
        stageSize: {width: runtime.stageWidth || 480, height: runtime.stageHeight || 360},
        editingTarget: vm.editingTarget ? vm.editingTarget.getName() : null,
        extensions: Array.from(vm.extensionManager._loadedExtensions ? vm.extensionManager._loadedExtensions.keys() : []),
        targets: [stage(), ...sprites()].filter(Boolean).map(t => {
            const blocks = Object.values(t.blocks._blocks);
            return {
                name: t.getName(),
                isStage: t.isStage,
                ...(t.isStage ? {} : {
                    x: Math.round(t.x),
                    y: Math.round(t.y),
                    size: Math.round(t.size),
                    direction: t.direction,
                    visible: t.visible,
                    rotationStyle: t.rotationStyle,
                    layer: t.getLayerOrder ? t.getLayerOrder() : undefined
                }),
                costumes: t.getCostumes().map(c => c.name),
                currentCostume: t.getCostumes()[t.currentCostume] ? t.getCostumes()[t.currentCostume].name : null,
                sounds: t.getSounds().map(s => s.name),
                variables: varsOf(t),
                scripts: blocks.filter(b => b.topLevel && !b.shadow).length,
                blocks: blocks.filter(b => !b.shadow).length
            };
        })
    });

    /** Scripts of one target in project.json (sb3) format. */
    const scriptsOf = target => {
        const json = JSON.parse(vm.toJSON(target.id));
        return {
            target: target.getName(),
            blocks: json.blocks || {},
            comments: json.comments || {},
            variables: json.variables || {},
            lists: json.lists || {},
            broadcasts: (json.broadcasts) || (stage() ? JSON.parse(vm.toJSON(stage().id)).broadcasts : {})
        };
    };

    // project.json primitive types
    const PRIMITIVES = {
        4: ['math_number', 'NUM'],
        5: ['math_positive_number', 'NUM'],
        6: ['math_whole_number', 'NUM'],
        7: ['math_integer', 'NUM'],
        8: ['math_angle', 'NUM'],
        9: ['colour_picker', 'COLOUR'],
        10: ['text', 'TEXT']
    };

    /**
     * Find or create the variable/list/broadcast a block refers to, and return its real id.
     * Lookup order: id, then name (sprite first, then stage). New ones are global (on the stage),
     * except variables the sprite should own, which Claude can make with create_variable first.
     */
    const resolveVar = (target, type, name, id) => {
        const vmType = type === 'list' ? 'list' : type === 'broadcast_msg' ? 'broadcast_msg' : '';
        const st = stage();
        if (id) {
            const byId = target.lookupVariableById(id);
            if (byId && byId.type === vmType) return byId;
        }
        let found = target.lookupVariableByNameAndType(String(name), vmType);
        if (!found && st && st !== target) found = st.lookupVariableByNameAndType(String(name), vmType);
        if (found) return found;
        const idTaken = id && runtime.targets.some(t => t.variables && t.variables[id]);
        const newId = id && !idTaken ? String(id) : uid();
        st.createVariable(newId, String(name), vmType);
        return st.variables[newId];
    };

    /** Convert project.json blocks into the VM's internal block objects (like scratch-vm's sb3 loader). */
    const toVmBlocks = (target, sb3Blocks) => {
        if (!sb3Blocks || typeof sb3Blocks !== 'object' || Array.isArray(sb3Blocks)) {
            throw new Error('"blocks" must be an object of id → block, in project.json format.');
        }
        const out = {};
        const idMap = {};
        for (const id of Object.keys(sb3Blocks)) idMap[id] = uid();
        const mapId = id => (id === null || id === undefined ? null : (idMap[id] || null));

        const primitive = (desc, parentId, isShadow) => {
            if (!Array.isArray(desc)) {
                if (desc === null || desc === undefined) return null;
                if (!idMap[desc]) throw new Error(`Input refers to block "${desc}", which is not in "blocks".`);
                return idMap[desc];
            }
            const newId = uid();
            const type = desc[0];
            const block = {id: newId, next: null, parent: parentId, shadow: isShadow, inputs: {}, topLevel: false};
            if (PRIMITIVES[type]) {
                const [opcode, field] = PRIMITIVES[type];
                block.opcode = opcode;
                block.fields = {[field]: {name: field, value: desc[1]}};
            } else if (type === 11) {
                const v = resolveVar(target, 'broadcast_msg', desc[1], desc[2]);
                block.opcode = 'event_broadcast_menu';
                block.fields = {BROADCAST_OPTION: {name: 'BROADCAST_OPTION', value: v.name, id: v.id, variableType: 'broadcast_msg'}};
            } else if (type === 12 || type === 13) {
                const isList = type === 13;
                const v = resolveVar(target, isList ? 'list' : '', desc[1], desc[2]);
                const field = isList ? 'LIST' : 'VARIABLE';
                block.opcode = isList ? 'data_listcontents' : 'data_variable';
                block.shadow = false;
                block.fields = {[field]: {name: field, value: v.name, id: v.id, variableType: isList ? 'list' : ''}};
                if (desc.length > 3) {
                    block.topLevel = true;
                    block.parent = null;
                    block.x = desc[3];
                    block.y = desc[4];
                }
            } else {
                throw new Error(`Unknown primitive ${JSON.stringify(desc)}. Use [4,"10"] numbers, [10,"hi"] text, [12,"name","id"] variables.`);
            }
            out[newId] = block;
            return newId;
        };

        for (const [oldId, src] of Object.entries(sb3Blocks)) {
            if (Array.isArray(src)) {
                primitive(src, null, false); // top-level variable/list reporter
                continue;
            }
            if (!src || typeof src.opcode !== 'string') throw new Error(`Block "${oldId}" has no opcode.`);
            const id = idMap[oldId];
            const block = {
                id,
                opcode: src.opcode,
                next: mapId(src.next),
                parent: mapId(src.parent),
                shadow: !!src.shadow,
                topLevel: !!src.topLevel || !src.parent,
                inputs: {},
                fields: {}
            };
            if (block.topLevel) {
                block.parent = null;
                block.x = Number(src.x) || 0;
                block.y = Number(src.y) || 0;
            }
            for (const [name, desc] of Object.entries(src.inputs || {})) {
                if (!Array.isArray(desc)) throw new Error(`Input ${name} of "${oldId}" must be an array like [1, [4, "10"]].`);
                let blockId = null;
                let shadowId = null;
                if (desc[0] === 1) {
                    blockId = shadowId = primitive(desc[1], id, true);
                } else if (desc[0] === 2) {
                    blockId = primitive(desc[1], id, false);
                } else {
                    blockId = primitive(desc[1], id, false);
                    shadowId = primitive(desc[2], id, true);
                }
                block.inputs[name] = {name, block: blockId, shadow: shadowId};
            }
            for (const [name, desc] of Object.entries(src.fields || {})) {
                const arr = Array.isArray(desc) ? desc : [desc];
                const field = {name, value: arr[0]};
                if (name === 'VARIABLE' || name === 'LIST' || name === 'BROADCAST_OPTION') {
                    const type = name === 'LIST' ? 'list' : name === 'BROADCAST_OPTION' ? 'broadcast_msg' : '';
                    const v = resolveVar(target, type, arr[0], arr[1]);
                    field.value = v.name;
                    field.id = v.id;
                    field.variableType = type;
                } else if (arr.length > 1 && arr[1] !== null) {
                    field.id = arr[1];
                }
                block.fields[name] = field;
            }
            if (src.mutation) {
                block.mutation = {tagName: 'mutation', children: [], ...src.mutation};
            } else if (src.opcode === 'control_stop') {
                const option = block.fields.STOP_OPTION && block.fields.STOP_OPTION.value;
                block.mutation = {tagName: 'mutation', children: [], hasnext: option === 'other scripts in sprite' || option === 'other scripts in stage' ? 'true' : 'false'};
            }
            out[id] = block;
        }
        // Fix parent links Claude left out: anything used as an input or as "next" is not a script top.
        const attach = (childId, parentId) => {
            const child = childId && out[childId];
            if (!child || childId === parentId) return;
            child.parent = parentId;
            child.topLevel = false;
            delete child.x;
            delete child.y;
        };
        for (const block of Object.values(out)) {
            for (const input of Object.values(block.inputs)) {
                attach(input.block, block.id);
                attach(input.shadow, block.id);
            }
            attach(block.next, block.id);
        }
        return Object.values(out);
    };

    const placeBelowExisting = (target, blocks) => {
        const existing = Object.values(target.blocks._blocks).filter(b => b.topLevel);
        let y = existing.reduce((m, b) => Math.max(m, (b.y || 0) + 120), 0);
        for (const b of blocks) {
            if (b.topLevel && b.x === 0 && b.y === 0) {
                b.x = 40;
                b.y = y;
                y += 160;
            }
        }
    };

    const loadExtensionsFor = async blocks => {
        const manager = vm.extensionManager;
        const ids = new Set();
        for (const b of blocks) {
            const i = b.opcode.indexOf('_');
            const prefix = i > 0 ? b.opcode.slice(0, i) : '';
            if (prefix && !['motion', 'looks', 'sound', 'event', 'control', 'sensing', 'operator', 'data',
                'procedures', 'argument', 'math', 'text', 'colour', 'matrix', 'note'].includes(prefix)) {
                ids.add(prefix);
            }
        }
        for (const id of ids) {
            if (manager.isExtensionLoaded(id)) continue;
            if (manager.isBuiltinExtension && manager.isBuiltinExtension(id)) {
                manager.loadExtensionIdSync(id);
            } else {
                throw new Error(`Blocks use the "${id}" extension, which isn't loaded. Load it first with add_extension.`);
            }
        }
    };

    // ---------------------------------------------------------------- tiny zip writer (for new sprites)

    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    const crc32 = data => {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const zip = files => {
        const enc = new TextEncoder();
        const parts = [];
        const central = [];
        let offset = 0;
        for (const [name, data] of files) {
            const nameBytes = enc.encode(name);
            const crc = crc32(data);
            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);
            local.setUint16(4, 20, true);
            local.setUint32(14, crc, true);
            local.setUint32(18, data.length, true);
            local.setUint32(22, data.length, true);
            local.setUint16(26, nameBytes.length, true);
            parts.push(new Uint8Array(local.buffer), nameBytes, data);
            const cd = new DataView(new ArrayBuffer(46));
            cd.setUint32(0, 0x02014b50, true);
            cd.setUint16(4, 20, true);
            cd.setUint16(6, 20, true);
            cd.setUint32(16, crc, true);
            cd.setUint32(20, data.length, true);
            cd.setUint32(24, data.length, true);
            cd.setUint16(28, nameBytes.length, true);
            cd.setUint32(42, offset, true);
            central.push(new Uint8Array(cd.buffer), nameBytes);
            offset += 30 + nameBytes.length + data.length;
        }
        const centralSize = central.reduce((n, p) => n + p.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, files.length, true);
        end.setUint16(10, files.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);
        const all = [...parts, ...central, new Uint8Array(end.buffer)];
        const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
        let pos = 0;
        for (const p of all) {
            out.set(p, pos);
            pos += p.length;
        }
        return out.buffer;
    };

    const DEFAULT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">' +
        '<circle cx="30" cy="30" r="26" fill="#d97757" stroke="#000" stroke-width="3"/></svg>';
    const checkSvg = svg => {
        const text = String(svg || '').trim();
        if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) throw new Error('Costumes must be SVG text starting with <svg>.');
        if (text.length > 2000000) throw new Error('SVG is too large (2 MB max).');
        return text;
    };
    const svgAsset = svg => {
        const storage = runtime.storage;
        const data = new TextEncoder().encode(svg);
        return storage.createAsset(storage.AssetType.ImageVector, storage.DataFormat.SVG, data, null, true);
    };
    const md5Of = async svg => svgAsset(svg).assetId;

    const snapshot = () => new Promise((resolve, reject) => {
        if (!vm.renderer) {
            reject(new Error('No renderer.'));
            return;
        }
        vm.renderer.requestSnapshot(url => resolve(url));
    });

    // ---------------------------------------------------------------- commands from Claude

    const commands = {
        async get_project () {
            return summary();
        },
        async get_scripts ({target}) {
            return scriptsOf(findTarget(target));
        },
        async add_script ({target, blocks}) {
            const t = findTarget(target);
            const vmBlocks = toVmBlocks(t, blocks);
            placeBelowExisting(t, vmBlocks);
            await loadExtensionsFor(vmBlocks);
            for (const b of vmBlocks) t.blocks.createBlock(b);
            t.blocks.updateTargetSpecificBlocks(t.isStage);
            refreshWorkspace();
            const tops = vmBlocks.filter(b => b.topLevel).map(b => ({id: b.id, opcode: b.opcode}));
            lastAction = `added ${vmBlocks.filter(b => !b.shadow).length} blocks to ${t.getName()}`;
            return {target: t.getName(), added: vmBlocks.filter(b => !b.shadow).length, scripts: tops};
        },
        async delete_script ({target, blockId}) {
            const t = findTarget(target);
            const b = t.blocks.getBlock(blockId);
            if (!b) throw new Error(`No block "${blockId}" in ${t.getName()}. Use get_scripts to see ids.`);
            if (!b.topLevel) throw new Error('That block is not the top of a script.');
            t.blocks.deleteBlock(blockId);
            refreshWorkspace();
            return {deleted: blockId};
        },
        async clear_scripts ({target}) {
            const t = findTarget(target);
            const tops = Object.values(t.blocks._blocks).filter(b => b.topLevel).map(b => b.id);
            for (const id of tops) t.blocks.deleteBlock(id);
            for (const id of Object.keys(t.comments || {})) delete t.comments[id];
            refreshWorkspace();
            return {target: t.getName(), deletedScripts: tops.length};
        },
        async create_sprite ({name, svg, x, y}) {
            const costumeSvg = checkSvg(svg || DEFAULT_SVG);
            const enc = new TextEncoder();
            const md5 = await md5Of(costumeSvg);
            const sprite = {
                isStage: false,
                name: String(name || 'Sprite'),
                variables: {},
                lists: {},
                broadcasts: {},
                blocks: {},
                comments: {},
                currentCostume: 0,
                costumes: [{name: 'costume1', bitmapResolution: 1, dataFormat: 'svg', assetId: md5, md5ext: `${md5}.svg`}],
                sounds: [],
                volume: 100,
                visible: true,
                x: Number(x) || 0,
                y: Number(y) || 0,
                size: 100,
                direction: 90,
                draggable: false,
                rotationStyle: 'all around'
            };
            const file = zip([
                ['sprite.json', enc.encode(JSON.stringify(sprite))],
                [`${md5}.svg`, enc.encode(costumeSvg)]
            ]);
            await vm.addSprite(file);
            const created = vm.editingTarget;
            if (created && !created.isStage) created.setXY(Number(x) || 0, Number(y) || 0);
            refreshWorkspace();
            return {created: created ? created.getName() : sprite.name};
        },
        async delete_sprite ({target}) {
            const t = findTarget(target);
            if (t.isStage) throw new Error('The stage cannot be deleted.');
            const name = t.getName();
            vm.deleteSprite(t.id);
            return {deleted: name};
        },
        async set_sprite ({target, name, x, y, size, direction, visible, rotationStyle, costume, draggable, layer}) {
            const t = findTarget(target);
            if (t.isStage) {
                if (costume !== undefined) t.setCostume(costumeIndex(t, costume));
                refreshWorkspace();
                return {target: t.getName()};
            }
            if (name !== undefined && name !== t.getName()) vm.renameSprite(t.id, String(name));
            if (x !== undefined || y !== undefined) t.setXY(x === undefined ? t.x : Number(x), y === undefined ? t.y : Number(y));
            if (size !== undefined) t.setSize(Number(size));
            if (direction !== undefined) t.setDirection(Number(direction));
            if (visible !== undefined) t.setVisible(!!visible);
            if (rotationStyle !== undefined) t.setRotationStyle(String(rotationStyle));
            if (draggable !== undefined) t.setDraggable(!!draggable);
            if (costume !== undefined) t.setCostume(costumeIndex(t, costume));
            if (layer === 'front') t.goToFront();
            if (layer === 'back') t.goToBack();
            runtime.emitProjectChanged();
            vm.emitTargetsUpdate();
            return {target: t.getName()};
        },
        async add_costume ({target, name, svg, replace}) {
            const t = findTarget(target);
            const text = checkSvg(svg);
            const asset = svgAsset(text);
            const costumeName = String(name || (t.isStage ? 'backdrop' : 'costume'));
            const costume = {name: costumeName, asset, md5: `${asset.assetId}.svg`, assetId: asset.assetId, dataFormat: 'svg', bitmapResolution: 1};
            const oldIndex = t.getCostumes().findIndex(c => c.name === costumeName);
            if (t.isStage) await vm.addBackdrop(costume.md5, costume);
            else await vm.addCostume(costume.md5, costume, t.id);
            if (replace !== false && oldIndex >= 0) {
                t.deleteCostume(oldIndex);
                const idx = t.getCostumes().findIndex(c => c.assetId === asset.assetId);
                if (idx >= 0) {
                    t.getCostumes()[idx].name = costumeName;
                    t.setCostume(idx);
                }
            }
            vm.emitTargetsUpdate();
            return {target: t.getName(), costume: t.getCostumes()[t.currentCostume].name, costumes: t.getCostumes().map(c => c.name)};
        },
        async delete_costume ({target, costume}) {
            const t = findTarget(target);
            if (t.getCostumes().length <= 1) throw new Error('A sprite needs at least one costume.');
            t.deleteCostume(costumeIndex(t, costume));
            vm.emitTargetsUpdate();
            return {costumes: t.getCostumes().map(c => c.name)};
        },
        async create_variable ({target, name, type, value}) {
            const t = findTarget(target);
            const isList = type === 'list';
            const existing = t.lookupVariableByNameAndType(String(name), isList ? 'list' : '');
            const v = existing || (() => {
                const id = uid();
                t.createVariable(id, String(name), isList ? 'list' : '');
                return t.variables[id];
            })();
            if (value !== undefined) v.value = isList ? (Array.isArray(value) ? value.map(String) : []) : value;
            refreshWorkspace();
            return {id: v.id, name: v.name, owner: t.getName(), type: isList ? 'list' : 'variable'};
        },
        async add_extension ({id}) {
            const manager = vm.extensionManager;
            const extId = String(id || '');
            if (manager.isExtensionLoaded(extId)) return {loaded: extId, already: true};
            if (manager.isBuiltinExtension && manager.isBuiltinExtension(extId)) {
                manager.loadExtensionIdSync(extId);
                return {loaded: extId};
            }
            if (/^https:\/\/extensions\.turbowarp\.org\/[\w/.-]+\.js$/.test(extId)) {
                await manager.loadExtensionURL(extId);
                return {loaded: extId};
            }
            throw new Error('Use a built-in extension id (pen, music, text2speech, translate, videoSensing, faceSensing, ...) or an https://extensions.turbowarp.org/....js URL.');
        },
        async run_project ({screenshotAfterMs}) {
            vm.greenFlag();
            if (screenshotAfterMs) {
                await new Promise(r => setTimeout(r, Math.min(Number(screenshotAfterMs) || 0, 10000)));
                return {running: true, image: await snapshot()};
            }
            return {running: true};
        },
        async stop_project () {
            vm.stopAll();
            return {stopped: true};
        },
        async screenshot () {
            return {image: await snapshot()};
        },
        async select_target ({target}) {
            const t = findTarget(target);
            vm.setEditingTarget(t.id);
            return {editing: t.getName()};
        }
    };
    const costumeIndex = (t, costume) => {
        if (typeof costume === 'number') return Math.max(0, Math.min(t.getCostumes().length - 1, costume));
        const i = t.getCostumes().findIndex(c => c.name === String(costume));
        if (i < 0) throw new Error(`No costume "${costume}". Costumes: ${t.getCostumes().map(c => c.name).join(', ')}`);
        return i;
    };

    const handle = async (method, params) => {
        const fn = commands[method];
        if (!fn) throw new Error(`Unknown command ${method}`);
        return fn(params);
    };

    // ---------------------------------------------------------------- blocks

    class ClaudeMcp {
        getInfo () {
            return {
                id: 'kbauClaudeMcp',
                name: 'Claude MCP',
                color1: COLOR,
                color2: '#c4654a',
                color3: '#a8513a',
                blocks: [
                    {
                        func: 'help',
                        blockType: Scratch.BlockType.BUTTON,
                        text: 'How to connect Claude'
                    },
                    {
                        opcode: 'isConnected',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'connected to Claude?'
                    },
                    {
                        opcode: 'getStatus',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'Claude bridge status'
                    },
                    {
                        opcode: 'lastChange',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'last change by Claude'
                    },
                    '---',
                    {
                        opcode: 'reconnect',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'connect to Claude bridge on port [PORT]',
                        arguments: {
                            PORT: {type: Scratch.ArgumentType.NUMBER, defaultValue: DEFAULT_PORT}
                        }
                    },
                    {
                        opcode: 'disconnect',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'disconnect from Claude'
                    }
                ]
            };
        }
        help () {
            // eslint-disable-next-line no-alert
            alert('Claude MCP lets Claude build in this project.\n\n' +
                '1. Install Node.js (version 18 or newer).\n' +
                '2. Download kbaublocks-mcp.mjs from kbau.lol (Extras → Claude MCP).\n' +
                '3. Add it to Claude, for example in Claude Code:\n' +
                '   claude mcp add kbaublocks -- node "C:\\path\\to\\kbaublocks-mcp.mjs"\n' +
                '4. Keep this editor open with this extension added. It connects by itself.\n\n' +
                `Status: ${status}. Full guide: ${SETUP_URL}`);
        }
        isConnected () {
            return status === 'connected';
        }
        getStatus () {
            return status;
        }
        lastChange () {
            return lastAction;
        }
        reconnect ({PORT}) {
            const p = Math.round(Number(PORT));
            if (p > 0 && p < 65536) {
                port = p;
                try {
                    localStorage.setItem('kbau:claude-mcp-port', String(p));
                } catch (e) {
                    // ignore
                }
            }
            stopped = false;
            if (socket) socket.close();
            connect();
        }
        disconnect () {
            stopped = true;
            clearTimeout(retryTimer);
            if (socket) socket.close();
            setStatus('disconnected');
        }
    }

    Scratch.extensions.register(new ClaudeMcp());
    connect();
})(Scratch);
