import {embedUrl, imageUrl} from '../api.js';
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

    // Owners edit the title, Description and Notes right here; each saves when you click away.
    const saveState = h('span', {class: 'save-state muted small', 'aria-live': 'polite'});
    const saveField = async (field, value) => {
        if (value === project[field]) return;
        saveState.textContent = 'Saving…';
        try {
            ({project} = await api.patch(`/projects/${project.id}`, {[field]: value}));
            document.title = `${project.title} · KbauBlocks`;
            saveState.textContent = 'Saved';
            setTimeout(() => {
                if (saveState.textContent === 'Saved') saveState.textContent = '';
            }, 2000);
        } catch (e) {
            saveState.textContent = '';
            toast(`Couldn't save: ${e.message}`);
        }
    };
    const editableText = (field, placeholder, emptyText) => {
        if (!isOwner) return h('div', {class: 'prose'}, project[field] || h('span', {class: 'muted'}, emptyText));
        const ta = h('textarea', {class: 'inline-edit', maxlength: 5000, placeholder, 'aria-label': placeholder}, project[field]);
        const grow = () => {
            ta.style.height = 'auto';
            ta.style.height = `${Math.max(90, ta.scrollHeight + 2)}px`;
        };
        ta.addEventListener('input', grow);
        ta.addEventListener('change', () => saveField(field, ta.value));
        requestAnimationFrame(grow);
        return ta;
    };
    let titleEl;
    if (isOwner) {
        titleEl = h('input', {class: 'title-input', type: 'text', maxlength: 100, value: project.title, 'aria-label': 'Project title'});
        titleEl.addEventListener('keydown', e => {
            if (e.key === 'Enter') titleEl.blur();
        });
        titleEl.addEventListener('change', () => {
            if (!titleEl.value.trim()) titleEl.value = 'Untitled';
            saveField('title', titleEl.value.trim());
        });
    } else {
        titleEl = h('h1', {style: 'margin-top:4px'}, project.title);
    }
    const ownerLine = h('div', {class: 'owner-line'}, avatarEl(project.owner),
        h('div', {},
            h('a', {href: link('user.html', {u: project.owner.username}), style: 'font-weight:800;color:var(--text)'}, project.owner.displayName), verifiedTick(project.owner),
            h('div', {class: 'muted small'},
                project.shared ? `Shared ${timeAgo(project.sharedAt)}` : 'Not shared',
                ` · Updated ${timeAgo(project.updatedAt)}`)));
    const statusBadges = h('div', {class: 'row', style: 'margin-bottom:6px'},
        !project.shared ? h('span', {class: 'badge warn'}, 'Unshared — only you can see this') : null,
        !project.shared && isOwner ? shareButton(project) : null,
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
    right.append(
        h('div', {class: 'card', style: 'margin-bottom:14px'}, h('h3', {}, 'Description'),
            editableText('description', 'What is your project about? How do you play it?', 'No description.')),
        h('div', {class: 'card'}, h('h3', {}, 'Notes'),
            editableText('notes', 'Credits, changelog, anything else people should know.', 'No notes.')));
    if (isOwner) right.append(h('div', {class: 'small muted', style: 'margin-top:6px;min-height:1.4em'}, saveState));

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
            panel.append(
                h('p', {class: 'muted small', style: 'margin-top:0'}, 'Edit the title, Description and Notes above; they save automatically.'),
                h('div', {class: 'row'}, shareButton(project, msg), h('span', {class: 'spacer'}),
                    h('button', {class: 'btn danger', onclick: () => deleteProject(project)}, 'Delete')),
                thumbnailEditor(project));
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

// Project thumbnail: upload your own image (kept when you save from the editor), or go back to the stage picture.
function thumbnailEditor (project) {
    const preview = h('img', {class: 'thumb-preview', alt: 'Current thumbnail'});
    const showPreview = () => {
        if (project.thumbnailUrl) imageUrl(project.thumbnailUrl).then(u => {
            preview.src = u;
        });
        else preview.src = link('logo.png');
    };
    showPreview();
    const input = h('input', {type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden'});
    const status = h('div', {class: 'muted small'});
    const note = () => (project.customThumbnail ?
        'Your own image. Saving from the editor keeps it.' :
        'Automatic: a picture of the stage, taken each time you save from the editor.');
    const reset = h('button', {class: 'btn small ghost'}, 'Use the stage instead');
    const paint = () => {
        status.textContent = note();
        reset.classList.toggle('hidden', !project.customThumbnail);
    };
    input.addEventListener('change', async () => {
        const f = input.files[0];
        input.value = '';
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) return toast('That image is over 2 MB.');
        const form = new FormData();
        form.append('thumbnail', f, f.name);
        status.textContent = 'Uploading…';
        try {
            ({project} = await api.upload('POST', `/projects/${project.id}/thumbnail`, form));
            showPreview();
            toast('Thumbnail updated');
        } catch (e) {
            toast(e.message);
        }
        paint();
    });
    reset.addEventListener('click', async () => {
        try {
            ({project} = await api.del(`/projects/${project.id}/thumbnail/custom`));
            toast('The next save from the editor will use the stage');
        } catch (e) {
            toast(e.message);
        }
        paint();
    });
    paint();
    return h('div', {class: 'thumb-editor'},
        h('h3', {}, 'Thumbnail'),
        h('div', {class: 'row', style: 'align-items:flex-start;flex-wrap:nowrap'}, preview,
            h('div', {style: 'flex:1;min-width:0'}, status,
                h('div', {class: 'row', style: 'margin-top:8px'},
                    h('button', {class: 'btn small', onclick: () => input.click()}, 'Upload image'), reset, input),
                h('div', {class: 'muted small', style: 'margin-top:6px'}, 'PNG, JPEG, GIF or WebP, up to 2 MB. 4:3 looks best.'))));
}

function shareButton (project, msg) {
    return h('button', {class: `btn ${project.shared ? '' : 'primary'}`, onclick: async () => {
        try {
            ({project} = await api.post(`/projects/${project.id}/${project.shared ? 'unshare' : 'share'}`));
            toast(project.shared ? 'Shared with everyone!' : 'Unshared');
            setTimeout(() => location.reload(), 400);
        } catch (e) {
            if (msg) msg.replaceChildren(errorNotice(e));
            else toast(e.message);
        }
    }}, project.shared ? 'Unshare' : 'Share');
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

const BURIED_SCORE = -5;

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
        // The project owner (or a moderator) can pin one top-level comment; it is listed first.
        const canPin = top && (isOwner || isMod) && !c.hidden;
        const el = h('div', {class: `comment ${c.pinned ? 'pinned' : ''}`}, avatarEl(c.author, 'sm'),
            h('div', {class: 'body'},
                c.pinned ? h('div', {class: 'pinned-label small'}, '📌 Pinned by the creator') : null,
                h('div', {class: 'head'}, h('a', {href: link('user.html', {u: c.author.username})}, c.author.displayName), verifiedTick(c.author),
                    h('span', {class: 'muted'}, timeAgo(c.createdAt))),
                h('div', {class: 'text'}, c.hidden ? h('em', {class: 'muted'}, 'This comment was removed by a moderator.') :
                    c.score <= BURIED_SCORE ? buried(c.content) : c.content),
                h('div', {class: 'tools'},
                    c.hidden ? null : voteControl(c),
                    user && top ? h('button', {onclick: () => replyBox.replaceChildren(composer(c.id, load))}, 'Reply') : null,
                    canPin ? h('button', {onclick: async () => {
                        try {
                            await api.request(c.pinned ? 'DELETE' : 'POST', `/comments/${c.id}/pin`);
                            toast(c.pinned ? 'Unpinned' : 'Pinned to the top');
                            load();
                        } catch (e) {
                            toast(e.message);
                        }
                    }}, c.pinned ? 'Unpin' : 'Pin') : null,
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
    // Upvote / downvote: click the same arrow again to take your vote back.
    const voteControl = c => {
        const own = user && user.username === c.author.username;
        const score = h('span', {class: 'vote-score'}, String(c.score));
        const up = h('button', {class: 'vote up', 'aria-label': 'Upvote', title: own ? "You can't vote on your own comment" : 'Upvote'}, '▲');
        const down = h('button', {class: 'vote down', 'aria-label': 'Downvote', title: own ? "You can't vote on your own comment" : 'Downvote'}, '▼');
        const paint = () => {
            score.textContent = String(c.score);
            up.classList.toggle('on', c.myVote === 1);
            down.classList.toggle('on', c.myVote === -1);
            up.setAttribute('aria-pressed', String(c.myVote === 1));
            down.setAttribute('aria-pressed', String(c.myVote === -1));
        };
        const vote = value => async () => {
            if (!user) {
                location.href = `${link('login.html')}?next=${encodeURIComponent(location.pathname + location.search)}`;
                return;
            }
            const next = c.myVote === value ? 0 : value;
            try {
                const r = await api.post(`/comments/${c.id}/vote`, {value: next});
                c.score = r.score;
                c.myVote = r.myVote;
                paint();
            } catch (e) {
                toast(e.message);
            }
        };
        up.addEventListener('click', vote(1));
        down.addEventListener('click', vote(-1));
        if (own) up.disabled = down.disabled = true;
        paint();
        return h('span', {class: 'vote-box'}, up, score, down);
    };
    // Comments with a very low score are folded away (one click shows them).
    const buried = content => {
        const box = h('span', {class: 'muted'}, h('em', {}, 'Hidden because of downvotes. '));
        box.append(h('button', {class: 'link-button', onclick: () => box.replaceWith(content)}, 'Show'));
        return box;
    };
    let sort = 'new';
    const sortTabs = h('div', {class: 'tabs small-tabs comment-sort'});
    const renderSort = () => sortTabs.replaceChildren(...[['new', 'Newest'], ['top', 'Top']].map(([k, label]) =>
        h('button', {class: k === sort ? 'active' : '', onclick: () => {
            sort = k;
            renderSort();
            load();
        }}, label)));
    renderSort();
    const load = async () => {
        try {
            const {comments} = await api.get(`/projects/${project.id}/comments?limit=50&sort=${sort}`);
            const total = comments.reduce((n, c) => n + 1 + c.replies.length, 0);
            header.textContent = `Comments (${total})`;
            list.replaceChildren(...(comments.length ? comments.map(c => commentEl(c, true)) : [h('p', {class: 'muted'}, 'No comments yet.')]));
        } catch (e) {
            list.replaceChildren(errorNotice(e));
        }
    };
    box.append(h('div', {class: 'comments-head'}, header, sortTabs));
    if (user && (project.shared || isOwner)) box.append(composer(null, load));
    else if (!user) box.append(h('p', {class: 'muted'}, h('a', {href: `${link('login.html')}?next=${encodeURIComponent(location.pathname + location.search)}`}, 'Sign in'), ' to comment.'));
    box.append(list);
    load();
}
