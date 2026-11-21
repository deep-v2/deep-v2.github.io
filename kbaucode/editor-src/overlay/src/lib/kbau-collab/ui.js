/**
 * KbauBlocks live collaboration: the menu bar button, the panel, live cursors and join/leave toasts.
 * Plain DOM (mounted by components/kbau-collab/kbau-collab.jsx) so it stays independent of TurboWarp's React tree.
 * Part of the KbauBlocks patch set, GPL-3.0.
 */
import {getCollabEngine} from './engine.js';
import {getApiBase, getToken, saveToKbau, siteUrl} from '../kbau-cloud.js';

const STATUS_POLL_MS = 30 * 1000;

const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));

const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.4c2.6-.4 4.6 1.2 5.1 3.9"/></svg>';
const CURSOR = color => `<svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true"><path d="M1.5 1.5l14 9.3-6.4 1.2-3.3 6.3z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

const CSS = `
.kbau-collab { position: relative; display: flex; align-items: center; height: 100%; }
.kbau-collab-btn {
    display: inline-flex; align-items: center; gap: .4rem; height: 2.125rem; padding: 0 .8rem; border-radius: 999px;
    border: 1px solid #2a2a2a; background: #161616; color: #fff; font: inherit; font-weight: 800; font-size: .8rem;
    cursor: pointer; white-space: nowrap;
}
.kbau-collab-btn:hover { background: #222; }
.kbau-collab-btn.live { border-color: #2f9e44; background: #0f2a17; }
.kbau-collab-btn.others { border-color: #2f9e44; }
.kbau-collab-dot { width: 8px; height: 8px; border-radius: 999px; background: #51cf66; box-shadow: 0 0 0 0 rgba(81,207,102,.7); animation: kbau-collab-pulse 1.8s infinite; }
@keyframes kbau-collab-pulse { 70% { box-shadow: 0 0 0 7px rgba(81,207,102,0); } 100% { box-shadow: 0 0 0 0 rgba(81,207,102,0); } }
.kbau-collab-stack { display: inline-flex; }
.kbau-collab-stack img, .kbau-collab-stack span { width: 20px; height: 20px; border-radius: 999px; border: 2px solid; margin-left: -6px; background: #333; object-fit: cover; box-sizing: border-box; }
.kbau-collab-stack :first-child { margin-left: 0; }
.kbau-collab-stack span { display: inline-flex; align-items: center; justify-content: center; font-size: .6rem; color: #fff; }
.kbau-collab-spin { width: 12px; height: 12px; border-radius: 999px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: kbau-collab-spin .8s linear infinite; }
@keyframes kbau-collab-spin { to { transform: rotate(360deg); } }
.kbau-collab-panel {
    position: fixed; z-index: 2000; width: 340px; max-width: calc(100vw - 16px); max-height: calc(100vh - 70px); overflow-y: auto;
    background: #161616; color: #ededed; border: 1px solid #2a2a2a; border-radius: 14px; box-shadow: 0 16px 40px rgba(0,0,0,.55);
    font-family: Nunito, "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: .875rem; line-height: 1.4; padding: 14px;
}
.kbau-collab-panel h3 { margin: 0; font-size: 1rem; font-weight: 900; }
.kbau-collab-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.kbau-collab-chip { font-size: .7rem; font-weight: 900; padding: 2px 8px; border-radius: 999px; background: #262626; color: #bbb; }
.kbau-collab-chip.live { background: #0f2a17; color: #69db7c; }
.kbau-collab-muted { color: #9a9a9a; font-size: .8rem; }
.kbau-collab-section { border-top: 1px solid #262626; margin-top: 12px; padding-top: 12px; }
.kbau-collab-section-title { font-size: .7rem; font-weight: 900; letter-spacing: .06em; text-transform: uppercase; color: #9a9a9a; margin-bottom: 6px; }
.kbau-collab-pbtn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px; border-radius: 999px; border: 1px solid #2a2a2a;
    background: #1d1d1d; color: #ededed; font: inherit; font-weight: 800; cursor: pointer;
}
.kbau-collab-pbtn:hover { background: #262626; }
.kbau-collab-pbtn.primary { background: #fff; color: #000; border-color: #fff; }
.kbau-collab-pbtn.primary:hover { background: #d4d4d4; }
.kbau-collab-pbtn.wide { width: 100%; }
.kbau-collab-pbtn.small { padding: 4px 10px; font-size: .75rem; }
.kbau-collab-pbtn:disabled { opacity: .55; cursor: default; }
.kbau-collab-row { display: flex; align-items: center; gap: 8px; }
.kbau-collab-person { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 10px; }
button.kbau-collab-person { width: 100%; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
button.kbau-collab-person:hover { background: #1f1f1f; }
.kbau-collab-avatar { width: 32px; height: 32px; border-radius: 10px; object-fit: cover; background: #333; flex: none; box-sizing: border-box; }
.kbau-collab-avatar.ring { border: 2.5px solid; }
.kbau-collab-person b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kbau-collab-person > div { min-width: 0; flex: 1; }
.kbau-collab-x { border: 0; background: none; color: #9a9a9a; cursor: pointer; font: inherit; font-size: 1rem; padding: 2px 6px; border-radius: 6px; }
.kbau-collab-x:hover { color: #fff; background: #262626; }
.kbau-collab-panel input {
    flex: 1; min-width: 0; padding: 8px 12px; border-radius: 999px; border: 1px solid #2a2a2a; background: #0e0e0e; color: #fff; font: inherit; outline: none;
}
.kbau-collab-panel input:focus { border-color: #fff; }
.kbau-collab-suggest { margin-top: 4px; }
.kbau-collab-progress { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.kbau-collab-note { margin-top: 10px; padding: 8px 10px; border-radius: 10px; background: #1d1d1d; color: #bbb; font-size: .78rem; }
.kbau-collab-note.error { background: #2a1414; color: #ffa8a8; }
.kbau-collab-cursors { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 45; }
.kbau-collab-cursor { position: absolute; left: 0; top: 0; will-change: transform; transition: opacity .2s; }
.kbau-collab-cursor span {
    position: absolute; left: 14px; top: 16px; padding: 1px 7px; border-radius: 999px; color: #fff; font: 800 11px Nunito, Helvetica, Arial, sans-serif;
    white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,.35);
}
.kbau-collab-toasts { position: fixed; left: 12px; bottom: 12px; z-index: 2001; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.kbau-collab-toast {
    display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; background: #000; color: #fff;
    font: 800 12px Nunito, Helvetica, Arial, sans-serif; box-shadow: 0 6px 18px rgba(0,0,0,.4); animation: kbau-collab-in .2s ease;
}
.kbau-collab-toast i { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
@keyframes kbau-collab-in { from { transform: translateY(6px); opacity: 0; } }
`;

let styleAdded = false;
const addStyle = () => {
    if (styleAdded) return;
    styleAdded = true;
    document.head.append(h('style', {}, CSS));
};

const avatar = (person, size = 32, ring = null) => {
    const img = h('img', {class: `kbau-collab-avatar${ring ? ' ring' : ''}`, alt: '', width: size, height: size,
        style: ring ? {borderColor: ring} : null});
    img.src = siteUrl('default-avatar.png');
    if (person && person.avatarUrl) {
        getApiBase().then(base => {
            img.src = /^https?:/.test(person.avatarUrl) ? person.avatarUrl : `${base}${person.avatarUrl}`;
        });
    }
    img.addEventListener('error', () => {
        img.src = siteUrl('default-avatar.png');
    });
    return img;
};
const myUsername = () => {
    try {
        return (JSON.parse(localStorage.getItem('kbau:user')) || {}).username || null;
    } catch (e) {
        return null;
    }
};
const where = tg => (tg === null ? 'on the Stage' : tg ? `editing ${tg}` : '');
const ago = ms => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
};

const toasts = () => {
    let el = document.querySelector('.kbau-collab-toasts');
    if (!el) {
        el = h('div', {class: 'kbau-collab-toasts', 'aria-live': 'polite'});
        document.body.append(el);
    }
    return el;
};
const toast = (text, color = '#fff') => {
    const t = h('div', {class: 'kbau-collab-toast'}, h('i', {style: {background: color}}), text);
    toasts().append(t);
    setTimeout(() => t.remove(), 3500);
};

/**
 * Mount the collaboration button into `root`.
 * @param {HTMLElement} root container rendered by the React component
 * @param {function(): object} getProps current props {vm, projectTitle, projectChanged}
 * @returns {function} unmount
 */
export const mountCollab = (root, getProps) => {
    addStyle();
    const {vm} = getProps();
    const engine = getCollabEngine(vm);
    const projectId = () => new URLSearchParams(location.search).get('kbau_project');
    let info = null; // {canEdit, canManage, owner, collaborators}
    let remote = {live: false, members: []};
    let open = false;
    let autoJoinChecked = false;
    let destroyed = false;
    let renderedKey = '';
    let inviteText = '';
    let inviteFocused = false;

    root.classList.add('kbau-collab');
    const button = h('button', {class: 'kbau-collab-btn', type: 'button', 'aria-haspopup': 'dialog', title: 'Live collaboration'});
    const panel = h('div', {class: 'kbau-collab-panel', role: 'dialog', 'aria-label': 'Live collaboration', hidden: true});
    root.append(button);
    document.body.append(panel);

    const loadInfo = async () => {
        const id = projectId();
        if (!id || !getToken()) {
            info = null;
            return;
        }
        try {
            const base = await getApiBase();
            const headers = {Authorization: `Bearer ${getToken()}`};
            const [a, b] = await Promise.all([
                fetch(`${base}/projects/${id}/collaborators`, {headers}),
                fetch(`${base}/projects/${id}/collab`, {headers})
            ]);
            info = a.ok ? await a.json() : {canEdit: false};
            remote = b.ok ? await b.json() : {live: false, members: []};
        } catch (e) {
            info = info || null;
        }
    };
    const pollStatus = async () => {
        if (destroyed || document.hidden || engine.status !== 'off') return;
        await loadInfo();
        render();
        // Opening a project someone is already editing live joins them (unless you have unsaved changes of your own).
        if (!autoJoinChecked && info && info.canEdit) {
            autoJoinChecked = true;
            if (remote.live && !getProps().projectChanged) {
                engine.start(projectId());
                toast(`Joined the live session with ${remote.members.map(m => m.displayName).join(', ')}`, '#51cf66');
            }
        }
    };

    const position = () => {
        const r = button.getBoundingClientRect();
        panel.style.top = `${r.bottom + 8}px`;
        panel.style.left = `${Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.right - panel.offsetWidth))}px`;
    };
    const setOpen = value => {
        open = value;
        panel.hidden = !open;
        if (open) {
            render(true);
            position();
            loadInfo().then(() => {
                render();
                position();
            });
        }
    };
    button.addEventListener('click', e => {
        e.stopPropagation();
        setOpen(!open);
    });
    const outside = e => {
        if (open && !panel.contains(e.target) && !button.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', () => open && position());

    // ---------- the button ----------
    const stack = people => h('span', {class: 'kbau-collab-stack'},
        people.slice(0, 3).map(p => {
            const img = avatar(p, 20);
            img.className = '';
            img.style.borderColor = p.color || '#555';
            return img;
        }),
        people.length > 3 ? h('span', {style: {borderColor: '#555'}}, `+${people.length - 3}`) : null);
    const renderButton = () => {
        const busy = ['connecting', 'waiting', 'seeding', 'loading', 'reconnecting'].includes(engine.status);
        button.className = 'kbau-collab-btn';
        if (engine.live) {
            button.classList.add('live');
            const others = [...engine.members.values()];
            fill(button, h('i', {class: 'kbau-collab-dot'}), 'Live', others.length ? stack(others) : null);
        } else if (busy) {
            fill(button, h('i', {class: 'kbau-collab-spin'}), engine.status === 'reconnecting' ? 'Reconnecting…' : 'Joining…');
        } else if (remote.live && info && info.canEdit) {
            button.classList.add('others');
            fill(button, h('i', {class: 'kbau-collab-dot'}), 'Join', stack(remote.members));
        } else {
            fill(button, h('span', {html: ICON, style: {display: 'inline-flex'}}), 'Collaborate');
        }
    };

    // ---------- the panel ----------
    // What the panel shows; it only redraws when this changes (so typing an invite isn't interrupted).
    const panelKey = () => JSON.stringify([
        engine.status, engine.message, engine.progress, engine.host, engine.lastSavedAt && Math.floor((Date.now() - engine.lastSavedAt) / 60000),
        engine.you && engine.you.u, [...engine.members.values()].map(m => [m.u, m.tg]), remote, info, projectId(), !!getToken(),
        vm.editingTarget && vm.editingTarget.id
    ]);
    const render = (force = false) => {
        renderButton();
        if (!open) return;
        const key = panelKey();
        if (!force && key === renderedKey) return;
        renderedKey = key;
        const live = engine.live;
        const chip = h('span', {class: `kbau-collab-chip${live ? ' live' : ''}`},
            live ? '● LIVE' : engine.status === 'off' || engine.status === 'error' ? 'OFF' : '…');
        const body = [];
        const id = projectId();
        if (!getToken()) {
            body.push(h('p', {class: 'kbau-collab-muted'}, 'Sign in to KbauBlocks to edit projects together with your friends in real time.'),
                h('button', {class: 'kbau-collab-pbtn primary wide', type: 'button', onclick: () => window.open(siteUrl('login'), '_blank')}, 'Sign in'));
        } else if (!id) {
            body.push(h('p', {class: 'kbau-collab-muted'}, 'Save this project to KbauBlocks first. Then you can invite people and edit it together, live.'),
                h('button', {class: 'kbau-collab-pbtn primary wide', type: 'button', onclick: async e => {
                    e.target.disabled = true;
                    e.target.textContent = 'Saving…';
                    try {
                        await saveToKbau(vm, getProps().projectTitle);
                        await loadInfo();
                    } catch (err) {
                        toast(`Could not save: ${err.message}`, '#ff6b6b');
                    }
                    render();
                }}, 'Save to KbauBlocks'));
        } else if (info && !info.canEdit) {
            body.push(h('p', {class: 'kbau-collab-muted'},
                'Only the owner and people they invite can edit this project live. Remix it to make your own copy.'));
        } else {
            body.push(sessionSection());
            if (info) body.push(peopleSection());
        }
        if (engine.message && engine.status !== 'live') {
            body.push(h('div', {class: `kbau-collab-note${engine.status === 'error' ? ' error' : ''}`}, engine.message));
        }
        fill(panel, h('div', {class: 'kbau-collab-head'}, h('h3', {}, 'Live collaboration'), chip), body);
        position();
    };

    const sessionSection = () => {
        const s = engine.status;
        if (s === 'off' || s === 'error') {
            const others = remote.live ? remote.members : [];
            return h('div', {},
                h('p', {class: 'kbau-collab-muted', style: {margin: '0 0 10px'}}, others.length ?
                    `${others.map(m => m.displayName).join(', ')} ${others.length === 1 ? 'is' : 'are'} editing this project right now.` :
                    'Edit this project together in real time: everyone sees blocks, sprites, costumes and sounds change as they happen.'),
                others.length ? h('div', {style: {marginBottom: '10px'}}, others.map(m => h('div', {class: 'kbau-collab-person'},
                    avatar(m, 32, m.color), h('div', {}, h('b', {}, m.displayName), h('span', {class: 'kbau-collab-muted'}, where(m.tg)))))) : null,
                h('button', {class: 'kbau-collab-pbtn primary wide', type: 'button', onclick: () => {
                    if (others.length && getProps().projectChanged &&
                        // eslint-disable-next-line no-alert
                        !window.confirm('Joining loads the live project and replaces your unsaved changes in this editor. Join anyway?')) return;
                    engine.start(id);
                }}, others.length ? 'Join live session' : 'Start live session'));
        }
        if (s !== 'live') {
            const label = {
                connecting: 'Connecting…', waiting: 'Waiting for the session to start…', seeding: 'Starting the session…',
                loading: 'Loading the live project…', reconnecting: 'Connection lost, reconnecting…'
            }[s] || '…';
            return h('div', {},
                h('div', {class: 'kbau-collab-progress'}, h('i', {class: 'kbau-collab-spin'}), h('span', {}, label)),
                engine.progress ? h('div', {class: 'kbau-collab-muted'}, engine.progress) : null,
                h('button', {class: 'kbau-collab-pbtn wide', type: 'button', style: {marginTop: '8px'}, onclick: () => engine.stop()}, 'Cancel'));
        }
        const me = engine.you;
        const people = [me, ...engine.members.values()].filter(Boolean);
        const hostName = (people.find(p => p.u === engine.host) || {}).displayName;
        return h('div', {},
            h('div', {class: 'kbau-collab-section-title'}, `In this session (${people.length})`),
            people.map(p => {
                const isMe = p === me;
                const tg = isMe ? (vm.editingTarget ? (vm.editingTarget.isStage ? null : vm.editingTarget.getName()) : '') : p.tg;
                return h(isMe ? 'div' : 'button', {
                    class: 'kbau-collab-person', type: isMe ? null : 'button', title: isMe ? null : 'Go to the sprite they\'re editing',
                    onclick: isMe ? null : () => {
                        const target = engine.targetByKey(p.tg);
                        if (target) vm.setEditingTarget(target.id);
                    }
                }, avatar(p, 32, p.color), h('div', {},
                    h('b', {}, p.displayName, isMe ? ' (you)' : ''),
                    h('span', {class: 'kbau-collab-muted'}, [where(tg), p.u === engine.host ? 'host' : ''].filter(Boolean).join(' · '))));
            }),
            h('div', {class: 'kbau-collab-note'},
                engine.host === (me && me.u) ?
                    'You\'re the host: the project saves to KbauBlocks automatically every few minutes while people edit.' :
                    `${hostName || 'The host'} saves the project automatically every few minutes.`,
                engine.lastSavedAt ? ` Last saved ${ago(engine.lastSavedAt)}.` : ''),
            h('div', {class: 'kbau-collab-row', style: {marginTop: '10px'}},
                h('button', {class: 'kbau-collab-pbtn', type: 'button', onclick: async e => {
                    e.target.disabled = true;
                    try {
                        await engine.save();
                        toast('Saved to KbauBlocks', '#51cf66');
                    } catch (err) {
                        toast(`Could not save: ${err.message}`, '#ff6b6b');
                    }
                    e.target.disabled = false;
                }}, 'Save now'),
                h('span', {style: {flex: 1}}),
                h('button', {class: 'kbau-collab-pbtn', type: 'button', onclick: () => engine.stop()}, 'Leave session')));
    };

    const peopleSection = () => {
        const list = h('div');
        const people = [{...info.owner, owner: true}, ...(info.collaborators || [])];
        fill(list, people.map(p => h('div', {class: 'kbau-collab-person'},
            avatar(p, 28),
            h('div', {}, h('b', {}, p.displayName), h('span', {class: 'kbau-collab-muted'}, p.owner ? 'owner' : `@${p.username}`)),
            !p.owner && (info.canManage || p.username === myUsername()) ?
                h('button', {class: 'kbau-collab-x', type: 'button', title: info.canManage ? `Remove ${p.displayName}` : 'Leave this project',
                    onclick: async () => {
                        // eslint-disable-next-line no-alert
                        if (!window.confirm(info.canManage ? `Remove ${p.displayName}? They won't be able to edit this project anymore.` :
                            'Leave this project? You won\'t be able to edit it anymore.')) return;
                        try {
                            const base = await getApiBase();
                            const res = await fetch(`${base}/projects/${projectId()}/collaborators/${encodeURIComponent(p.username)}`,
                                {method: 'DELETE', headers: {Authorization: `Bearer ${getToken()}`}});
                            if (!res.ok) throw new Error((await res.json()).error);
                            await loadInfo();
                            render(true);
                        } catch (err) {
                            toast(err.message, '#ff6b6b');
                        }
                    }}, '✕') : null)));
        let invite = null;
        if (info.canManage) {
            const input = h('input', {type: 'text', placeholder: 'Invite by username', 'aria-label': 'Username to invite', autocomplete: 'off'});
            input.value = inviteText;
            input.addEventListener('focus', () => {
                inviteFocused = true;
            });
            input.addEventListener('blur', () => {
                inviteFocused = false;
            });
            if (inviteFocused) {
                setTimeout(() => {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                });
            }
            const suggest = h('div', {class: 'kbau-collab-suggest'});
            const send = async username => {
                const name = (username || input.value).trim().replace(/^@/, '');
                if (!name) return;
                try {
                    const base = await getApiBase();
                    const res = await fetch(`${base}/projects/${projectId()}/collaborators`, {
                        method: 'POST', headers: {'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json'},
                        body: JSON.stringify({username: name})
                    });
                    const body = await res.json();
                    if (!res.ok) throw new Error(body.error);
                    info.collaborators = body.collaborators;
                    inviteText = '';
                    toast(`${name} can now edit this project with you`, '#51cf66');
                    render(true);
                } catch (err) {
                    toast(err.message, '#ff6b6b');
                }
            };
            let seq = 0;
            input.addEventListener('input', async () => {
                inviteText = input.value;
                const q = input.value.trim();
                const mine = ++seq;
                if (q.length < 2) return fill(suggest);
                try {
                    const base = await getApiBase();
                    const r = await (await fetch(`${base}/search?type=users&limit=5&q=${encodeURIComponent(q)}`)).json();
                    if (mine !== seq) return;
                    const taken = new Set(people.map(p => p.username));
                    fill(suggest, r.users.filter(u => !taken.has(u.username)).map(u => h('button', {
                        class: 'kbau-collab-person', type: 'button', onclick: () => send(u.username)
                    }, avatar(u, 24), h('div', {}, h('b', {}, u.displayName), h('span', {class: 'kbau-collab-muted'}, `@${u.username}`)))));
                } catch (e) {
                    // ignore
                }
            });
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') send();
                e.stopPropagation(); // keep editor shortcuts out of the text box
            });
            invite = h('div', {style: {marginTop: '8px'}},
                h('div', {class: 'kbau-collab-row'}, input, h('button', {class: 'kbau-collab-pbtn small primary', type: 'button', onclick: () => send()}, 'Invite')),
                suggest);
        }
        return h('div', {class: 'kbau-collab-section'},
            h('div', {class: 'kbau-collab-section-title'}, 'People who can edit'),
            list, invite,
            info.canManage ? h('p', {class: 'kbau-collab-muted', style: {margin: '8px 0 0'}},
                'Invited people see this project in My Stuff → Shared with me, and can edit it with you live.') : null);
    };

    // ---------- live cursors ----------
    let layer = null;
    const cursors = new Map(); // u -> {el, x, y, tx, ty}
    let raf = 0;
    const ensureLayer = () => {
        const ws = engine.workspace;
        if (!ws) return null;
        const div = ws.getInjectionDiv();
        if (!layer || layer.parentNode !== div) {
            layer = h('div', {class: 'kbau-collab-cursors'});
            div.append(layer);
        }
        return layer;
    };
    const frame = () => {
        raf = 0;
        const m = engine.canvasMatrix();
        const editing = vm.editingTarget ? (vm.editingTarget.isStage ? null : vm.editingTarget.getName()) : undefined;
        let active = false;
        for (const [u, c] of cursors) {
            const member = engine.members.get(u);
            const visible = member && member.cursor && member.tg === editing && m && Date.now() - member.cursor.at < 30000;
            c.el.style.opacity = visible ? '1' : '0';
            if (!visible) continue;
            // Smoothly glide toward the latest position (updates arrive ~15 times a second).
            c.x += (member.cursor.x - c.x) * 0.35;
            c.y += (member.cursor.y - c.y) * 0.35;
            const sx = c.x * m.a + m.e;
            const sy = c.y * m.a + m.f;
            c.el.style.transform = `translate(${sx}px, ${sy}px)`;
            active = true;
        }
        if (active) raf = requestAnimationFrame(frame);
    };
    engine.onPresence = member => {
        const l = ensureLayer();
        if (!l) return;
        let c = cursors.get(member.u);
        if (!c) {
            const el = h('div', {class: 'kbau-collab-cursor', html: CURSOR(member.color)},
                h('span', {style: {background: member.color}}, member.displayName));
            l.append(el);
            c = {el, x: member.cursor ? member.cursor.x : 0, y: member.cursor ? member.cursor.y : 0};
            cursors.set(member.u, c);
        }
        if (!raf) raf = requestAnimationFrame(frame);
        if (open) render();
    };
    engine.onNotify = (text, color) => toast(text, color);

    const unsubscribe = engine.on(() => {
        // Drop cursors of people who left.
        for (const [u, c] of cursors) {
            if (!engine.members.has(u)) {
                c.el.remove();
                cursors.delete(u);
            }
        }
        render();
    });
    const poll = setInterval(pollStatus, STATUS_POLL_MS);
    pollStatus();
    render();

    return () => {
        destroyed = true;
        clearInterval(poll);
        unsubscribe();
        document.removeEventListener('pointerdown', outside, true);
        panel.remove();
    };
};
