import {embedUrl} from '../api.js';
import {
    $, api, avatarEl, boot, editorUrl, errorNotice, fmt, h, link, modal, offlineNotice, param, projectGrid, timeAgo, toast,
    verifiedTick
} from '../ui.js';

const main = $('#main');

const reportDialog = async (targetType, targetId) => {
    const reason = h('textarea', {id: 'reason', maxlength: 1000, placeholder: 'What is wrong with it?'});
    const ok = await modal('Report', [h('label', {for: 'reason'}, 'Reason'), reason], [
        {label: 'Cancel', value: false, class: 'ghost'}, {label: 'Send report', value: true, class: 'primary'}]);
    if (!ok) return;
    try {
        await api.post('/reports', {targetType, targetId: String(targetId), reason: reason.value});
        toast('Thanks — a moderator will take a look.');
    } catch (e) {
        toast(e.message);
    }
};

(async () => {
    const {user, online} = await boot('project');
    if (!online) return main.append(offlineNotice());
    const id = param('id');
    let project;
    try {
        ({project} = await api.get(`/projects/${encodeURIComponent(id)}`));
    } catch (e) {
        return main.append(h('h1', {}, 'Project not found'), errorNotice(e));
    }
    document.title = `${project.title} · KbauBlocks`;
    api.post(`/projects/${project.id}/view`).catch(() => {});

    const isOwner = user && project.owner && user.id === project.owner.id;
    const isMod = user && (user.role === 'admin' || user.role === 'moderator');

    // ----- left column: player, actions, notes -----
    const iframe = h('iframe', {title: 'Project player', allow: 'fullscreen; autoplay; microphone; camera', allowfullscreen: true});
    embedUrl(project.id).then(u => {
        iframe.src = u;
    });
    const left = h('div');
    const right = h('div');
    main.append(h('div', {class: 'project-layout'}, left, right));

    const titleEl = h('h1', {style: 'margin-top:4px'}, project.title);
    const ownerLine = h('div', {class: 'owner-line'}, avatarEl(project.owner),
        h('div', {},
            h('a', {href: link('user.html', {u: project.owner.username}), style: 'font-weight:800;color:var(--text)'}, project.owner.displayName), verifiedTick(project.owner),
            h('div', {class: 'muted small'},
                project.shared ? `Shared ${timeAgo(project.sharedAt)}` : 'Not shared',
                ` · Updated ${timeAgo(project.updatedAt)}`)));
    const statusBadges = h('div', {class: 'row', style: 'margin-bottom:6px'},
        !project.shared ? h('span', {class: 'badge warn'}, 'Unshared — only you can see this') : null,
        project.hidden ? h('span', {class: 'badge warn'}, 'Hidden by moderators') : null);
    left.append(statusBadges, h('div', {class: 'player'}, iframe));

    const loveBtn = h('button', {class: `btn love ${project.loved ? 'on' : ''}`}, `♥ ${fmt(project.stats.loves)}`);
    const favBtn = h('button', {class: `btn ${project.favorited ? 'on' : ''}`}, `★ ${fmt(project.stats.favorites)}`);
    const requireLogin = () => {
        location.href = `${link('login.html')}?next=${encodeURIComponent(location.pathname + location.search)}`;
    };
    loveBtn.addEventListener('click', async () => {
        if (!user) return requireLogin();
        try {
            ({project} = await api.request(project.loved ? 'DELETE' : 'POST', `/projects/${project.id}/love`));
            loveBtn.textContent = `♥ ${fmt(project.stats.loves)}`;
            loveBtn.classList.toggle('on', project.loved);
        } catch (e) {
            toast(e.message);
        }
    });
    favBtn.addEventListener('click', async () => {
        if (!user) return requireLogin();
        try {
            ({project} = await api.request(project.favorited ? 'DELETE' : 'POST', `/projects/${project.id}/favorite`));
            favBtn.textContent = `★ ${fmt(project.stats.favorites)}`;
            favBtn.classList.toggle('on', project.favorited);
        } catch (e) {
            toast(e.message);
        }
    });

    const actions = h('div', {class: 'actions'}, loveBtn, favBtn,
        h('span', {class: 'btn ghost', style: 'cursor:default'}, `👁 ${fmt(project.stats.views)}`));
    const seeInside = h('a', {class: 'btn primary'}, isOwner ? 'Open in editor' : 'See inside');
    editorUrl(isOwner ? {kbau_project: project.id} : {kbau_project: project.id, kbau_remix: project.id}).then(u => {
        seeInside.href = u;
    });
    actions.append(seeInside);
    if (!isOwner) {
        const remix = h('a', {class: 'btn'}, '⑂ Remix');
        editorUrl({kbau_project: project.id, kbau_remix: project.id}).then(u => {
            remix.href = u;
        });
        remix.title = 'Open a copy in the editor. Saving it creates your remix, credited to the original.';
        actions.append(remix);
    }
    if (user) {
        actions.append(h('button', {class: 'btn', onclick: () => addToCollection(project, user)}, '+ Collection'));
        if (!isOwner) actions.append(h('button', {class: 'btn ghost small', onclick: () => reportDialog('project', project.id)}, 'Report'));
    }
    left.append(actions);

    // ----- right column: info -----
    right.append(titleEl, ownerLine);
    if (project.remixOf) {
        right.append(h('div', {class: 'notice small'}, '⑂ Remix of ',
            h('a', {href: link('project.html', {id: project.remixOf.id})}, project.remixOf.title),
            project.remixOf.owner ? ` by ${project.remixOf.owner}` : ''));
    }
    const instructions = h('div', {class: 'prose'}, project.instructions || h('span', {class: 'muted'}, 'No instructions.'));
    const description = h('div', {class: 'prose'}, project.description || h('span', {class: 'muted'}, 'No notes or credits.'));
    right.append(h('div', {class: 'card', style: 'margin-bottom:14px'}, h('h3', {}, 'Instructions'), instructions),
        h('div', {class: 'card'}, h('h3', {}, 'Notes and credits'), description));

    if (isOwner || isMod) right.append(ownerPanel(project, isOwner, isMod));

    // ----- comments -----
    const commentsBox = h('div', {class: 'card', style: 'margin-top:22px'});
    left.append(commentsBox);
    renderComments(commentsBox, project, user, isOwner, isMod);

    // ----- remixes -----
    const remixBox = h('div');
    left.append(h('div', {class: 'section-head'}, h('h2', {}, `Remixes (${project.stats.remixes})`)), remixBox);
    api.get(`/projects/${project.id}/remixes?limit=12`)
        .then(({projects}) => remixBox.replaceChildren(projectGrid(projects, 'No remixes yet.')))
        .catch(e => remixBox.replaceChildren(errorNotice(e)));
})();

