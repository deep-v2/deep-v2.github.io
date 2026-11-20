// Admin / moderation page: overview, reports, users (search, bans), activity log, IP bans, word filter.
import {$, api, avatarEl, boot, errorNotice, fmt, h, link, modal, offlineNotice, param, timeAgo, toast, userName} from '../ui.js';

const main = $('#main');
let me = null;
const isAdmin = () => me && me.role === 'admin';

const when = ms => (ms ? h('span', {title: new Date(ms).toLocaleString()}, timeAgo(ms)) : h('span', {class: 'muted'}, 'never'));
const userLink = name => (name ? h('a', {href: link('user', {u: name})}, `@${name}`) : h('span', {class: 'muted'}, 'Someone'));
const searchBox = (placeholder, value, onSearch) => {
    const input = h('input', {type: 'text', role: 'searchbox', placeholder, value: value || '', 'aria-label': placeholder});
    let timer;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => onSearch(input.value.trim()), 250);
    });
    return input;
};

/** Ban dialog: a reason (shown to the user when they try to sign in), plus IP ban for admins. */
const banDialog = async (username, onDone) => {
    const reason = h('textarea', {id: 'ban-reason', maxlength: 500, placeholder: 'e.g. Repeated spam in comments'});
    const ipBox = h('input', {type: 'checkbox', id: 'ban-ip'});
    const ok = await modal(`Ban @${username}`, [
        h('label', {for: 'ban-reason'}, 'Reason (the user sees this when they try to sign in)'), reason,
        isAdmin() ? h('label', {class: 'row', style: 'margin-top:12px;gap:8px;font-weight:600'}, ipBox,
            'Also ban the IP address they last signed in from') : null
    ], [{label: 'Cancel', value: false, class: 'ghost'}, {label: 'Ban', value: true, class: 'danger'}]);
    if (!ok) return;
    try {
        await api.post(`/admin/users/${encodeURIComponent(username)}/ban`, {reason: reason.value, banIp: ipBox.checked});
        toast(`@${username} is banned`);
        if (onDone) onDone();
    } catch (e) {
        toast(e.message);
    }
};

const unban = async (username, onDone) => {
    try {
        await api.post(`/admin/users/${encodeURIComponent(username)}/unban`);
        toast(`@${username} is unbanned`);
        if (onDone) onDone();
    } catch (e) {
        toast(e.message);
    }
};

// ---------- Overview ----------
const overview = async body => {
    const {stats: s} = await api.get('/admin/stats');
    const tile = (n, label, tab, extra) => h(tab ? 'button' : 'div', {class: 'card stat-tile', onclick: tab ? () => go(tab, extra) : null},
        h('b', {}, fmt(n)), h('span', {class: 'muted small'}, label));
    body.replaceChildren(
        h('div', {class: 'stat-tiles'},
            tile(s.users, 'accounts', 'users'),
            tile(s.new_day, 'new today', 'activity', {action: 'account.create'}),
            tile(s.new_week, 'new this week', 'users', {filter: 'new'}),
            tile(s.active_day, 'signed in today', 'activity', {action: 'account.login'}),
            tile(s.open_reports, 'open reports', 'reports'),
            tile(s.banned, 'banned accounts', 'users', {filter: 'banned'}),
            isAdmin() ? tile(s.ip_bans, 'IP bans', 'ips') : null,
            tile(s.blocked_day, 'filtered today', 'activity', {action: 'filter.blocked'}),
            tile(s.shared_projects, 'shared projects'),
            tile(s.comments, 'comments')),
        h('h2', {style: 'margin-top:26px'}, 'Latest activity'));
    const list = h('div');
    body.append(list);
    const {entries} = await api.get('/admin/log?limit=15');
    list.replaceChildren(logTable(entries));
};

// ---------- Reports ----------
const reports = async (body, opts) => {
    const status = opts.status || 'open';
    const sub = h('div', {class: 'tabs small-tabs'}, [['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']].map(([st, l]) =>
        h('button', {class: st === status ? 'active' : '', onclick: () => go('reports', {status: st})}, l)));
    const list = h('div', {}, h('p', {class: 'empty'}, 'Loading…'));
    body.replaceChildren(sub, list);
    const {reports: rows} = await api.get(`/admin/reports?status=${status}`);
    list.replaceChildren(...(rows.length ? rows.map(r => reportCard(r, () => go('reports', {status}))) : [h('p', {class: 'empty'}, 'Nothing here. 🎉')]));
};

