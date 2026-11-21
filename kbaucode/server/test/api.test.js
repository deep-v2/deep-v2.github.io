// End-to-end API tests: start a real server on a random port with a temporary data dir.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let base;
let proc;
let dataDir;

// Minimal valid zip (empty archive with one stored file) to stand in for an .sb3.
const fakeSb3 = (tag = 'a') => {
    const name = Buffer.from('project.json');
    const content = Buffer.from(`{"targets":[],"meta":{"tag":"${tag}"}}`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    return Buffer.concat([local, name, content]);
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

const freePort = () => new Promise(resolve => {
    const s = net.createServer().listen(0, () => {
        const {port} = s.address();
        s.close(() => resolve(port));
    });
});

before(async () => {
    // KBAU_TEST_BASE=http://127.0.0.1:8788/kbau-api runs the suite against an already running server (e.g. wrangler dev).
    if (process.env.KBAU_TEST_BASE) {
        base = process.env.KBAU_TEST_BASE;
        return;
    }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbau-test-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}/kbau-api`;
    proc = spawn(process.execPath, [path.join(here, '..', 'src', 'server.js')], {
        env: {...process.env, PORT: String(port), HOST: '127.0.0.1', KBAU_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1', KBAU_TRUST_PROXY: '1'},
        stdio: 'pipe'
    });
    for (let i = 0; i < 50; i++) {
        try {
            const r = await fetch(`${base}/health`);
            if (r.ok) return;
        } catch (e) {
            // not up yet
        }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
});
after(async () => {
    if (!proc) return;
    const exited = new Promise(resolve => proc.once('exit', resolve));
    proc.kill();
    await exited;
    // Windows may hold the SQLite file briefly after exit.
    fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
});

const call = async (method, p, {token, json, form, ip} = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    // The spawned Node server trusts X-Forwarded-For (KBAU_TRUST_PROXY=1), so tests can act from any IP.
    if (ip) headers['X-Forwarded-For'] = ip;
    let body;
    if (json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
    }
    if (form) body = form;
    const res = await fetch(`${base}${p}`, {method, headers, body});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())};
};
const projectForm = (title, extra = {}) => {
    const f = new FormData();
    f.append('project', new Blob([fakeSb3(title)]), 'project.sb3');
    f.append('title', title);
    f.append('thumbnail', new Blob([PNG]), 'thumb.png');
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    return f;
};

let alice;
let bob;
let projectId;

test('register, login, me', async () => {
    let r = await call('POST', '/auth/register', {json: {username: 'alice', password: 'password123'}});
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'admin', 'first user becomes admin');
    alice = r.body.token;
    r = await call('POST', '/auth/register', {json: {username: 'Alice', password: 'password123'}});
    assert.equal(r.status, 409, 'usernames are case-insensitive unique');
    r = await call('POST', '/auth/register', {json: {username: 'bob', password: 'short'}});
    assert.equal(r.status, 400);
    r = await call('POST', '/auth/register', {json: {username: 'bob', password: 'password456'}});
    bob = r.body.token;
    assert.equal(r.body.user.role, 'user');
    r = await call('POST', '/auth/login', {json: {username: 'bob', password: 'wrong-password'}});
    assert.equal(r.status, 401);
    r = await call('POST', '/auth/login', {json: {username: 'bob', password: 'password456'}});
    assert.equal(r.status, 200);
    r = await call('GET', '/auth/me', {token: bob});
    assert.equal(r.body.user.username, 'bob');
});

test('create, update, version and share a project', async () => {
    let r = await call('POST', '/projects', {token: alice, form: projectForm('Space Game')});
    assert.equal(r.status, 201);
    projectId = r.body.project.id;
    assert.equal(r.body.project.shared, false);
    // Unshared projects are invisible to others.
    assert.equal((await call('GET', `/projects/${projectId}`, {token: bob})).status, 404);
    assert.equal((await call('GET', `/projects/${projectId}/sb3`)).status, 404);
    assert.equal((await call('GET', `/projects/${projectId}/sb3`, {token: alice})).status, 200);
    // Bad upload rejected.
    const bad = new FormData();
    bad.append('project', new Blob(['not a zip']), 'x.sb3');
    assert.equal((await call('POST', '/projects', {token: alice, form: bad})).status, 400);
    // Update content -> v2.
    r = await call('PUT', `/projects/${projectId}/content`, {token: alice, form: projectForm('Space Game 2')});
    assert.equal(r.body.project.version, 2);
    assert.equal((await call('PUT', `/projects/${projectId}/content`, {token: bob, form: projectForm('hijack')})).status, 404);
    r = await call('GET', `/projects/${projectId}/versions`, {token: alice});
    assert.deepEqual(r.body.versions.map(v => v.version), [2, 1]);
    r = await call('POST', `/projects/${projectId}/versions/1/restore`, {token: alice});
    assert.equal(r.body.project.version, 3);
    const sb3 = await call('GET', `/projects/${projectId}/sb3`, {token: alice});
    assert.ok(sb3.body.toString('latin1').includes('Space Game"'), 'restored v1 content');
    r = await call('PATCH', `/projects/${projectId}`, {token: alice, json: {title: 'Space Game 2', description: 'Fly around', notes: 'Music by me'}});
    assert.equal(r.body.project.title, 'Space Game 2');
    assert.equal(r.body.project.description, 'Fly around');
    assert.equal(r.body.project.notes, 'Music by me');
    assert.equal((await call('PATCH', `/projects/${projectId}`, {token: bob, json: {title: 'Mine now'}})).status, 404,
        'others cannot edit (or even see) an unshared project');
    r = await call('PATCH', `/projects/${projectId}`, {token: alice, json: {notes: 'Music and art by me'}});
    assert.equal(r.body.project.description, 'Fly around', 'fields not sent are kept');
    assert.equal(r.body.project.notes, 'Music and art by me');
    r = await call('POST', `/projects/${projectId}/share`, {token: alice});
    assert.equal(r.body.project.shared, true);
    assert.equal((await call('PATCH', `/projects/${projectId}`, {token: bob, json: {title: 'Mine now'}})).status, 403,
        'only the owner can edit the details of a shared project');
    r = await call('GET', `/projects/${projectId}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.project.thumbnailUrl);
    assert.equal((await call('GET', `/projects/${projectId}/thumbnail`)).status, 200);
});

