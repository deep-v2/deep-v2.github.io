// Shared KbauBlocks website UI: header, footer, cards, toasts, modals. AGPL-3.0-or-later.
import {
    api, apiUrl, editorUrl, getCachedUser, imageUrl, refreshMe, serverAvailable, signOut, siteRoot
} from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
};
export const link = (path, params) => {
    const u = new URL(path, siteRoot);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    return u.href;
};
export const param = name => new URLSearchParams(location.search).get(name);

export const timeAgo = ms => {
    const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [n, name] of units) {
        if (s >= n) {
            const v = Math.floor(s / n);
            return `${v} ${name}${v === 1 ? '' : 's'} ago`;
        }
    }
    return 'just now';
};
export const fmt = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

export const toast = message => {
    const el = h('div', {class: 'toast', role: 'status'}, message);
    document.body.append(el);
    setTimeout(() => el.remove(), 2800);
};

export const modal = (title, bodyNodes, buttons) => new Promise(resolve => {
    const close = value => {
        backdrop.remove();
        resolve(value);
    };
    const backdrop = h('div', {class: 'modal-backdrop', onclick: e => {
        if (e.target === backdrop) close(null);
    }},
    h('div', {class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title},
        h('h2', {}, title),
        ...bodyNodes,
        h('div', {class: 'row', style: 'justify-content:flex-end;margin-top:16px'},
            ...buttons.map(b => h('button', {class: `btn ${b.class || ''}`, onclick: () => close(b.value)}, b.label)))
    ));
    document.body.append(backdrop);
    const first = backdrop.querySelector('input, textarea, select');
    if (first) first.focus();
});

export const avatarEl = (user, size = '') => {
    if (user && user.avatarUrl) {
        const img = h('img', {class: `avatar ${size}`, alt: ''});
        apiUrl(user.avatarUrl).then(u => {
            img.src = u;
        });
        // If the uploaded picture can't be loaded, fall back to the default one.
        img.addEventListener('error', () => {
            if (img.src !== DEFAULT_AVATAR) img.src = DEFAULT_AVATAR;
        });
        return img;
    }
    return h('img', {class: `avatar ${size}`, src: DEFAULT_AVATAR, alt: ''});
};
const DEFAULT_AVATAR = new URL('default-avatar.png', siteRoot).href;

// Verified tick: shown after names of staff and accounts an admin has verified.
export const verifiedTick = user => {
    if (!user || !user.verified) return null;
    const label = user.role === 'admin' || user.role === 'moderator' ? 'Verified · KbauBlocks staff' : 'Verified';
    return h('span', {class: 'verified', title: label, 'aria-label': label, role: 'img', html:
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="seal" d="M12 1.5l2.6 2.1 3.3-.4 1.2 3.1 3.1 1.2-.4 3.3 2.1 2.6-2.1 2.6.4 3.3-3.1 1.2-1.2 3.1-3.3-.4L12 22.5l-2.6-2.1-3.3.4-1.2-3.1-3.1-1.2.4-3.3L.1 12l2.1-2.6-.4-3.3 3.1-1.2 1.2-3.1 3.3.4z"/>' +
        '<path class="check" d="M7.5 12.4l3 3 6-6.3" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'});
};
export const userName = (user, attrs = {}) => h('span', {class: 'user-name', ...attrs},
    user.displayName || user.username, verifiedTick(user));

export const userGrid = (users, emptyText = 'Nobody here yet.') => (users.length ?
    h('div', {class: 'user-grid'}, users.map(u => h('a', {class: 'user-card card', href: link('user', {u: u.username})},
        avatarEl(u), h('div', {class: 'user-card-text'}, h('b', {}, userName(u)), h('span', {class: 'muted small'}, `@${u.username}`))))) :
    h('p', {class: 'empty'}, emptyText));