function reportCard (r, refresh) {
    let target;
    if (!r.target) target = h('span', {class: 'muted'}, '(target no longer exists)');
    else if (r.targetType === 'project') target = h('a', {href: link('project', {id: r.target.id})}, `Project “${r.target.title}” by ${r.target.owner}`, r.target.hidden ? ' (hidden)' : '');
    else if (r.targetType === 'comment') target = h('div', {}, `Comment by ${r.target.author.username} on `, h('a', {href: link('project', {id: r.target.projectId})}, `project ${r.target.projectId}`), h('blockquote', {class: 'prose quote'}, r.target.content));
    else target = h('a', {href: link('user', {u: r.target.username})}, `User @${r.target.username}`, r.target.banned ? ' (banned)' : '');
    const note = h('input', {type: 'text', placeholder: 'Note — also used as the ban reason', maxlength: 1000});
    const act = action => async () => {
        try {
            await api.post(`/admin/reports/${r.id}/resolve`, {action, note: note.value});
            toast('Done');
            refresh();
        } catch (e) {
            toast(e.message);
        }
    };
    return h('div', {class: 'card', style: 'margin-bottom:12px'},
        h('div', {class: 'muted small'}, `#${r.id} · ${r.targetType} · reported by ${r.reporter} · ${timeAgo(r.createdAt)}`),
        h('div', {style: 'margin:8px 0'}, target),
        h('div', {class: 'prose'}, h('b', {}, 'Reason: '), r.reason),
        r.status === 'open' ? h('div', {class: 'row', style: 'margin-top:12px'}, h('div', {style: 'flex:1;min-width:180px'}, note),
            r.targetType !== 'user' ? h('button', {class: 'btn', onclick: act('hide')}, 'Hide content') : null,
            h('button', {class: 'btn danger', onclick: act('ban')}, 'Ban author'),
            h('button', {class: 'btn ghost', onclick: act('dismiss')}, 'Dismiss')) :
            h('div', {class: 'muted small', style: 'margin-top:8px'}, `${r.status}${r.resolutionNote ? ` — ${r.resolutionNote}` : ''}`));
}

// ---------- Users ----------
const users = async (body, opts) => {
    const filterName = opts.filter || 'all';
    const q = opts.q || '';
    const filters = [['all', 'All'], ['banned', 'Banned'], ['new', 'New this week'], ['staff', 'Staff'], ['verified', 'Verified']];
    const search = searchBox(isAdmin() ? 'Search name, ban reason or IP (203.0.113.*)' : 'Search name or ban reason', q,
        value => go('users', {filter: filterName, q: value}, {keepFocus: true}));
    const list = h('div', {}, h('p', {class: 'empty'}, 'Loading…'));
    const more = h('button', {class: 'btn hidden', style: 'margin:16px auto 0;display:flex'}, 'Load more');
    body.replaceChildren(
        h('div', {class: 'row', style: 'margin-bottom:14px;align-items:center'},
            h('div', {class: 'tabs small-tabs', style: 'margin:0'}, filters.map(([f, l]) =>
                h('button', {class: f === filterName ? 'active' : '', onclick: () => go('users', {filter: f, q})}, l))),
            h('div', {style: 'flex:1;min-width:220px'}, search)),
        list, more);
    let pageN = 0;
    const load = async () => {
        const {users: rows} = await api.get(`/admin/users?filter=${filterName}&q=${encodeURIComponent(q)}&page=${pageN}&limit=30`);
        if (pageN === 0) list.replaceChildren();
        if (pageN === 0 && !rows.length) list.append(h('p', {class: 'empty'}, filterName === 'banned' ? 'No banned accounts.' : 'No accounts match.'));
        rows.forEach(u => list.append(userRow(u, () => go('users', {filter: filterName, q}))));
        more.classList.toggle('hidden', rows.length < 30);
        pageN++;
    };
    more.addEventListener('click', load);
    await load();
    return search;
};

