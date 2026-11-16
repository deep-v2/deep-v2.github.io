import {$, api, avatarEl, boot, h, link, offlineNotice, param, projectCard, errorNotice} from '../ui.js';

const main = $('#main');
(async () => {
    const {online} = await boot('explore');
    const q = (param('q') || '').trim();
    main.append(h('h1', {}, q ? `Results for “${q}”` : 'Explore'));
    if (!online) return main.append(offlineNotice());

    const grid = h('div', {class: 'grid'});
    const more = h('button', {class: 'btn', style: 'margin:22px auto 0;display:flex'}, 'Load more');
    const status = h('p', {class: 'empty hidden'});
    let page = 0;
    let path;
    if (q) {
        path = p => `/search?q=${encodeURIComponent(q)}&page=${p}`;
    } else {
        const sort = ['trending', 'popular', 'recent'].includes(param('sort')) ? param('sort') : 'trending';
        main.append(h('div', {class: 'tabs'}, [['trending', 'Trending'], ['popular', 'Popular'], ['recent', 'Recent']].map(([s, label]) =>
            h('a', {class: s === sort ? 'active' : '', href: link('explore.html', {sort: s})}, label))));
        path = p => `/explore?sort=${sort}&page=${p}`;
    }
    const usersBox = h('div');
    main.append(usersBox, grid, status, more);
    const load = async () => {
        more.disabled = true;
        try {
            const data = await api.get(path(page));
            if (page === 0 && data.users && data.users.length) {
                usersBox.append(h('h2', {}, 'People'), h('div', {class: 'row', style: 'margin-bottom:24px'}, data.users.map(u =>
                    h('a', {class: 'btn', href: link('user.html', {u: u.username})}, avatarEl(u, 'sm'), u.username))), h('h2', {}, 'Projects'));
            }
            data.projects.forEach(p => grid.append(projectCard(p)));
            if (page === 0 && !data.projects.length) {
                status.textContent = q ? 'No projects match your search.' : 'No shared projects yet.';
                status.classList.remove('hidden');
            }
            more.classList.toggle('hidden', data.projects.length < 24);
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
