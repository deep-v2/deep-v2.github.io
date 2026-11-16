#!/usr/bin/env node
// KbauBlocks server for Node (self-hosting): API + cloud variables + optional static website/editor hosting.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createApi} from './core/api.js';
import {encodeVars, handleCloudFrame, parseHandshake} from './core/cloud.js';
import {openDatabase} from './node/db.js';
import {createBlobStore} from './node/blobs.js';
import {acceptUpgrade} from './node/websocket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(env.KBAU_DATA_DIR || path.join(here, '..', 'data'));
const SITE_DIR = path.resolve(env.KBAU_SITE_DIR || path.join(here, '..', '..'));
const API_PREFIX = env.KBAU_API_PREFIX || '/kbau-api';
const SERVE_SITE = env.KBAU_SERVE_SITE !== '0';
const TRUST_PROXY = env.KBAU_TRUST_PROXY === '1';

const db = openDatabase(DATA_DIR, path.join(here, '..', 'migrations'));
const api = createApi({
    db,
    blobs: createBlobStore(DATA_DIR),
    apiPrefix: API_PREFIX,
    admins: (env.KBAU_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean),
    firstUserIsAdmin: env.KBAU_FIRST_USER_ADMIN !== '0'
});

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8', '.sb3': 'application/x.scratch.sb3', '.map': 'application/json', '.hex': 'text/plain'
};
const BLOCKED = /^\/(server|data)(\/|$)|\/\./;

const serveStatic = (req, res, pathname) => {
    if (pathname === '/config.json') {
        res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        return res.end(JSON.stringify({apiBase: API_PREFIX}));
    }
    const rel = decodeURIComponent(pathname);
    if (BLOCKED.test(rel)) {
        res.writeHead(404);
        return res.end('Not found');
    }
    let file = path.join(SITE_DIR, rel);
    if (!file.startsWith(SITE_DIR)) {
        res.writeHead(403);
        return res.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        return res.end('Not found');
    }
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
};

const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for'] ?
    String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || '');

const handleApi = async (req, res) => {
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]])),
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined
    });
    const response = await api.handle(request, {ip: clientIp(req)});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(response.body).pipe(res);
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        handleApi(req, res).catch(e => {
            console.error(e);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        });
        return;
    }
    if (SERVE_SITE && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(req, res, url.pathname);
    res.writeHead(404);
    res.end();
});

// ---------- cloud variables: WS <prefix>/cloud/<projectId> (or <prefix>/cloud with the id in the handshake) ----------
const rooms = new Map();
const storeFor = projectId => ({
    count: async () => (await db.get('SELECT COUNT(*) AS n FROM cloud_variables WHERE project_id = ?', projectId)).n,
    has: async name => !!(await db.get('SELECT 1 AS x FROM cloud_variables WHERE project_id = ? AND name = ?', projectId, name)),
    set: (name, value) => db.run(`INSERT INTO cloud_variables (project_id, name, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, projectId, name, value, Date.now()),
    remove: name => db.run('DELETE FROM cloud_variables WHERE project_id = ? AND name = ?', projectId, name),
    rename: (from, to) => db.run('UPDATE OR REPLACE cloud_variables SET name = ? WHERE project_id = ? AND name = ?', to, projectId, from)
});
server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const m = new RegExp(`^${API_PREFIX}/cloud(?:/(\\d+))?/?$`).exec(url.pathname);
    if (!m) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
    }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    const pathId = m[1] || null;
    let projectId = null;
    let queue = Promise.resolve();
    const bucket = {tokens: 20, last: Date.now()};
    const join = async raw => {
        const id = parseHandshake(raw);
        if (!id || (pathId && id !== pathId) || !(await api.cloudProjectAllowed(id))) return conn.close(4002);
        projectId = Number(id);
        if (!rooms.has(projectId)) rooms.set(projectId, new Set());
        rooms.get(projectId).add(conn);
        const vars = await db.all('SELECT name, value FROM cloud_variables WHERE project_id = ?', projectId);
        if (vars.length) conn.send(encodeVars(vars));
    };
    conn.on('message', raw => {
        queue = queue.then(async () => {
            if (projectId === null) return join(raw);
            const result = await handleCloudFrame(raw, storeFor(projectId), msg => {
                const text = `${JSON.stringify(msg)}\n`;
                for (const c of rooms.get(projectId) || []) if (c !== conn) c.send(text);
            }, bucket);
            if (result === 'close') conn.close(4000);
        }).catch(e => console.error(e));
    });
    conn.on('close', () => {
        const room = rooms.get(projectId);
        if (!room) return;
        room.delete(conn);
        if (!room.size) rooms.delete(projectId);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`KbauBlocks server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  API: ${API_PREFIX}  data: ${DATA_DIR}${SERVE_SITE ? `  site: ${SITE_DIR}` : ''}`);
});
const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
