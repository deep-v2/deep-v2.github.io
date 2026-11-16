// KbauBlocks community API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {transaction} from './db.js';
import {
    SESSION_TTL_MS, USERNAME_RE, hashPassword, hashToken, newToken, validatePassword, verifyPassword
} from './auth.js';
import {acceptUpgrade} from './websocket.js';

export class HttpError extends Error {
    constructor (status, message) {
        super(message);
        this.status = status;
    }
}

const now = () => Date.now();
const MAX_SB3 = 50 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const PAGE_SIZE = 24;

const clampText = (value, max, field) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
    if (value.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
    return value;
};

const isZip = buf => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
const imageType = buf => {
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    return null;
};
const likeEscape = s => s.replace(/[\\%_]/g, c => `\\${c}`);

class RateLimiter {
    constructor () {
        this.buckets = new Map();
        setInterval(() => {
            const t = now();
            for (const [k, b] of this.buckets) if (t - b.updated > 3600_000) this.buckets.delete(k);
        }, 600_000).unref();
    }
    // Allows `limit` events per `windowMs`, refilling continuously.
    check (key, limit, windowMs) {
        const t = now();
        let b = this.buckets.get(key);
        if (!b) {
            b = {tokens: limit, updated: t};
            this.buckets.set(key, b);
        }
        b.tokens = Math.min(limit, b.tokens + ((t - b.updated) / windowMs) * limit);
        b.updated = t;
        if (b.tokens < 1) throw new HttpError(429, 'Too many requests, slow down.');
        b.tokens -= 1;
    }
}