test('loves, favorites, views', async () => {
    let r = await call('POST', `/projects/${projectId}/love`, {token: bob});
    assert.equal(r.body.project.stats.loves, 1);
    assert.equal(r.body.project.loved, true);
    r = await call('POST', `/projects/${projectId}/love`, {token: bob});
    assert.equal(r.body.project.stats.loves, 1, 'idempotent');
    r = await call('POST', `/projects/${projectId}/favorite`, {token: bob});
    assert.equal(r.body.project.stats.favorites, 1);
    r = await call('DELETE', `/projects/${projectId}/love`, {token: bob});
    assert.equal(r.body.project.stats.loves, 0);
    assert.equal((await call('POST', `/projects/${projectId}/love`)).status, 401);
    await call('POST', `/projects/${projectId}/view`);
    r = await call('POST', `/projects/${projectId}/view`);
    assert.equal(r.body.views, 1, 'views deduplicated per viewer per day');
    r = await call('GET', '/users/bob/favorites');
    assert.equal(r.body.projects.length, 1);
});

test('remix with attribution', async () => {
    const r = await call('POST', '/projects', {token: bob, form: projectForm('Space Game Remix', {remixOf: projectId})});
    assert.equal(r.body.project.remixOf.id, Number(projectId));
    await call('POST', `/projects/${r.body.project.id}/share`, {token: bob});
    const remixes = await call('GET', `/projects/${projectId}/remixes`);
    assert.equal(remixes.body.projects.length, 1);
    assert.equal((await call('GET', `/projects/${projectId}`)).body.project.stats.remixes, 1);
});

test('comments and replies', async () => {
    let r = await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'Cool game!'}});
    assert.equal(r.status, 201);
    const top = r.body.comment.id;
    r = await call('POST', `/projects/${projectId}/comments`, {token: alice, json: {content: 'Thanks!', parentId: top}});
    assert.equal(r.body.comment.parentId, top);
    r = await call('GET', `/projects/${projectId}/comments`);
    assert.equal(r.body.comments.length, 1);
    assert.equal(r.body.comments[0].replies.length, 1);
    assert.equal((await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: '   '}})).status, 400);
});

test('explore, search, profiles', async () => {
    for (const sort of ['trending', 'popular', 'recent']) {
        const r = await call('GET', `/explore?sort=${sort}`);
        assert.equal(r.status, 200);
        assert.ok(r.body.projects.length >= 2, sort);
    }
    let r = await call('GET', '/search?q=space');
    assert.equal(r.body.projects.length, 2);
    r = await call('GET', '/search?q=bo');
    assert.equal(r.body.users[0].username, 'bob');
    r = await call('GET', '/users/bob');
    assert.equal(r.body.user.profileColor, '#ffffff', 'new accounts start with a white profile colour');
    r = await call('PATCH', '/users/me', {token: bob, json: {bio: 'I make games', profileColor: '#ff0000'}});
    assert.equal(r.body.user.bio, 'I make games');
    assert.equal((await call('PATCH', '/users/me', {token: bob, json: {profileColor: 'red'}})).status, 400);
    r = await call('GET', '/users/alice');
    assert.equal(r.body.stats.shared, 1);
});

test('collections', async () => {
    let r = await call('POST', '/collections', {token: bob, json: {title: 'Best games'}});
    const id = r.body.collection.id;
    r = await call('POST', `/collections/${id}/projects`, {token: bob, json: {projectId}});
    assert.equal(r.body.collection.projectCount, 1);
    assert.equal((await call('POST', `/collections/${id}/projects`, {token: alice, json: {projectId}})).status, 403);
    r = await call('GET', `/collections/${id}`);
    assert.equal(r.body.projects[0].id, projectId);
});

