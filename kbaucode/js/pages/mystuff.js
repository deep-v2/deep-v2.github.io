import {apiUrl} from '../api.js';
import {$, api, boot, editorUrl, errorNotice, h, link, modal, offlineNotice, timeAgo, toast} from '../ui.js';

const main = $('#main');
(async () => {
    const {user, online} = await boot('mystuff');
    if (!online) return main.append(h('h1', {}, 'My Stuff'), offlineNotice());
    if (!user) {
        location.href = `${link('login.html')}?next=${encodeURIComponent(location.pathname)}`;
        return;
    }
    main.append(h('div', {class: 'row', style: 'margin-bottom:10px'}, h('h1', {style: 'margin:0'}, 'My Stuff'), h('span', {class: 'spacer'}),
        h('a', {class: 'btn primary', href: link('editor/editor.html')}, '+ New project'),
        h('button', {class: 'btn', onclick: newCollection}, '+ New collection')));
    main.append(h('p', {class: 'muted'}, 'Projects you save with “File → Save to KbauBlocks” in the editor appear here. Share them when they’re ready.'));

    const tabs = h('div', {class: 'tabs'});
    const body = h('div', {class: 'card'});
    main.append(tabs, body);
    const show = async tab => {
        tabs.replaceChildren(...[['projects', 'Projects'], ['collections', 'Collections']].map(([t, l]) =>
            h('button', {class: t === tab ? 'active' : '', onclick: () => show(t)}, l)));
        body.replaceChildren(h('p', {class: 'empty'}, 'Loading…'));
        try {
            if (tab === 'projects') await renderProjects(body, user);
            else await renderCollections(body, user);
        } catch (e) {
            body.replaceChildren(errorNotice(e));
        }
    };
    show('projects');
})();

async function renderProjects (body, user) {
    const {projects} = await api.get(`/users/${encodeURIComponent(user.username)}/projects?all=1&limit=60`);
    if (!projects.length) {
        body.replaceChildren(h('p', {class: 'empty'}, 'No projects yet. ', h('a', {href: link('editor/editor.html')}, 'Make one!')));
        return;
    }
    body.replaceChildren(...projects.map(p => {
        const thumb = h('div', {class: 'thumb'});
        if (p.thumbnailUrl) {
            const img = h('img', {alt: ''});
            apiUrl(p.thumbnailUrl).then(u => {
                img.src = u;
            });
            thumb.append(img);
        }
        const open = h('a', {class: 'btn small primary'}, 'Open in editor');
        editorUrl({kbau_project: p.id}).then(u => {
            open.href = u;
        });
        const share = h('button', {class: 'btn small', onclick: async () => {
            try {
                await api.post(`/projects/${p.id}/${p.shared ? 'unshare' : 'share'}`);
                toast(p.shared ? 'Unshared' : 'Shared!');
                renderProjects(body, user);
            } catch (e) {
                toast(e.message);
            }
        }}, p.shared ? 'Unshare' : 'Share');
        const del = h('button', {class: 'btn small danger', onclick: async () => {
            const ok = await modal('Delete project?', [h('p', {}, `“${p.title}” will be removed. This can't be undone from the website.`)], [
                {label: 'Cancel', value: false, class: 'ghost'}, {label: 'Delete', value: true, class: 'danger'}]);
            if (!ok) return;
            try {
                await api.del(`/projects/${p.id}`);
                renderProjects(body, user);
            } catch (e) {
                toast(e.message);
            }
        }}, 'Delete');
        return h('div', {class: 'list-row'}, thumb,
            h('div', {class: 'grow'},
                h('a', {href: link('project.html', {id: p.id}), style: 'font-weight:800;color:var(--text)'}, p.title),
                h('div', {class: 'muted small'},
                    p.shared ? h('span', {class: 'badge accent'}, 'Shared') : h('span', {class: 'badge warn'}, 'Unshared'),
                    ` v${p.version} · updated ${timeAgo(p.updatedAt)} · ♥ ${p.stats.loves} · 👁 ${p.stats.views}`)),
            h('div', {class: 'row'}, open, share, del));
    }));
}

async function renderCollections (body, user) {
    const {collections} = await api.get(`/users/${encodeURIComponent(user.username)}/collections`);
    body.replaceChildren(...(collections.length ? collections.map(c => h('div', {class: 'list-row'},
        h('div', {class: 'grow'},
            h('a', {href: link('collection.html', {id: c.id}), style: 'font-weight:800;color:var(--text)'}, c.title),
            h('div', {class: 'muted small'}, `${c.projectCount} projects · updated ${timeAgo(c.updatedAt)}`)),
        h('a', {class: 'btn small', href: link('collection.html', {id: c.id})}, 'Open'))) :
        [h('p', {class: 'empty'}, 'No collections yet.')]));
}

async function newCollection () {
    const title = h('input', {type: 'text', id: 'c-title', maxlength: 100});
    const description = h('textarea', {id: 'c-desc', maxlength: 2000});
    const ok = await modal('New collection', [
        h('div', {class: 'field'}, h('label', {for: 'c-title'}, 'Title'), title),
        h('div', {class: 'field'}, h('label', {for: 'c-desc'}, 'Description'), description)
    ], [{label: 'Cancel', value: false, class: 'ghost'}, {label: 'Create', value: true, class: 'primary'}]);
    if (!ok) return;
    try {
        const {collection} = await api.post('/collections', {title: title.value, description: description.value});
        location.href = link('collection.html', {id: collection.id});
    } catch (e) {
        toast(e.message);
    }
}
