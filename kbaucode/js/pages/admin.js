import {$, api, boot, errorNotice, h, link, offlineNotice, timeAgo, toast} from '../ui.js';

const main = $('#main');
(async () => {
    const {user, online} = await boot('admin');
    main.append(h('h1', {}, 'Moderation'));
    if (!online) return main.append(offlineNotice());
    if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
        return main.append(h('div', {class: 'notice error'}, 'Only moderators can see this page.'));
    }
    const tabs = h('div', {class: 'tabs'});
    const body = h('div');
    main.append(tabs, body);
    const show = async status => {
        tabs.replaceChildren(...[['open', 'Open reports'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']].map(([s, l]) =>
            h('button', {class: s === status ? 'active' : '', onclick: () => show(s)}, l)));
        body.replaceChildren(h('p', {class: 'empty'}, 'Loading…'));
        try {
            const {reports} = await api.get(`/admin/reports?status=${status}`);
            body.replaceChildren(...(reports.length ? reports.map(r => reportCard(r, () => show(status))) : [h('p', {class: 'empty'}, 'Nothing here. 🎉')]));
        } catch (e) {
            body.replaceChildren(errorNotice(e));
        }
    };
    show('open');

    if (user.role === 'admin') {
        const name = h('input', {type: 'text', id: 'role-user', placeholder: 'username'});
        const role = h('select', {id: 'role'}, ['user', 'moderator', 'admin'].map(r => h('option', {value: r}, r)));
        main.append(h('div', {class: 'card', style: 'margin-top:28px;max-width:520px'},
            h('h3', {}, 'Roles'),
            h('div', {class: 'row'}, h('div', {style: 'flex:1'}, name), role, h('button', {class: 'btn primary', onclick: async () => {
                try {
                    await api.post(`/admin/users/${encodeURIComponent(name.value.trim())}/role`, {role: role.value});
                    toast(`${name.value} is now ${role.value}`);
                } catch (e) {
                    toast(e.message);
                }
            }}, 'Set role'))));
    }
})();

function reportCard (r, refresh) {
    let target;
    if (!r.target) target = h('span', {class: 'muted'}, '(target no longer exists)');
    else if (r.targetType === 'project') target = h('a', {href: link('project.html', {id: r.target.id})}, `Project “${r.target.title}” by ${r.target.owner}`, r.target.hidden ? ' (hidden)' : '');
    else if (r.targetType === 'comment') target = h('div', {}, `Comment by ${r.target.author.username} on `, h('a', {href: link('project.html', {id: r.target.projectId})}, `project ${r.target.projectId}`), h('blockquote', {class: 'prose', style: 'margin:6px 0;padding-left:10px;border-left:3px solid var(--border)'}, r.target.content));
    else target = h('a', {href: link('user.html', {u: r.target.username})}, `User @${r.target.username}`, r.target.banned ? ' (banned)' : '');
    const note = h('input', {type: 'text', placeholder: 'Note (optional)', maxlength: 1000});
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