test('follows, friends and the verified tick', async () => {
    const carol = (await call('POST', '/auth/register', {json: {username: 'carol', password: 'password789'}})).body.token;
    assert.equal((await call('POST', '/users/bob/follow')).status, 401, 'must be signed in');
    assert.equal((await call('POST', '/users/bob/follow', {token: bob})).status, 400, 'cannot follow yourself');
    assert.equal((await call('POST', '/users/nobody-here/follow', {token: bob})).status, 404);
    // One-way follow: following, not friends yet.
    let r = await call('POST', '/users/carol/follow', {token: bob});
    assert.deepEqual(r.body.relationship, {following: true, followedBy: false, friends: false});
    assert.equal(r.body.followers, 1);
    r = await call('POST', '/users/carol/follow', {token: bob});
    assert.equal(r.body.followers, 1, 'following twice is a no-op');
    r = await call('GET', '/users/bob', {token: carol});
    assert.deepEqual(r.body.relationship, {following: false, followedBy: true, friends: false, blocked: false, nickname: null});
    // Follow back: friends.
    r = await call('POST', '/users/bob/follow', {token: carol});
    assert.equal(r.body.relationship.friends, true);
    await call('POST', '/users/alice/follow', {token: bob});
    r = await call('GET', '/users/bob');
    assert.equal(r.body.relationship, undefined, 'no relationship for anonymous viewers');
    assert.equal(r.body.stats.followers, 1);
    assert.equal(r.body.stats.following, 2);
    assert.equal(r.body.stats.friends, 1);
    assert.deepEqual((await call('GET', '/users/bob/following')).body.users.map(u => u.username), ['alice', 'carol']);
    assert.deepEqual((await call('GET', '/users/bob/followers')).body.users.map(u => u.username), ['carol']);
    assert.deepEqual((await call('GET', '/users/bob/friends')).body.users.map(u => u.username), ['carol']);
    assert.deepEqual((await call('GET', '/users/carol/friends')).body.users.map(u => u.username), ['bob']);
    // Unfollow ends the friendship.
    r = await call('DELETE', '/users/bob/follow', {token: carol});
    assert.deepEqual(r.body.relationship, {following: false, followedBy: true, friends: false});
    assert.equal((await call('GET', '/users/bob/friends')).body.users.length, 0);

    // Verified: staff automatically, others only when an admin grants it.
    assert.equal((await call('GET', '/users/alice')).body.user.verified, true, 'admins are verified');
    assert.equal((await call('GET', '/users/carol')).body.user.verified, false);
    assert.equal((await call('POST', '/admin/users/carol/verify', {token: bob})).status, 403);
    r = await call('POST', '/admin/users/carol/verify', {token: alice});
    assert.equal(r.body.user.verified, true);
    assert.equal((await call('GET', '/users/carol')).body.user.verified, true);
    assert.equal((await call('GET', '/users/bob/following')).body.users.find(u => u.username === 'carol').verified, true);
    await call('POST', '/admin/users/carol/unverify', {token: alice});
    assert.equal((await call('GET', '/users/carol')).body.user.verified, false);

    // Search by type: an exact username comes first; projects-only search returns no users.
    r = await call('GET', '/search?q=BOB&type=users&limit=1');
    assert.equal(r.body.users[0].username, 'bob');
    assert.equal(r.body.projects.length, 0);
    r = await call('GET', '/search?q=bob&type=projects');
    assert.equal(r.body.users.length, 0);
});

test('word filter on every kind of text', async () => {
    const bad = async (method, p, opts) => {
        const r = await call(method, p, opts);
        assert.equal(r.status, 400, `${method} ${p} should be blocked`);
        assert.match(r.body.error, /isn't allowed/);
    };
    await bad('POST', '/auth/register', {ip: '203.0.113.11', json: {username: 'xXfuckXx', password: 'password123'}});
    await bad('POST', '/auth/register', {ip: '203.0.113.12', json: {username: 'sh1tlord', password: 'password123'}});
    assert.equal((await call('POST', '/auth/register', {ip: '203.0.113.13', json: {username: 'Cassandra', password: 'password123'}})).status, 200,
        'ordinary names that contain a bad word inside them are fine');
    await bad('PATCH', '/users/me', {token: bob, json: {bio: 'what the f u c k'}});
    await bad('PATCH', '/users/me', {token: bob, json: {displayName: 'B1tch'}});
    assert.equal((await call('PATCH', '/users/me', {token: bob, json: {bio: 'I love classic games and spicy food'}})).status, 200);
    await bad('PATCH', `/projects/${projectId}`, {token: alice, json: {title: 'shit game'}});
    await bad('PATCH', `/projects/${projectId}`, {token: alice, json: {notes: 'fuuuuck'}});
    await bad('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'you are a b!tch'}});
    await bad('POST', '/collections', {token: bob, json: {title: 'ass stuff'}});
    await bad('POST', '/reports', {token: bob, json: {targetType: 'user', targetId: 'alice', reason: 'fuck you'}});
    // Admins can add their own words.
    assert.equal((await call('POST', '/admin/words', {token: bob, json: {word: 'bananarama'}})).status, 403);
    assert.equal((await call('POST', '/admin/words', {token: alice, json: {word: 'Bananarama'}})).status, 201);
    await bad('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'bananarama forever'}});
    assert.equal((await call('POST', '/admin/words/test', {token: alice, json: {text: 'bananarama'}})).body.text, 'bananarama');
    await call('DELETE', '/admin/words/bananarama', {token: alice});
    assert.equal((await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'bananarama forever'}})).status, 201);
    const log = await call('GET', '/admin/log?action=filter.blocked', {token: alice});
    assert.ok(log.body.entries.length >= 10, 'blocked attempts are logged');
});

test('pinned comments', async () => {
    const a = (await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'first!'}})).body.comment;
    const b = (await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'second'}})).body.comment;
    assert.equal((await call('POST', `/comments/${a.id}/pin`, {token: bob})).status, 403, 'only the project owner pins');
    assert.equal((await call('POST', `/comments/${a.id}/pin`, {token: alice})).status, 200);
    let list = (await call('GET', `/projects/${projectId}/comments`)).body.comments;
    assert.equal(list[0].id, a.id, 'pinned comment comes first');
    assert.equal(list[0].pinned, true);
    await call('POST', `/comments/${b.id}/pin`, {token: alice});
    list = (await call('GET', `/projects/${projectId}/comments`)).body.comments;
    assert.equal(list[0].id, b.id);
    assert.equal(list.filter(c => c.pinned).length, 1, 'only one pinned comment per project');
    await call('DELETE', `/comments/${b.id}/pin`, {token: alice});
    assert.equal((await call('GET', `/projects/${projectId}/comments`)).body.comments.filter(c => c.pinned).length, 0);
});

