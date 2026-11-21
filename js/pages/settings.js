import {apiUrl, getApiBase, getApiOverride, setApiOverride, signOut, siteRoot, updateCachedUser} from '../api.js';
import {cropImage, IMAGE_TYPES, isImageFile} from '../image-tools.js';
import {$, api, avatarEl, boot, errorNotice, getSiteTheme, h, link, param, setSiteTheme, toast} from '../ui.js';

const main = $('#main');
const DEFAULT_AVATAR = new URL('default-avatar.png', siteRoot).href;
(async () => {
    const {user, online} = await boot('settings');
    main.append(h('h1', {}, 'Settings'));
    const tabs = h('div', {class: 'tabs'});
    const body = h('div', {class: 'card', style: 'max-width:640px'});
    main.append(tabs, body);
    const available = [
        user ? ['profile', 'Profile'] : null,
        user ? ['account', 'Account'] : null,
        user ? ['privacy', 'Privacy'] : null,
        ['appearance', 'Appearance'],
        ['server', 'Server']
    ].filter(Boolean);
    const show = tab => {
        tabs.replaceChildren(...available.map(([t, l]) => h('button', {class: t === tab ? 'active' : '', onclick: () => show(t)}, l)));
        body.replaceChildren();
        if (tab === 'profile') profile(body, user);
        if (tab === 'account') account(body, user);
        if (tab === 'privacy') privacy(body);
        if (tab === 'appearance') appearance(body);
        if (tab === 'server') server(body, online);
    };
    const requested = param('tab');
    show(available.some(([t]) => t === requested) ? requested : available[0][0]);
})();

const COLOR_PRESETS = ['#ffffff', '#ff5c5c', '#ff9f43', '#ffd84d', '#4cd98a', '#3ec7e0', '#5b8cff', '#a66bff', '#ff6bc1', '#8a8a8a'];
const AVATAR_CROP = {title: 'Crop profile picture', aspect: 1, radius: 0.27, out: [512, 512], gifOut: [256, 256]};
const BANNER_CROP = {title: 'Crop banner', aspect: 4, radius: 0.02, out: [1600, 400], gifOut: [960, 240]};

