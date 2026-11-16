#!/usr/bin/env node
// KbauBlocks server: community API + cloud variables + static website/editor hosting.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './db.js';
import {createApp} from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(env.KBAU_DATA_DIR || path.join(here, '..', 'data'));
const SITE_DIR = path.resolve(env.KBAU_SITE_DIR || path.join(here, '..', '..'));
const API_PREFIX = env.KBAU_API_PREFIX || '/kbau-api';
const SERVE_SITE = env.KBAU_SERVE_SITE !== '0';

const db = openDatabase(DATA_DIR);
const app = createApp({
    db,
    dataDir: DATA_DIR,
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
        // When the site is served by this server, point it at this API.
        res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        return res.end(JSON.stringify({apiBase: API_PREFIX}));
    }
    let rel = decodeURIComponent(pathname);
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
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-cache'});
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        app.handle(req, res, url.pathname, url.searchParams);
        return;
    }
    if (SERVE_SITE && (req.method === 'GET' || req.method === 'HEAD')) {
        serveStatic(req, res, url.pathname);
        return;
    }
    res.writeHead(404);
    res.end();
});
server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    app.handleUpgrade(req, socket, url.pathname);
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
