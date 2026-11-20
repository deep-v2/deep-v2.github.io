import {$, api, boot, errorNotice, h, link, modal, offlineNotice, param, projectCard, timeAgo, toast} from '../ui.js';

const main = $('#main');
(async () => {
    const {user, online} = await boot('collection');
    if (!online) return main.append(offlineNotice());
    let data;
    try {
        data = await api.get(`/collections/${encodeURIComponent(param('id') || '')}`);
    } catch (e) {
        return main.append(h('h1', {}, 'Collection not found'), errorNotice(e));
    }
    const {collection, projects} = data;
    document.title = `${collection.title} · KbauBlocks`;
    const isOwner = user && user.username === collection.owner.username;

    main.append(h('div', {class: 'row'},
        h('div', {style: 'flex:1;min-width:240px'},
            h('h1', {style: 'margin-bottom:4px'}, collection.title),
            h('div', {class: 'muted'}, 'Collection by ', h('a', {href: link('user.html', {u: collection.owner.username})}, collection.owner.displayName),
                ` · ${collection.projectCount} projects · updated ${timeAgo(collection.updatedAt)}`)),
        isOwner ? h('button', {class: 'btn', onclick: () => edit(collection)}, 'Edit') : null,
        isOwner ? h('button', {class: 'btn danger', onclick: () => remove(collection)}, 'Delete') : null));
    if (collection.description) main.append(h('p', {class: 'prose', style: 'margin-top:12px'}, collection.description));
    main.append(h('div', {style: 'height:16px'}));

    if (!projects.length) {
        main.append(h('p', {class: 'empty'}, isOwner ? 'Add shared projects from their project page with “+ Collection”.' : 'This collection is empty.'));
        return;
    }
    main.append(h('div', {class: 'grid'}, projects.map(p => {
        const card = projectCard(p);
        if (!isOwner) return card;
        return h('div', {}, card, h('button', {class: 'btn small ghost', style: 'margin-top:6px', onclick: async () => {
            try {
                await api.del(`/collections/${collection.id}/projects/${p.id}`);
                location.reload();
            } catch (e) {
                toast(e.message);
            }
        }}, 'Remove'));
    })));
})();

async function edit (collection) {
    const title = h('input', {type: 'text', id: 'c-title', value: collection.title, maxlength: 100});
    const description = h('textarea', {id: 'c-desc', maxlength: 2000}, collection.description);
    const ok = await modal('Edit collection', [
        h('div', {class: 'field'}, h('label', {for: 'c-title'}, 'Title'), title),
        h('div', {class: 'field'}, h('label', {for: 'c-desc'}, 'Description'), description)
    ], [{label: 'Cancel', value: false, class: 'ghost'}, {label: 'Save', value: true, class: 'primary'}]);
    if (!ok) return;
    try {
        await api.patch(`/collections/${collection.id}`, {title: title.value, description: description.value});
        location.reload();
    } catch (e) {
        toast(e.message);
    }
}

async function remove (collection) {
    const ok = await modal('Delete collection?', [h('p', {}, 'The projects themselves are not affected.')], [
        {label: 'Cancel', value: false, class: 'ghost'}, {label: 'Delete', value: true, class: 'danger'}]);
    if (!ok) return;
    try {
        await api.del(`/collections/${collection.id}`);
        location.href = link('mystuff.html');
    } catch (e) {
        toast(e.message);
    }
}