test('comment upvotes and downvotes', async () => {
    const c1 = (await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'nice physics'}})).body.comment;
    const c2 = (await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'meh'}})).body.comment;
    assert.equal(c1.score, 0);
    assert.equal((await call('POST', `/comments/${c1.id}/vote`, {json: {value: 1}})).status, 401, 'must be signed in');
    assert.equal((await call('POST', `/comments/${c1.id}/vote`, {token: bob, json: {value: 1}})).status, 400, 'no voting on your own');
    assert.equal((await call('POST', `/comments/${c1.id}/vote`, {token: alice, json: {value: 5}})).status, 400);
    let r = await call('POST', `/comments/${c1.id}/vote`, {token: alice, json: {value: 1}});
    assert.deepEqual(r.body, {score: 1, myVote: 1});
    r = await call('POST', `/comments/${c1.id}/vote`, {token: alice, json: {value: 1}});
    assert.equal(r.body.score, 1, 'voting twice counts once');
    r = await call('POST', `/comments/${c2.id}/vote`, {token: alice, json: {value: -1}});
    assert.equal(r.body.score, -1);
    // Viewers see their own vote; sort=top puts the best first (after any pinned comment).
    let list = (await call('GET', `/projects/${projectId}/comments?sort=top`, {token: alice})).body.comments;
    const nonPinned = list.filter(c => !c.pinned);
    assert.equal(nonPinned[0].id, c1.id);
    assert.equal(nonPinned[0].myVote, 1);
    assert.equal(list.find(c => c.id === c2.id).myVote, -1);
    assert.equal((await call('GET', `/projects/${projectId}/comments`)).body.comments[0].myVote, undefined);
    // Switch and clear.
    r = await call('POST', `/comments/${c1.id}/vote`, {token: alice, json: {value: -1}});
    assert.equal(r.body.score, -1);
    r = await call('POST', `/comments/${c1.id}/vote`, {token: alice, json: {value: 0}});
    assert.deepEqual(r.body, {score: 0, myVote: 0});
});

test('custom project thumbnails survive editor saves', async () => {
    const GIF = Buffer.from('474946383961010001000000002c00000000010001000002', 'hex');
    const id = (await call('POST', '/projects', {token: bob, form: projectForm('Thumb Test')})).body.project.id;
    const upload = (bytes, token = bob) => {
        const f = new FormData();
        f.append('thumbnail', new Blob([bytes]), 'thumb');
        return call('POST', `/projects/${id}/thumbnail`, {token, form: f});
    };
    assert.equal((await upload(Buffer.from('not an image'))).status, 400);
    assert.equal((await upload(GIF, alice)).status, 403, 'only the owner sets the thumbnail');
    let r = await upload(GIF);
    assert.equal(r.status, 200);
    assert.equal(r.body.project.customThumbnail, true);
    const thumbType = async () => {
        const res = await fetch(`${base}/projects/${id}/thumbnail?x=${Math.random()}`, {headers: {Authorization: `Bearer ${bob}`}});
        return res.headers.get('content-type');
    };
    assert.equal(await thumbType(), 'image/gif');
    // Saving from the editor (which sends a stage snapshot) keeps the custom thumbnail.
    r = await call('PUT', `/projects/${id}/content`, {token: bob, form: projectForm('Thumb Test')});
    assert.equal(r.status, 200);
    assert.equal(await thumbType(), 'image/gif');
    // Back to automatic: the next save uses the stage snapshot again.
    r = await call('DELETE', `/projects/${id}/thumbnail/custom`, {token: bob});
    assert.equal(r.body.project.customThumbnail, false);
    await call('PUT', `/projects/${id}/content`, {token: bob, form: projectForm('Thumb Test')});
    assert.equal(await thumbType(), 'image/png');
    await call('DELETE', `/projects/${id}`, {token: bob});
});

test('animated profile pictures and banners', async () => {
    const GIF = Buffer.from('474946383961010001000000002c00000000010001000002', 'hex');
    const send = (kind, bytes) => {
        const f = new FormData();
        f.append(kind, new Blob([bytes]), kind);
        return call('POST', `/users/me/${kind}`, {token: bob, form: f});
    };
    const type = async url => (await fetch(`${base}${url}`)).headers.get('content-type');
    for (const kind of ['avatar', 'banner']) {
        const key = `${kind}Url`;
        assert.equal((await send(kind, Buffer.from('nope'))).status, 400);
        let r = await send(kind, GIF);
        assert.equal(r.status, 200);
        const first = r.body.user[key];
        assert.ok(first, `${kind} URL is set`);
        assert.equal(await type(first), 'image/gif');
        r = await call('DELETE', `/users/me/${kind}`, {token: bob});
        assert.equal(r.body.user[key], null, `${kind} removed`);
        assert.equal((await fetch(`${base}${first}`)).status, 404);
        r = await send(kind, PNG);
        assert.notEqual(r.body.user[key], first, 're-upload gets a new URL');
        assert.equal(await type(r.body.user[key]), 'image/png');
    }
    const r = await call('GET', '/users/bob');
    assert.ok(r.body.user.bannerUrl && r.body.user.avatarUrl);
});