export const createApp = ({db, dataDir, apiPrefix = '/kbau-api', admins = [], firstUserIsAdmin = true}) => {
    const projectsDir = path.join(dataDir, 'projects');
    const thumbsDir = path.join(dataDir, 'thumbnails');
    const avatarsDir = path.join(dataDir, 'avatars');
    for (const d of [projectsDir, thumbsDir, avatarsDir]) fs.mkdirSync(d, {recursive: true});
    const limiter = new RateLimiter();
    const adminSet = new Set(admins.map(a => a.toLowerCase()));

    const q = sql => db.prepare(sql);

    // ---------- serializers ----------
    const userOut = u => u && ({
        id: u.id,
        username: u.username,
        displayName: u.display_name || u.username,
        bio: u.bio,
        workingOn: u.working_on,
        profileColor: u.profile_color,
        avatarUrl: u.has_avatar ? `/users/${encodeURIComponent(u.username)}/avatar?v=${u.has_avatar}` : null,
        role: u.role,
        banned: !!u.banned,
        createdAt: u.created_at
    });
    const userById = id => q('SELECT * FROM users WHERE id = ?').get(id);

    const projectOut = (p, viewer) => {
        if (!p) return null;
        const owner = userById(p.owner_id);
        let remixOf = null;
        if (p.remix_of) {
            const parent = q('SELECT id, title, owner_id, shared, hidden, deleted FROM projects WHERE id = ?').get(p.remix_of);
            if (parent) {
                const visible = parent.shared && !parent.hidden && !parent.deleted;
                remixOf = {
                    id: parent.id,
                    title: visible ? parent.title : '(unavailable project)',
                    owner: visible ? userById(parent.owner_id).username : null
                };
            }
        }
        const out = {
            id: String(p.id),
            title: p.title,
            description: p.description,
            instructions: p.instructions,
            shared: !!p.shared,
            hidden: !!p.hidden,
            owner: userOut(owner),
            remixOf,
            version: p.current_version,
            thumbnailUrl: p.has_thumbnail ? `/projects/${p.id}/thumbnail?v=${p.current_version}` : null,
            sb3Url: `/projects/${p.id}/sb3?v=${p.current_version}`,
            stats: {
                views: p.view_count,
                loves: p.love_count,
                favorites: p.favorite_count,
                remixes: p.remix_count,
                comments: p.comment_count
            },
            createdAt: p.created_at,
            updatedAt: p.updated_at,
            sharedAt: p.shared_at
        };
        if (viewer) {
            out.loved = !!q('SELECT 1 FROM loves WHERE user_id = ? AND project_id = ?').get(viewer.id, p.id);
            out.favorited = !!q('SELECT 1 FROM favorites WHERE user_id = ? AND project_id = ?').get(viewer.id, p.id);
            out.canEdit = viewer.id === p.owner_id;
        }
        return out;
    };
    const commentOut = c => {
        const author = userById(c.author_id);
        return {
            id: c.id,
            projectId: String(c.project_id),
            parentId: c.parent_id,
            content: c.hidden ? '' : c.content,
            hidden: !!c.hidden,
            author: {username: author.username, displayName: author.display_name || author.username, avatarUrl: userOut(author).avatarUrl},
            createdAt: c.created_at
        };
    };

    // ---------- helpers ----------
    const isMod = u => u && (u.role === 'admin' || u.role === 'moderator');
    const requireUser = ctx => {
        if (!ctx.user) throw new HttpError(401, 'You need to sign in.');
        if (ctx.user.banned) throw new HttpError(403, 'Your account has been suspended.');
        return ctx.user;
    };
    const requireMod = ctx => {
        const u = requireUser(ctx);
        if (!isMod(u)) throw new HttpError(403, 'Moderators only.');
        return u;
    };
    const canView = (p, user) => p && !p.deleted && (
        (p.shared && !p.hidden) || (user && (user.id === p.owner_id || isMod(user)))
    );
    const getProject = (id, user) => {
        if (!/^\d+$/.test(String(id))) throw new HttpError(404, 'Project not found.');
        const p = q('SELECT * FROM projects WHERE id = ?').get(Number(id));
        if (!canView(p, user)) throw new HttpError(404, 'Project not found.');
        return p;
    };
    const getOwnProject = (id, user) => {
        const p = getProject(id, user);
        if (p.owner_id !== user.id) throw new HttpError(403, 'You do not own this project.');
        return p;
    };
    const getUserByName = username => {
        const u = q('SELECT * FROM users WHERE username = ?').get(String(username));
        if (!u) throw new HttpError(404, 'User not found.');
        return u;
    };
    const page = ctx => Math.max(0, Math.min(1000, parseInt(ctx.query.get('page') || '0', 10) || 0));
    const limit = ctx => Math.max(1, Math.min(60, parseInt(ctx.query.get('limit') || String(PAGE_SIZE), 10) || PAGE_SIZE));

    const issueSession = user => {
        const token = newToken();
        const t = now();
        q('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)')
            .run(hashToken(token), user.id, t, t, t + SESSION_TTL_MS);
        return token;
    };
    const ensureAdminRole = user => {
        if (adminSet.has(user.username.toLowerCase()) && user.role !== 'admin') {
            q("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
            user.role = 'admin';
        }
        return user;
    };

    const storeSb3 = (projectId, version, buf) => {
        const dir = path.join(projectsDir, String(projectId));
        fs.mkdirSync(dir, {recursive: true});
        const file = path.join(dir, `${version}.sb3`);
        fs.writeFileSync(`${file}.tmp`, buf);
        fs.renameSync(`${file}.tmp`, file);
        q('INSERT INTO project_versions (project_id, version, size, sha256, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(projectId, version, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), now());
    };
    const storeThumb = (projectId, buf) => {
        fs.writeFileSync(path.join(thumbsDir, `${projectId}`), buf);
    };

    const readUploads = async ctx => {
        const form = await ctx.form();
        const file = async (name, max) => {
            const f = form.get(name);
            if (!f || typeof f === 'string') return null;
            if (f.size > max) throw new HttpError(413, `${name} is too large.`);
            return Buffer.from(await f.arrayBuffer());
        };
        return {form, file};
    };

    // ---------- routes ----------
    const routes = [];
    const route = (method, pattern, handler) => {
        const keys = [];
        const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => {
            keys.push(k);
            return '([^/]+)';
        })}/?$`);
        routes.push({method, re, keys, handler});
    };

    route('GET', '/health', () => ({ok: true, name: 'KbauBlocks', version: 1, time: now()}));

    // Auth
    route('POST', '/auth/register', async ctx => {
        limiter.check(`register:${ctx.ip}`, 5, 3600_000);
        const {username, password, email} = await ctx.json();
        if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
            throw new HttpError(400, 'Usernames are 3-20 characters: letters, numbers, - and _.');
        }
        if (!validatePassword(password)) throw new HttpError(400, 'Passwords must be at least 8 characters.');
        clampText(email, 200, 'email');
        if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');
        const hash = await hashPassword(password);
        const user = transaction(db, () => {
            const isFirst = q('SELECT COUNT(*) AS n FROM users').get().n === 0;
            const role = (isFirst && firstUserIsAdmin) || adminSet.has(username.toLowerCase()) ? 'admin' : 'user';
            const r = q('INSERT INTO users (username, display_name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(username, username, email || null, hash, role, now());
            return userById(r.lastInsertRowid);
        });
        return {token: issueSession(user), user: userOut(user)};
    });
    route('POST', '/auth/login', async ctx => {
        limiter.check(`login:${ctx.ip}`, 10, 600_000);
        const {username, password} = await ctx.json();
        const user = q('SELECT * FROM users WHERE username = ?').get(String(username || ''));
        if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
            throw new HttpError(401, 'Incorrect username or password.');
        }
        if (user.banned) throw new HttpError(403, 'Your account has been suspended.');
        ensureAdminRole(user);
        return {token: issueSession(user), user: userOut(user)};
    });
    route('POST', '/auth/logout', ctx => {
        if (ctx.token) q('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(ctx.token));
        return {ok: true};
    });
    route('GET', '/auth/me', ctx => ({user: ctx.user ? userOut(ctx.user) : null}));

    // Users
    route('GET', '/users/:username', ctx => {
        const u = getUserByName(ctx.params.username);
        const counts = q(`SELECT
            (SELECT COUNT(*) FROM projects WHERE owner_id = ? AND shared = 1 AND hidden = 0 AND deleted = 0) AS shared,
            (SELECT COALESCE(SUM(love_count), 0) FROM projects WHERE owner_id = ? AND shared = 1 AND hidden = 0 AND deleted = 0) AS loves,
            (SELECT COALESCE(SUM(view_count), 0) FROM projects WHERE owner_id = ? AND shared = 1 AND hidden = 0 AND deleted = 0) AS views,
            (SELECT COUNT(*) FROM collections WHERE owner_id = ?) AS collections`).get(u.id, u.id, u.id, u.id);
        return {user: userOut(u), stats: counts};
    });
    route('GET', '/users/:username/avatar', ctx => {
        const u = getUserByName(ctx.params.username);
        const file = path.join(avatarsDir, String(u.id));
        if (!u.has_avatar || !fs.existsSync(file)) throw new HttpError(404, 'No avatar.');
        return ctx.sendFile(file, imageType(fs.readFileSync(file)) || 'application/octet-stream', 'public, max-age=86400');
    });
    route('GET', '/users/:username/projects', ctx => {
        const u = getUserByName(ctx.params.username);
        const own = ctx.user && ctx.user.id === u.id;
        const includeUnshared = own && ctx.query.get('all') === '1';
        const rows = q(`SELECT * FROM projects WHERE owner_id = ? AND deleted = 0
            ${includeUnshared ? '' : 'AND shared = 1 AND hidden = 0'}
            ORDER BY ${includeUnshared ? 'updated_at' : 'shared_at'} DESC LIMIT ? OFFSET ?`)
            .all(u.id, limit(ctx), page(ctx) * limit(ctx));
        return {projects: rows.map(p => projectOut(p))};
    });
    route('GET', '/users/:username/favorites', ctx => {
        const u = getUserByName(ctx.params.username);
        const rows = q(`SELECT p.* FROM favorites f JOIN projects p ON p.id = f.project_id
            WHERE f.user_id = ? AND p.shared = 1 AND p.hidden = 0 AND p.deleted = 0
            ORDER BY f.created_at DESC LIMIT ? OFFSET ?`).all(u.id, limit(ctx), page(ctx) * limit(ctx));
        return {projects: rows.map(p => projectOut(p))};
    });
    route('GET', '/users/:username/collections', ctx => {
        const u = getUserByName(ctx.params.username);
        const rows = q('SELECT * FROM collections WHERE owner_id = ? ORDER BY updated_at DESC').all(u.id);
        return {collections: rows.map(collectionOut)};
    });
    route('PATCH', '/users/me', async ctx => {
        const user = requireUser(ctx);
        const body = await ctx.json();
        const displayName = clampText(body.displayName, 40, 'displayName');
        const bio = clampText(body.bio, 1000, 'bio');
        const workingOn = clampText(body.workingOn, 1000, 'workingOn');
        const color = clampText(body.profileColor, 7, 'profileColor');
        if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'profileColor must look like #12abef');
        q(`UPDATE users SET
            display_name = COALESCE(?, display_name), bio = COALESCE(?, bio),
            working_on = COALESCE(?, working_on), profile_color = COALESCE(?, profile_color)
            WHERE id = ?`).run(displayName ?? null, bio ?? null, workingOn ?? null, color ?? null, user.id);
        return {user: userOut(userById(user.id))};
    });
    route('POST', '/users/me/avatar', async ctx => {
        const user = requireUser(ctx);
        limiter.check(`avatar:${user.id}`, 10, 3600_000);
        const {file} = await readUploads(ctx);
        const buf = await file('avatar', MAX_IMAGE);
        if (!buf || !imageType(buf)) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image.');
        fs.writeFileSync(path.join(avatarsDir, String(user.id)), buf);
        q('UPDATE users SET has_avatar = has_avatar + 1 WHERE id = ?').run(user.id);
        return {user: userOut(userById(user.id))};
    });
    route('POST', '/users/me/password', async ctx => {
        const user = requireUser(ctx);
        const {currentPassword, newPassword} = await ctx.json();
        if (!(await verifyPassword(String(currentPassword || ''), user.password_hash))) {
            throw new HttpError(401, 'Your current password is incorrect.');
        }
        if (!validatePassword(newPassword)) throw new HttpError(400, 'Passwords must be at least 8 characters.');
        q('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), user.id);
        // Sign out every other session.
        q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, hashToken(ctx.token));
        return {ok: true};
    });

    // Projects
    route('POST', '/projects', async ctx => {
        const user = requireUser(ctx);
        limiter.check(`create:${user.id}`, 30, 3600_000);
        const {form, file} = await readUploads(ctx);
        const sb3 = await file('project', MAX_SB3);
        if (!sb3 || !isZip(sb3)) throw new HttpError(400, 'Upload a valid .sb3 project.');
        const thumb = await file('thumbnail', MAX_IMAGE);
        const title = clampText(form.get('title') || 'Untitled', 100, 'title').trim() || 'Untitled';
        let remixOf = null;
        const remixId = form.get('remixOf');
        if (remixId) {
            const parent = getProject(remixId, user);
            if (parent.owner_id !== user.id) remixOf = parent.id;
        }
        const project = transaction(db, () => {
            const t = now();
            const r = q(`INSERT INTO projects (owner_id, title, remix_of, current_version, has_thumbnail, created_at, updated_at)
                VALUES (?, ?, ?, 1, ?, ?, ?)`).run(user.id, title, remixOf, thumb && imageType(thumb) ? 1 : 0, t, t);
            const id = Number(r.lastInsertRowid);
            storeSb3(id, 1, sb3);
            if (thumb && imageType(thumb)) storeThumb(id, thumb);
            if (remixOf) q('UPDATE projects SET remix_count = remix_count + 1 WHERE id = ?').run(remixOf);
            return q('SELECT * FROM projects WHERE id = ?').get(id);
        });
        ctx.status = 201;
        return {project: projectOut(project, user)};
    });
    route('PUT', '/projects/:id/content', async ctx => {
        const user = requireUser(ctx);
        limiter.check(`save:${user.id}`, 120, 3600_000);
        const p = getOwnProject(ctx.params.id, user);
        const {form, file} = await readUploads(ctx);
        const sb3 = await file('project', MAX_SB3);
        if (!sb3 || !isZip(sb3)) throw new HttpError(400, 'Upload a valid .sb3 project.');
        const thumb = await file('thumbnail', MAX_IMAGE);
        const title = clampText(form.get('title') || undefined, 100, 'title');
        const project = transaction(db, () => {
            const version = p.current_version + 1;
            storeSb3(p.id, version, sb3);
            const hasThumb = thumb && imageType(thumb);
            if (hasThumb) storeThumb(p.id, thumb);
            q(`UPDATE projects SET current_version = ?, updated_at = ?, title = COALESCE(?, title),
                has_thumbnail = MAX(has_thumbnail, ?) WHERE id = ?`)
                .run(version, now(), title ? title.trim() || null : null, hasThumb ? 1 : 0, p.id);
            return q('SELECT * FROM projects WHERE id = ?').get(p.id);
        });
        return {project: projectOut(project, user)};
    });
    route('GET', '/projects/:id', ctx => ({project: projectOut(getProject(ctx.params.id, ctx.user), ctx.user)}));
    route('PATCH', '/projects/:id', async ctx => {
        const user = requireUser(ctx);
        const p = getOwnProject(ctx.params.id, user);
        const body = await ctx.json();
        const title = clampText(body.title, 100, 'title');
        const description = clampText(body.description, 5000, 'description');
        const instructions = clampText(body.instructions, 5000, 'instructions');
        q(`UPDATE projects SET title = COALESCE(?, title), description = COALESCE(?, description),
            instructions = COALESCE(?, instructions), updated_at = ? WHERE id = ?`)
            .run(title !== undefined ? (title.trim() || 'Untitled') : null, description ?? null, instructions ?? null, now(), p.id);
        return {project: projectOut(q('SELECT * FROM projects WHERE id = ?').get(p.id), user)};
    });
    route('POST', '/projects/:id/share', ctx => {
        const user = requireUser(ctx);
        const p = getOwnProject(ctx.params.id, user);
        q('UPDATE projects SET shared = 1, shared_at = COALESCE(shared_at, ?) WHERE id = ?').run(now(), p.id);
        return {project: projectOut(q('SELECT * FROM projects WHERE id = ?').get(p.id), user)};
    });
    route('POST', '/projects/:id/unshare', ctx => {
        const user = requireUser(ctx);
        const p = getOwnProject(ctx.params.id, user);
        q('UPDATE projects SET shared = 0 WHERE id = ?').run(p.id);
        return {project: projectOut(q('SELECT * FROM projects WHERE id = ?').get(p.id), user)};
    });
    route('DELETE', '/projects/:id', ctx => {
        const user = requireUser(ctx);
        const p = getProject(ctx.params.id, user);
        if (p.owner_id !== user.id && !isMod(user)) throw new HttpError(403, 'You do not own this project.');
        q('UPDATE projects SET deleted = 1, shared = 0 WHERE id = ?').run(p.id);
        return {ok: true};
    });
    route('GET', '/projects/:id/sb3', ctx => {
        const p = getProject(ctx.params.id, ctx.user);
        let version = p.current_version;
        const requested = ctx.query.get('version');
        if (requested) {
            if (p.owner_id !== (ctx.user && ctx.user.id) && !isMod(ctx.user)) {
                throw new HttpError(403, 'Only the owner can download older versions.');
            }
            version = parseInt(requested, 10);
        }
        const file = path.join(projectsDir, String(p.id), `${version}.sb3`);
        if (!fs.existsSync(file)) throw new HttpError(404, 'Version not found.');
        return ctx.sendFile(file, 'application/x.scratch.sb3', 'no-cache');
    });
    route('GET', '/projects/:id/thumbnail', ctx => {
        const p = getProject(ctx.params.id, ctx.user);
        const file = path.join(thumbsDir, String(p.id));
        if (!p.has_thumbnail || !fs.existsSync(file)) throw new HttpError(404, 'No thumbnail.');
        return ctx.sendFile(file, imageType(fs.readFileSync(file)) || 'image/png', 'public, max-age=300');
    });
    route('POST', '/projects/:id/thumbnail', async ctx => {
        const user = requireUser(ctx);
        const p = getOwnProject(ctx.params.id, user);
        const {file} = await readUploads(ctx);
        const buf = await file('thumbnail', MAX_IMAGE);
        if (!buf || !imageType(buf)) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image.');
        storeThumb(p.id, buf);
        q('UPDATE projects SET has_thumbnail = 1 WHERE id = ?').run(p.id);
        return {project: projectOut(q('SELECT * FROM projects WHERE id = ?').get(p.id), user)};
    });
    route('GET', '/projects/:id/versions', ctx => {
        const user = requireUser(ctx);
        const p = getOwnProject(ctx.params.id, user);
        return {versions: q('SELECT version, size, sha256, created_at AS createdAt FROM project_versions WHERE project_id = ? ORDER BY version DESC').all(p.id)};
    });
    route('POST', '/projects/:id/versions/:version/restore', ctx => {
        const user = requireUser(ctx);
        const p = getOwnProject(ctx.params.id, user);
        const v = parseInt(ctx.params.version, 10);
        const file = path.join(projectsDir, String(p.id), `${v}.sb3`);
        if (!fs.existsSync(file)) throw new HttpError(404, 'Version not found.');
        const project = transaction(db, () => {
            const version = p.current_version + 1;
            storeSb3(p.id, version, fs.readFileSync(file));
            q('UPDATE projects SET current_version = ?, updated_at = ? WHERE id = ?').run(version, now(), p.id);
            return q('SELECT * FROM projects WHERE id = ?').get(p.id);
        });
        return {project: projectOut(project, user)};
    });
    route('GET', '/projects/:id/remixes', ctx => {
        const p = getProject(ctx.params.id, ctx.user);
        const rows = q(`SELECT * FROM projects WHERE remix_of = ? AND shared = 1 AND hidden = 0 AND deleted = 0
            ORDER BY shared_at DESC LIMIT ? OFFSET ?`).all(p.id, limit(ctx), page(ctx) * limit(ctx));
        return {projects: rows.map(r => projectOut(r))};
    });
    const toggle = (table, column) => (ctx, on) => {
        const user = requireUser(ctx);
        const p = getProject(ctx.params.id, user);
        transaction(db, () => {
            const exists = q(`SELECT 1 FROM ${table} WHERE user_id = ? AND project_id = ?`).get(user.id, p.id);
            if (on && !exists) {
                q(`INSERT INTO ${table} (user_id, project_id, created_at) VALUES (?, ?, ?)`).run(user.id, p.id, now());
                q(`UPDATE projects SET ${column} = ${column} + 1 WHERE id = ?`).run(p.id);
            } else if (!on && exists) {
                q(`DELETE FROM ${table} WHERE user_id = ? AND project_id = ?`).run(user.id, p.id);
                q(`UPDATE projects SET ${column} = MAX(0, ${column} - 1) WHERE id = ?`).run(p.id);
            }
        });
        return {project: projectOut(q('SELECT * FROM projects WHERE id = ?').get(p.id), user)};
    };
    const love = toggle('loves', 'love_count');
    const fav = toggle('favorites', 'favorite_count');
    route('POST', '/projects/:id/love', ctx => love(ctx, true));
    route('DELETE', '/projects/:id/love', ctx => love(ctx, false));
    route('POST', '/projects/:id/favorite', ctx => fav(ctx, true));
    route('DELETE', '/projects/:id/favorite', ctx => fav(ctx, false));
    route('POST', '/projects/:id/view', ctx => {
        const p = getProject(ctx.params.id, ctx.user);
        const viewerKey = ctx.user ? `u${ctx.user.id}` : `ip${crypto.createHash('sha256').update(ctx.ip).digest('hex').slice(0, 16)}`;
        const day = Math.floor(now() / 86400_000);
        const r = q('INSERT OR IGNORE INTO views (project_id, viewer_key, day) VALUES (?, ?, ?)').run(p.id, viewerKey, day);
        if (r.changes) q('UPDATE projects SET view_count = view_count + 1 WHERE id = ?').run(p.id);
        return {views: q('SELECT view_count FROM projects WHERE id = ?').get(p.id).view_count};
    });

    // Comments
    route('GET', '/projects/:id/comments', ctx => {
        const p = getProject(ctx.params.id, ctx.user);
        const top = q(`SELECT * FROM comments WHERE project_id = ? AND parent_id IS NULL
            ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(p.id, limit(ctx), page(ctx) * limit(ctx));
        return {
            comments: top.map(c => ({
                ...commentOut(c),
                replies: q('SELECT * FROM comments WHERE parent_id = ? ORDER BY created_at ASC').all(c.id).map(commentOut)
            }))
        };
    });
    route('POST', '/projects/:id/comments', async ctx => {
        const user = requireUser(ctx);
        limiter.check(`comment:${user.id}`, 10, 60_000);
        const p = getProject(ctx.params.id, user);
        if (!p.shared && p.owner_id !== user.id) throw new HttpError(403, 'Comments are closed.');
        const {content, parentId} = await ctx.json();
        const text = clampText(content, 500, 'content');
        if (!text || !text.trim()) throw new HttpError(400, 'Write something first.');
        let parent = null;
        if (parentId) {
            parent = q('SELECT * FROM comments WHERE id = ? AND project_id = ?').get(Number(parentId), p.id);
            if (!parent) throw new HttpError(404, 'Comment not found.');
            if (parent.parent_id) parent = q('SELECT * FROM comments WHERE id = ?').get(parent.parent_id);
        }
        const c = transaction(db, () => {
            const r = q('INSERT INTO comments (project_id, author_id, parent_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(p.id, user.id, parent ? parent.id : null, text.trim(), now());
            q('UPDATE projects SET comment_count = comment_count + 1 WHERE id = ?').run(p.id);
            return q('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid);
        });
        ctx.status = 201;
        return {comment: commentOut(c)};
    });
    route('DELETE', '/comments/:id', ctx => {
        const user = requireUser(ctx);
        const c = q('SELECT * FROM comments WHERE id = ?').get(Number(ctx.params.id));
        if (!c) throw new HttpError(404, 'Comment not found.');
        const p = q('SELECT owner_id FROM projects WHERE id = ?').get(c.project_id);
        if (c.author_id !== user.id && p.owner_id !== user.id && !isMod(user)) throw new HttpError(403, 'Not allowed.');
        transaction(db, () => {
            const replies = q('SELECT COUNT(*) AS n FROM comments WHERE parent_id = ?').get(c.id).n;
            q('DELETE FROM comments WHERE id = ?').run(c.id);
            q('UPDATE projects SET comment_count = MAX(0, comment_count - ?) WHERE id = ?').run(1 + replies, c.project_id);
        });
        return {ok: true};
    });

    // Discovery
    const SHARED = 'p.shared = 1 AND p.hidden = 0 AND p.deleted = 0';
    route('GET', '/explore', ctx => {
        const sort = ctx.query.get('sort') || 'trending';
        const lim = limit(ctx);
        const off = page(ctx) * lim;
        let rows;
        if (sort === 'recent') {
            rows = q(`SELECT p.* FROM projects p WHERE ${SHARED} ORDER BY p.shared_at DESC LIMIT ? OFFSET ?`).all(lim, off);
        } else if (sort === 'popular') {
            rows = q(`SELECT p.* FROM projects p WHERE ${SHARED}
                ORDER BY (p.love_count * 3 + p.favorite_count * 4 + p.remix_count * 5 + p.view_count) DESC, p.shared_at DESC
                LIMIT ? OFFSET ?`).all(lim, off);
        } else if (sort === 'trending') {
            // Activity in the last 7 days, with a small boost for newly shared projects.
            const weekAgo = now() - 7 * 86400_000;
            const dayWeekAgo = Math.floor(weekAgo / 86400_000);
            rows = q(`SELECT p.*, (
                    (SELECT COUNT(*) FROM loves l WHERE l.project_id = p.id AND l.created_at > ?) * 3 +
                    (SELECT COUNT(*) FROM favorites f WHERE f.project_id = p.id AND f.created_at > ?) * 4 +
                    (SELECT COUNT(*) FROM views v WHERE v.project_id = p.id AND v.day > ?) +
                    (SELECT COUNT(*) FROM projects r WHERE r.remix_of = p.id AND r.created_at > ?) * 5 +
                    (CASE WHEN p.shared_at > ? THEN 2 ELSE 0 END)
                ) AS score
                FROM projects p WHERE ${SHARED}
                ORDER BY score DESC, p.shared_at DESC LIMIT ? OFFSET ?`)
                .all(weekAgo, weekAgo, dayWeekAgo, weekAgo, weekAgo, lim, off);
        } else {
            throw new HttpError(400, 'sort must be trending, popular or recent');
        }
        return {sort, projects: rows.map(p => projectOut(p))};
    });
    route('GET', '/search', ctx => {
        const term = (ctx.query.get('q') || '').trim().slice(0, 100);
        if (!term) return {projects: [], users: []};
        const like = `%${likeEscape(term)}%`;
        const projects = q(`SELECT p.* FROM projects p JOIN users u ON u.id = p.owner_id WHERE ${SHARED}
            AND (p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
            ORDER BY (p.title LIKE ? ESCAPE '\\') DESC, (p.love_count + p.view_count) DESC LIMIT ? OFFSET ?`)
            .all(like, like, like, like, limit(ctx), page(ctx) * limit(ctx));
        const users = page(ctx) === 0 ? q(`SELECT * FROM users WHERE banned = 0 AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
            ORDER BY username LIMIT 12`).all(like, like) : [];
        return {projects: projects.map(p => projectOut(p)), users: users.map(userOut)};
    });
    route('GET', '/stats', () => q(`SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM projects p WHERE ${SHARED}) AS projects,
        (SELECT COUNT(*) FROM comments) AS comments`).get());

    // Collections
    function collectionOut (c) {
        const owner = userById(c.owner_id);
        const count = q(`SELECT COUNT(*) AS n FROM collection_projects cp JOIN projects p ON p.id = cp.project_id
            WHERE cp.collection_id = ? AND ${SHARED}`).get(c.id).n;
        const cover = q(`SELECT p.id, p.current_version FROM collection_projects cp JOIN projects p ON p.id = cp.project_id
            WHERE cp.collection_id = ? AND ${SHARED} AND p.has_thumbnail = 1 ORDER BY cp.created_at DESC LIMIT 1`).get(c.id);
        return {
            id: String(c.id),
            title: c.title,
            description: c.description,
            owner: {username: owner.username, displayName: owner.display_name || owner.username},
            projectCount: count,
            thumbnailUrl: cover ? `/projects/${cover.id}/thumbnail?v=${cover.current_version}` : null,
            createdAt: c.created_at,
            updatedAt: c.updated_at
        };
    }
    const getCollection = id => {
        const c = q('SELECT * FROM collections WHERE id = ?').get(Number(id));
        if (!c) throw new HttpError(404, 'Collection not found.');
        return c;
    };
    route('POST', '/collections', async ctx => {
        const user = requireUser(ctx);
        limiter.check(`collection:${user.id}`, 20, 3600_000);
        const body = await ctx.json();
        const title = clampText(body.title, 100, 'title');
        if (!title || !title.trim()) throw new HttpError(400, 'Give your collection a title.');
        const description = clampText(body.description, 2000, 'description') || '';
        const r = q('INSERT INTO collections (owner_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(user.id, title.trim(), description, now(), now());
        ctx.status = 201;
        return {collection: collectionOut(getCollection(r.lastInsertRowid))};
    });
    route('GET', '/collections/:id', ctx => {
        const c = getCollection(ctx.params.id);
        const rows = q(`SELECT p.* FROM collection_projects cp JOIN projects p ON p.id = cp.project_id
            WHERE cp.collection_id = ? AND ${SHARED} ORDER BY cp.created_at DESC`).all(c.id);
        return {collection: collectionOut(c), projects: rows.map(p => projectOut(p))};
    });
    route('PATCH', '/collections/:id', async ctx => {
        const user = requireUser(ctx);
        const c = getCollection(ctx.params.id);
        if (c.owner_id !== user.id) throw new HttpError(403, 'Not your collection.');
        const body = await ctx.json();
        const title = clampText(body.title, 100, 'title');
        const description = clampText(body.description, 2000, 'description');
        q('UPDATE collections SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?')
            .run(title && title.trim() ? title.trim() : null, description ?? null, now(), c.id);
        return {collection: collectionOut(getCollection(c.id))};
    });
    route('DELETE', '/collections/:id', ctx => {
        const user = requireUser(ctx);
        const c = getCollection(ctx.params.id);
        if (c.owner_id !== user.id && !isMod(user)) throw new HttpError(403, 'Not your collection.');
        q('DELETE FROM collections WHERE id = ?').run(c.id);
        return {ok: true};
    });
    route('POST', '/collections/:id/projects', async ctx => {
        const user = requireUser(ctx);
        const c = getCollection(ctx.params.id);
        if (c.owner_id !== user.id) throw new HttpError(403, 'Not your collection.');
        const {projectId} = await ctx.json();
        const p = getProject(projectId, user);
        if (!p.shared) throw new HttpError(400, 'Only shared projects can be added to collections.');
        q('INSERT OR IGNORE INTO collection_projects (collection_id, project_id, added_by, created_at) VALUES (?, ?, ?, ?)')
            .run(c.id, p.id, user.id, now());
        q('UPDATE collections SET updated_at = ? WHERE id = ?').run(now(), c.id);
        return {collection: collectionOut(getCollection(c.id))};
    });
    route('DELETE', '/collections/:id/projects/:projectId', ctx => {
        const user = requireUser(ctx);
        const c = getCollection(ctx.params.id);
        if (c.owner_id !== user.id) throw new HttpError(403, 'Not your collection.');
        q('DELETE FROM collection_projects WHERE collection_id = ? AND project_id = ?').run(c.id, Number(ctx.params.projectId));
        return {collection: collectionOut(getCollection(c.id))};
    });

    // Reports & moderation
    route('POST', '/reports', async ctx => {
        const user = requireUser(ctx);
        limiter.check(`report:${user.id}`, 20, 3600_000);
        const {targetType, targetId, reason} = await ctx.json();
        if (!['project', 'comment', 'user'].includes(targetType)) throw new HttpError(400, 'Unknown report type.');
        const text = clampText(reason, 1000, 'reason');
        if (!text || !text.trim()) throw new HttpError(400, 'Tell us what is wrong.');
        if (targetType === 'project') getProject(targetId, user);
        if (targetType === 'comment' && !q('SELECT 1 FROM comments WHERE id = ?').get(Number(targetId))) throw new HttpError(404, 'Comment not found.');
        if (targetType === 'user') getUserByName(targetId);
        q('INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(user.id, targetType, String(targetId), text.trim(), now());
        ctx.status = 201;
        return {ok: true};
    });
    route('GET', '/admin/reports', ctx => {
        requireMod(ctx);
        const status = ctx.query.get('status') || 'open';
        const rows = q('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
        return {
            reports: rows.map(r => {
                let target = null;
                if (r.target_type === 'project') {
                    const p = q('SELECT * FROM projects WHERE id = ?').get(Number(r.target_id));
                    target = p && {id: String(p.id), title: p.title, owner: userById(p.owner_id).username, hidden: !!p.hidden};
                } else if (r.target_type === 'comment') {
                    const c = q('SELECT * FROM comments WHERE id = ?').get(Number(r.target_id));
                    target = c && {...commentOut(c), content: c.content};
                } else {
                    const u = q('SELECT * FROM users WHERE username = ?').get(r.target_id);
                    target = u && userOut(u);
                }
                return {
                    id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, status: r.status,
                    reporter: userById(r.reporter_id).username, createdAt: r.created_at, resolutionNote: r.resolution_note, target
                };
            })
        };
    });
    route('POST', '/admin/reports/:id/resolve', async ctx => {
        const mod = requireMod(ctx);
        const r = q('SELECT * FROM reports WHERE id = ?').get(Number(ctx.params.id));
        if (!r) throw new HttpError(404, 'Report not found.');
        const {action, note} = await ctx.json();
        if (!['dismiss', 'hide', 'ban'].includes(action)) throw new HttpError(400, 'action must be dismiss, hide or ban');
        transaction(db, () => {
            if (action === 'hide') {
                if (r.target_type === 'project') q('UPDATE projects SET hidden = 1 WHERE id = ?').run(Number(r.target_id));
                else if (r.target_type === 'comment') q('UPDATE comments SET hidden = 1 WHERE id = ?').run(Number(r.target_id));
                else throw new HttpError(400, 'Users cannot be hidden; use ban.');
            }
            if (action === 'ban') {
                let userId;
                if (r.target_type === 'user') userId = (q('SELECT id FROM users WHERE username = ?').get(r.target_id) || {}).id;
                if (r.target_type === 'project') userId = (q('SELECT owner_id FROM projects WHERE id = ?').get(Number(r.target_id)) || {}).owner_id;
                if (r.target_type === 'comment') userId = (q('SELECT author_id FROM comments WHERE id = ?').get(Number(r.target_id)) || {}).author_id;
                if (userId) banUser(userId, mod);
            }
            q('UPDATE reports SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ?')
                .run(action === 'dismiss' ? 'dismissed' : 'resolved', mod.id, clampText(note, 1000, 'note') || '', now(), r.id);
        });
        return {ok: true};
    });
    const banUser = (userId, mod) => {
        const target = userById(userId);
        if (!target) throw new HttpError(404, 'User not found.');
        if (target.role === 'admin' || (target.role === 'moderator' && mod.role !== 'admin')) throw new HttpError(403, 'You cannot ban this user.');
        q('UPDATE users SET banned = 1 WHERE id = ?').run(userId);
        q('DELETE FROM sessions WHERE user_id = ?').run(userId);
    };
    route('POST', '/admin/projects/:id/hide', ctx => {
        requireMod(ctx);
        q('UPDATE projects SET hidden = 1 WHERE id = ?').run(Number(ctx.params.id));
        return {ok: true};
    });
    route('POST', '/admin/projects/:id/unhide', ctx => {
        requireMod(ctx);
        q('UPDATE projects SET hidden = 0 WHERE id = ?').run(Number(ctx.params.id));
        return {ok: true};
    });
    route('POST', '/admin/comments/:id/hide', ctx => {
        requireMod(ctx);
        q('UPDATE comments SET hidden = 1 WHERE id = ?').run(Number(ctx.params.id));
        return {ok: true};
    });
    route('POST', '/admin/users/:username/ban', ctx => {
        const mod = requireMod(ctx);
        banUser(getUserByName(ctx.params.username).id, mod);
        return {ok: true};
    });
    route('POST', '/admin/users/:username/unban', ctx => {
        requireMod(ctx);
        q('UPDATE users SET banned = 0 WHERE id = ?').run(getUserByName(ctx.params.username).id);
        return {ok: true};
    });
    route('POST', '/admin/users/:username/role', async ctx => {
        const u = requireUser(ctx);
        if (u.role !== 'admin') throw new HttpError(403, 'Admins only.');
        const {role} = await ctx.json();
        if (!['user', 'moderator', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role.');
        q('UPDATE users SET role = ? WHERE id = ?').run(role, getUserByName(ctx.params.username).id);
        return {ok: true};
    });

    // ---------- request handling ----------
    const authenticate = req => {
        const header = req.headers.authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(header);
        if (!m) return {token: null, user: null};
        const token = m[1].trim();
        const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
        if (!s || s.expires_at < now()) return {token: null, user: null};
        if (now() - s.last_used_at > 3600_000) {
            q('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').run(now(), now() + SESSION_TTL_MS, s.token_hash);
        }
        return {token, user: userById(s.user_id)};
    };

    const readBody = (req, max) => new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > max) {
                reject(new HttpError(413, 'Request too large.'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });

    const CORS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400'
    };

    const handle = async (req, res, pathname, query) => {
        const sub = pathname.slice(apiPrefix.length) || '/';
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS);
            return res.end();
        }
        const ip = (req.headers['x-forwarded-for'] && process.env.KBAU_TRUST_PROXY === '1') ?
            String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || '';
        let matched = null;
        let methodMismatch = false;
        for (const r of routes) {
            const m = r.re.exec(sub);
            if (!m) continue;
            if (r.method !== req.method && !(req.method === 'HEAD' && r.method === 'GET')) {
                methodMismatch = true;
                continue;
            }
            matched = {r, m};
            break;
        }
        const send = (status, body) => {
            res.writeHead(status, {...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
            res.end(JSON.stringify(body));
        };
        if (!matched) return send(methodMismatch ? 405 : 404, {error: methodMismatch ? 'Method not allowed.' : 'Not found.'});
        const params = {};
        matched.r.keys.forEach((k, i) => {
            params[k] = decodeURIComponent(matched.m[i + 1]);
        });
        const {token, user} = authenticate(req);
        let bodyBuf = null;
        const ctx = {
            req, res, params, query, ip, token, user,
            status: 200,
            sentFile: false,
            json: async () => {
                bodyBuf = bodyBuf || await readBody(req, 1024 * 1024);
                if (!bodyBuf.length) return {};
                try {
                    const v = JSON.parse(bodyBuf.toString('utf8'));
                    return v && typeof v === 'object' ? v : {};
                } catch (e) {
                    throw new HttpError(400, 'Invalid JSON.');
                }
            },
            form: async () => {
                const type = req.headers['content-type'] || '';
                if (!type.startsWith('multipart/form-data')) throw new HttpError(400, 'Expected multipart/form-data.');
                bodyBuf = bodyBuf || await readBody(req, MAX_SB3 + MAX_IMAGE + 1024 * 1024);
                try {
                    return await new Request('http://local/', {method: 'POST', headers: {'content-type': type}, body: bodyBuf}).formData();
                } catch (e) {
                    throw new HttpError(400, 'Malformed upload.');
                }
            },
            sendFile: (file, type, cache) => {
                const stat = fs.statSync(file);
                res.writeHead(200, {...CORS, 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': cache});
                if (req.method === 'HEAD') res.end();
                else fs.createReadStream(file).pipe(res);
                ctx.sentFile = true;
            }
        };
        try {
            const result = await matched.r.handler(ctx);
            if (!ctx.sentFile) send(ctx.status, result);
        } catch (e) {
            if (e instanceof HttpError) return send(e.status, {error: e.message});
            console.error(e);
            send(500, {error: 'Internal server error.'});
        }
    };

    // ---------- cloud variables (TurboWarp/Scratch cloud protocol) ----------
    const rooms = new Map(); // projectId -> Set<conn>
    const MAX_VARS = 40;
    const MAX_VALUE = 100000;
    const isCloudName = n => typeof n === 'string' && n.startsWith('☁ ') && n.length <= 1024;
    const broadcast = (projectId, except, message) => {
        const room = rooms.get(projectId);
        if (!room) return;
        const text = `${JSON.stringify(message)}\n`;
        for (const c of room) if (c !== except) c.send(text);
    };
    const handleUpgrade = (req, socket, pathname) => {
        if (pathname !== `${apiPrefix}/cloud`) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        const conn = acceptUpgrade(req, socket);
        if (!conn) return;
        let projectId = null;
        let tokens = 20;
        let last = now();
        conn.on('message', raw => {
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                // ~10 messages per second sustained.
                tokens = Math.min(20, tokens + (now() - last) / 100);
                last = now();
                if (tokens < 1) continue;
                tokens--;
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch (e) {
                    return conn.close(4000);
                }
                if (msg.method === 'handshake') {
                    if (projectId !== null) continue;
                    const id = String(msg.project_id || '');
                    if (!/^\d+$/.test(id)) return conn.close(4002);
                    const p = q('SELECT * FROM projects WHERE id = ?').get(Number(id));
                    if (!p || p.deleted || p.hidden) return conn.close(4004);
                    projectId = p.id;
                    if (!rooms.has(projectId)) rooms.set(projectId, new Set());
                    rooms.get(projectId).add(conn);
                    const vars = q('SELECT name, value FROM cloud_variables WHERE project_id = ?').all(projectId);
                    if (vars.length) conn.send(vars.map(v => JSON.stringify({method: 'set', name: v.name, value: v.value})).join('\n') + '\n');
                    continue;
                }
                if (projectId === null) return conn.close(4000);
                if (!isCloudName(msg.name)) continue;
                if (msg.method === 'set' || msg.method === 'create') {
                    const value = String(msg.value ?? '');
                    if (value.length > MAX_VALUE) continue;
                    const exists = q('SELECT 1 FROM cloud_variables WHERE project_id = ? AND name = ?').get(projectId, msg.name);
                    if (!exists && q('SELECT COUNT(*) AS n FROM cloud_variables WHERE project_id = ?').get(projectId).n >= MAX_VARS) continue;
                    q(`INSERT INTO cloud_variables (project_id, name, value, updated_at) VALUES (?, ?, ?, ?)
                        ON CONFLICT(project_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
                        .run(projectId, msg.name, value, now());
                    broadcast(projectId, conn, {method: 'set', name: msg.name, value});
                } else if (msg.method === 'delete') {
                    q('DELETE FROM cloud_variables WHERE project_id = ? AND name = ?').run(projectId, msg.name);
                } else if (msg.method === 'rename' && isCloudName(msg.new_name)) {
                    q('UPDATE OR REPLACE cloud_variables SET name = ? WHERE project_id = ? AND name = ?').run(msg.new_name, projectId, msg.name);
                }
            }
        });
        conn.on('close', () => {
            if (projectId === null) return;
            const room = rooms.get(projectId);
            if (room) {
                room.delete(conn);
                if (!room.size) rooms.delete(projectId);
            }
        });
    };

    return {handle, handleUpgrade, apiPrefix};
};