function userRow (u, refresh) {
    const ipInfo = isAdmin() && (u.signupIp || u.lastIp) ? h('div', {class: 'muted small'},
        'IP: ', ipLink(u.lastIp || u.signupIp), u.signupIp && u.lastIp && u.signupIp !== u.lastIp ? [' · signed up from ', ipLink(u.signupIp)] : null,
        u.sameIpAccounts ? h('span', {class: 'badge warn', style: 'margin-left:6px'}, `${u.sameIpAccounts} other account${u.sameIpAccounts === 1 ? '' : 's'} on this IP`) : null) : null;
    const canBan = u.id !== me.id && u.role !== 'admin' && !(u.role === 'moderator' && !isAdmin());
    return h('div', {class: `card admin-user ${u.banned ? 'is-banned' : ''}`},
        h('a', {href: link('user', {u: u.username})}, avatarEl(u)),
        h('div', {class: 'grow'},
            h('div', {}, h('a', {href: link('user', {u: u.username}), style: 'font-weight:800;color:var(--text)'}, userName(u)),
                h('span', {class: 'muted'}, ` @${u.username}`),
                u.role !== 'user' ? h('span', {class: 'badge accent', style: 'margin-left:6px'}, u.role) : null,
                u.banned ? h('span', {class: 'badge danger', style: 'margin-left:6px'}, 'banned') : null),
            h('div', {class: 'muted small'}, 'Joined ', when(u.createdAt), ' · last sign-in ', when(u.lastLoginAt), ` · ${u.projectCount} project${u.projectCount === 1 ? '' : 's'}`),
            u.banned ? h('div', {class: 'small ban-reason'}, h('b', {}, 'Banned '), when(u.bannedAt), u.bannedBy ? ` by @${u.bannedBy}` : '', ': ',
                u.banReason || h('span', {class: 'muted'}, 'no reason given')) : null,
            ipInfo),
        h('div', {class: 'row'},
            canBan ? (u.banned ?
                h('button', {class: 'btn small', onclick: () => unban(u.username, refresh)}, 'Unban') :
                h('button', {class: 'btn small danger', onclick: () => banDialog(u.username, refresh)}, 'Ban')) : null,
            isAdmin() && u.id !== me.id ? h('select', {'aria-label': 'Role', onchange: async e => {
                try {
                    await api.post(`/admin/users/${encodeURIComponent(u.username)}/role`, {role: e.target.value});
                    toast(`@${u.username} is now ${e.target.value}`);
                    refresh();
                } catch (err) {
                    toast(err.message);
                }
            }}, ['user', 'moderator', 'admin'].map(r => h('option', {value: r, selected: r === u.role}, r))) : null));
}

const ipLink = ip => h('a', {href: '#', onclick: e => {
    e.preventDefault();
    go('users', {q: ip});
}}, ip);

// ---------- Activity log ----------
const ACTIONS = [
    ['', 'Everything'], ['account.create', 'Accounts created'], ['account.login', 'Sign-ins'], ['user', 'Bans, roles & ticks'],
    ['ip', 'IP bans'], ['filter.blocked', 'Filtered words'], ['report', 'Reports'], ['project', 'Projects'], ['comment', 'Comments'],
    ['filter.add', 'Word list changes']
];
const LABELS = {
    'account.create': 'created an account', 'account.login': 'signed in', 'user.ban': 'banned', 'user.unban': 'unbanned',
    'user.role': 'changed the role of', 'user.verify': 'verified', 'user.unverify': 'removed the tick from', 'ip.ban': 'banned IP',
    'ip.unban': 'unbanned IP', 'filter.blocked': 'was blocked by the word filter', 'filter.add': 'added a blocked word',
    'filter.remove': 'removed a blocked word', 'report.hide': 'hid content from', 'report.ban': 'banned the author of',
    'report.dismiss': 'dismissed', 'project.hide': 'hid', 'project.unhide': 'unhid', 'project.delete': 'deleted',
    'comment.hide': 'hid', 'comment.unhide': 'unhid', 'comment.delete': 'deleted a comment on'
};
const logTable = entries => (entries.length ? h('div', {class: 'log-list'}, entries.map(e => h('div', {class: `log-row log-${e.action.split('.')[0]}`},
    h('span', {class: 'log-time muted small', title: new Date(e.at).toLocaleString()}, new Date(e.at).toLocaleString([], {dateStyle: 'short', timeStyle: 'short'})),
    h('span', {class: 'log-text'},
        e.action === 'account.create' || e.action === 'account.login' ? userLink(e.target) : userLink(e.actor), ' ',
        LABELS[e.action] || e.action, ' ',
        e.action.startsWith('account.') || e.action.startsWith('filter.blocked') ? null :
            (e.targetType === 'user' ? userLink(e.target) : h('b', {}, e.target)),
        e.action === 'filter.blocked' ? h('span', {class: 'muted'}, ` (${e.target})`) : null,
        e.details ? h('span', {class: 'muted'}, ` — ${e.details}`) : null),
    isAdmin() && e.ip ? h('span', {class: 'log-ip muted small'}, ipLink(e.ip)) : null))) :
    h('p', {class: 'empty'}, 'Nothing logged yet.'));