function ownerPanel (project, isOwner, isMod) {
    const panel = h('div', {class: 'card', style: 'margin-top:14px'});
    const msg = h('div');
    const render = () => {
        panel.replaceChildren(h('h3', {}, isOwner ? 'Manage project' : 'Moderation'), msg);
        if (isOwner) {
            const title = h('input', {type: 'text', id: 'p-title', value: project.title, maxlength: 100});
            const instructions = h('textarea', {id: 'p-ins', maxlength: 5000}, project.instructions);
            const description = h('textarea', {id: 'p-desc', maxlength: 5000}, project.description);
            const save = h('button', {class: 'btn primary', onclick: async () => {
                save.disabled = true;
                try {
                    ({project} = await api.patch(`/projects/${project.id}`, {
                        title: title.value, instructions: instructions.value, description: description.value
                    }));
                    toast('Saved');
                    setTimeout(() => location.reload(), 400);
                } catch (e) {
                    msg.replaceChildren(errorNotice(e));
                    save.disabled = false;
                }
            }}, 'Save details');
            const shareBtn = h('button', {class: `btn ${project.shared ? '' : 'primary'}`, onclick: async () => {
                try {
                    ({project} = await api.post(`/projects/${project.id}/${project.shared ? 'unshare' : 'share'}`));
                    toast(project.shared ? 'Shared with everyone!' : 'Unshared');
                    setTimeout(() => location.reload(), 400);
                } catch (e) {
                    msg.replaceChildren(errorNotice(e));
                }
            }}, project.shared ? 'Unshare' : 'Share');
            panel.append(
                h('div', {class: 'field'}, h('label', {for: 'p-title'}, 'Title'), title),
                h('div', {class: 'field'}, h('label', {for: 'p-ins'}, 'Instructions'), instructions),
                h('div', {class: 'field'}, h('label', {for: 'p-desc'}, 'Notes and credits'), description),
                h('div', {class: 'row'}, save, shareBtn, h('span', {class: 'spacer'}),
                    h('button', {class: 'btn danger', onclick: () => deleteProject(project)}, 'Delete')));
            const versions = h('div', {class: 'small', style: 'margin-top:16px'});
            panel.append(h('h3', {style: 'margin-top:18px'}, 'Version history'), versions);
            api.get(`/projects/${project.id}/versions`).then(({versions: list}) => {
                versions.replaceChildren(...list.slice(0, 15).map(v => h('div', {class: 'list-row'},
                    h('span', {class: 'grow'}, `v${v.version} · ${(v.size / 1024).toFixed(0)} KB · ${timeAgo(v.createdAt)}`,
                        v.version === project.version ? h('span', {class: 'badge accent', style: 'margin-left:6px'}, 'current') : null),
                    v.version !== project.version ? h('button', {class: 'btn small', onclick: async () => {
                        try {
                            await api.post(`/projects/${project.id}/versions/${v.version}/restore`);
                            toast(`Restored v${v.version} as a new version`);
                            setTimeout(() => location.reload(), 500);
                        } catch (e) {
                            toast(e.message);
                        }
                    }}, 'Restore') : null)));
            }).catch(e => versions.replaceChildren(errorNotice(e)));
        }
        if (isMod && !isOwner) {
            panel.append(h('div', {class: 'row'},
                h('button', {class: 'btn', onclick: async () => {
                    await api.post(`/admin/projects/${project.id}/${project.hidden ? 'unhide' : 'hide'}`);
                    location.reload();
                }}, project.hidden ? 'Unhide project' : 'Hide project'),
                h('button', {class: 'btn danger', onclick: () => deleteProject(project)}, 'Delete')));
        }
    };
    render();
    return panel;
}

