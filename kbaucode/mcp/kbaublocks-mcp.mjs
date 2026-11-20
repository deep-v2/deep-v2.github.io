#!/usr/bin/env node
/**
 * KbauBlocks MCP bridge: lets Claude (or any MCP client) build things in the KbauBlocks editor.
 *
 *   Claude  <-- MCP over stdio -->  this program  <-- WebSocket 127.0.0.1:61017 -->  editor ("Claude MCP" extra)
 *
 * No dependencies: needs only Node.js 18+. Setup:
 *   Claude Code:     claude mcp add kbaublocks -- node "/path/to/kbaublocks-mcp.mjs"
 *   Claude Desktop:  add to claude_desktop_config.json → "mcpServers":
 *                    {"kbaublocks": {"command": "node", "args": ["/path/to/kbaublocks-mcp.mjs"]}}
 * Then open the KbauBlocks editor and add the "Claude MCP" extension from Extras.
 *
 * Environment:
 *   KBAU_MCP_PORT     WebSocket port (default 61017; set the same port in the extension block)
 *   KBAU_MCP_ORIGINS  extra comma-separated web origins allowed to connect (e.g. a self-hosted site)
 *
 * License: GPL-3.0-or-later.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';

const VERSION = '1.0.0';
const PORT = Number(process.env.KBAU_MCP_PORT) || 61017;
const ALLOWED_ORIGINS = [
    'https://kbau.lol',
    'https://deep-v2.github.io',
    'kbau://app',
    ...(process.env.KBAU_MCP_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
];
const originAllowed = origin => {
    if (!origin) return false;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // Local development servers.
    return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
};
const log = (...args) => console.error('[kbaublocks-mcp]', ...args);

// ------------------------------------------------------------------ WebSocket server (RFC 6455, minimal)

let editor = null; // the most recently connected editor
const pending = new Map();
let nextId = 1;

const frame = (opcode, payload) => {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
};

class Connection {
    constructor (socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.alive = true;
        socket.on('data', chunk => this.onData(chunk));
        socket.on('close', () => this.onClose());
        socket.on('error', () => this.onClose());
        this.pinger = setInterval(() => this.send(0x9, Buffer.alloc(0)), 20000);
    }
    send (opcode, payload) {
        if (this.alive) this.socket.write(frame(opcode, payload));
    }
    sendJson (obj) {
        this.send(0x1, Buffer.from(JSON.stringify(obj)));
    }
    onData (chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            if (this.buffer.length < 2) return;
            const b0 = this.buffer[0];
            const b1 = this.buffer[1];
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (this.buffer.length < 4) return;
                len = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (len === 127) {
                if (this.buffer.length < 10) return;
                len = Number(this.buffer.readBigUInt64BE(2));
                offset = 10;
            }
            if (len > 64 * 1024 * 1024) {
                this.close();
                return;
            }
            const masked = (b1 & 0x80) !== 0;
            const maskStart = offset;
            if (masked) offset += 4;
            if (this.buffer.length < offset + len) return;
            let payload = this.buffer.subarray(offset, offset + len);
            if (masked) {
                const mask = this.buffer.subarray(maskStart, maskStart + 4);
                payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
            }
            this.buffer = this.buffer.subarray(offset + len);
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            if (opcode === 0x8) {
                this.close();
                return;
            } else if (opcode === 0x9) {
                this.send(0xA, payload);
            } else if (opcode === 0x1 || opcode === 0x0) {
                this.fragments.push(payload);
                if (fin) {
                    const text = Buffer.concat(this.fragments).toString('utf8');
                    this.fragments = [];
                    this.onMessage(text);
                }
            }
        }
    }
    onMessage (text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch (e) {
            return;
        }
        if (msg && msg.type === 'hello') {
            log('editor connected');
            return;
        }
        if (msg && pending.has(msg.id)) {
            const {resolve, reject, timer} = pending.get(msg.id);
            pending.delete(msg.id);
            clearTimeout(timer);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
        }
    }
    close () {
        if (!this.alive) return;
        try {
            this.socket.end(frame(0x8, Buffer.alloc(0)));
        } catch (e) {
            // ignore
        }
        this.onClose();
    }
    onClose () {
        if (!this.alive) return;
        this.alive = false;
        clearInterval(this.pinger);
        if (editor === this) {
            editor = null;
            log('editor disconnected');
        }
    }
}

let listenError = null;
const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('KbauBlocks MCP bridge. Add the "Claude MCP" extension in the KbauBlocks editor to connect.\n');
});
server.on('upgrade', (req, socket) => {
    const origin = req.headers.origin;
    const key = req.headers['sec-websocket-key'];
    if (!originAllowed(origin) || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        log(`rejected connection from origin ${origin || '(none)'}`);
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
    }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    if (editor) editor.close(); // newest editor wins
    editor = new Connection(socket);
});
server.on('error', e => {
    listenError = e.code === 'EADDRINUSE' ?
        `Port ${PORT} is already in use (another KbauBlocks MCP bridge may be running). Close it, or set KBAU_MCP_PORT and the same port in the extension's "connect to Claude bridge" block.` :
        String(e.message || e);
    log(listenError);
});
server.listen(PORT, '127.0.0.1', () => log(`waiting for the editor on ws://127.0.0.1:${PORT}`));

const waitForEditor = async ms => {
    const end = Date.now() + ms;
    while (!editor && Date.now() < end) await new Promise(r => setTimeout(r, 200));
    return editor;
};

const callEditor = async (method, params) => {
    if (listenError) throw new Error(listenError);
    const conn = await waitForEditor(3000);
    if (!conn) {
        throw new Error('The KbauBlocks editor is not connected. Ask the user to open the editor (https://kbau.lol/editor/ ' +
            'or the KbauBlocks desktop app) and add the "Claude MCP" extension from Extras; it connects automatically.');
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('The editor did not answer in time.'));
        }, 30000);
        pending.set(id, {resolve, reject, timer});
        conn.sendJson({id, method, params});
    });
};

// ------------------------------------------------------------------ MCP tools

const TARGET = {type: 'string', description: 'Sprite name, or "Stage" for the stage.'};
const BLOCK_FORMAT = `Blocks use the project.json (sb3) format: an object mapping your own block ids to blocks:
{"a": {"opcode": "event_whenflagclicked", "next": "b", "parent": null, "topLevel": true, "x": 0, "y": 0},
 "b": {"opcode": "motion_movesteps", "next": "c", "parent": "a", "inputs": {"STEPS": [1, [4, "10"]]}},
 "c": {"opcode": "looks_sayforsecs", "next": null, "parent": "b",
       "inputs": {"MESSAGE": [1, [10, "Hello!"]], "SECS": [1, [4, "2"]]}}}
Inputs: [1, primitive] for a plain value; [3, "blockId", primitive] to put a reporter block over a default;
[2, "blockId"] for a substack/boolean slot (e.g. SUBSTACK, CONDITION). Primitives: [4,"n"] number, [10,"text"] text,
[9,"#ff0000"] colour, [11,"message","msgId"] broadcast, [12,"var name","varId"] variable reporter, [13,"list","listId"] list.
Fields: {"FIELD": ["value", null]}, e.g. "VARIABLE": ["score", "scoreId"], "KEY_OPTION": ["space", null].
Menus are shadow blocks, e.g. motion_goto with "TO": [1, "m"] and "m": {"opcode": "motion_goto_menu", "shadow": true,
"parent": "...", "fields": {"TO": ["_random_", null]}}. Custom blocks need procedures_definition + procedures_prototype
(shadow, with a mutation: proccode, argumentids, argumentnames, argumentdefaults as JSON strings, warp "false").
Variables, lists and broadcasts are matched by name (sprite first, then stage) and created on the stage if missing.
Leave out x/y to place the script below the existing ones. Extension blocks (pen_, music_, ...) load their extension.`;

const TOOLS = [
    {
        name: 'get_project',
        description: 'Summary of the open project: stage and sprites with position, costumes, sounds, variables and script counts. Call this first.',
        inputSchema: {type: 'object', properties: {}}
    },
    {
        name: 'get_scripts',
        description: 'All scripts of one sprite (or the stage) in project.json block format, with variables, lists and broadcasts.',
        inputSchema: {type: 'object', properties: {target: TARGET}, required: ['target']}
    },
    {
        name: 'add_script',
        description: `Add one or more scripts to a sprite or the stage.\n${BLOCK_FORMAT}`,
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET,
                blocks: {type: 'object', description: 'Blocks in project.json format (see the tool description).'}
            },
            required: ['target', 'blocks']
        }
    },
    {
        name: 'delete_script',
        description: 'Delete one script by the id of its top block (ids come from get_scripts).',
        inputSchema: {type: 'object', properties: {target: TARGET, blockId: {type: 'string'}}, required: ['target', 'blockId']}
    },
    {
        name: 'clear_scripts',
        description: 'Delete every script (and comment) of a sprite or the stage.',
        inputSchema: {type: 'object', properties: {target: TARGET}, required: ['target']}
    },
    {
        name: 'create_sprite',
        description: 'Create a new sprite. Optionally give its first costume as SVG text (draw it yourself; keep it about 40-150 px, centred art looks best).',
        inputSchema: {
            type: 'object',
            properties: {
                name: {type: 'string'},
                svg: {type: 'string', description: 'SVG source for the first costume (optional).'},
                x: {type: 'number'},
                y: {type: 'number'}
            },
            required: ['name']
        }
    },
    {
        name: 'delete_sprite',
        description: 'Delete a sprite.',
        inputSchema: {type: 'object', properties: {target: TARGET}, required: ['target']}
    },
    {
        name: 'set_sprite',
        description: 'Change a sprite: rename, position, size, direction, visibility, rotation style, current costume, draggable, layer. For the stage only "costume" (backdrop) applies.',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET,
                name: {type: 'string', description: 'New name.'},
                x: {type: 'number'},
                y: {type: 'number'},
                size: {type: 'number', description: 'Percent, 100 = normal.'},
                direction: {type: 'number', description: '90 = right.'},
                visible: {type: 'boolean'},
                rotationStyle: {type: 'string', enum: ['all around', 'left-right', "don't rotate"]},
                costume: {type: ['string', 'number'], description: 'Costume name or index.'},
                draggable: {type: 'boolean'},
                layer: {type: 'string', enum: ['front', 'back']}
            },
            required: ['target']
        }
    },
    {
        name: 'add_costume',
        description: 'Add a costume (or a backdrop, for the Stage) drawn as SVG and switch to it. A costume with the same name is replaced unless replace is false. Stage is 480x360; backdrops should be 480x360 SVGs.',
        inputSchema: {
            type: 'object',
            properties: {target: TARGET, name: {type: 'string'}, svg: {type: 'string'}, replace: {type: 'boolean'}},
            required: ['target', 'name', 'svg']
        }
    },
    {
        name: 'delete_costume',
        description: 'Delete a costume or backdrop by name or index.',
        inputSchema: {type: 'object', properties: {target: TARGET, costume: {type: ['string', 'number']}}, required: ['target', 'costume']}
    },
    {
        name: 'create_variable',
        description: 'Create a variable or list. On "Stage" it is global ("for all sprites"); on a sprite it is "for this sprite only". Optionally set its value.',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET,
                name: {type: 'string'},
                type: {type: 'string', enum: ['variable', 'list']},
                value: {description: 'Starting value (a list takes an array).'}
            },
            required: ['target', 'name']
        }
    },
    {
        name: 'add_extension',
        description: 'Load an extension: a built-in id (pen, music, text2speech, translate, videoSensing, faceSensing, ...) or an https://extensions.turbowarp.org/....js URL.',
        inputSchema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}
    },
    {
        name: 'run_project',
        description: 'Click the green flag. Optionally wait (up to 10000 ms) and return a screenshot of the stage to check the result.',
        inputSchema: {type: 'object', properties: {screenshotAfterMs: {type: 'number'}}}
    },
    {
        name: 'stop_project',
        description: 'Click the stop sign.',
        inputSchema: {type: 'object', properties: {}}
    },
    {
        name: 'screenshot',
        description: 'Screenshot of the stage as it looks right now.',
        inputSchema: {type: 'object', properties: {}}
    },
    {
        name: 'select_target',
        description: 'Show a sprite (or the stage) in the editor so the user sees its scripts.',
        inputSchema: {type: 'object', properties: {target: TARGET}, required: ['target']}
    }
];

const INSTRUCTIONS = `This server controls the KbauBlocks editor (a Scratch 3 compatible editor) open in the user's browser or desktop app.
Start with get_project. Build with create_sprite / add_costume (SVG art) / create_variable / add_script, then check with run_project (screenshotAfterMs) or screenshot.
Scripts use standard Scratch 3 opcodes in project.json format. The user sees every change live in the editor and can undo with File > restore or by deleting blocks.`;

const toContent = result => {
    if (result && typeof result.image === 'string' && result.image.startsWith('data:image/')) {
        const [, mime, data] = result.image.match(/^data:(image\/[\w+.-]+);base64,(.*)$/) || [];
        const rest = {...result};
        delete rest.image;
        const content = [];
        if (data) content.push({type: 'image', data, mimeType: mime});
        content.push({type: 'text', text: JSON.stringify(rest)});
        return content;
    }
    return [{type: 'text', text: JSON.stringify(result, null, 1)}];
};

// ------------------------------------------------------------------ MCP over stdio (JSON-RPC 2.0, one message per line)

const write = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => write({jsonrpc: '2.0', id, result});
const replyError = (id, code, message) => write({jsonrpc: '2.0', id, error: {code, message}});

const onRequest = async msg => {
    const {id, method, params} = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
    case 'initialize':
        reply(id, {
            protocolVersion: (params && params.protocolVersion) || '2025-06-18',
            capabilities: {tools: {}},
            serverInfo: {name: 'kbaublocks', version: VERSION},
            instructions: INSTRUCTIONS
        });
        return;
    case 'ping':
        if (isRequest) reply(id, {});
        return;
    case 'tools/list':
        reply(id, {tools: TOOLS});
        return;
    case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) {
            replyError(id, -32602, `Unknown tool: ${name}`);
            return;
        }
        try {
            const result = await callEditor(name, (params && params.arguments) || {});
            reply(id, {content: toContent(result)});
        } catch (e) {
            reply(id, {content: [{type: 'text', text: String(e.message || e)}], isError: true});
        }
        return;
    }
    default:
        if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
    }
};

const rl = readline.createInterface({input: process.stdin});
rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch (e) {
        replyError(null, -32700, 'Parse error');
        return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) onRequest(m);
});
rl.on('close', () => process.exit(0));
