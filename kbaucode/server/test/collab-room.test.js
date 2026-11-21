// Collab room unit tests (no server needed): long sessions, log compaction, resume limits.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CollabRoom} from '../src/core/collab-room.js';

test('collab room compacts its edit log in long sessions', () => {
    const deleted = [];
    let t = 0;
    const room = new CollabRoom({projectId: 1, deleteSnapshot: async (s, rev) => deleted.push(rev), now: () => (t += 20)});
    const conn = name => {
        const c = {name, inbox: [], send: t => c.inbox.push(JSON.parse(t)), close: () => {}};
        return c;
    };
    const last = (c, t) => [...c.inbox].reverse().find(m => m.t === t);
    const a = conn('a');
    room.join(a, {id: 1, username: 'a', displayName: 'A'}, {key: 'ka'});
    assert.equal(last(a, 'welcome').mode, 'seed');
    room.message(a, JSON.stringify({t: 'seed'}));
    assert.ok(last(a, 'seeded'));
    const b = conn('b');
    room.join(b, {id: 2, username: 'b', displayName: 'B'}, {key: 'kb'});
    assert.equal(last(b, 'welcome').mode, 'load');

    for (let i = 1; i <= 3000; i++) room.message(a, JSON.stringify({t: 'op', c: String(i), ops: [{k: 'b', n: i}]}));
    assert.ok(last(a, 'snapreq'), 'the host is asked for a snapshot after 3000 edits');
    assert.equal(b.inbox.filter(m => m.t === 'ops').length, 3000, 'everyone else got every edit');
    room.message(a, JSON.stringify({t: 'snap', rev: 2990}));
    assert.equal(room.session.snapRev, 2990);
    assert.equal(room.session.log.length, 3000, 'entries after the previous snapshot (rev 0) are kept for people still loading it');
    // Second compaction drops entries up to the first snapshot and deletes the oldest snapshot file.
    for (let i = 3001; i <= 6000; i++) room.message(a, JSON.stringify({t: 'op', c: String(i), ops: [{k: 'b', n: i}]}));
    room.message(a, JSON.stringify({t: 'snap', rev: 5995}));
    assert.equal(room.session.prevSnapRev, 2990);
    assert.ok(room.session.log.every(e => e.s > 2990));
    assert.deepEqual(deleted, [0], 'snapshot 0 is deleted once two newer ones exist');
    // Someone joining now loads snapshot 5995 and gets only the edits after it.
    const c = conn('c');
    room.join(c, {id: 3, username: 'c', displayName: 'C'}, {key: 'kc'});
    assert.equal(last(c, 'welcome').snapRev, 5995);
    assert.equal(c.inbox.filter(m => m.t === 'ops').length, 5);
    // Resuming from before the kept log falls back to a full load.
    const b2 = conn('b2');
    room.leave(b);
    room.join(b2, {id: 2, username: 'b', displayName: 'B'}, {key: 'kb', resume: {session: room.session.id, last: 100}});
    assert.equal(last(b2, 'welcome').mode, 'load');
    // Last one out deletes the remaining snapshots.
    room.leave(a);
    room.leave(c);
    room.leave(b2);
    assert.equal(room.session, null);
    assert.deepEqual(deleted.sort((x, y) => x - y), [0, 2990, 5995]);
});