async function deleteProject (project) {
    const ok = await modal('Delete project?', [h('p', {}, `“${project.title}” will be removed from KbauBlocks. This can't be undone from the website.`)], [
        {label: 'Cancel', value: false, class: 'ghost'}, {label: 'Delete', value: true, class: 'danger'}]);
    if (!ok) return;
    try {
        await api.del(`/projects/${project.id}`);
        location.href = link('mystuff.html');
    } catch (e) {
        toast(e.message);
    }
}

async function addToCollection (project, user) {
    let collections;
    try {
        ({collections} = await api.get(`/users/${encodeURIComponent(user.username)}/collections`));
    } catch (e) {
        return toast(e.message);
    }
    if (!project.shared) return toast('Share the project before adding it to a collection.');
    const select = h('select', {id: 'col'}, collections.map(c => h('option', {value: c.id}, c.title)),
        h('option', {value: '__new'}, '+ New collection…'));
    const newTitle = h('input', {type: 'text', id: 'col-new', placeholder: 'Collection name', maxlength: 100});
    const newField = h('div', {class: `field ${collections.length ? 'hidden' : ''}`, style: 'margin-top:12px'}, newTitle);
    if (!collections.length) select.value = '__new';
    select.addEventListener('change', () => newField.classList.toggle('hidden', select.value !== '__new'));
    const ok = await modal('Add to collection', [h('label', {for: 'col'}, 'Collection'), select, newField], [
        {label: 'Cancel', value: false, class: 'ghost'}, {label: 'Add', value: true, class: 'primary'}]);
    if (!ok) return;
    try {
        let colId = select.value;
        if (colId === '__new') {
            const {collection} = await api.post('/collections', {title: newTitle.value});
            colId = collection.id;
        }
        await api.post(`/collections/${colId}/projects`, {projectId: project.id});
        toast('Added to collection');
    } catch (e) {
        toast(e.message);
    }
}

