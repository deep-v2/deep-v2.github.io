// KbauBlocks community API — platform-neutral core.
// Runs on Node (src/server.js) and Cloudflare Workers (src/worker/index.js).
//
// db:    { get(sql, ...params) -> row|null, all(sql, ...params) -> rows, run(sql, ...params) -> {changes, lastId} }
// blobs: { put(key, Uint8Array, contentType), get(key) -> {body, size, type}|null }
import {
    SESSION_TTL_MS, USERNAME_RE, hashPassword, hashToken, newToken, sha256Hex, validatePassword, verifyPassword
} from './auth.js';
import {BUILT_IN_WORD_COUNT, createFilter} from './filter.js';
import {registerMessaging} from './messages.js';

export class HttpError extends Error {
    constructor (status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const now = () => Date.now();
export const MAX_SB3 = 50 * 1024 * 1024;
export const MAX_IMAGE = 2 * 1024 * 1024;
// Profile pictures and banners can be animated GIFs, which are bigger.
export const MAX_PROFILE_IMAGE = 8 * 1024 * 1024;
const PAGE_SIZE = 24;
const SHARED = 'p.shared = 1 AND p.hidden = 0 AND p.deleted = 0';

const clampText = (value, max, field) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
    if (value.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
    return value;
};
const isZip = b => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const ascii = (b, s, e) => String.fromCharCode(...b.subarray(s, e));
export const imageType = b => {
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
    if (b.length > 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif';
    return null;
};
const likeEscape = s => s.replace(/[\\%_]/g, c => `\\${c}`);

export const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
};

// Owner and remix-parent columns joined onto every project query (avoids N+1 lookups on D1).
const PROJECT_SELECT = `SELECT p.*,
    u.username AS o_username, u.display_name AS o_display_name, u.profile_color AS o_profile_color,
    u.has_avatar AS o_has_avatar, u.role AS o_role, u.banned AS o_banned, u.created_at AS o_created_at,
    u.bio AS o_bio, u.working_on AS o_working_on, u.verified AS o_verified,
    rp.id AS r_id, rp.title AS r_title, ru.username AS r_owner,
    (rp.shared = 1 AND rp.hidden = 0 AND rp.deleted = 0) AS r_visible
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    LEFT JOIN projects rp ON rp.id = p.remix_of
    LEFT JOIN users ru ON ru.id = rp.owner_id`;

// New accounts get a white profile colour (matches the white accent). 0001_init.sql's column default
// is the old mint; 0002 moved accounts still on that default to white.
const DEFAULT_PROFILE_COLOR = '#ffffff';

export const createApi = ({db, blobs, apiPrefix = '/kbau-api', admins = [], firstUserIsAdmin = true}) => {
    const adminSet = new Set(admins.map(a => a.toLowerCase()));
    let dummyHash = null;

    // ---------- serializers ----------
    // The tick: set by an admin, or automatic for staff.
    const isVerified = u => !!u.verified || u.role === 'admin' || u.role === 'moderator';
    const userOut = u => u && ({
        id: u.id,
        username: u.username,
        displayName: u.display_name || u.username,
        bio: u.bio,
        workingOn: u.working_on,
        profileColor: u.profile_color,
        avatarUrl: u.has_avatar > 0 ? `/users/${encodeURIComponent(u.username)}/avatar?v=${u.has_avatar}` : null,
        bannerUrl: u.has_banner > 0 ? `/users/${encodeURIComponent(u.username)}/banner?v=${u.has_banner}` : null,
        role: u.role,
        verified: isVerified(u),
        banned: !!u.banned,
        createdAt: u.created_at
    });
    const ownerFromRow = p => userOut({
        id: p.owner_id, username: p.o_username, display_name: p.o_display_name, bio: p.o_bio, working_on: p.o_working_on,
        profile_color: p.o_profile_color, has_avatar: p.o_has_avatar, role: p.o_role, banned: p.o_banned, created_at: p.o_created_at,
        verified: p.o_verified
    });
    const projectOut = p => p && ({
        id: String(p.id),
        title: p.title,
        description: p.description,
        notes: p.notes,
        shared: !!p.shared,
        hidden: !!p.hidden,
        owner: ownerFromRow(p),
        remixOf: p.r_id ? {
            id: p.r_id,
            title: p.r_visible ? p.r_title : '(unavailable project)',
            owner: p.r_visible ? p.r_owner : null
        } : null,
        version: p.current_version,
        thumbnailUrl: p.has_thumbnail ? `/projects/${p.id}/thumbnail?v=${p.has_thumbnail}` : null,
        customThumbnail: !!p.custom_thumbnail,
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
    });
    const projectWithViewer = async (p, viewer) => {
        const out = projectOut(p);
        if (viewer) {
            const flags = await db.get(`SELECT
                EXISTS(SELECT 1 FROM loves WHERE user_id = ? AND project_id = ?) AS loved,
                EXISTS(SELECT 1 FROM favorites WHERE user_id = ? AND project_id = ?) AS favorited`,
            viewer.id, p.id, viewer.id, p.id);
            out.loved = !!flags.loved;
            out.favorited = !!flags.favorited;
            out.canEdit = viewer.id === p.owner_id;
        }
        return out;
    };
    const COMMENT_SELECT = `SELECT c.*, u.username AS a_username, u.display_name AS a_display_name, u.has_avatar AS a_has_avatar,
        u.profile_color AS a_profile_color, u.verified AS a_verified, u.role AS a_role
        FROM comments c JOIN users u ON u.id = c.author_id`;
    const commentOut = c => ({
        id: c.id,
        projectId: String(c.project_id),
        parentId: c.parent_id,
        content: c.hidden ? '' : c.content,
        pinned: !!c.pinned,
        hidden: !!c.hidden,
        score: c.score || 0,
        author: {
            username: c.a_username,
            displayName: c.a_display_name || c.a_username,
            profileColor: c.a_profile_color,
            verified: isVerified({verified: c.a_verified, role: c.a_role}),
            avatarUrl: c.a_has_avatar > 0 ? `/users/${encodeURIComponent(c.a_username)}/avatar?v=${c.a_has_avatar}` : null
        },
        createdAt: c.created_at
    });
    const COLLECTION_SELECT = `SELECT c.*, u.username AS o_username, u.display_name AS o_display_name,
        (SELECT COUNT(*) FROM collection_projects cp JOIN projects p ON p.id = cp.project_id
            WHERE cp.collection_id = c.id AND ${SHARED}) AS project_count,
        (SELECT p.id || ':' || p.has_thumbnail FROM collection_projects cp JOIN projects p ON p.id = cp.project_id
            WHERE cp.collection_id = c.id AND ${SHARED} AND p.has_thumbnail > 0 ORDER BY cp.created_at DESC LIMIT 1) AS cover
        FROM collections c JOIN users u ON u.id = c.owner_id`;
    const collectionOut = c => {
        const [coverId, coverV] = c.cover ? String(c.cover).split(':') : [];
        return {
            id: String(c.id),
            title: c.title,
            description: c.description,
            owner: {username: c.o_username, displayName: c.o_display_name || c.o_username},
            projectCount: c.project_count,
            thumbnailUrl: coverId ? `/projects/${coverId}/thumbnail?v=${coverV}` : null,
            createdAt: c.created_at,
            updatedAt: c.updated_at
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
    const loadProject = id => db.get(`${PROJECT_SELECT} WHERE p.id = ?`, Number(id));
    const getProject = async (id, user) => {
        if (!/^\d+$/.test(String(id))) throw new HttpError(404, 'Project not found.');
        const p = await loadProject(id);
        if (!canView(p, user)) throw new HttpError(404, 'Project not found.');
        return p;
    };
    const getOwnProject = async (id, user) => {
        const p = await getProject(id, user);
        if (p.owner_id !== user.id) throw new HttpError(403, 'You do not own this project.');
        return p;
    };
    const getUserByName = async username => {
        const u = await db.get('SELECT * FROM users WHERE username = ?', String(username));
        if (!u) throw new HttpError(404, 'User not found.');
        return u;
    };
    // ---------- moderation helpers: activity log, word filter, IP bans ----------
    /** Record what happened, by whom, to what (shown on the admin page). */
    const log = (ctx, action, {targetType = '', targetId = '', targetName = '', details = '', actor} = {}) => {
        const who = actor || (ctx && ctx.user);
        return db.run(`INSERT INTO activity_log (created_at, action, actor_id, actor_name, target_type, target_id, target_name, details, ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, now(), action, who ? who.id : null, who ? who.username : '',
        targetType, String(targetId), String(targetName), String(details).slice(0, 1000), (ctx && ctx.ip) || '');
    };

    const filter = createFilter();
    let wordsLoadedAt = 0;
    const loadCustomWords = async force => {
        if (!force && now() - wordsLoadedAt < 60_000) return;
        filter.setCustom((await db.all('SELECT word FROM blocked_words')).map(r => r.word));
        wordsLoadedAt = now();
    };
    /**
     * Reject text containing blocked words. fields: [[value, 'label', {username}], ...]; undefined values are skipped.
     */
    const checkText = async (ctx, fields) => {
        await loadCustomWords();
        for (const [value, label, opts] of fields) {
            if (value === undefined || value === null || value === '') continue;
            const hit = filter.check(value, opts);
            if (hit) {
                await log(ctx, 'filter.blocked', {targetType: 'text', targetName: label, details: `${label} contained “${hit}”`});
                throw new HttpError(400, `Your ${label} contains a word that isn't allowed on KbauBlocks. Please change it.`);
            }
        }
    };

    let ipBans = null;
    let ipBansLoadedAt = 0;
    const loadIpBans = async force => {
        if (!force && ipBans && now() - ipBansLoadedAt < 60_000) return ipBans;
        ipBans = (await db.all('SELECT pattern FROM ip_bans')).map(r => r.pattern.toLowerCase());
        ipBansLoadedAt = now();
        return ipBans;
    };
    const ipMatches = (ip, pattern) => (pattern.endsWith('*') ? ip.startsWith(pattern.slice(0, -1)) : ip === pattern);
    const isIpBanned = async ip => !!ip && (await loadIpBans()).some(p => ipMatches(ip.toLowerCase(), p));

    const page = ctx => Math.max(0, Math.min(1000, parseInt(ctx.query.get('page') || '0', 10) || 0));
    const limitN = ctx => Math.max(1, Math.min(60, parseInt(ctx.query.get('limit') || String(PAGE_SIZE), 10) || PAGE_SIZE));

    // Fixed-window rate limit stored in the database (works across Worker isolates).
    const rateLimit = async (key, max, windowMs) => {
        const window = Math.floor(now() / windowMs) * windowMs;
        const row = await db.get(`INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1)
            ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count`, key, window);
        if (Math.random() < 0.02) await db.run('DELETE FROM rate_limits WHERE window < ?', now() - 86400_000);
        if (row && row.count > max) throw new HttpError(429, 'Too many requests, slow down.');
    };

    const issueSession = async user => {
        const token = newToken();
        const t = now();
        await db.run('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)',
            await hashToken(token), user.id, t, t, t + SESSION_TTL_MS);
        return token;
    };

    const storeSb3 = async (projectId, version, bytes) => {
        await blobs.put(`projects/${projectId}/${version}.sb3`, bytes, 'application/x.scratch.sb3');
        await db.run('INSERT INTO project_versions (project_id, version, size, sha256, created_at) VALUES (?, ?, ?, ?, ?)',
            projectId, version, bytes.length, await sha256Hex(bytes), now());
    };
    const recount = (projectId, column, sql) => db.run(`UPDATE projects SET ${column} = (${sql}) WHERE id = ?`, projectId, projectId);
    const recountLoves = id => recount(id, 'love_count', 'SELECT COUNT(*) FROM loves WHERE project_id = ?');
    const recountFavorites = id => recount(id, 'favorite_count', 'SELECT COUNT(*) FROM favorites WHERE project_id = ?');
    const recountComments = id => recount(id, 'comment_count', 'SELECT COUNT(*) FROM comments WHERE project_id = ?');
    const recountRemixes = id => recount(id, 'remix_count', 'SELECT COUNT(*) FROM projects WHERE remix_of = ? AND deleted = 0');

    const readUploads = async ctx => {
        const form = await ctx.form();
        const file = async (name, max) => {
            const f = form.get(name);
            if (!f || typeof f === 'string') return null;
            if (f.size > max) throw new HttpError(413, `${name} is too large.`);
            return new Uint8Array(await f.arrayBuffer());
        };
        return {form, file};
    };
    const fileResponse = async (key, cache, fallbackType) => {
        const obj = await blobs.get(key);
        if (!obj) throw new HttpError(404, 'Not found.');
        return new Response(obj.body, {
            headers: {...CORS, 'Content-Type': obj.type || fallbackType, 'Content-Length': String(obj.size), 'Cache-Control': cache}
        });
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

    route('GET', '/health', () => ({ok: true, name: 'KbauBlocks', version: 2, time: now()}));

    // Auth
    route('POST', '/auth/register', async ctx => {
        await rateLimit(`register:${ctx.ip}`, 5, 3600_000);
        const {username, password, email} = await ctx.json();
        if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
            throw new HttpError(400, 'Usernames are 3-20 characters: letters, numbers, - and _.');
        }
        if (!validatePassword(password)) throw new HttpError(400, 'Passwords must be at least 8 characters.');
        clampText(email, 200, 'email');
        await checkText(ctx, [[username, 'username', {username: true}]]);
        if (await db.get('SELECT 1 AS x FROM users WHERE username = ?', username)) throw new HttpError(409, 'That username is taken.');
        const hash = await hashPassword(password);
        const isFirst = (await db.get('SELECT COUNT(*) AS n FROM users')).n === 0;
        const role = (isFirst && firstUserIsAdmin) || adminSet.has(username.toLowerCase()) ? 'admin' : 'user';
        let r;
        try {
            r = await db.run(`INSERT INTO users (username, display_name, email, password_hash, role, profile_color, created_at,
                signup_ip, last_ip, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            username, username, email || null, hash, role, DEFAULT_PROFILE_COLOR, now(), ctx.ip || '', ctx.ip || '', now());
        } catch (e) {
            if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'That username is taken.');
            throw e;
        }
        const user = await db.get('SELECT * FROM users WHERE id = ?', r.lastId);
        const sameIp = ctx.ip ? (await db.get('SELECT COUNT(*) AS n FROM users WHERE id != ? AND (signup_ip = ? OR last_ip = ?)',
            user.id, ctx.ip, ctx.ip)).n : 0;
        await log(ctx, 'account.create', {actor: user, targetType: 'user', targetId: user.id, targetName: user.username,
            details: sameIp ? `${sameIp} other account(s) used this IP` : ''});
        return {token: await issueSession(user), user: userOut(user)};
    });
    route('POST', '/auth/login', async ctx => {
        await rateLimit(`login:${ctx.ip}`, 10, 600_000);
        const {username, password} = await ctx.json();
        const user = await db.get('SELECT * FROM users WHERE username = ?', String(username || ''));
        if (!user) {
            // Do the same work as a real check so response timing doesn't reveal which usernames exist.
            dummyHash = dummyHash || await hashPassword('kbau-dummy-password');
            await verifyPassword(String(password || ''), dummyHash);
            throw new HttpError(401, 'Incorrect username or password.');
        }
        if (!(await verifyPassword(String(password || ''), user.password_hash))) {
            throw new HttpError(401, 'Incorrect username or password.');
        }
        if (user.banned) {
            throw new HttpError(403, `Your account has been suspended.${user.ban_reason ? ` Reason: ${user.ban_reason}` : ''}`);
        }
        if (adminSet.has(user.username.toLowerCase()) && user.role !== 'admin') {
            await db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
            user.role = 'admin';
        }
        await db.run('UPDATE users SET last_ip = ?, last_login_at = ? WHERE id = ?', ctx.ip || '', now(), user.id);
        await log(ctx, 'account.login', {actor: user, targetType: 'user', targetId: user.id, targetName: user.username});
        return {token: await issueSession(user), user: userOut(user)};
    });
    route('POST', '/auth/logout', async ctx => {
        if (ctx.token) await db.run('DELETE FROM sessions WHERE token_hash = ?', await hashToken(ctx.token));
        return {ok: true};
    });
    route('GET', '/auth/me', ctx => ({user: ctx.user ? userOut(ctx.user) : null}));

    // Users
    route('GET', '/users/:username', async ctx => {
        const u = await getUserByName(ctx.params.username);
        const stats = await db.get(`SELECT
            (SELECT COUNT(*) FROM projects p WHERE p.owner_id = ? AND ${SHARED}) AS shared,
            (SELECT COALESCE(SUM(love_count), 0) FROM projects p WHERE p.owner_id = ? AND ${SHARED}) AS loves,
            (SELECT COALESCE(SUM(view_count), 0) FROM projects p WHERE p.owner_id = ? AND ${SHARED}) AS views,
            (SELECT COUNT(*) FROM collections WHERE owner_id = ?) AS collections,
            (SELECT COUNT(*) FROM follows f JOIN users x ON x.id = f.follower_id WHERE f.followee_id = ? AND x.banned = 0) AS followers,
            (SELECT COUNT(*) FROM follows f JOIN users x ON x.id = f.followee_id WHERE f.follower_id = ? AND x.banned = 0) AS following,
            (SELECT COUNT(*) FROM follows a JOIN follows b ON b.follower_id = a.followee_id AND b.followee_id = a.follower_id
                JOIN users x ON x.id = a.followee_id WHERE a.follower_id = ? AND x.banned = 0) AS friends`,
        u.id, u.id, u.id, u.id, u.id, u.id, u.id);
        const out = {user: userOut(u), stats};
        if (ctx.user && ctx.user.id !== u.id) {
            const blocks = await messaging.blockState(ctx.user.id, u.id);
            out.relationship = {...await relationship(ctx.user.id, u.id), blocked: blocks.byMe,
                nickname: await messaging.nicknameOf(ctx.user.id, u.id)};
        }
        return out;
    });

    // Follows: following is one-way; two people who follow each other are friends.
    const relationship = async (viewerId, otherId) => {
        const r = await db.get(`SELECT
            EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?) AS following,
            EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?) AS followed_by`,
        viewerId, otherId, otherId, viewerId);
        return {following: !!r.following, followedBy: !!r.followed_by, friends: !!(r.following && r.followed_by)};
    };
    const setFollow = async (ctx, on) => {
        const me = requireUser(ctx);
        const target = await getUserByName(ctx.params.username);
        if (target.id === me.id) throw new HttpError(400, 'You cannot follow yourself.');
        if (on) {
            if (target.banned) throw new HttpError(404, 'User not found.');
            const blocks = await messaging.blockState(me.id, target.id);
            if (blocks.byMe) throw new HttpError(403, 'You blocked this user. Unblock them first.');
            if (blocks.byThem) throw new HttpError(403, 'You can\'t follow this user.');
            await rateLimit(`follow:${me.id}`, 200, 3600_000);
            await db.run('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
                me.id, target.id, now());
        } else {
            await db.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', me.id, target.id);
        }
        const {n} = await db.get(`SELECT COUNT(*) AS n FROM follows f JOIN users x ON x.id = f.follower_id
            WHERE f.followee_id = ? AND x.banned = 0`, target.id);
        return {relationship: await relationship(me.id, target.id), followers: n};
    };
    route('POST', '/users/:username/follow', ctx => setFollow(ctx, true));
    route('DELETE', '/users/:username/follow', ctx => setFollow(ctx, false));
    const userList = sql => async ctx => {
        const u = await getUserByName(ctx.params.username);
        const rows = await db.all(`${sql} AND x.banned = 0 ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
            u.id, limitN(ctx), page(ctx) * limitN(ctx));
        return {users: await messaging.withNicknames(ctx.user && ctx.user.id, rows.map(userOut))};
    };
    route('GET', '/users/:username/followers', userList(
        'SELECT x.*, f.created_at AS f_created FROM follows f JOIN users x ON x.id = f.follower_id WHERE f.followee_id = ?'));
    route('GET', '/users/:username/following', userList(
        'SELECT x.*, f.created_at AS f_created FROM follows f JOIN users x ON x.id = f.followee_id WHERE f.follower_id = ?'));
    // Friends: newest friendship first (whichever follow completed the pair).
    route('GET', '/users/:username/friends', userList(`SELECT x.* FROM follows a
        JOIN follows f ON f.follower_id = a.followee_id AND f.followee_id = a.follower_id
        JOIN users x ON x.id = a.followee_id WHERE a.follower_id = ?`));
    for (const kind of ['avatar', 'banner']) {
        route('GET', `/users/:username/${kind}`, async ctx => {
            const u = await getUserByName(ctx.params.username);
            if (!(u[`has_${kind}`] > 0)) throw new HttpError(404, `No ${kind}.`);
            return fileResponse(`${kind}s/${u.id}`, 'public, max-age=86400', 'image/png');
        });
    }
    route('GET', '/users/:username/projects', async ctx => {
        const u = await getUserByName(ctx.params.username);
        const all = ctx.user && ctx.user.id === u.id && ctx.query.get('all') === '1';
        const rows = await db.all(`${PROJECT_SELECT} WHERE p.owner_id = ? AND p.deleted = 0
            ${all ? '' : 'AND p.shared = 1 AND p.hidden = 0'}
            ORDER BY ${all ? 'p.updated_at' : 'p.shared_at'} DESC LIMIT ? OFFSET ?`, u.id, limitN(ctx), page(ctx) * limitN(ctx));
        return {projects: rows.map(projectOut)};
    });
    route('GET', '/users/:username/favorites', async ctx => {
        const u = await getUserByName(ctx.params.username);
        const rows = await db.all(`${PROJECT_SELECT} JOIN favorites f ON f.project_id = p.id
            WHERE f.user_id = ? AND ${SHARED} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`, u.id, limitN(ctx), page(ctx) * limitN(ctx));
        return {projects: rows.map(projectOut)};
    });
    route('GET', '/users/:username/collections', async ctx => {
        const u = await getUserByName(ctx.params.username);
        const rows = await db.all(`${COLLECTION_SELECT} WHERE c.owner_id = ? ORDER BY c.updated_at DESC`, u.id);
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
        await checkText(ctx, [[displayName, 'display name'], [bio, 'bio'], [workingOn, "“What I'm working on” text"]]);
        await db.run(`UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio),
            working_on = COALESCE(?, working_on), profile_color = COALESCE(?, profile_color) WHERE id = ?`,
        displayName ?? null, bio ?? null, workingOn ?? null, color ?? null, user.id);
        return {user: userOut(await db.get('SELECT * FROM users WHERE id = ?', user.id))};
    });
    // Profile picture and banner: PNG, JPEG, WebP or (animated) GIF. The site crops them before uploading.
    // DELETE removes one; the upload counter is kept (negated) so a later upload gets a fresh URL.
    for (const kind of ['avatar', 'banner']) {
        const col = `has_${kind}`;
        route('POST', `/users/me/${kind}`, async ctx => {
            const user = requireUser(ctx);
            await rateLimit(`${kind}:${user.id}`, 20, 3600_000);
            const {file} = await readUploads(ctx);
            const bytes = await file(kind, MAX_PROFILE_IMAGE);
            const type = bytes && imageType(bytes);
            if (!type) throw new HttpError(400, 'Upload a PNG, JPEG, WebP or GIF image (up to 8 MB).');
            await blobs.put(`${kind}s/${user.id}`, bytes, type);
            await db.run(`UPDATE users SET ${col} = ABS(${col}) + 1 WHERE id = ?`, user.id);
            return {user: userOut(await db.get('SELECT * FROM users WHERE id = ?', user.id))};
        });
        route('DELETE', `/users/me/${kind}`, async ctx => {
            const user = requireUser(ctx);
            await db.run(`UPDATE users SET ${col} = -ABS(${col}) WHERE id = ?`, user.id);
            return {user: userOut(await db.get('SELECT * FROM users WHERE id = ?', user.id))};
        });
    }
    route('POST', '/users/me/password', async ctx => {
        const user = requireUser(ctx);
        const {currentPassword, newPassword} = await ctx.json();
        if (!(await verifyPassword(String(currentPassword || ''), user.password_hash))) {
            throw new HttpError(401, 'Your current password is incorrect.');
        }
        if (!validatePassword(newPassword)) throw new HttpError(400, 'Passwords must be at least 8 characters.');
        await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(newPassword), user.id);
        await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', user.id, await hashToken(ctx.token));
        return {ok: true};
    });

    // Direct messages, requests, pins, blocks, nicknames (messages.js)
    const messaging = registerMessaging({
        route, db, HttpError, now, requireUser, getUserByName, userOut, rateLimit, checkText, clampText, relationship
    });

    // Projects
    route('POST', '/projects', async ctx => {
        const user = requireUser(ctx);
        await rateLimit(`create:${user.id}`, 30, 3600_000);
        const {form, file} = await readUploads(ctx);
        const sb3 = await file('project', MAX_SB3);
        if (!sb3 || !isZip(sb3)) throw new HttpError(400, 'Upload a valid .sb3 project.');
        const thumb = await file('thumbnail', MAX_IMAGE);
        const thumbType = thumb && imageType(thumb);
        const title = clampText(form.get('title') || 'Untitled', 100, 'title').trim() || 'Untitled';
        await checkText(ctx, [[title, 'project title']]);
        let remixOf = null;
        const remixId = form.get('remixOf');
        if (remixId) {
            const parent = await getProject(remixId, user);
            if (parent.owner_id !== user.id) remixOf = parent.id;
        }
        const t = now();
        const r = await db.run(`INSERT INTO projects (owner_id, title, remix_of, current_version, has_thumbnail, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?, ?)`, user.id, title, remixOf, thumbType ? 1 : 0, t, t);
        const id = Number(r.lastId);
        await storeSb3(id, 1, sb3);
        if (thumbType) await blobs.put(`thumbnails/${id}`, thumb, thumbType);
        if (remixOf) await recountRemixes(remixOf);
        ctx.status = 201;
        return {project: await projectWithViewer(await loadProject(id), user)};
    });
    route('PUT', '/projects/:id/content', async ctx => {
        const user = requireUser(ctx);
        await rateLimit(`save:${user.id}`, 120, 3600_000);
        const p = await getOwnProject(ctx.params.id, user);
        const {form, file} = await readUploads(ctx);
        const sb3 = await file('project', MAX_SB3);
        if (!sb3 || !isZip(sb3)) throw new HttpError(400, 'Upload a valid .sb3 project.');
        const thumb = await file('thumbnail', MAX_IMAGE);
        const thumbType = thumb && imageType(thumb);
        const title = clampText(form.get('title') || undefined, 100, 'title');
        await checkText(ctx, [[title, 'project title']]);
        // Claim the next version number atomically, then store the file. The editor's stage snapshot only
        // replaces the thumbnail if the owner hasn't uploaded their own.
        const claimed = await db.get(`UPDATE projects SET current_version = current_version + 1, updated_at = ?,
            title = COALESCE(?, title),
            has_thumbnail = CASE WHEN ? AND custom_thumbnail = 0 THEN has_thumbnail + 1 ELSE has_thumbnail END
            WHERE id = ? RETURNING current_version, custom_thumbnail`, now(), title ? title.trim() || null : null, thumbType ? 1 : 0, p.id);
        await storeSb3(p.id, claimed.current_version, sb3);
        if (thumbType && !claimed.custom_thumbnail) await blobs.put(`thumbnails/${p.id}`, thumb, thumbType);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    });
    route('GET', '/projects/:id', async ctx => ({project: await projectWithViewer(await getProject(ctx.params.id, ctx.user), ctx.user)}));
    route('PATCH', '/projects/:id', async ctx => {
        const user = requireUser(ctx);
        const p = await getOwnProject(ctx.params.id, user);
        const body = await ctx.json();
        const title = clampText(body.title, 100, 'title');
        const description = clampText(body.description, 5000, 'description');
        const notes = clampText(body.notes, 5000, 'notes');
        await checkText(ctx, [[title, 'project title'], [description, 'description'], [notes, 'notes']]);
        await db.run(`UPDATE projects SET title = COALESCE(?, title), description = COALESCE(?, description),
            notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`,
        title !== undefined ? (title.trim() || 'Untitled') : null, description ?? null, notes ?? null, now(), p.id);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    });
    route('POST', '/projects/:id/share', async ctx => {
        const user = requireUser(ctx);
        const p = await getOwnProject(ctx.params.id, user);
        await db.run('UPDATE projects SET shared = 1, shared_at = COALESCE(shared_at, ?) WHERE id = ?', now(), p.id);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    });
    route('POST', '/projects/:id/unshare', async ctx => {
        const user = requireUser(ctx);
        const p = await getOwnProject(ctx.params.id, user);
        await db.run('UPDATE projects SET shared = 0 WHERE id = ?', p.id);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    });
    route('DELETE', '/projects/:id', async ctx => {
        const user = requireUser(ctx);
        const p = await getProject(ctx.params.id, user);
        if (p.owner_id !== user.id && !isMod(user)) throw new HttpError(403, 'You do not own this project.');
        await db.run('UPDATE projects SET deleted = 1, shared = 0 WHERE id = ?', p.id);
        if (p.remix_of) await recountRemixes(p.remix_of);
        if (p.owner_id !== user.id) {
            await log(ctx, 'project.delete', {targetType: 'project', targetId: p.id, targetName: `“${p.title}” by ${p.o_username}`});
        }
        return {ok: true};
    });
    route('GET', '/projects/:id/sb3', async ctx => {
        const p = await getProject(ctx.params.id, ctx.user);
        let version = p.current_version;
        const requested = ctx.query.get('version');
        if (requested) {
            if (!ctx.user || (p.owner_id !== ctx.user.id && !isMod(ctx.user))) {
                throw new HttpError(403, 'Only the owner can download older versions.');
            }
            version = parseInt(requested, 10);
        }
        return fileResponse(`projects/${p.id}/${version}.sb3`, 'no-cache', 'application/x.scratch.sb3');
    });
    route('GET', '/projects/:id/thumbnail', async ctx => {
        const p = await getProject(ctx.params.id, ctx.user);
        if (!p.has_thumbnail) throw new HttpError(404, 'No thumbnail.');
        return fileResponse(`thumbnails/${p.id}`, 'public, max-age=300', 'image/png');
    });
    route('POST', '/projects/:id/thumbnail', async ctx => {
        const user = requireUser(ctx);
        const p = await getOwnProject(ctx.params.id, user);
        const {file} = await readUploads(ctx);
        const bytes = await file('thumbnail', MAX_IMAGE);
        const type = bytes && imageType(bytes);
        if (!type) throw new HttpError(400, 'Upload a PNG, JPEG, GIF or WebP image (up to 2 MB).');
        await blobs.put(`thumbnails/${p.id}`, bytes, type);
        // An uploaded thumbnail is "custom": later editor saves won't replace it with a stage snapshot.
        await db.run('UPDATE projects SET has_thumbnail = has_thumbnail + 1, custom_thumbnail = 1 WHERE id = ?', p.id);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    });
    // Go back to automatic thumbnails (the stage, taken on the next save from the editor).
    route('DELETE', '/projects/:id/thumbnail/custom', async ctx => {
        const user = requireUser(ctx);
        const p = await getOwnProject(ctx.params.id, user);
        await db.run('UPDATE projects SET custom_thumbnail = 0 WHERE id = ?', p.id);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    });
    route('GET', '/projects/:id/versions', async ctx => {
        const user = requireUser(ctx);
        const p = await getOwnProject(ctx.params.id, user);
        return {versions: await db.all('SELECT version, size, sha256, created_at AS createdAt FROM project_versions WHERE project_id = ? ORDER BY version DESC', p.id)};
    });
    route('POST', '/projects/:id/versions/:version/restore', async ctx => {
        const user = requireUser(ctx);
        const p = await getOwnProject(ctx.params.id, user);
        const v = parseInt(ctx.params.version, 10);
        const old = await blobs.get(`projects/${p.id}/${v}.sb3`);
        if (!old) throw new HttpError(404, 'Version not found.');
        const bytes = new Uint8Array(await new Response(old.body).arrayBuffer());
        const claimed = await db.get('UPDATE projects SET current_version = current_version + 1, updated_at = ? WHERE id = ? RETURNING current_version', now(), p.id);
        await storeSb3(p.id, claimed.current_version, bytes);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    });
    route('GET', '/projects/:id/remixes', async ctx => {
        const p = await getProject(ctx.params.id, ctx.user);
        const rows = await db.all(`${PROJECT_SELECT} WHERE p.remix_of = ? AND ${SHARED} ORDER BY p.shared_at DESC LIMIT ? OFFSET ?`,
            p.id, limitN(ctx), page(ctx) * limitN(ctx));
        return {projects: rows.map(projectOut)};
    });
    const toggle = (table, recountFn) => async (ctx, on) => {
        const user = requireUser(ctx);
        const p = await getProject(ctx.params.id, user);
        if (on) await db.run(`INSERT OR IGNORE INTO ${table} (user_id, project_id, created_at) VALUES (?, ?, ?)`, user.id, p.id, now());
        else await db.run(`DELETE FROM ${table} WHERE user_id = ? AND project_id = ?`, user.id, p.id);
        await recountFn(p.id);
        return {project: await projectWithViewer(await loadProject(p.id), user)};
    };
    const love = toggle('loves', recountLoves);
    const fav = toggle('favorites', recountFavorites);
    route('POST', '/projects/:id/love', ctx => love(ctx, true));
    route('DELETE', '/projects/:id/love', ctx => love(ctx, false));
    route('POST', '/projects/:id/favorite', ctx => fav(ctx, true));
    route('DELETE', '/projects/:id/favorite', ctx => fav(ctx, false));
    route('POST', '/projects/:id/view', async ctx => {
        const p = await getProject(ctx.params.id, ctx.user);
        const viewerKey = ctx.user ? `u${ctx.user.id}` : `ip${(await sha256Hex(ctx.ip)).slice(0, 16)}`;
        const r = await db.run('INSERT OR IGNORE INTO views (project_id, viewer_key, day) VALUES (?, ?, ?)', p.id, viewerKey, Math.floor(now() / 86400_000));
        if (r.changes) await db.run('UPDATE projects SET view_count = view_count + 1 WHERE id = ?', p.id);
        return {views: (await db.get('SELECT view_count FROM projects WHERE id = ?', p.id)).view_count};
    });

    // Comments
    route('GET', '/projects/:id/comments', async ctx => {
        const p = await getProject(ctx.params.id, ctx.user);
        // The pinned comment (if any) always comes first; then newest first, or highest score with sort=top.
        const order = ctx.query.get('sort') === 'top' ? 'c.score DESC, c.created_at DESC' : 'c.created_at DESC';
        const top = await db.all(`${COMMENT_SELECT} WHERE c.project_id = ? AND c.parent_id IS NULL
            ORDER BY c.pinned DESC, ${order} LIMIT ? OFFSET ?`, p.id, limitN(ctx), page(ctx) * limitN(ctx));
        let replies = [];
        if (top.length) {
            replies = await db.all(`${COMMENT_SELECT} WHERE c.parent_id IN (${top.map(() => '?').join(',')}) ORDER BY c.created_at ASC`,
                ...top.map(c => c.id));
        }
        // The signed-in viewer's own votes, so the arrows show what they picked.
        const myVotes = new Map();
        const ids = [...top, ...replies].map(c => c.id);
        if (ctx.user && ids.length) {
            const rows = await db.all(`SELECT comment_id, value FROM comment_votes WHERE user_id = ? AND comment_id IN (${ids.map(() => '?').join(',')})`,
                ctx.user.id, ...ids);
            for (const r of rows) myVotes.set(r.comment_id, r.value);
        }
        const out = c => ({...commentOut(c), ...(ctx.user ? {myVote: myVotes.get(c.id) || 0} : {})});
        const blocked = new Set(ctx.user ? (await db.all('SELECT blocked_id FROM blocks WHERE blocker_id = ?', ctx.user.id)).map(r => r.blocked_id) : []);
        const visible = c => !blocked.has(c.author_id);
        return {
            comments: top.filter(visible).map(c => ({...out(c), replies: replies.filter(r => r.parent_id === c.id && visible(r)).map(out)}))
        };
    });
    // Upvote (1), downvote (-1) or clear (0) a comment. One vote per person; you can't vote on your own.
    route('POST', '/comments/:id/vote', async ctx => {
        const user = requireUser(ctx);
        await rateLimit(`vote:${user.id}`, 300, 3600_000);
        const {value} = await ctx.json();
        if (![1, -1, 0].includes(value)) throw new HttpError(400, 'value must be 1, -1 or 0');
        const c = await db.get('SELECT * FROM comments WHERE id = ?', Number(ctx.params.id));
        if (!c) throw new HttpError(404, 'Comment not found.');
        await getProject(c.project_id, user);
        if (c.author_id === user.id) throw new HttpError(400, "You can't vote on your own comment.");
        if (c.hidden) throw new HttpError(400, 'This comment was removed.');
        if (value === 0) {
            await db.run('DELETE FROM comment_votes WHERE comment_id = ? AND user_id = ?', c.id, user.id);
        } else {
            await db.run(`INSERT INTO comment_votes (comment_id, user_id, value, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(comment_id, user_id) DO UPDATE SET value = excluded.value`, c.id, user.id, value, now());
        }
        await db.run('UPDATE comments SET score = (SELECT COALESCE(SUM(value), 0) FROM comment_votes WHERE comment_id = ?) WHERE id = ?', c.id, c.id);
        const {score} = await db.get('SELECT score FROM comments WHERE id = ?', c.id);
        return {score, myVote: value};
    });
    route('POST', '/projects/:id/comments', async ctx => {
        const user = requireUser(ctx);
        await rateLimit(`comment:${user.id}`, 10, 60_000);
        const p = await getProject(ctx.params.id, user);
        if (!p.shared && p.owner_id !== user.id) throw new HttpError(403, 'Comments are closed.');
        if (p.owner_id !== user.id && (await messaging.blockState(user.id, p.owner_id)).byThem) {
            throw new HttpError(403, 'You can\'t comment on this project.');
        }
        const {content, parentId} = await ctx.json();
        const text = clampText(content, 500, 'content');
        if (!text || !text.trim()) throw new HttpError(400, 'Write something first.');
        await checkText(ctx, [[text, 'comment']]);
        let parent = null;
        if (parentId) {
            parent = await db.get('SELECT * FROM comments WHERE id = ? AND project_id = ?', Number(parentId), p.id);
            if (!parent) throw new HttpError(404, 'Comment not found.');
            if (parent.parent_id) parent = await db.get('SELECT * FROM comments WHERE id = ?', parent.parent_id);
        }
        const r = await db.run('INSERT INTO comments (project_id, author_id, parent_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
            p.id, user.id, parent ? parent.id : null, text.trim(), now());
        await recountComments(p.id);
        ctx.status = 201;
        return {comment: commentOut(await db.get(`${COMMENT_SELECT} WHERE c.id = ?`, r.lastId))};
    });
    route('DELETE', '/comments/:id', async ctx => {
        const user = requireUser(ctx);
        const c = await db.get('SELECT c.*, p.owner_id FROM comments c JOIN projects p ON p.id = c.project_id WHERE c.id = ?', Number(ctx.params.id));
        if (!c) throw new HttpError(404, 'Comment not found.');
        if (c.author_id !== user.id && c.owner_id !== user.id && !isMod(user)) throw new HttpError(403, 'Not allowed.');
        await db.run('DELETE FROM comments WHERE parent_id = ?', c.id);
        await db.run('DELETE FROM comments WHERE id = ?', c.id);
        await recountComments(c.project_id);
        if (c.author_id !== user.id) {
            await log(ctx, 'comment.delete', {targetType: 'comment', targetId: c.id, targetName: `project ${c.project_id}`,
                details: String(c.content).slice(0, 200)});
        }
        return {ok: true};
    });
    // Pin one top-level comment to the top of a project (the project's owner, or a moderator).
    const setPinned = on => async ctx => {
        const user = requireUser(ctx);
        const c = await db.get('SELECT c.*, p.owner_id FROM comments c JOIN projects p ON p.id = c.project_id WHERE c.id = ?', Number(ctx.params.id));
        if (!c) throw new HttpError(404, 'Comment not found.');
        if (c.owner_id !== user.id && !isMod(user)) throw new HttpError(403, 'Only the project owner can pin comments.');
        if (on && c.parent_id) throw new HttpError(400, 'Only top-level comments can be pinned.');
        if (on && c.hidden) throw new HttpError(400, 'Removed comments cannot be pinned.');
        if (on) await db.run('UPDATE comments SET pinned = 0 WHERE project_id = ? AND pinned = 1', c.project_id);
        await db.run('UPDATE comments SET pinned = ? WHERE id = ?', on ? 1 : 0, c.id);
        return {ok: true, pinned: on};
    };
    route('POST', '/comments/:id/pin', setPinned(true));
    route('DELETE', '/comments/:id/pin', setPinned(false));

    // Discovery
    route('GET', '/explore', async ctx => {
        const sort = ctx.query.get('sort') || 'trending';
        const lim = limitN(ctx);
        const off = page(ctx) * lim;
        let rows;
        if (sort === 'recent') {
            rows = await db.all(`${PROJECT_SELECT} WHERE ${SHARED} ORDER BY p.shared_at DESC LIMIT ? OFFSET ?`, lim, off);
        } else if (sort === 'popular') {
            rows = await db.all(`${PROJECT_SELECT} WHERE ${SHARED}
                ORDER BY (p.love_count * 3 + p.favorite_count * 4 + p.remix_count * 5 + p.view_count) DESC, p.shared_at DESC
                LIMIT ? OFFSET ?`, lim, off);
        } else if (sort === 'trending') {
            const weekAgo = now() - 7 * 86400_000;
            rows = await db.all(`${PROJECT_SELECT} WHERE ${SHARED}
                ORDER BY (
                    (SELECT COUNT(*) FROM loves l WHERE l.project_id = p.id AND l.created_at > ?) * 3 +
                    (SELECT COUNT(*) FROM favorites f WHERE f.project_id = p.id AND f.created_at > ?) * 4 +
                    (SELECT COUNT(*) FROM views v WHERE v.project_id = p.id AND v.day > ?) +
                    (SELECT COUNT(*) FROM projects r WHERE r.remix_of = p.id AND r.created_at > ?) * 5 +
                    (CASE WHEN p.shared_at > ? THEN 2 ELSE 0 END)
                ) DESC, p.shared_at DESC LIMIT ? OFFSET ?`,
            weekAgo, weekAgo, Math.floor(weekAgo / 86400_000), weekAgo, weekAgo, lim, off);
        } else {
            throw new HttpError(400, 'sort must be trending, popular or recent');
        }
        return {sort, projects: rows.map(projectOut)};
    });
    route('GET', '/search', async ctx => {
        const term = (ctx.query.get('q') || '').trim().slice(0, 100);
        if (!term) return {projects: [], users: []};
        const like = `%${likeEscape(term)}%`;
        // type=users / type=projects: one kind only (paginated). No type: projects plus the first few users.
        const type = ctx.query.get('type');
        const findUsers = (limit, offset) => db.all(`SELECT * FROM users WHERE banned = 0
            AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
            ORDER BY (lower(username) = lower(?)) DESC, (username LIKE ? ESCAPE '\\') DESC, length(username), username
            LIMIT ? OFFSET ?`, like, like, term, `${likeEscape(term)}%`, limit, offset);
        if (type === 'users') {
            return {projects: [], users: (await findUsers(limitN(ctx), page(ctx) * limitN(ctx))).map(userOut)};
        }
        const projects = await db.all(`${PROJECT_SELECT} WHERE ${SHARED}
            AND (p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
            ORDER BY (p.title LIKE ? ESCAPE '\\') DESC, (p.love_count + p.view_count) DESC LIMIT ? OFFSET ?`,
        like, like, like, like, limitN(ctx), page(ctx) * limitN(ctx));
        const users = page(ctx) === 0 && type !== 'projects' ? await findUsers(12, 0) : [];
        return {projects: projects.map(projectOut), users: users.map(userOut)};
    });
    route('GET', '/stats', () => db.get(`SELECT (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM projects p WHERE ${SHARED}) AS projects, (SELECT COUNT(*) FROM comments) AS comments`));

    // Collections
    const getCollection = async id => {
        const c = await db.get(`${COLLECTION_SELECT} WHERE c.id = ?`, Number(id));
        if (!c) throw new HttpError(404, 'Collection not found.');
        return c;
    };
    route('POST', '/collections', async ctx => {
        const user = requireUser(ctx);
        await rateLimit(`collection:${user.id}`, 20, 3600_000);
        const body = await ctx.json();
        const title = clampText(body.title, 100, 'title');
        if (!title || !title.trim()) throw new HttpError(400, 'Give your collection a title.');
        const description = clampText(body.description, 2000, 'description') || '';
        await checkText(ctx, [[title, 'collection title'], [description, 'collection description']]);
        const r = await db.run('INSERT INTO collections (owner_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            user.id, title.trim(), description, now(), now());
        ctx.status = 201;
        return {collection: collectionOut(await getCollection(r.lastId))};
    });
    route('GET', '/collections/:id', async ctx => {
        const c = await getCollection(ctx.params.id);
        const rows = await db.all(`${PROJECT_SELECT} JOIN collection_projects cp ON cp.project_id = p.id
            WHERE cp.collection_id = ? AND ${SHARED} ORDER BY cp.created_at DESC`, c.id);
        return {collection: collectionOut(c), projects: rows.map(projectOut)};
    });
    route('PATCH', '/collections/:id', async ctx => {
        const user = requireUser(ctx);
        const c = await getCollection(ctx.params.id);
        if (c.owner_id !== user.id) throw new HttpError(403, 'Not your collection.');
        const body = await ctx.json();
        const title = clampText(body.title, 100, 'title');
        const description = clampText(body.description, 2000, 'description');
        await checkText(ctx, [[title, 'collection title'], [description, 'collection description']]);
        await db.run('UPDATE collections SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?',
            title && title.trim() ? title.trim() : null, description ?? null, now(), c.id);
        return {collection: collectionOut(await getCollection(c.id))};
    });
    route('DELETE', '/collections/:id', async ctx => {
        const user = requireUser(ctx);
        const c = await getCollection(ctx.params.id);
        if (c.owner_id !== user.id && !isMod(user)) throw new HttpError(403, 'Not your collection.');
        await db.run('DELETE FROM collection_projects WHERE collection_id = ?', c.id);
        await db.run('DELETE FROM collections WHERE id = ?', c.id);
        return {ok: true};
    });
    route('POST', '/collections/:id/projects', async ctx => {
        const user = requireUser(ctx);
        const c = await getCollection(ctx.params.id);
        if (c.owner_id !== user.id) throw new HttpError(403, 'Not your collection.');
        const {projectId} = await ctx.json();
        const p = await getProject(projectId, user);
        if (!p.shared) throw new HttpError(400, 'Only shared projects can be added to collections.');
        await db.run('INSERT OR IGNORE INTO collection_projects (collection_id, project_id, added_by, created_at) VALUES (?, ?, ?, ?)',
            c.id, p.id, user.id, now());
        await db.run('UPDATE collections SET updated_at = ? WHERE id = ?', now(), c.id);
        return {collection: collectionOut(await getCollection(c.id))};
    });
    route('DELETE', '/collections/:id/projects/:projectId', async ctx => {
        const user = requireUser(ctx);
        const c = await getCollection(ctx.params.id);
        if (c.owner_id !== user.id) throw new HttpError(403, 'Not your collection.');
        await db.run('DELETE FROM collection_projects WHERE collection_id = ? AND project_id = ?', c.id, Number(ctx.params.projectId));
        return {collection: collectionOut(await getCollection(c.id))};
    });

    // Reports & moderation
    route('POST', '/reports', async ctx => {
        const user = requireUser(ctx);
        await rateLimit(`report:${user.id}`, 20, 3600_000);
        const {targetType, targetId, reason} = await ctx.json();
        if (!['project', 'comment', 'user', 'message'].includes(targetType)) throw new HttpError(400, 'Unknown report type.');
        const text = clampText(reason, 1000, 'reason');
        if (!text || !text.trim()) throw new HttpError(400, 'Tell us what is wrong.');
        await checkText(ctx, [[text, 'report']]);
        if (targetType === 'project') await getProject(targetId, user);
        if (targetType === 'comment' && !(await db.get('SELECT 1 AS x FROM comments WHERE id = ?', Number(targetId)))) {
            throw new HttpError(404, 'Comment not found.');
        }
        if (targetType === 'user') await getUserByName(targetId);
        if (targetType === 'message' && !(await db.get(`SELECT 1 AS x FROM messages m
            JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
            WHERE m.id = ? AND m.sender_id != ?`, user.id, Number(targetId), user.id))) {
            throw new HttpError(404, 'Message not found.');
        }
        await db.run('INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
            user.id, targetType, String(targetId), text.trim(), now());
        ctx.status = 201;
        return {ok: true};
    });
    route('GET', '/admin/reports', async ctx => {
        requireMod(ctx);
        const status = ctx.query.get('status') || 'open';
        const rows = await db.all(`SELECT r.*, u.username AS reporter FROM reports r JOIN users u ON u.id = r.reporter_id
            WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`, status);
        const reports = [];
        for (const r of rows) {
            let target = null;
            if (r.target_type === 'project') {
                const p = await loadProject(r.target_id);
                target = p && {id: String(p.id), title: p.title, owner: p.o_username, hidden: !!p.hidden};
            } else if (r.target_type === 'comment') {
                const c = await db.get(`${COMMENT_SELECT} WHERE c.id = ?`, Number(r.target_id));
                target = c && {...commentOut(c), content: c.content};
            } else if (r.target_type === 'message') {
                // Moderators see only the reported message, not the rest of the chat.
                const m = await db.get(`SELECT m.*, u.username AS sender FROM messages m JOIN users u ON u.id = m.sender_id
                    WHERE m.id = ?`, Number(r.target_id));
                target = m && {id: m.id, sender: m.sender, content: m.body, deleted: !!m.deleted, hidden: !!m.hidden, createdAt: m.created_at};
            } else {
                target = userOut(await db.get('SELECT * FROM users WHERE username = ?', r.target_id));
            }
            reports.push({
                id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, status: r.status,
                reporter: r.reporter, createdAt: r.created_at, resolutionNote: r.resolution_note, target
            });
        }
        return {reports};
    });
    const isAdmin = u => u && u.role === 'admin';
    const requireAdmin = ctx => {
        const u = requireUser(ctx);
        if (!isAdmin(u)) throw new HttpError(403, 'Admins only.');
        return u;
    };
    const IP_PATTERN_RE = /^[0-9a-f.:]{1,45}\*?$/i;
    const addIpBan = async (ctx, pattern, reason) => {
        const p = String(pattern || '').trim().toLowerCase();
        if (!p || !IP_PATTERN_RE.test(p) || p === '*') {
            throw new HttpError(400, 'Use an IP address (203.0.113.7) or a prefix ending in * (203.0.113.*).');
        }
        if (ctx.ip && ipMatches(ctx.ip.toLowerCase(), p)) throw new HttpError(400, 'That would ban your own connection.');
        await db.run('INSERT INTO ip_bans (pattern, reason, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(pattern) DO NOTHING',
            p, clampText(reason, 500, 'reason') || '', ctx.user.username, now());
        await loadIpBans(true);
        await log(ctx, 'ip.ban', {targetType: 'ip', targetId: p, targetName: p, details: reason || ''});
        return p;
    };
    const banUser = async (ctx, userId, reason, {banIp = false} = {}) => {
        const mod = ctx.user;
        const target = await db.get('SELECT * FROM users WHERE id = ?', userId);
        if (!target) throw new HttpError(404, 'User not found.');
        if (target.id === mod.id) throw new HttpError(400, 'You cannot ban yourself.');
        if (target.role === 'admin' || (target.role === 'moderator' && mod.role !== 'admin')) throw new HttpError(403, 'You cannot ban this user.');
        const why = (clampText(reason, 500, 'reason') || '').trim();
        if (banIp && !isAdmin(mod)) throw new HttpError(403, 'Only admins can ban IP addresses.');
        await db.run('UPDATE users SET banned = 1, ban_reason = ?, banned_at = ?, banned_by = ? WHERE id = ?', why, now(), mod.username, userId);
        await db.run('DELETE FROM sessions WHERE user_id = ?', userId);
        await log(ctx, 'user.ban', {targetType: 'user', targetId: target.id, targetName: target.username, details: why});
        if (banIp && target.last_ip) await addIpBan(ctx, target.last_ip, `Ban of ${target.username}${why ? `: ${why}` : ''}`);
    };
    route('POST', '/admin/reports/:id/resolve', async ctx => {
        const mod = requireMod(ctx);
        const r = await db.get('SELECT * FROM reports WHERE id = ?', Number(ctx.params.id));
        if (!r) throw new HttpError(404, 'Report not found.');
        const {action, note} = await ctx.json();
        if (!['dismiss', 'hide', 'ban'].includes(action)) throw new HttpError(400, 'action must be dismiss, hide or ban');
        const noteText = clampText(note, 1000, 'note') || '';
        if (action === 'hide') {
            if (r.target_type === 'project') await db.run('UPDATE projects SET hidden = 1 WHERE id = ?', Number(r.target_id));
            else if (r.target_type === 'comment') await db.run('UPDATE comments SET hidden = 1 WHERE id = ?', Number(r.target_id));
            else if (r.target_type === 'message') await db.run('UPDATE messages SET hidden = 1 WHERE id = ?', Number(r.target_id));
            else throw new HttpError(400, 'Users cannot be hidden; use ban.');
        }
        if (action === 'ban') {
            let row = null;
            if (r.target_type === 'user') row = await db.get('SELECT id AS uid FROM users WHERE username = ?', r.target_id);
            if (r.target_type === 'project') row = await db.get('SELECT owner_id AS uid FROM projects WHERE id = ?', Number(r.target_id));
            if (r.target_type === 'comment') row = await db.get('SELECT author_id AS uid FROM comments WHERE id = ?', Number(r.target_id));
            if (r.target_type === 'message') row = await db.get('SELECT sender_id AS uid FROM messages WHERE id = ?', Number(r.target_id));
            if (row) await banUser(ctx, row.uid, noteText || `Report #${r.id}: ${r.reason}`);
        }
        await db.run('UPDATE reports SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ?',
            action === 'dismiss' ? 'dismissed' : 'resolved', mod.id, noteText, now(), r.id);
        await log(ctx, `report.${action}`, {targetType: r.target_type, targetId: r.target_id, targetName: `report #${r.id}`, details: noteText});
        return {ok: true};
    });
    const setHidden = (table, on) => async ctx => {
        requireMod(ctx);
        const id = Number(ctx.params.id);
        await db.run(`UPDATE ${table} SET hidden = ? WHERE id = ?`, on ? 1 : 0, id);
        await log(ctx, `${table === 'projects' ? 'project' : 'comment'}.${on ? 'hide' : 'unhide'}`, {
            targetType: table === 'projects' ? 'project' : 'comment', targetId: id, targetName: `${table === 'projects' ? 'project' : 'comment'} ${id}`
        });
        return {ok: true};
    };
    route('POST', '/admin/projects/:id/hide', setHidden('projects', true));
    route('POST', '/admin/projects/:id/unhide', setHidden('projects', false));
    route('POST', '/admin/comments/:id/hide', setHidden('comments', true));
    route('POST', '/admin/comments/:id/unhide', setHidden('comments', false));
    route('POST', '/admin/users/:username/ban', async ctx => {
        requireMod(ctx);
        const {reason, banIp} = await ctx.json();
        await banUser(ctx, (await getUserByName(ctx.params.username)).id, reason, {banIp: !!banIp});
        return {ok: true};
    });
    route('POST', '/admin/users/:username/unban', async ctx => {
        requireMod(ctx);
        const target = await getUserByName(ctx.params.username);
        await db.run("UPDATE users SET banned = 0, ban_reason = '', banned_at = NULL, banned_by = '' WHERE id = ?", target.id);
        await log(ctx, 'user.unban', {targetType: 'user', targetId: target.id, targetName: target.username});
        return {ok: true};
    });
    route('POST', '/admin/users/:username/role', async ctx => {
        requireAdmin(ctx);
        const {role} = await ctx.json();
        if (!['user', 'moderator', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role.');
        const target = await getUserByName(ctx.params.username);
        await db.run('UPDATE users SET role = ? WHERE id = ?', role, target.id);
        await log(ctx, 'user.role', {targetType: 'user', targetId: target.id, targetName: target.username, details: `${target.role} → ${role}`});
        return {ok: true};
    });
    // Verified tick: admins only, so it keeps meaning something.
    const setVerified = on => async ctx => {
        requireAdmin(ctx);
        const target = await getUserByName(ctx.params.username);
        await db.run('UPDATE users SET verified = ? WHERE id = ?', on ? 1 : 0, target.id);
        await log(ctx, on ? 'user.verify' : 'user.unverify', {targetType: 'user', targetId: target.id, targetName: target.username});
        return {user: userOut({...target, verified: on ? 1 : 0})};
    };
    route('POST', '/admin/users/:username/verify', setVerified(true));
    route('POST', '/admin/users/:username/unverify', setVerified(false));

    // ---------- admin page data ----------
    const DAY = 86400_000;
    route('GET', '/admin/stats', async ctx => {
        requireMod(ctx);
        const t = now();
        return {stats: await db.get(`SELECT
            (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE created_at > ?) AS new_day,
            (SELECT COUNT(*) FROM users WHERE created_at > ?) AS new_week,
            (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
            (SELECT COUNT(*) FROM users WHERE last_login_at > ?) AS active_day,
            (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports,
            (SELECT COUNT(*) FROM projects p WHERE ${SHARED}) AS shared_projects,
            (SELECT COUNT(*) FROM comments) AS comments,
            (SELECT COUNT(*) FROM ip_bans) AS ip_bans,
            (SELECT COUNT(*) FROM activity_log WHERE action = 'filter.blocked' AND created_at > ?) AS blocked_day`,
        t - DAY, t - 7 * DAY, t - DAY, t - DAY)};
    });
    /** Users for the admin page. filter: all | banned | staff | verified | new. IP addresses only for admins. */
    route('GET', '/admin/users', async ctx => {
        const me = requireMod(ctx);
        const q = (ctx.query.get('q') || '').trim().slice(0, 100);
        const filterName = ctx.query.get('filter') || 'all';
        const where = ['1 = 1'];
        const args = [];
        if (q) {
            const like = `%${likeEscape(q)}%`;
            if (isAdmin(me) && /^[0-9a-f.:]+\*?$/i.test(q) && /[.:]/.test(q)) {
                // An IP address (or prefix with *): accounts that signed up or last signed in from it.
                const ipLike = q.endsWith('*') ? `${likeEscape(q.slice(0, -1))}%` : likeEscape(q);
                where.push("(signup_ip LIKE ? ESCAPE '\\' OR last_ip LIKE ? ESCAPE '\\')");
                args.push(ipLike, ipLike);
            } else {
                where.push("(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR ban_reason LIKE ? ESCAPE '\\')");
                args.push(like, like, like);
            }
        }
        if (filterName === 'banned') where.push('banned = 1');
        if (filterName === 'staff') where.push("role IN ('admin', 'moderator')");
        if (filterName === 'verified') where.push('verified = 1');
        if (filterName === 'new') {
            where.push('created_at > ?');
            args.push(now() - 7 * DAY);
        }
        const order = filterName === 'banned' ? 'banned_at DESC' : 'created_at DESC';
        const rows = await db.all(`SELECT u.*,
            (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.deleted = 0) AS project_count,
            (SELECT COUNT(*) FROM users o WHERE o.id != u.id AND u.signup_ip != '' AND (o.signup_ip = u.signup_ip OR o.last_ip = u.signup_ip
                OR (u.last_ip != '' AND (o.signup_ip = u.last_ip OR o.last_ip = u.last_ip)))) AS same_ip
            FROM users u WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...args, limitN(ctx), page(ctx) * limitN(ctx));
        return {users: rows.map(u => ({
            ...userOut(u),
            banReason: u.ban_reason, bannedAt: u.banned_at, bannedBy: u.banned_by, lastLoginAt: u.last_login_at,
            projectCount: u.project_count, sameIpAccounts: u.same_ip,
            ...(isAdmin(me) ? {signupIp: u.signup_ip, lastIp: u.last_ip} : {})
        }))};
    });
    /** Activity log: account creations, logins, bans, filter blocks, moderation actions. */
    route('GET', '/admin/log', async ctx => {
        const me = requireMod(ctx);
        const action = (ctx.query.get('action') || '').trim();
        const q = (ctx.query.get('q') || '').trim().slice(0, 100);
        const where = ['1 = 1'];
        const args = [];
        if (action) {
            // "account" matches account.create and account.login; "account.create" matches only that.
            where.push(action.includes('.') ? 'action = ?' : 'action LIKE ?');
            args.push(action.includes('.') ? action : `${action}.%`);
        }
        if (q) {
            const like = `%${likeEscape(q)}%`;
            where.push(`(actor_name LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\'${isAdmin(me) ? " OR ip LIKE ? ESCAPE '\\'" : ''})`);
            args.push(like, like, like);
            if (isAdmin(me)) args.push(like);
        }
        const rows = await db.all(`SELECT * FROM activity_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
            ...args, limitN(ctx), page(ctx) * limitN(ctx));
        return {entries: rows.map(e => ({
            id: e.id, at: e.created_at, action: e.action, actor: e.actor_name || null, targetType: e.target_type,
            targetId: e.target_id, target: e.target_name, details: e.details, ...(isAdmin(me) ? {ip: e.ip} : {})
        }))};
    });
    // IP bans (admins only).
    route('GET', '/admin/ip-bans', async ctx => {
        requireAdmin(ctx);
        const rows = await db.all(`SELECT b.*, (SELECT COUNT(*) FROM users u WHERE u.signup_ip = b.pattern OR u.last_ip = b.pattern) AS accounts
            FROM ip_bans b ORDER BY created_at DESC`);
        return {bans: rows.map(b => ({id: b.id, pattern: b.pattern, reason: b.reason, createdBy: b.created_by, createdAt: b.created_at, accounts: b.accounts}))};
    });
    route('POST', '/admin/ip-bans', async ctx => {
        requireAdmin(ctx);
        const {pattern, reason} = await ctx.json();
        ctx.status = 201;
        return {pattern: await addIpBan(ctx, pattern, reason)};
    });
    route('DELETE', '/admin/ip-bans/:id', async ctx => {
        requireAdmin(ctx);
        const b = await db.get('SELECT * FROM ip_bans WHERE id = ?', Number(ctx.params.id));
        if (!b) throw new HttpError(404, 'Not found.');
        await db.run('DELETE FROM ip_bans WHERE id = ?', b.id);
        await loadIpBans(true);
        await log(ctx, 'ip.unban', {targetType: 'ip', targetId: b.pattern, targetName: b.pattern});
        return {ok: true};
    });
    // Extra blocked words (admins edit; built-in list is in core/filter.js).
    route('GET', '/admin/words', async ctx => {
        requireMod(ctx);
        const rows = await db.all('SELECT * FROM blocked_words ORDER BY word');
        return {builtIn: BUILT_IN_WORD_COUNT, words: rows.map(w => ({word: w.word, createdBy: w.created_by, createdAt: w.created_at}))};
    });
    route('POST', '/admin/words', async ctx => {
        requireAdmin(ctx);
        const {word} = await ctx.json();
        const w = String(word || '').trim().toLowerCase();
        if (!/^[\p{L}\p{N}' -]{2,40}$/u.test(w)) throw new HttpError(400, 'Words are 2-40 letters.');
        await db.run('INSERT INTO blocked_words (word, created_by, created_at) VALUES (?, ?, ?) ON CONFLICT(word) DO NOTHING', w, ctx.user.username, now());
        await loadCustomWords(true);
        await log(ctx, 'filter.add', {targetType: 'word', targetName: w});
        ctx.status = 201;
        return {ok: true};
    });
    route('DELETE', '/admin/words/:word', async ctx => {
        requireAdmin(ctx);
        const w = String(ctx.params.word).toLowerCase();
        await db.run('DELETE FROM blocked_words WHERE word = ?', w);
        await loadCustomWords(true);
        await log(ctx, 'filter.remove', {targetType: 'word', targetName: w});
        return {ok: true};
    });
    /** Try text against the filter without saving anything (admin page tester). */
    route('POST', '/admin/words/test', async ctx => {
        requireMod(ctx);
        const {text} = await ctx.json();
        await loadCustomWords();
        const value = clampText(text, 2000, 'text') || '';
        return {text: filter.check(value), username: filter.check(value, {username: true})};
    });

    // ---------- request handling ----------
    const authenticate = async request => {
        const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
        if (!m) return {token: null, user: null};
        const token = m[1].trim();
        const tokenHash = await hashToken(token);
        const row = await db.get(`SELECT u.*, s.last_used_at AS s_last_used, s.expires_at AS s_expires
            FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, tokenHash);
        if (!row || row.s_expires < now()) return {token: null, user: null};
        if (now() - row.s_last_used > 3600_000) {
            await db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?', now(), now() + SESSION_TTL_MS, tokenHash);
        }
        return {token, user: row};
    };
    const json = (status, body) => new Response(JSON.stringify(body), {
        status, headers: {...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
    });

    /**
     * @param {Request} request standard Request
     * @param {{ip: string}} info client info from the platform adapter
     * @returns {Promise<Response>} response
     */
    const handle = async (request, {ip = ''} = {}) => {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
        const sub = url.pathname.slice(apiPrefix.length) || '/';
        let matched = null;
        let methodMismatch = false;
        for (const r of routes) {
            const m = r.re.exec(sub);
            if (!m) continue;
            if (r.method !== request.method && !(request.method === 'HEAD' && r.method === 'GET')) {
                methodMismatch = true;
                continue;
            }
            matched = {r, m};
            break;
        }
        if (!matched) return json(methodMismatch ? 405 : 404, {error: methodMismatch ? 'Method not allowed.' : 'Not found.'});
        const params = {};
        matched.r.keys.forEach((k, i) => {
            params[k] = decodeURIComponent(matched.m[i + 1]);
        });
        const size = Number(request.headers.get('content-length') || 0);
        try {
            // Banned networks can still browse, but cannot sign up, sign in or change anything.
            if (!['GET', 'HEAD'].includes(request.method) && await isIpBanned(ip)) {
                throw new HttpError(403, 'Your network has been banned from KbauBlocks.');
            }
            const {token, user} = await authenticate(request);
            const ctx = {
                request, params, query: url.searchParams, ip, token, user, status: 200,
                json: async () => {
                    if (size > 1024 * 1024) throw new HttpError(413, 'Request too large.');
                    const text = await request.text();
                    if (!text) return {};
                    try {
                        const v = JSON.parse(text);
                        return v && typeof v === 'object' ? v : {};
                    } catch (e) {
                        throw new HttpError(400, 'Invalid JSON.');
                    }
                },
                form: async () => {
                    if (!(request.headers.get('content-type') || '').startsWith('multipart/form-data')) {
                        throw new HttpError(400, 'Expected multipart/form-data.');
                    }
                    if (size > MAX_SB3 + MAX_IMAGE + 1024 * 1024) throw new HttpError(413, 'Request too large.');
                    try {
                        return await request.formData();
                    } catch (e) {
                        throw new HttpError(400, 'Malformed upload.');
                    }
                }
            };
            const result = await matched.r.handler(ctx);
            if (result instanceof Response) return result;
            return json(ctx.status, result);
        } catch (e) {
            if (e instanceof HttpError) return json(e.status, e.code ? {error: e.message, code: e.code} : {error: e.message});
            console.error(e);
            return json(500, {error: 'Internal server error.'});
        }
    };

    /** Cloud rooms may only be opened for projects that exist and aren't hidden or deleted. */
    const cloudProjectAllowed = async projectId => {
        if (!/^\d+$/.test(String(projectId))) return false;
        const p = await db.get('SELECT hidden, deleted FROM projects WHERE id = ?', Number(projectId));
        return !!p && !p.hidden && !p.deleted;
    };

    return {handle, cloudProjectAllowed, apiPrefix};
};
