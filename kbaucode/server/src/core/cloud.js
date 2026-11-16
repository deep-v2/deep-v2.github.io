// Cloud variable protocol (compatible with TurboWarp's / Scratch's cloud clients).
// Messages are newline-delimited JSON: handshake, set, create, delete, rename.
export const MAX_VARS = 40;
export const MAX_VALUE = 100000;
export const isCloudName = n => typeof n === 'string' && n.startsWith('☁ ') && n.length <= 1024;

/**
 * Handle one incoming frame from a client that has already completed its handshake.
 * @param {string} raw the frame text
 * @param {object} store {count(), has(name), set(name, value), remove(name), rename(from, to)} (may be async)
 * @param {function} broadcast called with an outgoing message object for every other client
 * @param {object} bucket per-connection rate limit state {tokens, last}
 * @returns {Promise<string|null>} 'close' if the client must be disconnected
 */
export const handleCloudFrame = async (raw, store, broadcast, bucket) => {
    for (const line of String(raw).split('\n')) {
        if (!line.trim()) continue;
        const now = Date.now();
        bucket.tokens = Math.min(20, bucket.tokens + (now - bucket.last) / 100); // ~10 msg/s sustained
        bucket.last = now;
        if (bucket.tokens < 1) continue;
        bucket.tokens--;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return 'close';
        }
        if (msg.method === 'handshake' || !isCloudName(msg.name)) continue;
        if (msg.method === 'set' || msg.method === 'create') {
            const value = String(msg.value ?? '');
            if (value.length > MAX_VALUE) continue;
            if (!(await store.has(msg.name)) && (await store.count()) >= MAX_VARS) continue;
            await store.set(msg.name, value);
            broadcast({method: 'set', name: msg.name, value});
        } else if (msg.method === 'delete') {
            await store.remove(msg.name);
        } else if (msg.method === 'rename' && isCloudName(msg.new_name)) {
            await store.rename(msg.name, msg.new_name);
        }
    }
    return null;
};

/** Parse the first frame; returns the project id string or null. */
export const parseHandshake = raw => {
    const line = String(raw).split('\n').find(l => l.trim());
    try {
        const msg = JSON.parse(line);
        if (msg.method !== 'handshake') return null;
        const id = String(msg.project_id ?? '');
        return /^\d+$/.test(id) ? id : null;
    } catch (e) {
        return null;
    }
};

export const encodeVars = vars => vars.map(v => JSON.stringify({method: 'set', name: v.name, value: v.value})).join('\n') + '\n';
