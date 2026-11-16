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
        env: {...process.env, PORT: String(port), HOST: '127.0.0.1', KBAU_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1'},
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

const call = async (method, p, {token, json, form} = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
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
    r = await call('PATCH', `/projects/${projectId}`, {token: alice, json: {description: 'Fly around', instructions: 'Arrow keys'}});
    assert.equal(r.body.project.description, 'Fly around');
    r = await call('POST', `/projects/${projectId}/share`, {token: alice});
    assert.equal(r.body.project.shared, true);
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
