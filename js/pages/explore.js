import {$, api, avatarEl, boot, h, link, offlineNotice, param, projectCard, errorNotice, userGrid, userName} from '../ui.js';

const main = $('#main');
(async () => {
    const {online} = await boot('explore');
    const q = (param('q') || '').trim();
    // type=users / type=projects come from the search box dropdown; no type shows both.
    const type = q && ['users', 'projects'].includes(param('type')) ? param('type') : null;
    main.append(h('h1', {}, q ? `${type === 'users' ? 'Users' : type === 'projects' ? 'Projects' : 'Results'} for “${q}”` : 'Explore'));
    if (!online) return main.append(offlineNotice());

    const grid = h('div', {class: type === 'users' ? 'user-grid' : 'grid'});
    const more = h('button', {class: 'btn', style: 'margin:22px auto 0;display:flex'}, 'Load more');
    const status = h('p', {class: 'empty hidden'});
    let page = 0;
    let path;
    if (q) {
        main.append(h('div', {class: 'tabs'}, [[null, 'All'], ['users', 'Users'], ['projects', 'Projects']].map(([t, label]) =>
            h('a', {class: t === type ? 'active' : '', href: link('explore', t ? {q, type: t} : {q})}, label))));
        path = p => `/search?q=${encodeURIComponent(q)}&page=${p}${type ? `&type=${type}` : ''}`;
    } else {
        const sort = ['trending', 'popular', 'recent'].includes(param('sort')) ? param('sort') : 'trending';
        main.append(h('div', {class: 'tabs'}, [['trending', 'Trending'], ['popular', 'Popular'], ['recent', 'Recent']].map(([s, label]) =>
            h('a', {class: s === sort ? 'active' : '', href: link('explore', {sort: s})}, label))));
        path = p => `/explore?sort=${sort}&page=${p}`;
    }
    const usersBox = h('div');
    main.append(usersBox, grid, status, more);
    const load = async () => {
        more.disabled = true;
        try {
            const data = await api.get(path(page));
            let count;
            if (type === 'users') {
                const cards = userGrid(data.users);
                if (data.users.length) grid.append(...cards.children);
                count = data.users.length;
            } else {
                if (page === 0 && data.users && data.users.length) {
                    usersBox.append(h('h2', {}, 'People'), h('div', {class: 'row', style: 'margin-bottom:24px'}, data.users.map(u =>
                        h('a', {class: 'btn', href: link('user', {u: u.username})}, avatarEl(u, 'sm'), userName(u)))), h('h2', {}, 'Projects'));
                }
                data.projects.forEach(p => grid.append(projectCard(p)));
                count = data.projects.length;
            }
            if (page === 0 && !count) {
                status.textContent = type === 'users' ? 'No users match your search.' :
                    q ? 'No projects match your search.' : 'No shared projects yet.';
                status.classList.remove('hidden');
            }
            more.classList.toggle('hidden', count < 24);
            page++;
        } catch (e) {
            main.append(errorNotice(e));
        } finally {
            more.disabled = false;
        }
    };
    more.addEventListener('click', load);
    load();
})();