const PLACEHOLDER = new URL('logo.png', siteRoot).href;
export const projectCard = project => {
    const img = h('img', {alt: '', loading: 'lazy'});
    const thumb = h('div', {class: 'thumb'});
    if (project.thumbnailUrl) {
        // Unshared projects' thumbnails need your sign-in, so they're fetched with the token.
        (project.shared ? apiUrl : imageUrl)(project.thumbnailUrl).then(u => {
            img.src = u;
        });
        thumb.append(img);
    } else {
        thumb.append(h('img', {class: 'placeholder', src: PLACEHOLDER, alt: ''}));
    }
    return h('a', {class: 'project-card', href: link('project', {id: project.id})},
        thumb,
        h('div', {class: 'meta'},
            h('div', {class: 'title', title: project.title}, project.title,
                !project.shared ? h('span', {class: 'badge warn', style: 'margin-left:6px'}, 'Unshared') : null),
            h('div', {class: 'by'}, project.owner ? userName(project.owner) : ''),
            h('div', {class: 'stats'},
                h('span', {title: 'Views'}, `👁 ${fmt(project.stats.views)}`),
                h('span', {title: 'Loves'}, `♥ ${fmt(project.stats.loves)}`),
                h('span', {title: 'Favorites'}, `★ ${fmt(project.stats.favorites)}`))));
};
export const projectGrid = (projects, emptyText = 'Nothing here yet.') => (
    projects.length ? h('div', {class: 'grid'}, projects.map(projectCard)) : h('p', {class: 'empty'}, emptyText)
);

/** Shown wherever community features are needed but no server is reachable. */
export const offlineNotice = () => h('div', {class: 'notice warn'},
    h('b', {}, 'Community server not connected. '),
    'Sharing, accounts and comments need a KbauBlocks server. The editor still works fully on its own. ',
    h('a', {href: link('settings', {tab: 'server'})}, 'Connect a server'),
    ' or ',
    h('a', {href: 'https://github.com/deep-v2/deep-v2.github.io/tree/main/kbaucode/server'}, 'host your own'),
    '.');

export const errorNotice = err => h('div', {class: 'notice error'}, err && err.message ? err.message : String(err));

// ---------- theme ----------
const THEME_KEY = 'kbau:site-theme';
export const getSiteTheme = () => {
    try {
        return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
    } catch (e) {
        return 'dark';
    }
};
export const setSiteTheme = theme => {
    try {
        if (theme === 'light') localStorage.setItem(THEME_KEY, 'light');
        else localStorage.removeItem(THEME_KEY);
    } catch (e) {
        // ignore
    }
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
};
document.documentElement.dataset.theme = getSiteTheme();

// ---------- header / footer ----------
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const MENU_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';

const USER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';

// Search box dropdown: the user whose name matches exactly, then "Search users" and "Search projects".
const attachSearchSuggest = (form, input) => {
    const box = h('div', {class: 'search-suggest hidden', role: 'listbox', id: 'search-suggest'});
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-controls', 'search-suggest');
    form.append(box);
    let seq = 0;
    let timer = null;
    let active = -1;
    let exactUser = null;
    const options = () => [...box.querySelectorAll('.suggest-item')];
    const highlight = i => {
        const items = options();
        active = items.length ? (i + items.length) % items.length : -1;
        items.forEach((el, n) => el.classList.toggle('active', n === active));
    };
    const render = term => {
        if (!term) {
            box.classList.add('hidden');
            return;
        }
        const item = (href, icon, ...label) => h('a', {class: 'suggest-item', role: 'option', href}, icon, h('span', {class: 'suggest-label'}, ...label));
        const icon = svg => h('span', {class: 'suggest-icon', html: svg});
        // (replaceChildren would print a null as the text "null", so leave the user row out entirely.)
        box.replaceChildren(...[
            exactUser ? item(link('user', {u: exactUser.username}), avatarEl(exactUser, 'sm'),
                h('b', {}, userName(exactUser)), h('span', {class: 'muted small'}, ` @${exactUser.username}`)) : null,
            item(link('explore', {q: term, type: 'users'}), icon(USER_ICON), 'Search users ', h('span', {class: 'muted'}, `“${term}”`)),
            item(link('explore', {q: term, type: 'projects'}), icon(SEARCH_ICON), 'Search projects ', h('span', {class: 'muted'}, `“${term}”`))
        ].filter(Boolean));
        box.classList.remove('hidden');
        active = -1;
    };
    const lookup = async term => {
        const mine = ++seq;
        let found = null;
        try {
            const {users} = await api.get(`/search?q=${encodeURIComponent(term)}&type=users&limit=1`);
            if (users[0] && users[0].username.toLowerCase() === term.toLowerCase()) found = users[0];
        } catch (e) {
            // offline or no server: just no user row
        }
        if (mine !== seq || input.value.trim() !== term) return;
        exactUser = found;
        render(term);
    };
    input.addEventListener('input', () => {
        const term = input.value.trim();
        exactUser = exactUser && term.toLowerCase() === exactUser.username.toLowerCase() ? exactUser : null;
        render(term);
        clearTimeout(timer);
        seq++;
        if (term && /^[A-Za-z0-9_-]{1,20}$/.test(term)) timer = setTimeout(() => lookup(term), 180);
    });
    input.addEventListener('focus', () => render(input.value.trim()));
    input.addEventListener('keydown', e => {
        if (box.classList.contains('hidden')) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
        } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            location.href = options()[active].href;
        } else if (e.key === 'Escape') {
            box.classList.add('hidden');
        }
    });
    document.addEventListener('click', e => {
        if (!form.contains(e.target)) box.classList.add('hidden');
    });
};