test('bans with reasons, IP bans and the activity log', async () => {
    const dave = await call('POST', '/auth/register', {ip: '198.51.100.7', json: {username: 'dave', password: 'password123'}});
    assert.equal(dave.status, 200);
    await call('POST', '/auth/register', {ip: '198.51.100.7', json: {username: 'dave2', password: 'password123'}});
    let r = await call('GET', '/admin/log?action=account.create', {token: alice});
    const created = r.body.entries.find(e => e.target === 'dave2');
    assert.ok(created, 'account creation is logged');
    assert.equal(created.ip, '198.51.100.7');
    assert.match(created.details, /1 other account/);
    // Admins see IPs and same-IP accounts; regular users can't use the admin API.
    r = await call('GET', '/admin/users?q=198.51.100.*', {token: alice});
    assert.deepEqual(r.body.users.map(u => u.username).sort(), ['dave', 'dave2']);
    assert.equal(r.body.users[0].sameIpAccounts, 1);
    assert.equal((await call('GET', '/admin/users', {token: bob})).status, 403);
    // Ban with a reason.
    r = await call('POST', '/admin/users/dave/ban', {token: alice, json: {reason: 'Spamming comments'}});
    assert.equal(r.status, 200);
    r = await call('POST', '/auth/login', {ip: '198.51.100.9', json: {username: 'dave', password: 'password123'}});
    assert.equal(r.status, 403);
    assert.match(r.body.error, /Spamming comments/);
    r = await call('GET', '/admin/users?filter=banned', {token: alice});
    const d = r.body.users.find(u => u.username === 'dave');
    assert.equal(d.banReason, 'Spamming comments');
    assert.equal(d.bannedBy, 'alice');
    // IP bans block sign-ups and changes from that network, but not browsing.
    assert.equal((await call('POST', '/admin/ip-bans', {token: bob, json: {pattern: '198.51.100.*'}})).status, 403);
    assert.equal((await call('POST', '/admin/ip-bans', {token: alice, json: {pattern: 'not an ip'}})).status, 400);
    r = await call('POST', '/admin/ip-bans', {token: alice, json: {pattern: '198.51.100.*', reason: 'ban evasion'}});
    assert.equal(r.status, 201);
    r = await call('POST', '/auth/register', {ip: '198.51.100.50', json: {username: 'dave3', password: 'password123'}});
    assert.equal(r.status, 403);
    assert.match(r.body.error, /network has been banned/);
    assert.equal((await call('GET', '/explore', {ip: '198.51.100.50'})).status, 200, 'banned networks can still browse');
    assert.equal((await call('POST', '/auth/register', {ip: '192.0.2.1', json: {username: 'erin', password: 'password123'}})).status, 200);
    const bans = (await call('GET', '/admin/ip-bans', {token: alice})).body.bans;
    assert.equal(bans.length, 1);
    await call('DELETE', `/admin/ip-bans/${bans[0].id}`, {token: alice});
    assert.equal((await call('POST', '/auth/register', {ip: '198.51.100.50', json: {username: 'dave3', password: 'password123'}})).status, 200);
    // Ban + IP ban in one go (admins only).
    r = await call('POST', '/admin/users/dave3/ban', {token: alice, json: {reason: 'again', banIp: true}});
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/admin/ip-bans', {token: alice})).body.bans[0].pattern, '198.51.100.50');
    // Unban clears the reason; everything is in the log.
    await call('POST', '/admin/users/dave/unban', {token: alice});
    assert.equal((await call('GET', '/admin/users?q=dave', {token: alice})).body.users.find(u => u.username === 'dave').banReason, '');
    const actions = (await call('GET', '/admin/log?limit=60', {token: alice})).body.entries.map(e => e.action);
    for (const a of ['account.create', 'user.ban', 'user.unban', 'ip.ban', 'ip.unban']) {
        assert.ok(actions.includes(a), `log has ${a}`);
    }
    assert.ok((await call('GET', '/admin/log?action=account.login', {token: alice})).body.entries.length > 0, 'logins are logged');
    const stats = (await call('GET', '/admin/stats', {token: alice})).body.stats;
    assert.ok(stats.users >= 6 && stats.banned >= 1 && stats.ip_bans === 1);
});

test('reports and moderation', async () => {
    const c = await call('POST', `/projects/${projectId}/comments`, {token: bob, json: {content: 'mean comment'}});
    let r = await call('POST', '/reports', {token: alice, json: {targetType: 'comment', targetId: c.body.comment.id, reason: 'rude'}});
    assert.equal(r.status, 201);
    assert.equal((await call('GET', '/admin/reports', {token: bob})).status, 403);
    r = await call('GET', '/admin/reports', {token: alice});
    assert.equal(r.body.reports.length, 1);
    const reportId = r.body.reports[0].id;
    await call('POST', `/admin/reports/${reportId}/resolve`, {token: alice, json: {action: 'hide'}});
    r = await call('GET', `/projects/${projectId}/comments`);
    const hidden = r.body.comments.find(x => x.id === c.body.comment.id);
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.content, '');
    // Ban bob: sessions revoked, cannot log in.
    await call('POST', '/admin/users/bob/ban', {token: alice});
    assert.equal((await call('GET', '/auth/me', {token: bob})).body.user, null);
    assert.equal((await call('POST', '/auth/login', {json: {username: 'bob', password: 'password456'}})).status, 403);
    await call('POST', '/admin/users/bob/unban', {token: alice});
    r = await call('POST', '/auth/login', {json: {username: 'bob', password: 'password456'}});
    bob = r.body.token;
    // Hidden projects disappear from explore.
    await call('POST', `/admin/projects/${projectId}/hide`, {token: alice});
    r = await call('GET', '/explore?sort=recent');
    assert.ok(!r.body.projects.some(p => p.id === projectId));
    await call('POST', `/admin/projects/${projectId}/unhide`, {token: alice});
});

test('cloud variables over WebSocket', async () => {
    const wsUrl = `${base.replace('http', 'ws')}/cloud/${projectId}`;
    const open = () => new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const messages = [];
        ws.onmessage = e => messages.push(...String(e.data).split('\n').filter(Boolean).map(JSON.parse));
        ws.onopen = () => resolve({ws, messages});
        ws.onerror = reject;
    });
    const a = await open();
    const b = await open();
    a.ws.send(`${JSON.stringify({method: 'handshake', project_id: projectId, user: 'alice'})}\n`);
    b.ws.send(`${JSON.stringify({method: 'handshake', project_id: projectId, user: 'bob'})}\n`);
    await new Promise(r => setTimeout(r, 150));
    a.ws.send(`${JSON.stringify({method: 'set', name: '☁ score', value: '42', project_id: projectId, user: 'alice'})}\n`);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(b.messages.at(-1), {method: 'set', name: '☁ score', value: '42'});
    // A new client receives stored values on handshake.
    const c = await open();
    c.ws.send(`${JSON.stringify({method: 'handshake', project_id: projectId, user: 'carol'})}\n`);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(c.messages[0], {method: 'set', name: '☁ score', value: '42'});
    for (const x of [a, b, c]) x.ws.close();
});

