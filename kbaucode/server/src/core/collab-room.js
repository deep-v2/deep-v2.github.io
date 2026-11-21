// Live collaboration room: one per project, shared by the Cloudflare Durable Object and the Node server.
//
// The room is the sequencer. Editors send batches of edits ("ops"); the room numbers each batch (seq),
// acknowledges it to the sender and relays it to everyone else, so every editor applies the same edits
// in the same order. Nothing here understands Scratch: ops are opaque JSON.
//
// Joining: the first person in seeds the room by uploading a snapshot of their project (HTTP, gzipped)
// and saying {t:'seed'}. Everyone after that loads the latest snapshot and replays the log since it.
// When the log grows, the room asks one editor for a fresh snapshot (compaction) and drops old entries.
// A dropped connection can resume (replay only what it missed) if the room still has those entries.
// Editors report a checksum of their state now and then; anyone who disagrees with the majority is
// told to resync (reload from snapshot + log), so the room heals itself if two edits ever raced.
//
// conn: {send(text), close(code, reason)}

export const COLLAB_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#20c997', '#f06595', '#94d82d', '#5c7cfa'];
export const MAX_MEMBERS = 12;
const COMPACT_BYTES = 1500 * 1024;
const COMPACT_COUNT = 3000;
const SNAPSHOT_TIMEOUT_MS = 90 * 1000;
const MAX_PRESENCE = 2048;

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

export class CollabRoom {
    /**
     * @param {object} opts options
     * @param {string|number} opts.projectId project id
     * @param {function(string, number): Promise} [opts.deleteSnapshot] remove a stored snapshot (session, rev)
     * @param {function(): number} [opts.now] clock
     */
    constructor ({projectId, deleteSnapshot = async () => {}, now = () => Date.now()}) {
        this.projectId = String(projectId);
        this.deleteSnapshot = deleteSnapshot;
        this.now = now;
        this.conns = new Map(); // conn -> member
        this.session = null;
        this.nextCid = 1;
    }

    get size () {
        return this.conns.size;
    }

    _public (m) {
        return {u: m.cid, uid: m.uid, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl, color: m.color, tg: m.tg};
    }

    _send (conn, msg) {
        try {
            conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
        } catch (e) {
            // closed; the platform will call leave()
        }
    }

    _broadcast (text, except) {
        for (const [conn, m] of this.conns) {
            if (conn !== except && m.welcomed) this._send(conn, text);
        }
    }

    _host () {
        let host = null;
        for (const m of this.conns.values()) {
            if (m.welcomed && (!host || m.cid < host.cid)) host = m;
        }
        return host;
    }

    _members () {
        return [...this.conns.values()].filter(m => m.welcomed).map(m => this._public(m));
    }

    /** For the API: is anyone editing live, and who. */
    status () {
        const live = !!(this.session && this.session.seeded);
        return {live, members: live ? this._members().map(({u, ...rest}) => rest) : []};
    }

    /**
     * A user passed authorization and sent hello.
     * @param {object} conn connection
     * @param {object} user {id, username, displayName, avatarUrl}
     * @param {object} hello {key, resume: {session, last}}
     */
    join (conn, user, hello = {}) {
        if (this.conns.size >= MAX_MEMBERS) {
            this._send(conn, {t: 'error', code: 'full', message: `This live session is full (${MAX_MEMBERS} people).`});
            conn.close(4004, 'Room full');
            return;
        }
        const used = new Set([...this.conns.values()].map(m => m.color));
        const color = COLLAB_COLORS.find(c => !used.has(c)) || COLLAB_COLORS[this.nextCid % COLLAB_COLORS.length];
        const m = {
            cid: this.nextCid++, uid: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl,
            color, key: String(hello.key || randomId()).slice(0, 40), welcomed: false, tg: null,
            tokens: 400, last: this.now()
        };
        this.conns.set(conn, m);
        if (!this.session) {
            this.session = {
                id: randomId(), seq: 0, seeded: false, seeder: conn, snapRev: null, prevSnapRev: null,
                log: [], logBytes: 0, floor: 0, seen: new Map(), sums: new Map(), snapReq: null, snapReqAt: 0
            };
            this._send(conn, {t: 'welcome', mode: 'seed', session: this.session.id, you: this._public(m), members: []});
        } else if (!this.session.seeded) {
            this._send(conn, {t: 'wait'});
        } else {
            this._welcome(conn, hello.resume);
        }
    }

