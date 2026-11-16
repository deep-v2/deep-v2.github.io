// KbauBlocks API on Cloudflare Workers: D1 (database), R2 (project files), Durable Objects (cloud variables).
import {DurableObject} from 'cloudflare:workers';
import {CORS, createApi} from '../core/api.js';
import {encodeVars, handleCloudFrame, parseHandshake} from '../core/cloud.js';

const clean = params => params.map(p => (p === undefined ? null : p));

const d1Adapter = DB => ({
    get: (sql, ...params) => DB.prepare(sql).bind(...clean(params)).first(),
    all: async (sql, ...params) => (await DB.prepare(sql).bind(...clean(params)).all()).results,
    run: async (sql, ...params) => {
        const r = await DB.prepare(sql).bind(...clean(params)).run();
        return {changes: r.meta.changes, lastId: r.meta.last_row_id};
    }
});

const r2Adapter = BUCKET => ({
    put: (key, bytes, type) => BUCKET.put(key, bytes, {httpMetadata: {contentType: type}}),
    get: async key => {
        const obj = await BUCKET.get(key);
        if (!obj) return null;
        return {body: obj.body, size: obj.size, type: obj.httpMetadata && obj.httpMetadata.contentType};
    }
});

let cached = null;
const getApi = env => {
    if (!cached || cached.env !== env) {
        cached = {
            env,
            api: createApi({
                db: d1Adapter(env.DB),
                blobs: r2Adapter(env.BUCKET),
                apiPrefix: env.KBAU_API_PREFIX || '/kbau-api',
                admins: String(env.KBAU_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean),
                firstUserIsAdmin: String(env.KBAU_FIRST_USER_ADMIN ?? '1') !== '0'
            })
        };
    }
    return cached.api;
};

export default {
    async fetch (request, env) {
        const api = getApi(env);
        const url = new URL(request.url);
        const prefix = api.apiPrefix;
        const cloud = new RegExp(`^${prefix}/cloud/(\\d+)/?$`).exec(url.pathname);
        if (cloud) {
            if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
                return new Response('Expected a WebSocket upgrade', {status: 426, headers: CORS});
            }
            if (!(await api.cloudProjectAllowed(cloud[1]))) return new Response('Unknown project', {status: 404, headers: CORS});
            return env.CLOUD.get(env.CLOUD.idFromName(cloud[1])).fetch(request);
        }
        if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
            return api.handle(request, {ip: request.headers.get('cf-connecting-ip') || ''});
        }
        return new Response(JSON.stringify({name: 'KbauBlocks', api: prefix}), {
            status: 404, headers: {...CORS, 'Content-Type': 'application/json'}
        });
    }
};

/** One instance per project: holds the connected clients and that project's cloud variables. */
export class CloudRoom extends DurableObject {
    constructor (ctx, env) {
        super(ctx, env);
        ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS vars (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
        const sql = (q, ...b) => ctx.storage.sql.exec(q, ...b);
        this.store = {
            count: () => sql('SELECT COUNT(*) AS n FROM vars').one().n,
            has: name => sql('SELECT 1 AS x FROM vars WHERE name = ?', name).toArray().length > 0,
            set: (name, value) => {
                sql('INSERT INTO vars (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', name, value);
            },
            remove: name => {
                sql('DELETE FROM vars WHERE name = ?', name);
            },
            rename: (from, to) => {
                sql('UPDATE OR REPLACE vars SET name = ? WHERE name = ?', to, from);
            }
        };
    }

    fetch (request) {
        const projectId = new URL(request.url).pathname.split('/').filter(Boolean).pop();
        const [client, server] = Object.values(new WebSocketPair());
        // Hibernatable: the object can sleep between messages without dropping connections.
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({projectId, joined: false, tokens: 20, last: Date.now()});
        return new Response(null, {status: 101, webSocket: client});
    }

    async webSocketMessage (ws, message) {
        const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
        const state = ws.deserializeAttachment();
        if (!state.joined) {
            if (parseHandshake(text) !== state.projectId) {
                ws.close(4002, 'Bad handshake');
                return;
            }
            state.joined = true;
            ws.serializeAttachment(state);
            const vars = this.ctx.storage.sql.exec('SELECT name, value FROM vars').toArray();
            if (vars.length) ws.send(encodeVars(vars));
            return;
        }
        const result = await handleCloudFrame(text, this.store, msg => {
            const out = `${JSON.stringify(msg)}\n`;
            for (const other of this.ctx.getWebSockets()) {
                if (other === ws) continue;
                const s = other.deserializeAttachment();
                if (!s || !s.joined) continue;
                try {
                    other.send(out);
                } catch (e) {
                    // closed
                }
            }
        }, state);
        ws.serializeAttachment(state);
        if (result === 'close') ws.close(4000, 'Bad message');
    }

    webSocketClose (ws) {
        try {
            ws.close(1000, 'Closing');
        } catch (e) {
            // already closed
        }
    }
}
