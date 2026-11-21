// Direct messages, message requests, pinned chats, blocking and private nicknames.
//
// Rules:
// - Friends (people who follow each other) can always message each other.
// - Anyone else starts a message request. They can send up to the recipient's dm_request_limit messages
//   (Settings > Privacy, 0 = friends only) until the recipient accepts; the sender is told how many are left.
// - The recipient can accept (or simply reply), decline (the sender isn't told; they just can't send more), or block.
// - Blocking works both ways: no messages, no follows, and the blocked person can't comment on your projects.
// - Nicknames are only visible to the person who set them, and can only be given to friends.

const MAX_MESSAGE = 2000;
const MAX_NICKNAME = 32;
const MAX_PINS = 10;
export const MAX_REQUEST_LIMIT = 20;

export const registerMessaging = ({
    route, db, HttpError, now, requireUser, getUserByName, userOut, rateLimit, checkText, clampText, relationship
}) => {
    const pair = (a, b) => (a < b ? [a, b] : [b, a]);
    const getConv = (meId, otherId) => db.get('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?', ...pair(meId, otherId));
    const blockState = async (meId, otherId) => {
        const r = await db.get(`SELECT
            EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS by_me,
            EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS by_them`, meId, otherId, otherId, meId);
        return {byMe: !!r.by_me, byThem: !!r.by_them};
    };
    const nicknameOf = async (meId, otherId) => {
        const r = await db.get('SELECT nickname FROM nicknames WHERE owner_id = ? AND target_id = ?', meId, otherId);
        return r ? r.nickname : null;
    };
    /** Adds the viewer's private nickname to each user object. */
    const withNicknames = async (viewerId, users) => {
        if (!viewerId || !users.length) return users;
        const rows = await db.all(`SELECT target_id, nickname FROM nicknames WHERE owner_id = ? AND target_id IN (${users.map(() => '?').join(',')})`,
            viewerId, ...users.map(u => u.id));
        const map = new Map(rows.map(r => [r.target_id, r.nickname]));
        return users.map(u => (map.has(u.id) ? {...u, nickname: map.get(u.id)} : u));
    };
    const otherUser = async (ctx, me) => {
        const other = await getUserByName(ctx.params.username);
        if (other.id === me.id) throw new HttpError(400, 'You can\'t message yourself.');
        return other;
    };
    const member = (convId, userId) => db.get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', convId, userId);

    /** Everything the chat screen needs to know about what the viewer may do. */
    const chatState = async (me, other, conv) => {
        const rel = await relationship(me.id, other.id);
        const blocks = await blockState(me.id, other.id);
        const name = other.display_name || other.username;
        let status = 'none';
        if (conv) {
            if (conv.status === 'accepted' || rel.friends) status = 'accepted';
            else if (conv.requester_id === me.id) status = 'request-sent';
            else status = conv.status === 'declined' ? 'declined' : 'request-received';
        } else if (rel.friends) {
            status = 'accepted';
        }
        const limit = Math.max(0, Math.min(MAX_REQUEST_LIMIT, other.dm_request_limit ?? 3));
        let sent = 0;
        if (status === 'request-sent') {
            sent = (await db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id = ?', conv.id, me.id)).n;
        }
        const pending = status === 'none' || status === 'request-sent';
        const remaining = pending ? Math.max(0, limit - sent) : null;
        let reason = null;
        let notice = null;
        if (blocks.byMe) {
            reason = 'blocked';
            notice = `You blocked ${name}. Unblock them to send messages.`;
        } else if (blocks.byThem || other.banned) {
            reason = 'unavailable';
            notice = 'You can\'t message this person.';
        } else if (status === 'declined') {
            reason = 'declined';
            notice = `You declined ${name}'s message request.`;
        } else if (pending && limit === 0) {
            reason = 'friends-only';
            notice = `${name} only gets messages from friends. Follow each other to chat.`;
        } else if (pending && (remaining === 0 || (conv && conv.status === 'declined'))) {
            // A declined request looks the same as a full one to the sender.
            reason = 'limit';
            notice = `${name} hasn't accepted your message request yet. You can send more messages once they do.`;
        } else if (pending) {
            notice = status === 'none' ?
                `You aren't friends with ${name}, so this starts a message request. You can send ${remaining} message${remaining === 1 ? '' : 's'} until they accept it.` :
                `Waiting for ${name} to accept your message request. You can send ${remaining} more message${remaining === 1 ? '' : 's'} until then.`;
        } else if (status === 'request-received') {
            notice = `${name} wants to message you. They can't see whether you've read this until you accept. Replying also accepts.`;
        }
        const mine = conv ? await member(conv.id, me.id) : null;
        const theirs = conv ? await member(conv.id, other.id) : null;
        return {
            conversationId: conv ? conv.id : null,
            status,
            friends: rel.friends,
            canSend: !reason,
            reason,
            notice,
            remaining,
            limit,
            pinned: !!(mine && mine.pinned_at),
            blockedByMe: blocks.byMe,
            // "Seen" only once the chat is accepted, so requests can be read privately.
            otherLastReadId: status === 'accepted' && theirs ? theirs.last_read_id : 0
        };
    };

    const messageOut = m => ({
        id: m.id,
        senderId: m.sender_id,
        body: m.deleted || m.hidden ? '' : m.body,
        deleted: !!m.deleted,
        hidden: !!m.hidden,
        createdAt: m.created_at
    });

    /** The viewer's conversations, newest first, pinned ones on top. */
    const listConversations = async me => {
        const rows = await db.all(`SELECT c.*, m.pinned_at, m.last_read_id, m.cleared_id,
                CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END AS other_id,
                lm.body AS lm_body, lm.sender_id AS lm_sender, lm.deleted AS lm_deleted, lm.hidden AS lm_hidden,
                (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.sender_id != ?
                    AND x.deleted = 0) AS unread
            FROM conversation_members m
            JOIN conversations c ON c.id = m.conversation_id
            LEFT JOIN messages lm ON lm.id = c.last_message_id
            WHERE m.user_id = ? AND c.last_message_id > m.cleared_id
            ORDER BY (m.pinned_at IS NOT NULL) DESC, c.last_message_at DESC LIMIT 200`, me.id, me.id, me.id);
        if (!rows.length) return [];
        const ids = rows.map(r => r.other_id);
        const marks = ids.map(() => '?').join(',');
        const users = new Map((await db.all(`SELECT * FROM users WHERE id IN (${marks})`, ...ids)).map(u => [u.id, u]));
        const blocked = new Set((await db.all(`SELECT blocked_id FROM blocks WHERE blocker_id = ? AND blocked_id IN (${marks})`,
            me.id, ...ids)).map(r => r.blocked_id));
        const friendIds = new Set((await db.all(`SELECT a.followee_id AS id FROM follows a
            JOIN follows b ON b.follower_id = a.followee_id AND b.followee_id = a.follower_id
            WHERE a.follower_id = ? AND a.followee_id IN (${marks})`, me.id, ...ids)).map(r => r.id));
        const nicknames = new Map((await db.all(`SELECT target_id, nickname FROM nicknames WHERE owner_id = ? AND target_id IN (${marks})`,
            me.id, ...ids)).map(r => [r.target_id, r.nickname]));
        const out = [];
        for (const r of rows) {
            const o = users.get(r.other_id);
            if (!o || blocked.has(o.id)) continue;
            const friends = friendIds.has(o.id);
            let status = 'accepted';
            if (r.status !== 'accepted' && !friends) {
                if (r.requester_id === me.id) status = 'request-sent';
                else if (r.status === 'declined') continue;
                else status = 'request-received';
            }
            out.push({
                id: r.id,
                user: {...userOut(o), ...(nicknames.has(o.id) ? {nickname: nicknames.get(o.id)} : {})},
                status,
                friends,
                pinned: !!r.pinned_at,
                unread: r.unread,
                lastMessage: {
                    body: r.lm_deleted || r.lm_hidden ? '' : r.lm_body,
                    deleted: !!r.lm_deleted,
                    hidden: !!r.lm_hidden,
                    fromMe: r.lm_sender === me.id,
                    createdAt: r.last_message_at
                }
            });
        }
        return out;
    };

    route('GET', '/messages/conversations', async ctx => {
        const me = requireUser(ctx);
        const all = await listConversations(me);
        const box = ctx.query.get('box') === 'requests' ? 'requests' : 'chats';
        return {
            conversations: all.filter(c => (box === 'requests') === (c.status === 'request-received')),
            requestCount: all.filter(c => c.status === 'request-received').length
        };
    });
    // Header badge: chats with unread messages, and new message requests.
    route('GET', '/messages/unread', async ctx => {
        const me = requireUser(ctx);
        const all = await listConversations(me);
        return {
            unread: all.filter(c => c.status !== 'request-received' && c.unread > 0).length,
            requests: all.filter(c => c.status === 'request-received').length
        };
    });

    // One chat: the other person, what you can do, and messages (newest 50, or before/after a message id).
    route('GET', '/messages/with/:username', async ctx => {
        const me = requireUser(ctx);
        const other = await otherUser(ctx, me);
        const conv = await getConv(me.id, other.id);
        const state = await chatState(me, other, conv);
        let messages = [];
        if (conv) {
            const mine = await member(conv.id, me.id);
            const before = Number(ctx.query.get('before')) || 0;
            const after = Number(ctx.query.get('after')) || 0;
            const limit = Math.max(1, Math.min(100, Number(ctx.query.get('limit')) || 50));
            if (after) {
                messages = await db.all(`SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND id > ?
                    ORDER BY id ASC LIMIT ?`, conv.id, mine.cleared_id, after, limit);
            } else {
                messages = (await db.all(`SELECT * FROM messages WHERE conversation_id = ? AND id > ? ${before ? 'AND id < ?' : ''}
                    ORDER BY id DESC LIMIT ?`, conv.id, mine.cleared_id, ...(before ? [before] : []), limit)).reverse();
            }
        }
        const [user] = await withNicknames(me.id, [userOut(other)]);
        return {user, state, messages: messages.map(messageOut)};
    });

    route('POST', '/messages/with/:username', async ctx => {
        const me = requireUser(ctx);
        await rateLimit(`dm:${me.id}`, 30, 60_000);
        const other = await otherUser(ctx, me);
        const {body} = await ctx.json();
        const text = clampText(body, MAX_MESSAGE, 'message');
        if (!text || !text.trim()) throw new HttpError(400, 'Write something first.');
        let conv = await getConv(me.id, other.id);
        const state = await chatState(me, other, conv);
        if (!state.canSend) throw new HttpError(403, state.notice, state.reason);
        await checkText(ctx, [[text, 'message']]);
        const t = now();
        if (!conv) {
            const [a, b] = pair(me.id, other.id);
            await db.run(`INSERT INTO conversations (user_a, user_b, status, requester_id, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING`, a, b, state.friends ? 'accepted' : 'request', me.id, t);
            conv = await getConv(me.id, other.id);
            for (const uid of [a, b]) {
                await db.run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', conv.id, uid);
            }
        } else if (conv.status !== 'accepted' && (state.friends || state.status === 'request-received')) {
            // Friends, or replying to a request: the chat is accepted.
            await db.run('UPDATE conversations SET status = \'accepted\' WHERE id = ?', conv.id);
        }
        const r = await db.run('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)',
            conv.id, me.id, text.trim(), t);
        await db.run('UPDATE conversations SET last_message_id = ?, last_message_at = ? WHERE id = ?', r.lastId, t, conv.id);
        await db.run('UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?', r.lastId, conv.id, me.id);
        conv = await getConv(me.id, other.id);
        ctx.status = 201;
        return {
            message: messageOut(await db.get('SELECT * FROM messages WHERE id = ?', r.lastId)),
            state: await chatState(me, other, conv)
        };
    });

    const withConv = handler => async ctx => {
        const me = requireUser(ctx);
        const other = await otherUser(ctx, me);
        const conv = await getConv(me.id, other.id);
        if (!conv) throw new HttpError(404, 'No conversation yet.');
        await handler(ctx, me, other, conv);
        return {state: await chatState(me, other, await getConv(me.id, other.id))};
    };
    route('POST', '/messages/with/:username/read', withConv(async (ctx, me, other, conv) => {
        await db.run('UPDATE conversation_members SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?',
            conv.last_message_id, conv.id, me.id);
    }));
    route('POST', '/messages/with/:username/accept', withConv(async (ctx, me, other, conv) => {
        if (conv.requester_id === me.id && conv.status !== 'accepted') throw new HttpError(400, 'Only the other person can accept this request.');
        await db.run('UPDATE conversations SET status = \'accepted\' WHERE id = ?', conv.id);
    }));
    route('POST', '/messages/with/:username/decline', withConv(async (ctx, me, other, conv) => {
        if (conv.status === 'accepted' || conv.requester_id === me.id) throw new HttpError(400, 'There is no request to decline.');
        await db.run('UPDATE conversations SET status = \'declined\' WHERE id = ?', conv.id);
        await db.run('UPDATE conversation_members SET cleared_id = ?, pinned_at = NULL WHERE conversation_id = ? AND user_id = ?',
            conv.last_message_id, conv.id, me.id);
    }));
    const setPin = on => withConv(async (ctx, me, other, conv) => {
        if (on) {
            const {n} = await db.get('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ? AND pinned_at IS NOT NULL', me.id);
            if (n >= MAX_PINS) throw new HttpError(400, `You can pin up to ${MAX_PINS} chats.`);
        }
        await db.run('UPDATE conversation_members SET pinned_at = ? WHERE conversation_id = ? AND user_id = ?', on ? now() : null, conv.id, me.id);
    });
    route('PUT', '/messages/with/:username/pin', setPin(true));
    route('DELETE', '/messages/with/:username/pin', setPin(false));
    // Delete the chat for yourself (it comes back if a new message arrives).
    route('DELETE', '/messages/with/:username', withConv(async (ctx, me, other, conv) => {
        await db.run('UPDATE conversation_members SET cleared_id = ?, pinned_at = NULL WHERE conversation_id = ? AND user_id = ?',
            conv.last_message_id, conv.id, me.id);
    }));
    // Unsend one of your messages.
    route('DELETE', '/messages/:id', async ctx => {
        const me = requireUser(ctx);
        const m = await db.get('SELECT * FROM messages WHERE id = ?', Number(ctx.params.id));
        if (!m || m.sender_id !== me.id) throw new HttpError(404, 'Message not found.');
        // Hidden from both people; the text is kept only so moderators can still act on a report.
        await db.run('UPDATE messages SET deleted = 1 WHERE id = ?', m.id);
        return {message: messageOut({...m, deleted: 1})};
    });

    // Blocking
    route('POST', '/users/:username/block', async ctx => {
        const me = requireUser(ctx);
        const other = await getUserByName(ctx.params.username);
        if (other.id === me.id) throw new HttpError(400, 'You can\'t block yourself.');
        await db.run('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', me.id, other.id, now());
        await db.run('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)',
            me.id, other.id, other.id, me.id);
        const conv = await getConv(me.id, other.id);
        if (conv) await db.run('UPDATE conversation_members SET pinned_at = NULL WHERE conversation_id = ? AND user_id = ?', conv.id, me.id);
        return {relationship: await relationship(me.id, other.id)};
    });
    route('DELETE', '/users/:username/block', async ctx => {
        const me = requireUser(ctx);
        const other = await getUserByName(ctx.params.username);
        await db.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', me.id, other.id);
        return {relationship: await relationship(me.id, other.id)};
    });

    // Private nicknames for friends
    route('PUT', '/users/:username/nickname', async ctx => {
        const me = requireUser(ctx);
        const other = await getUserByName(ctx.params.username);
        const {nickname} = await ctx.json();
        const text = (clampText(nickname, MAX_NICKNAME, 'nickname') || '').trim();
        if (!text) {
            await db.run('DELETE FROM nicknames WHERE owner_id = ? AND target_id = ?', me.id, other.id);
        } else {
            if (!(await relationship(me.id, other.id)).friends) throw new HttpError(403, 'You can only give nicknames to friends.');
            await db.run(`INSERT INTO nicknames (owner_id, target_id, nickname, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(owner_id, target_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at`,
            me.id, other.id, text, now());
        }
        return {nickname: text || null};
    });

    // Settings > Privacy
    route('GET', '/users/me/privacy', async ctx => {
        const me = requireUser(ctx);
        const blocked = await db.all(`SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id
            WHERE b.blocker_id = ? ORDER BY b.created_at DESC`, me.id);
        return {dmRequestLimit: me.dm_request_limit ?? 3, maxRequestLimit: MAX_REQUEST_LIMIT, blocked: blocked.map(userOut)};
    });
    route('PATCH', '/users/me/privacy', async ctx => {
        const me = requireUser(ctx);
        const {dmRequestLimit} = await ctx.json();
        const n = Number(dmRequestLimit);
        if (!Number.isInteger(n) || n < 0 || n > MAX_REQUEST_LIMIT) {
            throw new HttpError(400, `dmRequestLimit must be a whole number from 0 to ${MAX_REQUEST_LIMIT}.`);
        }
        await db.run('UPDATE users SET dm_request_limit = ? WHERE id = ?', n, me.id);
        return {dmRequestLimit: n};
    });

    return {blockState, nicknameOf, withNicknames};
};