    _welcome (conn, resume) {
        const s = this.session;
        const m = this.conns.get(conn);
        const announce = !m.welcomed;
        m.welcomed = true;
        const base = {t: 'welcome', session: s.id, you: this._public(m), members: this._members().filter(x => x.u !== m.cid),
            host: this._host().cid, seq: s.seq};
        let from;
        if (resume && resume.session === s.id && Number.isInteger(resume.last) && resume.last >= s.floor && resume.last <= s.seq) {
            this._send(conn, {...base, mode: 'resume'});
            from = resume.last;
        } else {
            this._send(conn, {...base, mode: 'load', snapRev: s.snapRev});
            from = s.snapRev;
        }
        for (const e of s.log) if (e.s > from) this._send(conn, e.text);
        if (announce) this._broadcast(JSON.stringify({t: 'join', m: this._public(m)}), conn);
    }

    /**
     * @param {object} conn connection
     * @param {string} text message
     */
    message (conn, text) {
        const m = this.conns.get(conn);
        if (!m || !this.session) return;
        let msg;
        try {
            msg = JSON.parse(text);
        } catch (e) {
            conn.close(4000, 'Bad message');
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        const s = this.session;
        switch (msg.t) {
        case 'op': {
            if (!m.welcomed || !Array.isArray(msg.ops) || !msg.ops.length) return;
            // Generous bucket (~100 batches/s sustained). Ops can't be dropped without breaking everyone's copy,
            // so a client that floods is disconnected instead; it reconnects and resumes.
            const t = this.now();
            m.tokens = Math.min(400, m.tokens + (t - m.last) / 10);
            m.last = t;
            if (--m.tokens < 0) {
                conn.close(4005, 'Too many edits');
                return;
            }
            const c = String(msg.c ?? '').slice(0, 40);
            const dedupe = `${m.key}:${c}`;
            if (c && s.seen.has(dedupe)) {
                this._send(conn, {t: 'ack', c, s: s.seen.get(dedupe)});
                return;
            }
            const seq = ++s.seq;
            const entry = {s: seq, text: JSON.stringify({t: 'ops', s: seq, u: m.cid, ops: msg.ops})};
            s.log.push(entry);
            s.logBytes += entry.text.length;
            if (c) {
                s.seen.set(dedupe, seq);
                if (s.seen.size > 5000) s.seen.delete(s.seen.keys().next().value);
            }
            this._send(conn, {t: 'ack', c, s: seq});
            this._broadcast(entry.text, conn);
            this._maybeCompact();
            return;
        }
        case 'p': {
            // Presence (cursor, which sprite): relayed, never stored.
            if (!m.welcomed || text.length > MAX_PRESENCE) return;
            if (typeof msg.tg === 'string' || msg.tg === null) m.tg = msg.tg;
            this._broadcast(JSON.stringify({...msg, t: 'p', u: m.cid}), conn);
            return;
        }
        case 'seed': {
            if (conn !== s.seeder || s.seeded) return;
            s.seeded = true;
            s.snapRev = 0;
            s.floor = 0;
            this._welcomeSeeder(conn);
            for (const [other, om] of this.conns) {
                if (other !== conn && !om.welcomed) this._welcome(other, null);
            }
            return;
        }
        case 'snap': {
            const rev = Number(msg.rev);
            if (s.snapReq !== conn || !Number.isInteger(rev) || rev <= (s.snapRev ?? -1) || rev > s.seq) return;
            const dropped = s.prevSnapRev;
            s.prevSnapRev = s.snapRev;
            s.snapRev = rev;
            // Keep entries after the previous snapshot: someone may still be loading it.
            s.floor = s.prevSnapRev;
            s.log = s.log.filter(e => e.s > s.floor);
            s.logBytes = s.log.reduce((n, e) => n + e.text.length, 0);
            s.snapReq = null;
            if (dropped !== null && dropped !== s.prevSnapRev) this.deleteSnapshot(s.id, dropped).catch(() => {});
            return;
        }
        case 'sum': {
            const at = Number(msg.s);
            const h = String(msg.h || '').slice(0, 64);
            if (!m.welcomed || !Number.isInteger(at) || at > s.seq || !h) return;
            let rec = s.sums.get(at);
            if (!rec) {
                rec = new Map();
                s.sums.set(at, rec);
                if (s.sums.size > 64) s.sums.delete(s.sums.keys().next().value);
            }
            if (!rec.has(h)) rec.set(h, new Set());
            rec.get(h).add(conn);
            if (rec.size > 1) {
                // Disagreement: everyone outside the largest group reloads from snapshot + log
                // (ties: everyone does, which is always safe).
                const groups = [...rec.values()].sort((a, b) => b.size - a.size);
                const keep = groups[0].size > groups[1].size ? groups[0] : null;
                for (const g of groups) {
                    if (g === keep) continue;
                    for (const c2 of g) if (this.conns.has(c2)) this._send(c2, {t: 'resync', at});
                }
                s.sums.delete(at);
            }
            return;
        }
        case 'rejoin': {
            if (m.welcomed && s.seeded) this._welcome(conn, null);
            return;
        }
        default:
        }
    }

    _welcomeSeeder (conn) {
        const m = this.conns.get(conn);
        m.welcomed = true;
        this._send(conn, {t: 'seeded', session: this.session.id, host: m.cid, seq: this.session.seq});
    }

    _maybeCompact () {
        const s = this.session;
        if (!s || !s.seeded) return;
        const since = s.log.filter(e => e.s > s.snapRev);
        if (since.length < COMPACT_COUNT && s.logBytes < COMPACT_BYTES) return;
        if (s.snapReq && this.conns.has(s.snapReq) && this.now() - s.snapReqAt < SNAPSHOT_TIMEOUT_MS) return;
        const host = this._host();
        if (!host) return;
        const conn = [...this.conns].find(([, m]) => m === host)[0];
        s.snapReq = conn;
        s.snapReqAt = this.now();
        this._send(conn, {t: 'snapreq'});
    }

    /** Disconnect everyone signed in as this user (they lost access). */
    kick (uid) {
        for (const [conn, m] of this.conns) {
            if (m.uid === uid) {
                this._send(conn, {t: 'error', code: 'removed', message: 'You were removed from this project.'});
                conn.close(4003, 'Removed');
            }
        }
    }

    leave (conn) {
        const m = this.conns.get(conn);
        if (!m) return;
        this.conns.delete(conn);
        const s = this.session;
        if (!s) return;
        if (!this.conns.size) {
            // Last one out: the session ends (the project itself is whatever was last saved).
            for (const rev of [s.snapRev, s.prevSnapRev]) {
                if (rev !== null) this.deleteSnapshot(s.id, rev).catch(() => {});
            }
            this.session = null;
            return;
        }
        if (m.welcomed) this._broadcast(JSON.stringify({t: 'leave', u: m.cid}));
        if (!s.seeded && s.seeder === conn) {
            // The seeder left before uploading: the next person in line seeds instead.
            const [next, nm] = [...this.conns][0];
            s.seeder = next;
            this._send(next, {t: 'welcome', mode: 'seed', session: s.id, you: this._public(nm), members: []});
            return;
        }
        if (s.snapReq === conn) {
            s.snapReq = null;
            this._maybeCompact();
        }
        const host = this._host();
        if (host && m.welcomed) this._broadcast(JSON.stringify({t: 'host', u: host.cid}));
    }
}