export const renderHeader = async active => {
    const header = h('header', {class: 'site-header'});
    const nav = h('nav', {class: 'nav', 'aria-label': 'Main'},
        h('a', {class: `create ${active === 'create' ? 'active' : ''}`, href: link('editor/')}, 'Create'),
        h('a', {class: active === 'explore' ? 'active' : '', href: link('explore')}, 'Explore'),
        h('a', {class: active === 'extras' ? 'active' : '', href: link('extras')}, 'Extras'),
        h('a', {class: active === 'download' ? 'active' : '', href: link('download')}, 'Download'));
    const searchInput = h('input', {type: 'search', name: 'q', placeholder: 'Search projects and people', 'aria-label': 'Search', value: active === 'explore' ? (param('q') || '') : ''});
    const search = h('form', {class: 'search', role: 'search', action: link('explore'), method: 'get', html: SEARCH_ICON});
    search.append(searchInput);
    attachSearchSuggest(search, searchInput);
    const right = h('div', {class: 'header-right'});
    const inner = h('div', {class: 'header-inner'},
        h('button', {class: 'menu-toggle', 'aria-label': 'Menu', html: MENU_ICON, onclick: () => nav.classList.toggle('open')}),
        h('a', {class: 'brand', href: link('./')}, h('img', {src: link('logo.png'), alt: ''}), h('span', {}, 'KbauBlocks')),
        nav, search, right);
    header.append(inner);
    document.body.prepend(header);

    const renderRight = user => {
        right.replaceChildren();
        if (user) {
            const menu = h('div', {class: 'dropdown-menu hidden'},
                h('a', {href: link('user', {u: user.username})}, 'Profile'),
                h('a', {href: link('mystuff')}, 'My Stuff'),
                h('a', {href: link('settings')}, 'Settings'),
                (user.role === 'admin' || user.role === 'moderator') ? h('a', {href: link('admin')}, 'Admin') : null,
                h('button', {onclick: async () => {
                    await signOut();
                    location.reload();
                }}, 'Sign out'));
            const chip = h('button', {class: 'user-chip', 'aria-haspopup': 'true', onclick: e => {
                e.stopPropagation();
                menu.classList.toggle('hidden');
            }}, avatarEl(user, 'sm'), h('span', {class: 'small'}, user.username));
            document.addEventListener('click', () => menu.classList.add('hidden'));
            right.append(h('a', {class: 'btn small', href: link('mystuff')}, 'My Stuff'), h('div', {class: 'dropdown'}, chip, menu));
        } else {
            const next = encodeURIComponent(location.pathname + location.search);
            right.append(
                h('a', {class: 'btn small ghost', href: `${link('login')}?next=${next}`}, 'Sign in'),
                h('a', {class: 'btn small primary', href: `${link('login')}?mode=join&next=${next}`}, 'Join'));
        }
    };
    renderRight(getCachedUser());
    const available = await serverAvailable();
    if (!available) {
        right.replaceChildren(h('a', {class: 'btn small primary', href: link('editor/')}, 'Open editor'));
        return null;
    }
    const user = await refreshMe();
    renderRight(user);
    return user;
};

export const renderFooter = () => {
    document.body.append(h('footer', {class: 'site-footer'},
        h('div', {class: 'inner'},
            h('span', {}, '© KbauBlocks contributors'),
            h('a', {href: link('editor/credits.html')}, 'Credits'),
            h('a', {href: 'https://github.com/deep-v2/deep-v2.github.io/tree/main/kbaucode'}, 'Source code'),
            h('a', {href: link('download')}, 'Download for Windows'),
            h('a', {href: link('kbaucode/docs/ARCHITECTURE.md')}, 'Architecture'),
            h('span', {class: 'spacer'}),
            h('span', {}, 'Built on TurboWarp and Scratch. Not affiliated with the Scratch Foundation.'))));
};

/** Common page bootstrap. Returns {user, online}. */
export const boot = async active => {
    const user = await renderHeader(active);
    renderFooter();
    const online = await serverAvailable();
    return {user, online};
};

export {api, editorUrl};
