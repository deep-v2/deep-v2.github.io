import {getApiBase, getApiOverride, setApiOverride, signOut, updateCachedUser} from '../api.js';
import {$, api, avatarEl, boot, errorNotice, getSiteTheme, h, link, param, setSiteTheme, toast} from '../ui.js';

const main = $('#main');
(async () => {
    const {user, online} = await boot('settings');
    main.append(h('h1', {}, 'Settings'));
    const tabs = h('div', {class: 'tabs'});
    const body = h('div', {class: 'card', style: 'max-width:640px'});
    main.append(tabs, body);
    const available = [
        user ? ['profile', 'Profile'] : null,
        user ? ['account', 'Account'] : null,
        ['appearance', 'Appearance'],
        ['server', 'Server']
    ].filter(Boolean);
    const show = tab => {
        tabs.replaceChildren(...available.map(([t, l]) => h('button', {class: t === tab ? 'active' : '', onclick: () => show(t)}, l)));
        body.replaceChildren();
        if (tab === 'profile') profile(body, user);
        if (tab === 'account') account(body, user);
        if (tab === 'appearance') appearance(body);
        if (tab === 'server') server(body, online);
    };
    const requested = param('tab');
    show(available.some(([t]) => t === requested) ? requested : available[0][0]);
})();

function profile (body, user) {
    const displayName = h('input', {type: 'text', id: 'dn', value: user.displayName, maxlength: 40});
    const bio = h('textarea', {id: 'bio', maxlength: 1000}, user.bio);
    const workingOn = h('textarea', {id: 'wo', maxlength: 1000}, user.workingOn);
    const color = h('input', {type: 'color', id: 'color', value: user.profileColor, style: 'width:64px;height:38px;padding:2px'});
    const avatarInput = h('input', {type: 'file', accept: 'image/png,image/jpeg,image/webp', id: 'avatar'});
    const avatarPreview = h('div', {}, avatarEl(user, 'lg'));
    avatarInput.addEventListener('change', async () => {
        const file = avatarInput.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) return toast('Images must be under 2 MB.');
        const form = new FormData();
        form.append('avatar', file);
        try {
            const res = await api.upload('POST', '/users/me/avatar', form);
            updateCachedUser(res.user);
            avatarPreview.replaceChildren(avatarEl(res.user, 'lg'));
            toast('Profile picture updated');
        } catch (e) {
            toast(e.message);
        }
    });
    const msg = h('div');
    body.append(
        h('div', {class: 'row field'}, avatarPreview, h('div', {}, h('label', {for: 'avatar'}, 'Profile picture'), avatarInput,
            h('div', {class: 'muted small'}, 'PNG, JPEG or WebP, up to 2 MB.'))),
        h('div', {class: 'field'}, h('label', {for: 'dn'}, 'Display name'), displayName),
        h('div', {class: 'field'}, h('label', {for: 'bio'}, 'About me'), bio),
        h('div', {class: 'field'}, h('label', {for: 'wo'}, 'What I\'m working on'), workingOn),
        h('div', {class: 'field'}, h('label', {for: 'color'}, 'Profile color'), color),
        msg,
        h('div', {class: 'row'}, h('button', {class: 'btn primary', onclick: async () => {
            try {
                const res = await api.patch('/users/me', {
                    displayName: displayName.value, bio: bio.value, workingOn: workingOn.value, profileColor: color.value
                });
                updateCachedUser(res.user);
                toast('Profile saved');
            } catch (e) {
                msg.replaceChildren(errorNotice(e));
            }
        }}, 'Save profile'), h('a', {class: 'btn', href: link('user', {u: user.username})}, 'View profile')));
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
