import {apiUrl as apiUrlSafe} from '../api.js';
import {
    $, api, avatarEl, boot, errorNotice, fmt, h, link, modal, offlineNotice, param, projectGrid, timeAgo, toast
} from '../ui.js';

const main = $('#main');
(async () => {
    const {user: me, online} = await boot('user');
    if (!online) return main.append(offlineNotice());
    const username = param('u');
    let data;
    try {
        data = await api.get(`/users/${encodeURIComponent(username || '')}`);
    } catch (e) {
        return main.append(h('h1', {}, 'User not found'), errorNotice(e));
    }
    const {user, stats} = data;
    document.title = `${user.displayName} · KbauBlocks`;
    const isMe = me && me.id === user.id;
    const isMod = me && (me.role === 'admin' || me.role === 'moderator');

    main.append(h('div', {class: 'card', style: 'padding:0;overflow:hidden'},
        h('div', {class: 'profile-banner', style: `background:linear-gradient(120deg, ${user.profileColor}, #000)`}),
        h('div', {class: 'profile-head'}, avatarEl(user, 'lg'),
            h('div', {style: 'padding-bottom:6px;flex:1;min-width:200px'},
                h('h1', {style: 'margin:0'}, user.displayName,
                    user.role !== 'user' ? h('span', {class: 'badge accent', style: 'margin-left:8px'}, user.role) : null,
                    user.banned ? h('span', {class: 'badge warn', style: 'margin-left:8px'}, 'suspended') : null),
                h('div', {class: 'muted'}, `@${user.username} · joined ${timeAgo(user.createdAt)}`)),
            h('div', {class: 'row', style: 'padding-bottom:10px'},
                isMe ? h('a', {class: 'btn', href: link('settings.html')}, 'Edit profile') : null,
                me && !isMe ? h('button', {class: 'btn ghost small', onclick: () => report(user.username)}, 'Report') : null,
                isMod && !isMe ? h('button', {class: 'btn small danger', onclick: async () => {
                    try {
                        await api.post(`/admin/users/${encodeURIComponent(user.username)}/${user.banned ? 'unban' : 'ban'}`);
                        location.reload();
                    } catch (e) {
                        toast(e.message);
                    }
                }}, user.banned ? 'Unban' : 'Ban') : null)),
        h('div', {style: 'padding:6px 20px 20px'},
            h('div', {class: 'stat-row'},
                h('div', {}, h('b', {}, fmt(stats.shared)), h('span', {class: 'muted small'}, 'shared projects')),
                h('div', {}, h('b', {}, fmt(stats.loves)), h('span', {class: 'muted small'}, 'loves received')),
                h('div', {}, h('b', {}, fmt(stats.views)), h('span', {class: 'muted small'}, 'project views')),
                h('div', {}, h('b', {}, fmt(stats.collections)), h('span', {class: 'muted small'}, 'collections'))),
            h('div', {class: 'feature-grid'},
                h('div', {}, h('h3', {}, 'About me'), h('div', {class: 'prose'}, user.bio || h('span', {class: 'muted'}, 'Nothing here yet.'))),
                h('div', {}, h('h3', {}, 'What I\'m working on'), h('div', {class: 'prose'}, user.workingOn || h('span', {class: 'muted'}, 'Nothing here yet.')))))));

    const tabs = [['projects', 'Shared projects'], ['favorites', 'Favorites'], ['collections', 'Collections']];
    const body = h('div');
    const tabBar = h('div', {class: 'tabs', style: 'margin-top:24px'});
    const show = async tab => {
        tabBar.replaceChildren(...tabs.map(([t, label]) => h('button', {class: t === tab ? 'active' : '', onclick: () => show(t)}, label)));
        body.replaceChildren(h('p', {class: 'empty'}, 'Loading…'));
        try {
            if (tab === 'collections') {
                const {collections} = await api.get(`/users/${encodeURIComponent(user.username)}/collections`);
                body.replaceChildren(collections.length ? h('div', {class: 'grid'}, collections.map(c => {
                    const img = h('img', {alt: ''});
                    if (c.thumbnailUrl) apiUrlSafe(c.thumbnailUrl).then(u => {
                        img.src = u;
                    });
                    return h('a', {class: 'project-card', href: link('collection.html', {id: c.id})},
                        h('div', {class: 'thumb'}, c.thumbnailUrl ? img : h('img', {class: 'placeholder', src: link('logo.svg'), alt: ''})),
                        h('div', {class: 'meta'}, h('div', {class: 'title'}, c.title), h('div', {class: 'by'}, `${c.projectCount} projects`)));
                })) : h('p', {class: 'empty'}, 'No collections yet.'));
            } else {
                const {projects} = await api.get(`/users/${encodeURIComponent(user.username)}/${tab}?limit=60`);
                body.replaceChildren(projectGrid(projects, tab === 'favorites' ? 'No favorites yet.' : 'No shared projects yet.'));
            }
        } catch (e) {
            body.replaceChildren(errorNotice(e));
        }
    };
    main.append(tabBar, body);
    show('projects');
})();

async function report (username) {
    const reason = h('textarea', {id: 'reason', maxlength: 1000});
    const ok = await modal('Report user', [h('label', {for: 'reason'}, 'Reason'), reason], [
        {label: 'Cancel', value: false, class: 'ghost'}, {label: 'Send report', value: true, class: 'primary'}]);
    if (!ok) return;
    try {
        await api.post('/reports', {targetType: 'user', targetId: username, reason: reason.value});
        toast('Thanks — a moderator will take a look.');
    } catch (e) {
        toast(e.message);
    }
}
