import {setSession} from '../api.js';
import {$, api, boot, h, link, offlineNotice, param} from '../ui.js';

const main = $('#main');
(async () => {
    const {user, online} = await boot('login');
    const next = param('next');
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : link('index.html');
    const wrap = h('div', {class: 'card', style: 'max-width:420px;margin:30px auto'});
    main.append(wrap);
    if (!online) return wrap.append(offlineNotice());
    if (user) {
        wrap.append(h('p', {}, `You're signed in as ${user.username}.`), h('a', {class: 'btn primary', href: safeNext}, 'Continue'));
        return;
    }
    let mode = param('mode') === 'join' ? 'join' : 'login';
    const render = () => {
        const err = h('div', {class: 'notice error hidden', role: 'alert'});
        const username = h('input', {type: 'text', id: 'username', autocomplete: 'username', required: true, maxlength: 20});
        const password = h('input', {type: 'password', id: 'password', autocomplete: mode === 'join' ? 'new-password' : 'current-password', required: true});
        const confirm = h('input', {type: 'password', id: 'confirm', autocomplete: 'new-password'});
        const submit = h('button', {class: 'btn primary', type: 'submit', style: 'width:100%'}, mode === 'join' ? 'Create account' : 'Sign in');
        const form = h('form', {onsubmit: async e => {
            e.preventDefault();
            err.classList.add('hidden');
            if (mode === 'join' && password.value !== confirm.value) {
                err.textContent = 'Passwords do not match.';
                err.classList.remove('hidden');
                return;
            }
            submit.disabled = true;
            try {
                const res = await api.post(mode === 'join' ? '/auth/register' : '/auth/login', {username: username.value.trim(), password: password.value});
                setSession(res.token, res.user);
                location.href = safeNext;
            } catch (ex) {
                err.textContent = ex.message;
                err.classList.remove('hidden');
                submit.disabled = false;
            }
        }},
        h('div', {class: 'field'}, h('label', {for: 'username'}, 'Username'), username,
            mode === 'join' ? h('div', {class: 'muted small'}, '3–20 letters, numbers, - or _. Don’t use your real name.') : null),
        h('div', {class: 'field'}, h('label', {for: 'password'}, 'Password'), password,
            mode === 'join' ? h('div', {class: 'muted small'}, 'At least 8 characters.') : null),
        mode === 'join' ? h('div', {class: 'field'}, h('label', {for: 'confirm'}, 'Confirm password'), confirm) : null,
        err, submit);
        wrap.replaceChildren(
            h('div', {class: 'tabs'},
                h('button', {class: mode === 'login' ? 'active' : '', onclick: () => {
                    mode = 'login';
                    render();
                }}, 'Sign in'),
                h('button', {class: mode === 'join' ? 'active' : '', onclick: () => {
                    mode = 'join';
                    render();
                }}, 'Create account')),
            form);
        username.focus();
    };
    render();
})();