const activity = async (body, opts) => {
    const action = opts.action || '';
    const q = opts.q || '';
    const select = h('select', {'aria-label': 'Type', onchange: e => go('activity', {action: e.target.value, q})},
        ACTIONS.map(([v, l]) => h('option', {value: v, selected: v === action}, l)));
    const search = searchBox(isAdmin() ? 'Search names, details or IP' : 'Search names or details', q,
        value => go('activity', {action, q: value}, {keepFocus: true}));
    const list = h('div', {}, h('p', {class: 'empty'}, 'Loading…'));
    const more = h('button', {class: 'btn hidden', style: 'margin:16px auto 0;display:flex'}, 'Load more');
    body.replaceChildren(h('div', {class: 'row', style: 'margin-bottom:14px'}, select, h('div', {style: 'flex:1;min-width:220px'}, search)), list, more);
    let pageN = 0;
    const all = [];
    const load = async () => {
        const {entries} = await api.get(`/admin/log?action=${encodeURIComponent(action)}&q=${encodeURIComponent(q)}&page=${pageN}&limit=50`);
        all.push(...entries);
        list.replaceChildren(logTable(all));
        more.classList.toggle('hidden', entries.length < 50);
        pageN++;
    };
    more.addEventListener('click', load);
    await load();
    return search;
};

// ---------- IP bans ----------
const ips = async body => {
    const pattern = h('input', {type: 'text', placeholder: '203.0.113.7 or 203.0.113.*', 'aria-label': 'IP address or prefix'});
    const reason = h('input', {type: 'text', placeholder: 'Reason', maxlength: 500, 'aria-label': 'Reason'});
    const list = h('div', {}, h('p', {class: 'empty'}, 'Loading…'));
    body.replaceChildren(
        h('p', {class: 'muted'}, 'People on a banned IP can still look around, but cannot sign up, sign in, post, or change anything. ',
            'End an address with * to ban a whole range (careful: schools and phone networks share addresses).'),
        h('div', {class: 'row', style: 'margin-bottom:16px'}, h('div', {style: 'flex:1;min-width:200px'}, pattern),
            h('div', {style: 'flex:2;min-width:200px'}, reason),
            h('button', {class: 'btn danger', onclick: async () => {
                try {
                    await api.post('/admin/ip-bans', {pattern: pattern.value, reason: reason.value});
                    toast('IP banned');
                    go('ips');
                } catch (e) {
                    toast(e.message);
                }
            }}, 'Ban IP')),
        list);
    const {bans} = await api.get('/admin/ip-bans');
    list.replaceChildren(bans.length ? h('div', {class: 'log-list'}, bans.map(b => h('div', {class: 'log-row'},
        h('b', {}, ipLink(b.pattern)),
        h('span', {class: 'grow'}, b.reason || h('span', {class: 'muted'}, 'no reason'),
            h('span', {class: 'muted small'}, ` — by @${b.createdBy}, `, when(b.createdAt), b.accounts ? ` · ${b.accounts} account(s)` : '')),
        h('button', {class: 'btn small', onclick: async () => {
            await api.del(`/admin/ip-bans/${b.id}`);
            toast(`Unbanned ${b.pattern}`);
            go('ips');
        }}, 'Remove')))) : h('p', {class: 'empty'}, 'No IP bans.'));
};