function renderComments (box, project, user, isOwner, isMod) {
    const list = h('div');
    const header = h('h2', {}, `Comments (${project.stats.comments})`);
    const composer = (parentId, onDone) => {
        const ta = h('textarea', {maxlength: 500, placeholder: parentId ? 'Write a reply…' : 'Leave a kind comment…', 'aria-label': 'Comment'});
        const btn = h('button', {class: 'btn primary small', onclick: async () => {
            if (!ta.value.trim()) return;
            btn.disabled = true;
            try {
                await api.post(`/projects/${project.id}/comments`, {content: ta.value, parentId});
                ta.value = '';
                onDone();
            } catch (e) {
                toast(e.message);
            } finally {
                btn.disabled = false;
            }
        }}, parentId ? 'Reply' : 'Post');
        return h('div', {style: 'margin:8px 0 12px'}, ta, h('div', {class: 'row', style: 'justify-content:flex-end;margin-top:6px'}, btn));
    };
    const commentEl = (c, top) => {
        const replyBox = h('div');
        const canDelete = user && (user.username === c.author.username || isOwner || isMod);
        const el = h('div', {class: 'comment'}, avatarEl(c.author, 'sm'),
            h('div', {class: 'body'},
                h('div', {class: 'head'}, h('a', {href: link('user.html', {u: c.author.username})}, c.author.displayName), verifiedTick(c.author),
                    h('span', {class: 'muted'}, timeAgo(c.createdAt))),
                h('div', {class: 'text'}, c.hidden ? h('em', {class: 'muted'}, 'This comment was removed by a moderator.') : c.content),
                h('div', {class: 'tools'},
                    user && top ? h('button', {onclick: () => replyBox.replaceChildren(composer(c.id, load))}, 'Reply') : null,
                    canDelete ? h('button', {onclick: async () => {
                        try {
                            await api.del(`/comments/${c.id}`);
                            load();
                        } catch (e) {
                            toast(e.message);
                        }
                    }}, 'Delete') : null,
                    user && user.username !== c.author.username ? h('button', {onclick: () => reportDialog('comment', c.id)}, 'Report') : null),
                replyBox,
                top && c.replies && c.replies.length ? h('div', {class: 'replies'}, c.replies.map(r => commentEl(r, false))) : null));
        return el;
    };
    const load = async () => {
        try {
            const {comments} = await api.get(`/projects/${project.id}/comments?limit=50`);
            const total = comments.reduce((n, c) => n + 1 + c.replies.length, 0);
            header.textContent = `Comments (${total})`;
            list.replaceChildren(...(comments.length ? comments.map(c => commentEl(c, true)) : [h('p', {class: 'muted'}, 'No comments yet.')]));
        } catch (e) {
            list.replaceChildren(errorNotice(e));
        }
    };
    box.append(header);
    if (user && (project.shared || isOwner)) box.append(composer(null, load));
    else if (!user) box.append(h('p', {class: 'muted'}, h('a', {href: `${link('login.html')}?next=${encodeURIComponent(location.pathname + location.search)}`}, 'Sign in'), ' to comment.'));
    box.append(list);
    load();
}