test('password change revokes other sessions', async () => {
    const second = (await call('POST', '/auth/login', {json: {username: 'alice', password: 'password123'}})).body.token;
    const r = await call('POST', '/users/me/password', {token: alice, json: {currentPassword: 'password123', newPassword: 'newpassword1'}});
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/auth/me', {token: second})).body.user, null);
    assert.equal((await call('GET', '/auth/me', {token: alice})).body.user.username, 'alice');
});

test('delete project', async () => {
    assert.equal((await call('DELETE', `/projects/${projectId}`, {token: bob})).status, 403);
    assert.equal((await call('DELETE', `/projects/${projectId}`, {token: alice})).status, 200);
    assert.equal((await call('GET', `/projects/${projectId}`)).status, 404);
});

test('direct messages, requests, pins, blocking and nicknames', async () => {
    const reg = async (username, ip) => (await call('POST', '/auth/register', {ip, json: {username, password: 'password123'}})).body.token;
    const erin = await reg('dm_erin', '192.0.2.11');
    const frank = await reg('dm_frank', '192.0.2.12');
    const gina = await reg('dm_gina', '192.0.2.13');
    const say = (token, to, body) => call('POST', `/messages/with/${to}`, {token, json: {body}});

    // Erin lets non-friends send 2 messages before she accepts.
    assert.equal((await call('PATCH', '/users/me/privacy', {token: erin, json: {dmRequestLimit: 99}})).status, 400);
    assert.equal((await call('PATCH', '/users/me/privacy', {token: erin, json: {dmRequestLimit: 2}})).body.dmRequestLimit, 2);
    let r = await call('GET', '/messages/with/dm_erin', {token: frank});
    assert.equal(r.body.state.status, 'none');
    assert.equal(r.body.state.remaining, 2);
    assert.match(r.body.state.notice, /message request/, 'the sender is told it is a request');
    assert.equal((await say(frank, 'dm_frank', 'me')).status, 400, 'no messaging yourself');
    r = await say(frank, 'dm_erin', 'hi erin');
    assert.equal(r.status, 201);
    assert.equal(r.body.state.status, 'request-sent');
    assert.equal(r.body.state.remaining, 1);
    r = await say(frank, 'dm_erin', 'are you there?');
    assert.equal(r.body.state.canSend, false);
    assert.equal(r.body.state.reason, 'limit');
    r = await say(frank, 'dm_erin', 'hello??');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'limit');
    assert.match(r.body.error, /accepted your message request/);

    // Erin sees a request, not a chat, and Frank can't see whether she read it.
    assert.equal((await call('GET', '/messages/conversations', {token: erin})).body.conversations.length, 0);
    r = await call('GET', '/messages/conversations?box=requests', {token: erin});
    assert.equal(r.body.conversations.length, 1);
    assert.equal(r.body.conversations[0].user.username, 'dm_frank');
    assert.deepEqual((await call('GET', '/messages/unread', {token: erin})).body, {unread: 0, requests: 1});
    r = await call('GET', '/messages/with/dm_frank', {token: erin});
    assert.deepEqual(r.body.messages.map(m => m.body), ['hi erin', 'are you there?']);
    assert.equal(r.body.state.status, 'request-received');
    await call('POST', '/messages/with/dm_frank/read', {token: erin});
    assert.equal((await call('GET', '/messages/with/dm_erin', {token: frank})).body.state.otherLastReadId, 0);

    // Accepting lets Frank write freely; read receipts now show.
    r = await call('POST', '/messages/with/dm_frank/accept', {token: erin});
    assert.equal(r.body.state.status, 'accepted');
    r = await say(frank, 'dm_erin', 'thanks!');
    assert.equal(r.status, 201);
    const lastId = r.body.message.id;
    assert.equal((await call('GET', '/messages/unread', {token: erin})).body.unread, 1);
    await call('POST', '/messages/with/dm_frank/read', {token: erin});
    assert.equal((await call('GET', '/messages/with/dm_erin', {token: frank})).body.state.otherLastReadId, lastId);
    r = await call('GET', `/messages/with/dm_frank?after=${lastId - 1}`, {token: erin});
    assert.deepEqual(r.body.messages.map(m => m.body), ['thanks!']);

    // Pins.
    await say(gina, 'dm_erin', 'hey');
    await call('POST', '/messages/with/dm_gina/accept', {token: erin});
    await call('PUT', '/messages/with/dm_frank/pin', {token: erin});
    r = await call('GET', '/messages/conversations', {token: erin});
    assert.deepEqual(r.body.conversations.map(c => [c.user.username, c.pinned]), [['dm_frank', true], ['dm_gina', false]]);

    // Unsend, and reports on messages (only on other people's messages in your own chats).
    r = await call('DELETE', `/messages/${lastId}`, {token: erin});
    assert.equal(r.status, 404, 'only the sender can unsend');
    r = await call('DELETE', `/messages/${lastId}`, {token: frank});
    assert.equal(r.body.message.deleted, true);
    const firstId = (await call('GET', '/messages/with/dm_frank', {token: erin})).body.messages[0].id;
    assert.equal((await call('POST', '/reports', {token: frank, json: {targetType: 'message', targetId: firstId, reason: 'x'}})).status, 404);
    assert.equal((await call('POST', '/reports', {token: gina, json: {targetType: 'message', targetId: firstId, reason: 'x'}})).status, 404);
    assert.equal((await call('POST', '/reports', {token: erin, json: {targetType: 'message', targetId: firstId, reason: 'rude'}})).status, 201);
    const report = (await call('GET', '/admin/reports', {token: alice})).body.reports.find(x => x.targetType === 'message');
    assert.equal(report.target.content, 'hi erin');

    // Nicknames: friends only, and only the person who set it sees it.
    assert.equal((await call('PUT', '/users/dm_frank/nickname', {token: erin, json: {nickname: 'Franky'}})).status, 403);
    await call('POST', '/users/dm_frank/follow', {token: erin});
    await call('POST', '/users/dm_erin/follow', {token: frank});
    assert.equal((await call('PUT', '/users/dm_frank/nickname', {token: erin, json: {nickname: 'Franky'}})).body.nickname, 'Franky');
    assert.equal((await call('GET', '/users/dm_frank', {token: erin})).body.relationship.nickname, 'Franky');
    assert.equal((await call('GET', '/users/dm_erin/friends', {token: erin})).body.users[0].nickname, 'Franky');
    assert.equal((await call('GET', '/users/dm_erin/friends', {token: frank})).body.users[0].nickname, undefined);
    assert.equal((await call('GET', '/messages/conversations', {token: erin})).body.conversations[0].user.nickname, 'Franky');

    // Friends-only setting; friends can always chat.
    await call('PATCH', '/users/me/privacy', {token: erin, json: {dmRequestLimit: 0}});
    const hank = await reg('dm_hank', '192.0.2.14');
    r = await say(hank, 'dm_erin', 'hi');
    assert.equal(r.body.code, 'friends-only');
    await call('POST', '/users/dm_erin/follow', {token: hank});
    await call('POST', '/users/dm_hank/follow', {token: erin});
    r = await say(hank, 'dm_erin', 'now we are friends');
    assert.equal(r.status, 201);
    assert.equal(r.body.state.status, 'accepted');

    // Declining: the sender just can't send more.
    await call('PATCH', '/users/me/privacy', {token: erin, json: {dmRequestLimit: 5}});
    const ivy = await reg('dm_ivy', '192.0.2.15');
    await say(ivy, 'dm_erin', 'buy my stuff');
    r = await call('POST', '/messages/with/dm_ivy/decline', {token: erin});
    assert.equal(r.body.state.status, 'declined');
    assert.equal((await call('GET', '/messages/conversations?box=requests', {token: erin})).body.conversations.length, 0);
    r = await say(ivy, 'dm_erin', 'hello?');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'limit', 'a decline looks like a full request to the sender');

    // Blocking: removes follows both ways, stops messages and follows, hides the chat and their comments.
    r = await call('POST', '/users/dm_frank/block', {token: erin});
    assert.equal(r.body.relationship.friends, false);
    assert.equal((await call('GET', '/users/dm_frank', {token: erin})).body.relationship.blocked, true);
    assert.equal((await say(frank, 'dm_erin', 'hey')).body.code, 'unavailable');
    assert.equal((await say(erin, 'dm_frank', 'hey')).body.code, 'blocked');
    assert.equal((await call('POST', '/users/dm_erin/follow', {token: frank})).status, 403);
    assert.ok(!(await call('GET', '/messages/conversations', {token: erin})).body.conversations.some(c => c.user.username === 'dm_frank'));
    const pid = (await call('POST', '/projects', {token: erin, form: projectForm('Erin Game', {shared: '1'})})).body.project.id;
    await call('POST', `/projects/${pid}/share`, {token: erin});
    assert.equal((await call('POST', `/projects/${pid}/comments`, {token: frank, json: {content: 'nice'}})).status, 403);
    r = await call('GET', '/users/me/privacy', {token: erin});
    assert.deepEqual(r.body.blocked.map(u => u.username), ['dm_frank']);
    await call('DELETE', '/users/dm_frank/block', {token: erin});
    assert.equal((await call('GET', '/users/me/privacy', {token: erin})).body.blocked.length, 0);
    assert.equal((await say(frank, 'dm_erin', 'hi again')).status, 201, 'an accepted chat keeps working after unblocking');
});