// ---------- Word filter ----------
const words = async body => {
    const {builtIn, words: list} = await api.get('/admin/words');
    const word = h('input', {type: 'text', placeholder: 'Add a word', maxlength: 40, 'aria-label': 'Word to block'});
    const tester = h('input', {type: 'text', placeholder: 'Try some text…', 'aria-label': 'Text to test'});
    const result = h('div', {class: 'small', style: 'margin-top:6px;min-height:1.5em'});
    tester.addEventListener('input', async () => {
        if (!tester.value.trim()) return result.replaceChildren();
        const r = await api.post('/admin/words/test', {text: tester.value});
        result.replaceChildren(r.text ? h('span', {style: 'color:var(--danger)'}, `Blocked (matched “${r.text}”)`) :
            r.username ? h('span', {style: 'color:var(--warm)'}, `Allowed in text, blocked as a username (“${r.username}”)`) :
                h('span', {class: 'muted'}, 'Allowed'));
    });
    body.replaceChildren(
        h('p', {class: 'muted'}, `The filter checks usernames, display names, bios, project titles, descriptions, notes, comments, collections and reports. `,
            `It has ${builtIn} built-in swears and slurs and sees through tricks like sh1t, f u c k and fuuuck, while letting ordinary words like “class” or “Scunthorpe” through.`),
        h('div', {class: 'card', style: 'margin-bottom:16px'}, h('h3', {}, 'Test the filter'), tester, result),
        h('div', {class: 'card'}, h('h3', {}, `Extra blocked words (${list.length})`),
            isAdmin() ? h('div', {class: 'row', style: 'margin-bottom:12px'}, h('div', {style: 'flex:1'}, word),
                h('button', {class: 'btn primary', onclick: async () => {
                    try {
                        await api.post('/admin/words', {word: word.value});
                        go('words');
                    } catch (e) {
                        toast(e.message);
                    }
                }}, 'Add')) : null,
            list.length ? h('div', {class: 'chip-list'}, list.map(w => h('span', {class: 'chip', title: `Added by @${w.createdBy}`}, w.word,
                isAdmin() ? h('button', {'aria-label': `Remove ${w.word}`, onclick: async () => {
                    await api.del(`/admin/words/${encodeURIComponent(w.word)}`);
                    go('words');
                }}, '×') : null))) : h('p', {class: 'muted'}, 'None yet.')));
};

// ---------- page shell ----------
const TABS = [['overview', 'Overview', overview], ['reports', 'Reports', reports], ['users', 'Users', users],
    ['activity', 'Activity log', activity], ['ips', 'IP bans', ips, true], ['words', 'Word filter', words]];
let tabBar;
let body;
async function go (tab, opts = {}, {keepFocus} = {}) {
    const def = TABS.find(t => t[0] === tab) || TABS[0];
    const params = new URLSearchParams({tab: def[0], ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v))});
    history.replaceState(null, '', `?${params}`);
    tabBar.replaceChildren(...TABS.filter(t => !t[3] || isAdmin()).map(([id, label]) =>
        h('button', {class: id === def[0] ? 'active' : '', onclick: () => go(id)}, label)));
    if (!keepFocus) body.replaceChildren(h('p', {class: 'empty'}, 'Loading…'));
    try {
        const focus = await def[2](body, opts);
        if (keepFocus && focus) {
            focus.focus();
            focus.setSelectionRange(focus.value.length, focus.value.length);
        }
    } catch (e) {
        body.replaceChildren(errorNotice(e));
    }
}

(async () => {
    const {user, online} = await boot('admin');
    me = user;
    main.append(h('h1', {}, 'Admin'));
    if (!online) return main.append(offlineNotice());
    if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
        return main.append(h('div', {class: 'notice error'}, 'Only moderators can see this page.'));
    }
    tabBar = h('div', {class: 'tabs'});
    body = h('div');
    main.append(tabBar, body);
    const opts = {};
    for (const k of ['status', 'filter', 'q', 'action']) if (param(k)) opts[k] = param(k);
    go(param('tab') || 'overview', opts);
})();
