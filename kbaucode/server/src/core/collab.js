// Live collaboration over HTTP: collaborators, the shared asset store, session snapshots, and room access.
// The real-time part is collab-room.js (one room per project, over WebSocket).
import {hashToken} from './auth.js';
import {md5} from './md5.js';

export const MAX_COLLABORATORS = 20;
const MAX_ASSET = 16 * 1024 * 1024;
const MAX_SNAPSHOT = 24 * 1024 * 1024;
const ASSET_RE = /^([a-f0-9]{32})\.(svg|png|jpg|jpeg|gif|bmp|wav|mp3|ogg|json)$/;
const SESSION_RE = /^[a-f0-9]{8,32}$/;
const ASSET_TYPES = {
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
    wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', json: 'application/json'
};

const avatarUrlOf = u => (u.has_avatar > 0 ? `/users/${encodeURIComponent(u.username)}/avatar?v=${u.has_avatar}` : null);

/**
 * Check a WebSocket hello: a valid session token for someone who may edit the project.
 * @returns {Promise<object|null>} {id, username, displayName, avatarUrl} or null
 */
export const authorizeCollab = async (db, token, projectId) => {
    if (typeof token !== 'string' || !token || token.length > 200 || !/^\d+$/.test(String(projectId))) return null;
    const row = await db.get(`SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`, await hashToken(token));
    if (!row || row.s_expires < Date.now() || row.banned) return null;
    const p = await db.get('SELECT owner_id, deleted FROM projects WHERE id = ?', Number(projectId));
    if (!p || p.deleted) return null;
    if (p.owner_id !== row.id &&
        !(await db.get('SELECT 1 AS x FROM project_collaborators WHERE project_id = ? AND user_id = ?', Number(projectId), row.id))) {
        return null;
    }
    return {id: row.id, username: row.username, displayName: row.display_name || row.username, avatarUrl: avatarUrlOf(row)};
};

export const snapshotKey = (projectId, session, rev) => `collab/${projectId}/${session}/${rev}`;