test('live collaboration: collaborators, assets, snapshots and the room', async () => {
    const crypto = await import('node:crypto');
    const reg = async (username, ip) => (await call('POST', '/auth/register', {ip, json: {username, password: 'password123'}})).body.token;
    const owner = await reg('co_owner', '192.0.2.31');
    const mate = await reg('co_mate', '192.0.2.32');
    const outsider = await reg('co_out', '192.0.2.33');
    const pid = (await call('POST', '/projects', {token: owner, form: projectForm('Team Game')})).body.project.id;

    // Invites: owner only; invited people can open and save the (unshared) project.
    assert.equal((await call('GET', `/projects/${pid}`, {token: mate})).status, 404);
    assert.equal((await call('POST', `/projects/${pid}/collaborators`, {token: mate, json: {username: 'co_out'}})).status, 404);
    let r = await call('POST', `/projects/${pid}/collaborators`, {token: owner, json: {username: 'co_mate'}});
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.collaborators.map(u => u.username), ['co_mate']);
    assert.equal((await call('POST', `/projects/${pid}/collaborators`, {token: owner, json: {username: 'co_owner'}})).status, 400);
    r = await call('GET', `/projects/${pid}`, {token: mate});
    assert.equal(r.body.project.canEdit, true);
    assert.equal(r.body.project.collaborator, true);
    assert.equal((await call('PUT', `/projects/${pid}/content`, {token: mate, form: projectForm('Team Game')})).status, 200);
    assert.equal((await call('PUT', `/projects/${pid}/content`, {token: outsider, form: projectForm('Team Game')})).status, 404);
    assert.deepEqual((await call('GET', '/users/me/collab-projects', {token: mate})).body.projects.map(p => p.id), [pid]);
    r = await call('GET', `/projects/${pid}/collaborators`, {token: mate});
    assert.equal(r.body.canEdit, true);
    assert.equal(r.body.canManage, false);

    // Shared asset store: named by MD5, checked on upload, cached forever.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    const name = `${crypto.createHash('md5').update(svg).digest('hex')}.svg`;
    const putAsset = (asset, body, token = mate) => fetch(`${base}/collab/assets/${asset}?project=${pid}`, {
        method: 'PUT', headers: {Authorization: `Bearer ${token}`}, body
    });
    assert.equal((await putAsset(`${'0'.repeat(32)}.svg`, svg)).status, 400, 'contents must match the name');
    assert.equal((await putAsset(name, svg, outsider)).status, 404);
    assert.equal((await putAsset(name, svg)).status, 201);
    assert.equal((await putAsset(name, svg)).status, 200, 'second upload is a no-op');
    r = await call('POST', '/collab/assets/missing', {token: mate, json: {project: pid, assets: [name, `${'a'.repeat(32)}.png`]}});
    assert.deepEqual(r.body.missing, [`${'a'.repeat(32)}.png`]);
    let res = await fetch(`${base}/collab/assets/${name}`);
    assert.equal(await res.text(), svg.toString());
    assert.match(res.headers.get('cache-control'), /immutable/);

    // Live room over WebSocket.
    const wsBase = `${base.replace(/^http/, 'ws')}/collab/${pid}`;
    const connect = (token, extra = {}) => new Promise((resolve, reject) => {
        const ws = new WebSocket(wsBase);
        const inbox = [];
        const waiters = [];
        ws.addEventListener('message', e => {
            const msg = JSON.parse(e.data);
            const i = waiters.findIndex(w => w.type === msg.t);
            if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
            else inbox.push(msg);
        });
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({t: 'hello', token, ...extra}));
            resolve({
                ws,
                send: msg => ws.send(JSON.stringify(msg)),
                next: (type, ms = 3000) => {
                    const i = inbox.findIndex(m => m.t === type);
                    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
                    return new Promise((ok, fail) => {
                        const w = {type, resolve: ok};
                        waiters.push(w);
                        setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), ms);
                    });
                },
                has: type => inbox.some(m => m.t === type),
                closed: new Promise(ok => ws.addEventListener('close', e => ok(e.code)))
            });
        });
        ws.addEventListener('error', reject);
    });
    const out = await connect(outsider);
    assert.equal((await out.next('error')).code, 'denied');
    assert.equal(await out.closed, 4001);

    const a = await connect(owner, {key: 'A'});
    const seed = await a.next('welcome');
    assert.equal(seed.mode, 'seed', 'the first one in seeds the room');
    const b = await connect(mate, {key: 'B'});
    await b.next('wait');
    // Seeding: upload the snapshot, then say so.
    const snapUrl = rev => `${base}/projects/${pid}/collab/snapshot/${seed.session}/${rev}`;
    res = await fetch(snapUrl(0), {method: 'PUT', headers: {Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({project: {targets: []}})});
    assert.equal(res.status, 201);
    a.send({t: 'seed'});
    await a.next('seeded');
    const wb = await b.next('welcome');
    assert.equal(wb.mode, 'load');
    assert.equal(wb.snapRev, 0);
    assert.equal(wb.members[0].username, 'co_owner');
    assert.equal((await a.next('join')).m.username, 'co_mate');
    res = await fetch(snapUrl(0), {headers: {Authorization: `Bearer ${mate}`}});
    assert.deepEqual(await res.json(), {project: {targets: []}});
    r = await call('GET', `/projects/${pid}/collab`, {token: mate});
    assert.equal(r.body.live, true);
    assert.equal(r.body.members.length, 2);

    // Ops are numbered, acked to the sender and relayed to everyone else.
    a.send({t: 'op', c: '1', ops: [{k: 'b', e: {type: 'create'}}]});
    assert.deepEqual(await a.next('ack'), {t: 'ack', c: '1', s: 1});
    let ops = await b.next('ops');
    assert.equal(ops.s, 1);
    assert.equal(ops.u, seed.you.u);
    b.send({t: 'op', c: '1', ops: [{k: 'x'}]});
    assert.equal((await b.next('ack')).s, 2);
    assert.equal((await a.next('ops')).s, 2);
    // Resending the same batch (after a reconnect) doesn't apply it twice.
    a.send({t: 'op', c: '1', ops: [{k: 'b', e: {type: 'create'}}]});
    assert.equal((await a.next('ack')).s, 1);
    // Presence is relayed, not numbered.
    a.send({t: 'p', tg: 'Sprite1', x: 10, y: 20});
    const p = await b.next('p');
    assert.equal(p.tg, 'Sprite1');
    assert.equal(p.u, seed.you.u);

    // A dropped connection resumes from where it was.
    b.ws.close();
    await b.closed;
    assert.equal((await a.next('leave')).u, wb.you.u);
    a.send({t: 'op', c: '2', ops: [{k: 'y'}]});
    await a.next('ack');
    const b2 = await connect(mate, {key: 'B', resume: {session: seed.session, last: 2}});
    const wb2 = await b2.next('welcome');
    assert.equal(wb2.mode, 'resume');
    ops = await b2.next('ops');
    assert.equal(ops.s, 3);

    // Checksums: when two editors disagree at the same point, both are told to resync.
    a.send({t: 'sum', s: 3, h: 'aaa'});
    b2.send({t: 'sum', s: 3, h: 'bbb'});
    assert.equal((await a.next('resync')).at, 3);
    assert.equal((await b2.next('resync')).at, 3);

    // Removing a collaborator kicks them out of the room.
    await call('DELETE', `/projects/${pid}/collaborators/co_mate`, {token: owner});
    assert.equal((await b2.next('error')).code, 'removed');
    assert.equal(await b2.closed, 4003);

    // Last one out ends the session and deletes its snapshots.
    a.ws.close();
    await a.closed;
    await new Promise(ok => setTimeout(ok, 100));
    assert.equal((await call('GET', `/projects/${pid}/collab`, {token: owner})).body.live, false);
    assert.equal((await fetch(snapUrl(0), {headers: {Authorization: `Bearer ${owner}`}})).status, 404);
});
