// Shared KbauBlocks website UI: header, footer, cards, toasts, modals. AGPL-3.0-or-later.
import {
    api, apiUrl, editorUrl, getCachedUser, refreshMe, serverAvailable, signOut, siteRoot
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
        return img;
    }
    const name = (user && (user.displayName || user.username)) || '?';
    return h('span', {class: `avatar ${size}`, style: `background:${(user && user.profileColor) || '#ffffff'}`}, name[0].toUpperCase());
};

const PLACEHOLDER = new URL('logo.png', siteRoot).href;
export const projectCard = project => {
    const img = h('img', {alt: '', loading: 'lazy'});
    const thumb = h('div', {class: 'thumb'});
    if (project.thumbnailUrl) {
        apiUrl(project.thumbnailUrl).then(u => {
            img.src = u;
        });
        thumb.append(img);
    } else {
        thumb.append(h('img', {class: 'placeholder', src: PLACEHOLDER, alt: ''}));
    }
    return h('a', {class: 'project-card', href: link('project.html', {id: project.id})},
        thumb,
        h('div', {class: 'meta'},
            h('div', {class: 'title', title: project.title}, project.title,
                !project.shared ? h('span', {class: 'badge warn', style: 'margin-left:6px'}, 'Unshared') : null),
            h('div', {class: 'by'}, project.owner ? project.owner.displayName || project.owner.username : ''),
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
    h('a', {href: link('settings.html', {tab: 'server'})}, 'Connect a server'),
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

export const renderHeader = async active => {
    const header = h('header', {class: 'site-header'});
    const nav = h('nav', {class: 'nav', 'aria-label': 'Main'},
        h('a', {class: `create ${active === 'create' ? 'active' : ''}`, href: link('editor/editor.html')}, 'Create'),
        h('a', {class: active === 'explore' ? 'active' : '', href: link('explore.html')}, 'Explore'),
        h('a', {class: active === 'extensions' ? 'active' : '', href: link('extensions.html')}, 'Extensions'));
    const searchInput = h('input', {type: 'search', name: 'q', placeholder: 'Search projects and people', 'aria-label': 'Search', value: active === 'explore' ? (param('q') || '') : ''});
    const search = h('form', {class: 'search', role: 'search', action: link('explore.html'), method: 'get', html: SEARCH_ICON});
    search.append(searchInput);
    const right = h('div', {class: 'header-right'});
    const inner = h('div', {class: 'header-inner'},
        h('button', {class: 'menu-toggle', 'aria-label': 'Menu', html: MENU_ICON, onclick: () => nav.classList.toggle('open')}),
        h('a', {class: 'brand', href: link('index.html')}, h('img', {src: link('logo.png'), alt: ''}), h('span', {}, 'KbauBlocks')),
        nav, search, right);
    header.append(inner);
    document.body.prepend(header);

    const renderRight = user => {
        right.replaceChildren();
        if (user) {
            const menu = h('div', {class: 'dropdown-menu hidden'},
                h('a', {href: link('user.html', {u: user.username})}, 'Profile'),
                h('a', {href: link('mystuff.html')}, 'My Stuff'),
                h('a', {href: link('settings.html')}, 'Settings'),
                (user.role === 'admin' || user.role === 'moderator') ? h('a', {href: link('admin.html')}, 'Moderation') : null,
                h('button', {onclick: async () => {
                    await signOut();
                    location.reload();
                }}, 'Sign out'));
            const chip = h('button', {class: 'user-chip', 'aria-haspopup': 'true', onclick: e => {
                e.stopPropagation();
                menu.classList.toggle('hidden');
            }}, avatarEl(user, 'sm'), h('span', {class: 'small'}, user.username));
            document.addEventListener('click', () => menu.classList.add('hidden'));
            right.append(h('a', {class: 'btn small', href: link('mystuff.html')}, 'My Stuff'), h('div', {class: 'dropdown'}, chip, menu));
        } else {
            const next = encodeURIComponent(location.pathname + location.search);
            right.append(
                h('a', {class: 'btn small ghost', href: `${link('login.html')}?next=${next}`}, 'Sign in'),
                h('a', {class: 'btn small primary', href: `${link('login.html')}?mode=join&next=${next}`}, 'Join'));
        }
    };
    renderRight(getCachedUser());
    const available = await serverAvailable();
    if (!available) {
        right.replaceChildren(h('a', {class: 'btn small primary', href: link('editor/editor.html')}, 'Open editor'));
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
            h('a', {href: link('docs/ARCHITECTURE.md')}, 'Architecture'),
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