export const registerCollab = ({
    route, db, blobs, HttpError, now, requireUser, getUserByName, userOut, rateLimit, getProject, isCollaborator,
    projectList, blockState, collabStatus, collabKick
}) => {
    const canEdit = async (p, user) => !!user && (p.owner_id === user.id || await isCollaborator(p.id, user.id));
    const getEditable = async (id, user) => {
        const p = await getProject(id, user);
        if (!(await canEdit(p, user))) throw new HttpError(403, 'Only the owner and invited collaborators can edit this project.');
        return p;
    };
    const readBody = async (ctx, max) => {
        const declared = Number(ctx.request.headers.get('content-length') || 0);
        if (declared > max) throw new HttpError(413, 'Too large.');
        const bytes = new Uint8Array(await ctx.request.arrayBuffer());
        if (bytes.length > max) throw new HttpError(413, 'Too large.');
        return bytes;
    };
    const collaboratorsOf = async p => {
        const rows = await db.all(`SELECT u.*, c.created_at AS c_created FROM project_collaborators c JOIN users u ON u.id = c.user_id
            WHERE c.project_id = ? ORDER BY c.created_at`, p.id);
        return rows.map(u => ({...userOut(u), addedAt: u.c_created}));
    };

    // Who works on a project (shown on the project page and in the editor).
    route('GET', '/projects/:id/collaborators', async ctx => {
        const p = await getProject(ctx.params.id, ctx.user);
        const owner = await db.get('SELECT * FROM users WHERE id = ?', p.owner_id);
        return {
            owner: userOut(owner),
            collaborators: await collaboratorsOf(p),
            canManage: !!ctx.user && ctx.user.id === p.owner_id,
            canEdit: await canEdit(p, ctx.user)
        };
    });
    route('POST', '/projects/:id/collaborators', async ctx => {
        const user = requireUser(ctx);
        await rateLimit(`collab-invite:${user.id}`, 60, 3600_000);
        const p = await getProject(ctx.params.id, user);
        if (p.owner_id !== user.id) throw new HttpError(403, 'Only the owner can invite collaborators.');
        const {username} = await ctx.json();
        const target = await getUserByName(String(username || '').trim());
        if (target.id === user.id) throw new HttpError(400, 'You already own this project.');
        if (target.banned) throw new HttpError(404, 'User not found.');
        const blocks = await blockState(user.id, target.id);
        if (blocks.byMe) throw new HttpError(403, 'You blocked this user.');
        if (blocks.byThem) throw new HttpError(403, 'You can\'t invite this user.');
        const {n} = await db.get('SELECT COUNT(*) AS n FROM project_collaborators WHERE project_id = ?', p.id);
        if (n >= MAX_COLLABORATORS) throw new HttpError(400, `A project can have up to ${MAX_COLLABORATORS} collaborators.`);
        await db.run(`INSERT INTO project_collaborators (project_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT DO NOTHING`, p.id, target.id, user.id, now());
        ctx.status = 201;
        return {collaborators: await collaboratorsOf(p)};
    });
    // The owner removes someone, or a collaborator leaves.
    route('DELETE', '/projects/:id/collaborators/:username', async ctx => {
        const user = requireUser(ctx);
        const p = await getProject(ctx.params.id, user);
        const target = await getUserByName(ctx.params.username);
        if (p.owner_id !== user.id && target.id !== user.id) throw new HttpError(403, 'Only the owner can remove collaborators.');
        await db.run('DELETE FROM project_collaborators WHERE project_id = ? AND user_id = ?', p.id, target.id);
        await collabKick(p.id, target.id).catch(() => {});
        return {collaborators: await collaboratorsOf(p)};
    });
    route('GET', '/users/me/collab-projects', async ctx => {
        const user = requireUser(ctx);
        return {projects: await projectList(`JOIN project_collaborators pc ON pc.project_id = p.id
            WHERE pc.user_id = ? AND p.deleted = 0 ORDER BY p.updated_at DESC LIMIT 100`, user.id)};
    });

    // Is anyone editing live right now? (The editor polls this to offer "Join".)
    route('GET', '/projects/:id/collab', async ctx => {
        const p = await getProject(ctx.params.id, ctx.user);
        const editable = await canEdit(p, ctx.user);
        const status = editable ? await collabStatus(p.id).catch(() => ({live: false, members: []})) : {live: false, members: []};
        return {canEdit: editable, ...status};
    });

    // Shared asset store, addressed by MD5 like Scratch's (so each costume/sound is stored once and cached forever).
    route('PUT', '/collab/assets/:asset', async ctx => {
        const user = requireUser(ctx);
        const m = ASSET_RE.exec(ctx.params.asset);
        if (!m) throw new HttpError(400, 'Bad asset name.');
        await getEditable(ctx.query.get('project'), user);
        await rateLimit(`collab-asset:${user.id}`, 3000, 3600_000);
        if (await db.get('SELECT 1 AS x FROM collab_assets WHERE md5ext = ?', ctx.params.asset)) return {ok: true, existed: true};
        const bytes = await readBody(ctx, MAX_ASSET);
        if (await md5(bytes) !== m[1]) throw new HttpError(400, 'Asset contents don\'t match its name.');
        await blobs.put(`assets/${ctx.params.asset}`, bytes, ASSET_TYPES[m[2]]);
        await db.run('INSERT INTO collab_assets (md5ext, size, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
            ctx.params.asset, bytes.length, now());
        ctx.status = 201;
        return {ok: true};
    });
    route('POST', '/collab/assets/missing', async ctx => {
        const user = requireUser(ctx);
        const {project, assets} = await ctx.json();
        await getEditable(project, user);
        if (!Array.isArray(assets) || assets.length > 5000) throw new HttpError(400, 'assets must be a list (up to 5000).');
        const wanted = [...new Set(assets.filter(a => typeof a === 'string' && ASSET_RE.test(a)))];
        const have = new Set();
        for (let i = 0; i < wanted.length; i += 90) {
            const chunk = wanted.slice(i, i + 90);
            const rows = await db.all(`SELECT md5ext FROM collab_assets WHERE md5ext IN (${chunk.map(() => '?').join(',')})`, ...chunk);
            for (const r of rows) have.add(r.md5ext);
        }
        return {missing: wanted.filter(a => !have.has(a))};
    });
    route('GET', '/collab/assets/:asset', async ctx => {
        const m = ASSET_RE.exec(ctx.params.asset);
        if (!m) throw new HttpError(404, 'Not found.');
        const obj = await blobs.get(`assets/${ctx.params.asset}`);
        if (!obj) throw new HttpError(404, 'Not found.');
        return new Response(obj.body, {headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': ASSET_TYPES[m[2]],
            'Content-Length': String(obj.size),
            'Cache-Control': 'public, max-age=31536000, immutable'
        }});
    });

    // Session snapshots (gzipped project.json + collab ids), written by an editor, read by people joining.
    const snapRoute = handler => async ctx => {
        const user = requireUser(ctx);
        const p = await getEditable(ctx.params.id, user);
        if (!SESSION_RE.test(ctx.params.session) || !/^\d{1,9}$/.test(ctx.params.rev)) throw new HttpError(400, 'Bad snapshot.');
        return handler(ctx, p, snapshotKey(p.id, ctx.params.session, Number(ctx.params.rev)), user);
    };
    route('PUT', '/projects/:id/collab/snapshot/:session/:rev', snapRoute(async (ctx, p, key, user) => {
        await rateLimit(`collab-snap:${user.id}`, 600, 3600_000);
        const bytes = await readBody(ctx, MAX_SNAPSHOT);
        const type = (ctx.request.headers.get('content-type') || '').includes('gzip') ? 'application/gzip' : 'application/json';
        await blobs.put(key, bytes, type);
        ctx.status = 201;
        return {ok: true};
    }));
    route('GET', '/projects/:id/collab/snapshot/:session/:rev', snapRoute(async (ctx, p, key) => {
        const obj = await blobs.get(key);
        if (!obj) throw new HttpError(404, 'Snapshot not found.');
        return new Response(obj.body, {headers: {
            'Access-Control-Allow-Origin': '*', 'Content-Type': obj.type || 'application/json',
            'Content-Length': String(obj.size), 'Cache-Control': 'no-store'
        }});
    }));

    return {canEdit, getEditable};
};