function profile (body, user) {
    body.classList.add('profile-editor-card');
    let saved = {displayName: user.displayName, bio: user.bio || '', workingOn: user.workingOn || '', profileColor: user.profileColor};

    // ---- Live preview: the banner and the picture are drop zones ----
    const bannerImg = h('img', {class: 'pe-banner-img', alt: ''});
    const bannerZone = h('div', {class: 'pe-banner pe-drop', role: 'button', tabindex: '0', 'aria-label': 'Change banner'},
        bannerImg,
        h('span', {class: 'pe-hover'}, cameraIcon(), h('span', {}, 'Change banner')),
        h('span', {class: 'pe-drop-label'}, 'Drop to set as banner'),
        h('span', {class: 'pe-busy'}, h('span', {class: 'pe-spinner'})));
    const avatarImg = h('img', {class: 'pe-avatar-img', alt: ''});
    const avatarZone = h('div', {class: 'pe-avatar pe-drop', role: 'button', tabindex: '0', 'aria-label': 'Change profile picture'},
        avatarImg,
        h('span', {class: 'pe-hover'}, cameraIcon()),
        h('span', {class: 'pe-drop-label'}, 'Drop'),
        h('span', {class: 'pe-busy'}, h('span', {class: 'pe-spinner'})));
    const previewName = h('div', {class: 'pe-name'});
    const removeAvatar = h('button', {class: 'btn small ghost', type: 'button'}, 'Remove picture');
    const removeBanner = h('button', {class: 'btn small ghost', type: 'button'}, 'Remove banner');
    const pickAvatar = h('button', {class: 'btn small', type: 'button'}, 'Upload picture');
    const pickBanner = h('button', {class: 'btn small', type: 'button'}, 'Upload banner');

    const renderImages = () => {
        if (user.bannerUrl) {
            apiUrl(user.bannerUrl).then(u => {
                bannerImg.src = u;
            });
            bannerZone.classList.add('has-image');
        } else {
            bannerImg.removeAttribute('src');
            bannerZone.classList.remove('has-image');
        }
        if (user.avatarUrl) {
            apiUrl(user.avatarUrl).then(u => {
                avatarImg.src = u;
            });
        } else {
            avatarImg.src = DEFAULT_AVATAR;
        }
        removeAvatar.hidden = !user.avatarUrl;
        removeBanner.hidden = !user.bannerUrl;
    };
    avatarImg.addEventListener('error', () => {
        if (avatarImg.src !== DEFAULT_AVATAR) avatarImg.src = DEFAULT_AVATAR;
    });
    const setUser = next => {
        user = next;
        updateCachedUser(next);
        renderImages();
    };

    const upload = async (kind, file) => {
        const zone = kind === 'avatar' ? avatarZone : bannerZone;
        let result;
        try {
            result = await cropImage(file, kind === 'avatar' ? AVATAR_CROP : BANNER_CROP);
        } catch (e) {
            return toast(e.message);
        }
        if (!result) return;
        // Show the cropped image right away while it uploads.
        const local = URL.createObjectURL(result.blob);
        (kind === 'avatar' ? avatarImg : bannerImg).src = local;
        if (kind === 'banner') bannerZone.classList.add('has-image');
        zone.classList.add('busy');
        const form = new FormData();
        form.append(kind, result.blob, `${kind}.${(result.blob.type || 'image/png').split('/')[1]}`);
        try {
            const res = await api.upload('POST', `/users/me/${kind}`, form);
            setUser(res.user);
            toast(result.uncropped ? 'Uploaded. This browser can\'t crop GIFs, so it was saved as it is.' :
                kind === 'avatar' ? 'Profile picture updated' : 'Banner updated');
        } catch (e) {
            renderImages();
            toast(e.message);
        } finally {
            zone.classList.remove('busy');
            setTimeout(() => URL.revokeObjectURL(local), 10000);
        }
    };
    const remove = async kind => {
        try {
            setUser((await api.del(`/users/me/${kind}`)).user);
            toast(kind === 'avatar' ? 'Profile picture removed' : 'Banner removed');
        } catch (e) {
            toast(e.message);
        }
    };
    removeAvatar.addEventListener('click', () => remove('avatar'));
    removeBanner.addEventListener('click', () => remove('banner'));

    const picker = kind => {
        const input = h('input', {type: 'file', accept: IMAGE_TYPES.join(','), hidden: true});
        input.addEventListener('change', () => {
            if (input.files[0]) upload(kind, input.files[0]);
            input.remove();
        });
        document.body.append(input);
        input.click();
    };
    for (const [zone, kind] of [[avatarZone, 'avatar'], [bannerZone, 'banner']]) {
        zone.addEventListener('click', e => {
            e.stopPropagation();
            picker(kind);
        });
        zone.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                picker(kind);
            }
        });
    }
    pickAvatar.addEventListener('click', () => picker('avatar'));
    pickBanner.addEventListener('click', () => picker('banner'));

    const preview = h('div', {class: 'pe-preview'},
        bannerZone,
        h('div', {class: 'pe-head'}, avatarZone,
            h('div', {class: 'pe-head-text'}, previewName, h('div', {class: 'muted small'}, `@${user.username}`))));

    // Drag and drop: while a file is dragged over the page, both zones light up.
    let dragDepth = 0;
    const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const endDrag = () => {
        dragDepth = 0;
        preview.classList.remove('dragging');
        avatarZone.classList.remove('over');
        bannerZone.classList.remove('over');
    };
    const onEnter = e => {
        if (!hasFiles(e)) return;
        dragDepth++;
        preview.classList.add('dragging');
    };
    const onLeave = e => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) endDrag();
    };
    const onOver = e => {
        if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        endDrag();
    };
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('dragover', onOver);
    document.addEventListener('drop', onDrop);
    for (const [zone, kind] of [[avatarZone, 'avatar'], [bannerZone, 'banner']]) {
        zone.addEventListener('dragover', e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            avatarZone.classList.toggle('over', kind === 'avatar');
            bannerZone.classList.toggle('over', kind === 'banner');
        });
        zone.addEventListener('drop', e => {
            e.preventDefault();
            e.stopPropagation();
            endDrag();
            const file = [...(e.dataTransfer.files || [])][0];
            if (!file) return;
            if (!isImageFile(file)) return toast('Drop a PNG, JPEG, WebP or GIF image.');
            upload(kind, file);
        });
    }
    // Stop listening once another settings tab replaces this one.
    const observer = new MutationObserver(() => {
        if (preview.isConnected) return;
        document.removeEventListener('dragenter', onEnter);
        document.removeEventListener('dragleave', onLeave);
        document.removeEventListener('dragover', onOver);
        document.removeEventListener('drop', onDrop);
        body.classList.remove('profile-editor-card');
        observer.disconnect();
    });
    observer.observe(body, {childList: true});

    // ---- Text fields ----
    const counter = (el, max) => {
        const c = h('span', {class: 'pe-count'});
        const update = () => {
            c.textContent = `${el.value.length} / ${max}`;
            c.classList.toggle('near', el.value.length > max * 0.9);
        };
        el.addEventListener('input', update);
        update();
        return c;
    };
    const displayName = h('input', {type: 'text', id: 'dn', value: user.displayName, maxlength: 40, placeholder: user.username});
    const bio = h('textarea', {id: 'bio', maxlength: 1000, rows: 4, placeholder: 'Tell people about yourself'}, user.bio);
    const workingOn = h('textarea', {id: 'wo', maxlength: 1000, rows: 3, placeholder: 'Games, animations, extensions…'}, user.workingOn);
    const color = h('input', {type: 'color', id: 'color', value: user.profileColor, 'aria-label': 'Custom colour'});
    const swatches = h('div', {class: 'pe-swatches', role: 'radiogroup', 'aria-label': 'Profile colour'});
    const customSwatch = h('label', {class: 'pe-swatch custom', title: 'Pick any colour'}, color, h('span', {'aria-hidden': 'true'}, '+'));
    const renderSwatches = () => {
        const current = color.value.toLowerCase();
        const preset = COLOR_PRESETS.includes(current);
        customSwatch.classList.toggle('on', !preset);
        customSwatch.style.background = preset ? '' : current;
        swatches.replaceChildren(...COLOR_PRESETS.map(c => h('button', {
            type: 'button', class: `pe-swatch${c === current ? ' on' : ''}`, style: `background:${c}`, role: 'radio',
            'aria-checked': String(c === current), 'aria-label': c, title: c,
            onclick: () => {
                color.value = c;
                changed();
            }
        })), customSwatch);
    };

    const msg = h('div');
    const saveBtn = h('button', {class: 'btn primary', type: 'button'}, 'Save changes');
    const resetBtn = h('button', {class: 'btn ghost', type: 'button'}, 'Undo');
    const saveBar = h('div', {class: 'pe-savebar', role: 'region', 'aria-label': 'Unsaved changes'},
        h('span', {}, 'You have unsaved changes'), h('span', {class: 'spacer'}), resetBtn, saveBtn);
    const values = () => ({displayName: displayName.value, bio: bio.value, workingOn: workingOn.value, profileColor: color.value.toLowerCase()});
    const changed = () => {
        const v = values();
        previewName.textContent = v.displayName.trim() || user.username;
        preview.style.setProperty('--pe-color', v.profileColor);
        renderSwatches();
        saveBar.classList.toggle('show', Object.keys(v).some(k => v[k] !== saved[k]));
    };
    for (const el of [displayName, bio, workingOn, color]) el.addEventListener('input', changed);
    resetBtn.addEventListener('click', () => {
        displayName.value = saved.displayName;
        bio.value = saved.bio;
        workingOn.value = saved.workingOn;
        color.value = saved.profileColor;
        for (const el of [displayName, bio, workingOn]) el.dispatchEvent(new Event('input'));
        changed();
    });
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
            const res = await api.patch('/users/me', values());
            user = res.user;
            updateCachedUser(res.user);
            saved = {displayName: res.user.displayName, bio: res.user.bio || '', workingOn: res.user.workingOn || '',
                profileColor: res.user.profileColor.toLowerCase()};
            msg.replaceChildren();
            changed();
            toast('Profile saved');
        } catch (e) {
            msg.replaceChildren(errorNotice(e));
        } finally {
            saveBtn.disabled = false;
        }
    });
    saved.profileColor = saved.profileColor.toLowerCase();

    body.append(
        preview,
        h('div', {class: 'pe-image-actions'},
            h('p', {class: 'muted small', style: 'margin:0'},
                'Drag an image or GIF onto your picture or banner, or click them. You can crop it before it\'s saved. ',
                'PNG, JPEG, WebP or GIF; GIFs stay animated.'),
            h('div', {class: 'row'}, pickAvatar, removeAvatar, pickBanner, removeBanner)),
        h('div', {class: 'pe-fields'},
            h('div', {class: 'field'}, h('div', {class: 'pe-label'}, h('label', {for: 'dn'}, 'Display name'), counter(displayName, 40)), displayName),
            h('div', {class: 'field'}, h('div', {class: 'pe-label'}, h('label', {for: 'bio'}, 'About me'), counter(bio, 1000)), bio),
            h('div', {class: 'field'}, h('div', {class: 'pe-label'}, h('label', {for: 'wo'}, 'What I\'m working on'), counter(workingOn, 1000)), workingOn),
            h('div', {class: 'field'},
                h('div', {class: 'pe-label'}, h('label', {for: 'color'}, 'Profile colour'),
                    h('span', {class: 'muted small'}, 'Shown on your banner when you don\'t have a banner image')),
                swatches)),
        msg,
        saveBar,
        h('div', {class: 'row', style: 'margin-top:6px'}, h('a', {class: 'btn ghost', href: link('user', {u: user.username})}, 'View profile →')));
    renderImages();
    changed();
}

