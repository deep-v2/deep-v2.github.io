// Messages: direct messages between users, message requests, pinned chats. AGPL-3.0-or-later.
import {
    $, api, avatarEl, boot, errorNotice, h, link, modal, offlineNotice, param, refreshMessageBadge, toast, userName
} from '../ui.js';

const main = $('#main');
const POLL_CHAT_MS = 4000;
const POLL_LIST_MS = 15000;
const MAX_MESSAGE = 2000;

const ICONS = {
    pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/></svg>'
};

const shortTime = ms => {
    const d = new Date(ms);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    const diffDays = (today - d) / 86400000;
    if (diffDays < 6) return d.toLocaleDateString([], {weekday: 'short'});
    return d.toLocaleDateString([], {month: 'short', day: 'numeric'});
};
const dayLabel = ms => {
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'});
};
// replaceChildren() would print null/false as text; h() skips them, and so does this.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
const displayOf = u => u.nickname || u.displayName || u.username;

// Message text with clickable links (built as nodes, never as HTML).
const linkify = text => {
    const out = [];
    const re = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index));
        out.push(h('a', {href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow'}, m[0]));
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
};

(async () => {
    const {user: me, online} = await boot('messages');
    if (!online) return main.append(offlineNotice());
    if (!me) {
        location.href = link('login', {next: location.pathname + location.search});
        return;
    }

    let box = param('box') === 'requests' ? 'requests' : 'chats';
    let current = param('u');
    let conversations = [];
    let requestCount = 0;

    // ---------- layout ----------
    const listEl = h('div', {class: 'dm-list', role: 'list'});
    const filter = h('input', {type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats'});
    const tabChats = h('button', {type: 'button'}, 'Chats');
    const reqBadge = h('span', {class: 'dm-count', hidden: true});
    const tabReqs = h('button', {type: 'button'}, 'Requests', reqBadge);
    const sidebar = h('aside', {class: 'dm-sidebar'},
        h('div', {class: 'dm-sidebar-head'},
            h('h1', {}, 'Messages'),
            h('button', {class: 'btn small primary dm-new', type: 'button', html: ICONS.edit, title: 'New message', onclick: () => newMessage()},
                h('span', {}, 'New'))),
        h('div', {class: 'dm-tabs', role: 'tablist'}, tabChats, tabReqs),
        h('div', {class: 'dm-filter'}, filter),
        listEl);
    const pane = h('section', {class: 'dm-pane'});
    const shell = h('div', {class: 'dm'}, sidebar, pane);
    main.classList.add('dm-main');
    main.append(shell);

    tabChats.addEventListener('click', () => setBox('chats'));
    tabReqs.addEventListener('click', () => setBox('requests'));
    filter.addEventListener('input', () => renderList());
    const setBox = async b => {
        box = b;
        await loadList();
    };

    const setUrl = () => {
        const u = new URL(location.href);
        if (current) u.searchParams.set('u', current);
        else u.searchParams.delete('u');
        if (box === 'requests') u.searchParams.set('box', 'requests');
        else u.searchParams.delete('box');
        history.replaceState(null, '', u);
    };

    // ---------- conversation list ----------
    const loadList = async () => {
        try {
            const r = await api.get(`/messages/conversations${box === 'requests' ? '?box=requests' : ''}`);
            conversations = r.conversations;
            requestCount = r.requestCount;
        } catch (e) {
            fill(listEl, errorNotice(e));
            return;
        }
        renderList();
    };
    const renderList = () => {
        tabChats.className = box === 'chats' ? 'active' : '';
        tabReqs.className = box === 'requests' ? 'active' : '';
        tabChats.setAttribute('aria-selected', String(box === 'chats'));
        tabReqs.setAttribute('aria-selected', String(box === 'requests'));
        reqBadge.hidden = !requestCount;
        reqBadge.textContent = String(requestCount);
        const term = filter.value.trim().toLowerCase();
        const shown = conversations.filter(c => !term ||
            `${c.user.username} ${c.user.displayName} ${c.user.nickname || ''}`.toLowerCase().includes(term));
        if (!shown.length) {
            fill(listEl, h('div', {class: 'dm-empty-list muted small'},
                term ? 'No chats match.' :
                    box === 'requests' ? 'No message requests. When someone who isn\'t your friend messages you, it shows up here.' :
                        'No chats yet. Message a friend, or start a message request.'));
            return;
        }
        const pinned = shown.filter(c => c.pinned);
        const rest = shown.filter(c => !c.pinned);
        const item = c => {
            const lm = c.lastMessage;
            const preview = lm.deleted ? 'Message unsent' : lm.hidden ? 'Message removed' : lm.body;
            return h('a', {
                class: `dm-item${c.user.username === current ? ' selected' : ''}${c.unread ? ' unread' : ''}`,
                href: link('messages', {u: c.user.username}),
                role: 'listitem',
                onclick: e => {
                    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                    e.preventDefault();
                    openChat(c.user.username);
                }
            },
            avatarEl(c.user),
            h('div', {class: 'dm-item-text'},
                h('div', {class: 'dm-item-top'},
                    h('b', {}, userName(c.user)),
                    c.pinned ? h('span', {class: 'dm-pin', title: 'Pinned', html: ICONS.pin}) : null,
                    h('span', {class: 'spacer'}),
                    h('span', {class: 'muted small'}, shortTime(lm.createdAt))),
                h('div', {class: 'dm-item-bottom'},
                    h('span', {class: 'dm-preview'}, lm.fromMe ? 'You: ' : '', preview),
                    c.status === 'request-sent' ? h('span', {class: 'badge'}, 'Request sent') : null,
                    c.unread ? h('span', {class: 'dm-count'}, c.unread > 99 ? '99+' : String(c.unread)) : null)));
        };
        fill(listEl,
            pinned.length ? h('div', {class: 'dm-section'}, 'Pinned') : null,
            ...pinned.map(item),
            pinned.length && rest.length ? h('div', {class: 'dm-section'}, 'All chats') : null,
            ...rest.map(item));
    };

    // ---------- one chat ----------
    let chat = null; // {username, user, state, messages, timer}
    const stopChat = () => {
        if (chat) clearInterval(chat.timer);
        chat = null;
    };
    const emptyPane = () => {
        stopChat();
        shell.classList.remove('chat-open');
        fill(pane, h('div', {class: 'dm-welcome'},
            h('div', {class: 'dm-welcome-icon', html: ICONS.chat}),
            h('h2', {}, 'Your messages'),
            h('p', {class: 'muted'}, 'Chat with your friends, or send anyone a message request.'),
            h('button', {class: 'btn primary', type: 'button', onclick: () => newMessage()}, 'New message')));
    };

    const openChat = async username => {
        stopChat();
        current = username;
        setUrl();
        renderList();
        shell.classList.add('chat-open');
        fill(pane, h('div', {class: 'dm-loading muted'}, 'Loading…'));
        let data;
        try {
            data = await api.get(`/messages/with/${encodeURIComponent(username)}`);
        } catch (e) {
            fill(pane, h('div', {class: 'dm-welcome'}, errorNotice(e)));
            return;
        }
        if (current !== username) return;
        chat = {username, user: data.user, state: data.state, messages: data.messages, hasOlder: data.messages.length >= 50};
        renderChat();
        markRead();
        chat.timer = setInterval(poll, POLL_CHAT_MS);
    };

    const markRead = async () => {
        if (!chat || !chat.state.conversationId || document.hidden) return;
        const last = chat.messages[chat.messages.length - 1];
        if (!last || last.senderId === me.id) return;
        try {
            await api.post(`/messages/with/${encodeURIComponent(chat.username)}/read`);
            const c = conversations.find(x => x.user.username === chat.username);
            if (c && c.unread) {
                c.unread = 0;
                renderList();
            }
            refreshMessageBadge();
        } catch (e) {
            // ignore
        }
    };

    const poll = async () => {
        if (!chat || document.hidden) return;
        const ref = chat;
        const lastId = ref.messages.length ? ref.messages[ref.messages.length - 1].id : 0;
        try {
            const data = await api.get(`/messages/with/${encodeURIComponent(ref.username)}?after=${lastId}`);
            if (chat !== ref) return;
            const fresh = data.messages.filter(m => !ref.messages.some(x => x.id === m.id));
            const stateChanged = JSON.stringify(data.state) !== JSON.stringify(ref.state);
            ref.state = data.state;
            if (fresh.length) {
                ref.messages.push(...fresh);
                appendMessages(fresh);
                markRead();
            }
            if (stateChanged) renderChrome();
            else updateSeen();
        } catch (e) {
            // try again next tick
        }
    };

    // Pieces of the chat view that get re-rendered.
    let els = {};
    const renderChat = () => {
        const u = chat.user;
        const nameEl = h('div', {class: 'dm-chat-name'}, userName(u));
        const sub = h('div', {class: 'muted small'});
        const pinBtn = h('button', {class: 'icon-btn', type: 'button', html: ICONS.pin});
        const moreBtn = h('button', {class: 'icon-btn', type: 'button', html: ICONS.more, 'aria-label': 'More', 'aria-haspopup': 'true'});
        const menu = h('div', {class: 'dropdown-menu hidden dm-menu'});
        moreBtn.addEventListener('click', e => {
            e.stopPropagation();
            buildMenu(menu);
            menu.classList.toggle('hidden');
        });
        document.addEventListener('click', () => menu.classList.add('hidden'));
        pinBtn.addEventListener('click', togglePin);
        const head = h('header', {class: 'dm-chat-head'},
            h('button', {class: 'icon-btn dm-back', type: 'button', html: ICONS.back, 'aria-label': 'Back to chats', onclick: () => {
                current = null;
                setUrl();
                renderList();
                emptyPane();
            }}),
            h('a', {class: 'dm-chat-who', href: link('user', {u: u.username})}, avatarEl(u), h('div', {}, nameEl, sub)),
            h('span', {class: 'spacer'}),
            pinBtn,
            h('div', {class: 'dropdown'}, moreBtn, menu));
        const older = h('button', {class: 'btn small ghost dm-older', type: 'button', onclick: loadOlder}, 'Load older messages');
        const scroller = h('div', {class: 'dm-messages', 'aria-live': 'polite'});
        const notice = h('div', {class: 'dm-notice'});
        const requestBar = h('div', {class: 'dm-request-bar'});
        const input = h('textarea', {rows: 1, maxlength: MAX_MESSAGE, placeholder: `Message ${displayOf(u)}`, 'aria-label': 'Message'});
        const counter = h('span', {class: 'dm-counter muted small'});
        const sendBtn = h('button', {class: 'btn primary dm-send', type: 'button', html: ICONS.send, 'aria-label': 'Send'});
        const composer = h('div', {class: 'dm-composer'}, input, counter, sendBtn);
        const autosize = () => {
            input.style.height = 'auto';
            input.style.height = `${Math.min(160, input.scrollHeight)}px`;
            input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden';
            const n = input.value.length;
            counter.textContent = n > MAX_MESSAGE - 200 ? `${MAX_MESSAGE - n}` : '';
        };
        input.addEventListener('input', autosize);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                send();
            }
        });
        sendBtn.addEventListener('click', send);
        els = {nameEl, sub, pinBtn, scroller, older, notice, requestBar, input, sendBtn, composer, autosize};
        fill(pane, head, h('div', {class: 'dm-scroll-wrap'}, scroller), requestBar, notice, composer);
        scroller.append(older);
        appendMessages(chat.messages, true);
        renderChrome();
        if (window.matchMedia('(pointer: fine)').matches) input.focus();
    };

    // Header subtitle, pin button, notices, request bar and composer state.
    const renderChrome = () => {
        const {state, user: u} = chat;
        fill(els.sub, `@${u.username}`,
            state.friends ? h('span', {class: 'badge', style: 'margin-left:6px'}, 'Friends') : null,
            u.nickname ? h('span', {class: 'muted', style: 'margin-left:6px'}, `· ${u.displayName}`) : null);
        fill(els.nameEl, userName(u));
        els.pinBtn.hidden = !state.conversationId || state.status === 'request-received';
        els.pinBtn.classList.toggle('on', state.pinned);
        els.pinBtn.title = state.pinned ? 'Unpin chat' : 'Pin chat';
        els.pinBtn.setAttribute('aria-label', els.pinBtn.title);
        els.older.hidden = !chat.hasOlder;

        const warn = state.reason && state.reason !== 'declined';
        els.notice.className = `dm-notice${warn ? ' warn' : ''}${state.notice ? '' : ' hidden'}`;
        els.notice.textContent = state.notice || '';

        fill(els.requestBar);
        els.requestBar.hidden = state.status !== 'request-received';
        if (state.status === 'request-received') {
            els.requestBar.append(
                h('span', {}, h('b', {}, displayOf(u)), ' sent you a message request.'),
                h('span', {class: 'spacer'}),
                h('button', {class: 'btn small primary', type: 'button', onclick: () => chatAction('accept', 'Request accepted')}, 'Accept'),
                h('button', {class: 'btn small', type: 'button', onclick: () => chatAction('decline', 'Request declined', true)}, 'Decline'),
                h('button', {class: 'btn small danger', type: 'button', onclick: () => block()}, 'Block'));
        }
        els.input.disabled = !state.canSend;
        els.sendBtn.disabled = !state.canSend;
        els.composer.classList.toggle('disabled', !state.canSend);
        els.input.placeholder = state.canSend ? `Message ${displayOf(u)}` :
            state.reason === 'limit' ? 'Waiting for them to accept your request' :
                state.reason === 'friends-only' ? 'Only friends can message them' : 'You can\'t send messages here';
        updateSeen();
    };

    const buildMenu = menu => {
        const {state, user: u} = chat;
        fill(menu,
            h('a', {href: link('user', {u: u.username})}, 'View profile'),
            state.friends ? h('button', {type: 'button', onclick: () => setNickname()}, u.nickname ? 'Change nickname' : 'Set nickname') : null,
            state.conversationId ? h('button', {type: 'button', onclick: () => deleteChat()}, 'Delete chat') : null,
            h('button', {type: 'button', class: 'danger-text', onclick: () => (state.blockedByMe ? unblock() : block())},
                state.blockedByMe ? 'Unblock' : 'Block'));
    };

    // ---------- message rendering ----------
    const GROUP_MS = 5 * 60 * 1000;
    const appendMessages = (list, initial = false) => {
        const sc = els.scroller;
        const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
        for (const m of list) sc.append(...messageNodes(m, prevOf(m)));
        if (initial || nearBottom || list.some(m => m.senderId === me.id)) sc.scrollTop = sc.scrollHeight;
        updateSeen();
    };
    const prevOf = m => {
        const i = chat.messages.findIndex(x => x.id === m.id);
        return i > 0 ? chat.messages[i - 1] : null;
    };
    const messageNodes = (m, prev) => {
        const nodes = [];
        if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
            nodes.push(h('div', {class: 'dm-day'}, h('span', {}, dayLabel(m.createdAt))));
        }
        const mine = m.senderId === me.id;
        const grouped = prev && prev.senderId === m.senderId && m.createdAt - prev.createdAt < GROUP_MS &&
            new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString();
        const time = new Date(m.createdAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
        const bubble = h('div', {class: `dm-bubble${m.deleted || m.hidden ? ' gone' : ''}`, title: new Date(m.createdAt).toLocaleString()},
            m.deleted ? 'Message unsent' : m.hidden ? 'Removed by a moderator' : linkify(m.body));
        const actions = h('div', {class: 'dm-msg-actions'},
            h('span', {class: 'muted small'}, time),
            !m.deleted && !m.hidden ? (mine ?
                h('button', {type: 'button', onclick: () => unsend(m)}, 'Unsend') :
                h('button', {type: 'button', onclick: () => reportMessage(m)}, 'Report')) : null);
        nodes.push(h('div', {class: `dm-msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`, 'data-id': String(m.id)},
            !mine ? (grouped ? h('span', {class: 'dm-avatar-space'}) : avatarEl(chat.user, 'sm')) : null,
            bubble, actions));
        return nodes;
    };
    const updateSeen = () => {
        if (!chat) return;
        els.scroller.querySelectorAll('.dm-seen').forEach(el => el.remove());
        const lastMine = [...chat.messages].reverse().find(m => m.senderId === me.id);
        const last = chat.messages[chat.messages.length - 1];
        if (!lastMine || lastMine !== last) return;
        const row = els.scroller.querySelector(`.dm-msg[data-id="${lastMine.id}"]`);
        if (!row) return;
        const seen = chat.state.otherLastReadId >= lastMine.id;
        row.after(h('div', {class: 'dm-seen muted small'}, seen ? 'Seen' : chat.state.status === 'request-sent' ? 'Sent as a request' : 'Sent'));
    };
    const rerenderMessages = () => {
        const sc = els.scroller;
        const keepBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
        const fromBottom = sc.scrollHeight - sc.scrollTop;
        fill(sc, els.older);
        chat.messages.forEach((m, i) => sc.append(...messageNodes(m, i ? chat.messages[i - 1] : null)));
        sc.scrollTop = keepBottom ? sc.scrollHeight : sc.scrollHeight - fromBottom;
        updateSeen();
    };
    async function loadOlder () {
        if (!chat || !chat.messages.length) return;
        const ref = chat;
        try {
            const data = await api.get(`/messages/with/${encodeURIComponent(ref.username)}?before=${ref.messages[0].id}`);
            if (chat !== ref) return;
            ref.messages.unshift(...data.messages);
            ref.hasOlder = data.messages.length >= 50;
            els.older.hidden = !ref.hasOlder;
            rerenderMessages();
        } catch (e) {
            toast(e.message);
        }
    }

    // ---------- actions ----------
    let sending = false;
    async function send () {
        if (!chat || sending) return;
        const body = els.input.value.trim();
        if (!body) return;
        const ref = chat;
        sending = true;
        els.sendBtn.disabled = true;
        try {
            const r = await api.post(`/messages/with/${encodeURIComponent(ref.username)}`, {body});
            if (chat !== ref) return;
            els.input.value = '';
            els.autosize();
            if (!ref.messages.some(m => m.id === r.message.id)) {
                ref.messages.push(r.message);
                appendMessages([r.message]);
            }
            const wasRequest = ref.state.status === 'none';
            ref.state = r.state;
            renderChrome();
            if (wasRequest && r.state.status === 'request-sent') {
                toast(`Message request sent. ${displayOf(ref.user)} will see it in their requests.`);
            }
            loadList();
        } catch (e) {
            toast(e.message);
            // The server says why (e.g. the request limit was reached): refresh what we show.
            try {
                const data = await api.get(`/messages/with/${encodeURIComponent(ref.username)}?after=${ref.messages.length ? ref.messages[ref.messages.length - 1].id : 0}`);
                if (chat === ref) {
                    ref.state = data.state;
                    renderChrome();
                }
            } catch (e2) {
                // ignore
            }
        } finally {
            sending = false;
            if (chat === ref) els.sendBtn.disabled = !ref.state.canSend;
            if (chat === ref && ref.state.canSend) els.input.focus();
        }
    }
    const chatAction = async (action, message, close) => {
        try {
            const r = await api.post(`/messages/with/${encodeURIComponent(chat.username)}/${action}`);
            chat.state = r.state;
            toast(message);
            if (close) {
                current = null;
                setUrl();
                emptyPane();
            } else {
                renderChrome();
            }
            if (action === 'accept') box = 'chats';
            await loadList();
            refreshMessageBadge();
        } catch (e) {
            toast(e.message);
        }
    };
    async function togglePin () {
        const on = !chat.state.pinned;
        try {
            const r = await (on ? api.put : api.del)(`/messages/with/${encodeURIComponent(chat.username)}/pin`);
            chat.state = r.state;
            renderChrome();
            toast(on ? 'Chat pinned' : 'Chat unpinned');
            loadList();
        } catch (e) {
            toast(e.message);
        }
    }
    const deleteChat = async () => {
        const ok = await modal('Delete this chat?', [h('p', {class: 'muted'},
            'This removes the chat from your list. ', displayOf(chat.user), ' keeps their copy. If they message you again, the chat comes back.')],
        [{label: 'Cancel', value: false}, {label: 'Delete chat', value: true, class: 'danger'}]);
        if (!ok) return;
        try {
            await api.del(`/messages/with/${encodeURIComponent(chat.username)}`);
            toast('Chat deleted');
            current = null;
            setUrl();
            emptyPane();
            loadList();
        } catch (e) {
            toast(e.message);
        }
    };
    const block = async () => {
        const name = displayOf(chat.user);
        const ok = await modal(`Block ${name}?`, [h('ul', {class: 'muted', style: 'margin:0;padding-left:18px;line-height:1.6'},
            h('li', {}, 'You won\'t be able to message each other.'),
            h('li', {}, 'You\'ll stop following each other, and they can\'t follow you.'),
            h('li', {}, 'Their comments are hidden for you, and they can\'t comment on your projects.'),
            h('li', {}, 'They aren\'t told. You can unblock them in Settings → Privacy.'))],
        [{label: 'Cancel', value: false}, {label: 'Block', value: true, class: 'danger'}]);
        if (!ok) return;
        try {
            await api.post(`/users/${encodeURIComponent(chat.user.username)}/block`);
            toast(`${name} is blocked`);
            current = null;
            setUrl();
            emptyPane();
            await loadList();
            refreshMessageBadge();
        } catch (e) {
            toast(e.message);
        }
    };
    const unblock = async () => {
        try {
            await api.del(`/users/${encodeURIComponent(chat.user.username)}/block`);
            toast(`${displayOf(chat.user)} is unblocked`);
            openChat(chat.username);
        } catch (e) {
            toast(e.message);
        }
    };
    const setNickname = async () => {
        const u = chat.user;
        const input = h('input', {type: 'text', maxlength: 32, value: u.nickname || '', placeholder: u.displayName});
        const value = await modal(`Nickname for ${u.displayName}`, [
            h('p', {class: 'muted small', style: 'margin-top:0'}, 'Only you can see this. It replaces their name in your chats and friends list.'),
            input
        ], [{label: 'Cancel', value: null}, u.nickname ? {label: 'Remove', value: ''} : null, {label: 'Save', value: 'save', class: 'primary'}].filter(Boolean));
        if (value === null) return;
        const nickname = value === 'save' ? input.value.trim() : '';
        try {
            const r = await api.put(`/users/${encodeURIComponent(u.username)}/nickname`, {nickname});
            chat.user = {...u, nickname: r.nickname || undefined};
            if (!r.nickname) delete chat.user.nickname;
            renderChrome();
            rerenderMessages();
            loadList();
            toast(r.nickname ? 'Nickname saved' : 'Nickname removed');
        } catch (e) {
            toast(e.message);
        }
    };
    const unsend = async m => {
        try {
            const r = await api.del(`/messages/${m.id}`);
            Object.assign(m, r.message);
            rerenderMessages();
            loadList();
        } catch (e) {
            toast(e.message);
        }
    };
    const reportMessage = async m => {
        const reason = h('textarea', {rows: 3, maxlength: 1000, placeholder: 'What\'s wrong with this message?'});
        const ok = await modal('Report message', [
            h('blockquote', {class: 'dm-quote'}, m.body),
            h('p', {class: 'muted small'}, 'Moderators will see this message only, not the rest of your chat.'),
            reason
        ], [{label: 'Cancel', value: false}, {label: 'Report', value: true, class: 'primary'}]);
        if (!ok) return;
        try {
            await api.post('/reports', {targetType: 'message', targetId: m.id, reason: reason.value || 'Reported from messages'});
            toast('Thanks, a moderator will take a look.');
        } catch (e) {
            toast(e.message);
        }
    };

    // ---------- new message ----------
    async function newMessage () {
        const input = h('input', {type: 'search', placeholder: 'Search people by name or username', 'aria-label': 'Search people'});
        const results = h('div', {class: 'dm-pick'});
        let friends = [];
        const row = u => h('button', {class: 'dm-pick-row', type: 'button', onclick: () => {
            // Close the dialog (its only button is Close), then open the chat.
            const dialog = document.querySelector('.dm-new-modal');
            if (dialog) dialog.closest('.modal').querySelector('.row .btn').click();
            box = 'chats';
            openChat(u.username);
        }}, avatarEl(u, 'sm'), h('span', {}, h('b', {}, userName(u)), h('span', {class: 'muted small'}, ` @${u.username}`)),
        friends.some(f => f.id === u.id) ? h('span', {class: 'badge', style: 'margin-left:auto'}, 'Friend') : null);
        const show = (list, label) => fill(results,
            label ? h('div', {class: 'dm-section'}, label) : null,
            ...(list.length ? list.filter(u => u.id !== me.id).map(row) : [h('p', {class: 'muted small'}, 'Nobody found.')]));
        let seq = 0;
        input.addEventListener('input', async () => {
            const q = input.value.trim();
            const mySeq = ++seq;
            if (!q) return show(friends, 'Friends');
            try {
                const r = await api.get(`/search?type=users&limit=8&q=${encodeURIComponent(q)}`);
                if (mySeq === seq) show(r.users, null);
            } catch (e) {
                // ignore
            }
        });
        const p = modal('New message', [h('div', {class: 'dm-new-modal'}, input, results)], [{label: 'Close', value: null}]);
        try {
            friends = (await api.get(`/users/${encodeURIComponent(me.username)}/friends?limit=60`)).users;
        } catch (e) {
            friends = [];
        }
        if (!input.value.trim()) {
            show(friends, 'Friends');
            if (!friends.length) fill(results, h('p', {class: 'muted small'}, 'Search for someone to message. Friends (people who follow each other) can always chat.'));
        }
        await p;
    }

    // ---------- start ----------
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            poll();
            markRead();
            loadList();
        }
    });
    setInterval(() => {
        if (!document.hidden) loadList();
    }, POLL_LIST_MS);
    await loadList();
    if (current) openChat(current);
    else emptyPane();
})();
