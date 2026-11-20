import {apiUrl as apiUrlSafe} from '../api.js';
import {
    $, api, avatarEl, boot, errorNotice, fmt, h, link, modal, offlineNotice, param, projectGrid, timeAgo, toast,
    userGrid, verifiedTick
} from '../ui.js';

// Follow button label for the signed-in viewer's relationship with this profile.
const followLabel = rel => {
    if (rel.friends) return 'Friends';
    if (rel.following) return 'Following';
    return rel.followedBy ? 'Follow back' : 'Follow';
};

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
    const isAdmin = me && me.role === 'admin';
    const isStaff = user.role === 'admin' || user.role === 'moderator';

    // Follow / unfollow. Following someone who already follows you makes you friends.
    let rel = data.relationship || {following: false, followedBy: false, friends: false};
    const followersCount = h('b', {}, fmt(stats.followers));
    const friendsCount = h('b', {}, fmt(stats.friends));
    const followsYou = h('span', {class: 'badge', style: 'margin-left:8px'}, 'Follows you');
    const followBtn = h('button', {class: 'btn'});
    const renderFollow = () => {
        followBtn.textContent = followLabel(rel);
        followBtn.className = `btn ${rel.following ? 'on' : 'primary'}`;
        followBtn.title = rel.following ? 'Click to unfollow' : '';
        followsYou.style.display = rel.followedBy && !rel.friends ? '' : 'none';
    };
    followBtn.addEventListener('click', async () => {
        if (!me) {
            location.href = link('login', {next: location.pathname + location.search});
            return;
        }
        const wasFriends = rel.friends;
        followBtn.disabled = true;
        try {
            const r = rel.following ?
                await api.del(`/users/${encodeURIComponent(user.username)}/follow`) :
                await api.post(`/users/${encodeURIComponent(user.username)}/follow`);
            rel = r.relationship;
            followersCount.textContent = fmt(r.followers);
            stats.friends += (rel.friends ? 1 : 0) - (wasFriends ? 1 : 0);
            friendsCount.textContent = fmt(stats.friends);
            if (rel.friends && !wasFriends) toast(`You and ${user.displayName} are now friends!`);
            renderFollow();
        } catch (e) {
            toast(e.message);
        } finally {
            followBtn.disabled = false;
        }
    });
    renderFollow();

    main.append(h('div', {class: 'card', style: 'padding:0;overflow:hidden'},
        h('div', {class: 'profile-banner', style: `background:linear-gradient(120deg, ${user.profileColor}, #000)`}),
        h('div', {class: 'profile-head'}, avatarEl(user, 'lg'),
            h('div', {style: 'padding-bottom:6px;flex:1;min-width:200px'},
                h('h1', {style: 'margin:0'}, user.displayName, verifiedTick(user),
                    user.role !== 'user' ? h('span', {class: 'badge accent', style: 'margin-left:8px'}, user.role) : null,
                    user.banned ? h('span', {class: 'badge warn', style: 'margin-left:8px'}, 'suspended') : null),
                h('div', {class: 'muted'}, `@${user.username} · joined ${timeAgo(user.createdAt)}`, me && !isMe ? followsYou : null)),
            h('div', {class: 'row', style: 'padding-bottom:10px'},
                isMe ? h('a', {class: 'btn', href: link('settings')}, 'Edit profile') : null,
                !isMe && !user.banned ? followBtn : null,
                isAdmin && !isMe && !isStaff ? h('button', {class: 'btn ghost small', onclick: async () => {
                    try {
                        await api.post(`/admin/users/${encodeURIComponent(user.username)}/${user.verified ? 'unverify' : 'verify'}`);
                        location.reload();
                    } catch (e) {
                        toast(e.message);
                    }
                }}, user.verified ? 'Remove tick' : 'Verify') : null,
                me && !isMe ? h('button', {class: 'btn ghost small', onclick: () => report(user.username)}, 'Report') : null,
                isMod && !isMe && user.role !== 'admin' ? h('button', {class: 'btn small danger', onclick: async () => {
                    if (!user.banned) return banDialog(user.username, isAdmin);
                    try {
                        await api.post(`/admin/users/${encodeURIComponent(user.username)}/unban`);
                        location.reload();
                    } catch (e) {
                        toast(e.message);
                    }
                }}, user.banned ? 'Unban' : 'Ban') : null)),
        h('div', {style: 'padding:6px 20px 20px'},
            h('div', {class: 'stat-row'},
                h('button', {class: 'stat-link', onclick: () => show('followers')}, followersCount, h('span', {class: 'muted small'}, 'followers')),
                h('button', {class: 'stat-link', onclick: () => show('following')}, h('b', {}, fmt(stats.following)), h('span', {class: 'muted small'}, 'following')),
                h('button', {class: 'stat-link', onclick: () => show('friends')}, friendsCount, h('span', {class: 'muted small'}, 'friends')),
                h('div', {}, h('b', {}, fmt(stats.shared)), h('span', {class: 'muted small'}, 'shared projects')),
                h('div', {}, h('b', {}, fmt(stats.loves)), h('span', {class: 'muted small'}, 'loves received')),
                h('div', {}, h('b', {}, fmt(stats.views)), h('span', {class: 'muted small'}, 'project views')),
                h('div', {}, h('b', {}, fmt(stats.collections)), h('span', {class: 'muted small'}, 'collections'))),
            h('div', {class: 'feature-grid'},
                h('div', {}, h('h3', {}, 'About me'), h('div', {class: 'prose'}, user.bio || h('span', {class: 'muted'}, 'Nothing here yet.'))),
                h('div', {}, h('h3', {}, 'What I\'m working on'), h('div', {class: 'prose'}, user.workingOn || h('span', {class: 'muted'}, 'Nothing here yet.')))))));

    const tabs = [['projects', 'Shared projects'], ['favorites', 'Favorites'], ['collections', 'Collections'],
        ['friends', 'Friends'], ['followers', 'Followers'], ['following', 'Following']];
    const emptyPeople = {
        friends: 'No friends yet. Friends are people who follow each other.',
        followers: 'No followers yet.',
        following: 'Not following anyone yet.'
    };
    const body = h('div');
    const tabBar = h('div', {class: 'tabs', style: 'margin-top:24px'});
    const show = async tab => {
        tabBar.replaceChildren(...tabs.map(([t, label]) => h('button', {class: t === tab ? 'active' : '', onclick: () => show(t)}, label)));
        body.replaceChildren(h('p', {class: 'empty'}, 'Loading…'));
        try {
            if (emptyPeople[tab]) {
                const {users} = await api.get(`/users/${encodeURIComponent(user.username)}/${tab}?limit=60`);
                body.replaceChildren(userGrid(users, emptyPeople[tab]));
            } else if (tab === 'collections') {
                const {collections} = await api.get(`/users/${encodeURIComponent(user.username)}/collections`);
                body.replaceChildren(collections.length ? h('div', {class: 'grid'}, collections.map(c => {
                    const img = h('img', {alt: ''});
                    if (c.thumbnailUrl) apiUrlSafe(c.thumbnailUrl).then(u => {
                        img.src = u;
                    });
                    return h('a', {class: 'project-card', href: link('collection', {id: c.id})},
                        h('div', {class: 'thumb'}, c.thumbnailUrl ? img : h('img', {class: 'placeholder', src: link('logo.png'), alt: ''})),
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

// Ban with a reason (shown to the user when they try to sign in); admins can also ban the IP.
async function banDialog (username, canBanIp) {
    const reason = h('textarea', {id: 'ban-reason', maxlength: 500, placeholder: 'e.g. Repeated spam in comments'});
    const ipBox = h('input', {type: 'checkbox', id: 'ban-ip'});
    const ok = await modal(`Ban @${username}`, [
        h('label', {for: 'ban-reason'}, 'Reason (the user sees this when they try to sign in)'), reason,
        canBanIp ? h('label', {class: 'row', style: 'margin-top:12px;gap:8px;font-weight:600'}, ipBox,
            'Also ban the IP address they last signed in from') : null
    ], [{label: 'Cancel', value: false, class: 'ghost'}, {label: 'Ban', value: true, class: 'danger'}]);
    if (!ok) return;
    try {
        await api.post(`/admin/users/${encodeURIComponent(username)}/ban`, {reason: reason.value, banIp: ipBox.checked});
        location.reload();
    } catch (e) {
        toast(e.message);
    }
}

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