function cameraIcon () {
    return h('span', {class: 'pe-icon', 'aria-hidden': 'true', html:
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.5"/></svg>'});
}

const LIMIT_PRESETS = [[0, 'Friends only'], [1, '1'], [3, '3'], [5, '5'], [10, '10'], [20, '20']];

async function privacy (body) {
    body.append(h('p', {class: 'muted'}, 'Loading…'));
    let data;
    try {
        data = await api.get('/users/me/privacy');
    } catch (e) {
        body.replaceChildren(errorNotice(e));
        return;
    }
    let limit = data.dmRequestLimit;
    const presets = h('div', {class: 'privacy-limit', role: 'radiogroup', 'aria-label': 'Message request limit'});
    const custom = h('input', {type: 'number', min: 0, max: data.maxRequestLimit, value: limit, id: 'dm-limit', style: 'width:90px'});
    const summary = h('div', {class: 'notice'});
    const render = () => {
        presets.replaceChildren(...LIMIT_PRESETS.map(([n, label]) => h('button', {
            type: 'button', class: `btn small${n === limit ? ' on' : ''}`, role: 'radio', 'aria-checked': String(n === limit),
            onclick: () => save(n)
        }, label)));
        custom.value = String(limit);
        summary.textContent = limit === 0 ?
            'Only friends can message you. Anyone else is told that you only get messages from friends.' :
            `People who aren't your friends can send you ${limit} message${limit === 1 ? '' : 's'} as a request. ` +
            'They\'re told how many they have left, and that they need to wait once they reach it. Accept the request (or reply) to chat normally.';
    };
    const save = async n => {
        if (!Number.isInteger(n) || n < 0 || n > data.maxRequestLimit) {
            toast(`Pick a number from 0 to ${data.maxRequestLimit}.`);
            render();
            return;
        }
        try {
            limit = (await api.patch('/users/me/privacy', {dmRequestLimit: n})).dmRequestLimit;
            render();
            toast('Saved');
        } catch (e) {
            toast(e.message);
        }
    };
    custom.addEventListener('change', () => save(Number(custom.value)));

    const blockedList = h('div');
    const renderBlocked = () => {
        blockedList.replaceChildren(...(data.blocked.length ? data.blocked.map(u => h('div', {class: 'blocked-row'},
            avatarEl(u, 'sm'),
            h('a', {href: link('user', {u: u.username}), style: 'flex:1;min-width:0'}, h('b', {}, u.displayName), h('span', {class: 'muted small'}, ` @${u.username}`)),
            h('button', {class: 'btn small', type: 'button', onclick: async () => {
                try {
                    await api.del(`/users/${encodeURIComponent(u.username)}/block`);
                    data.blocked = data.blocked.filter(x => x.id !== u.id);
                    renderBlocked();
                    toast(`${u.displayName} is unblocked`);
                } catch (e) {
                    toast(e.message);
                }
            }}, 'Unblock'))) : [h('p', {class: 'muted small'}, 'You haven\'t blocked anyone.')]));
    };
    body.replaceChildren(
        h('h3', {style: 'margin-top:0'}, 'Message requests'),
        h('p', {class: 'muted small'},
            'Friends (people who follow each other) can always message you. Anyone else starts a message request. ',
            'Choose how many messages they can send before you accept it.'),
        presets,
        h('div', {class: 'row', style: 'margin:4px 0 12px'}, h('label', {for: 'dm-limit', style: 'margin:0'}, 'Or a custom number (0–20):'), custom),
        summary,
        h('h3', {}, 'Blocked people'),
        h('p', {class: 'muted small'}, 'Blocked people can\'t message you, follow you or comment on your projects, and you don\'t see their comments. They aren\'t told.'),
        blockedList);
    render();
    renderBlocked();
}

function account (body, user) {
    const current = h('input', {type: 'password', id: 'cur', autocomplete: 'current-password'});
    const next = h('input', {type: 'password', id: 'new', autocomplete: 'new-password'});
    const msg = h('div');
    body.append(
        h('p', {}, 'Signed in as ', h('b', {}, user.username), user.role !== 'user' ? ` (${user.role})` : ''),
        h('h3', {}, 'Change password'),
        h('div', {class: 'field'}, h('label', {for: 'cur'}, 'Current password'), current),
        h('div', {class: 'field'}, h('label', {for: 'new'}, 'New password'), next),
        msg,
        h('div', {class: 'row'},
            h('button', {class: 'btn primary', onclick: async () => {
                try {
                    await api.post('/users/me/password', {currentPassword: current.value, newPassword: next.value});
                    current.value = next.value = '';
                    msg.replaceChildren(h('div', {class: 'notice ok'}, 'Password changed. Other devices were signed out.'));
                } catch (e) {
                    msg.replaceChildren(errorNotice(e));
                }
            }}, 'Change password'),
            h('span', {class: 'spacer'}),
            h('button', {class: 'btn', onclick: async () => {
                await signOut();
                location.href = link('./');
            }}, 'Sign out')));
}

function appearance (body) {
    const theme = getSiteTheme();
    const pick = value => h('button', {class: `btn ${theme === value ? 'on' : ''}`, onclick: () => {
        setSiteTheme(value);
        body.replaceChildren();
        appearance(body);
    }}, value === 'dark' ? 'Dark' : 'Light');
    body.append(h('h3', {}, 'Website theme'), h('div', {class: 'row'}, pick('dark'), pick('light')),
        h('p', {class: 'muted small', style: 'margin-top:14px'},
            'The editor has its own theme options in its settings (gear) menu, including accent colors, block themes and the Scratch Addons theme editor. It defaults to dark.'));
}

async function server (body, online) {
    const current = await getApiBase();
    const input = h('input', {type: 'url', id: 'api', placeholder: 'https://your-server.example/kbau-api', value: getApiOverride()});
    const status = h('div', {class: `notice ${online ? 'ok' : 'warn'}`},
        online ? `Connected to ${current}` : (current ? `Can't reach ${current}` : 'No community server configured.'));
    body.append(
        h('h3', {}, 'Community server'),
        h('p', {class: 'muted small'},
            'KbauBlocks accounts, sharing, comments and cloud variables run on a KbauBlocks server. ',
            'Anyone can host one (see kbaucode/server in the source). Leave this blank to use the default from this site\'s config.json.'),
        status,
        h('div', {class: 'field'}, h('label', {for: 'api'}, 'Server API URL'), input),
        h('div', {class: 'row'},
            h('button', {class: 'btn primary', onclick: async () => {
                const value = input.value.trim();
                if (value) {
                    try {
                        const res = await fetch(`${value.replace(/\/+$/, '')}/health`);
                        const data = await res.json();
                        if (!data || data.name !== 'KbauBlocks') throw new Error();
                    } catch (e) {
                        status.className = 'notice error';
                        status.textContent = `${value} doesn't look like a KbauBlocks server.`;
                        return;
                    }
                }
                setApiOverride(value || null);
                location.reload();
            }}, 'Save'),
            h('button', {class: 'btn', onclick: () => {
                setApiOverride(null);
                location.reload();
            }}, 'Reset to default')));
}
