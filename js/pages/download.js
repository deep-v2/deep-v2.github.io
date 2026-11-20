// Download page: the offline KbauBlocks app for Windows (built by .github/workflows/kbaucode-desktop.yml).
import {$, boot, h, link} from '../ui.js';

const REPO = 'deep-v2/deep-v2.github.io';
const LATEST = `https://github.com/${REPO}/releases/latest/download`;
const main = $('#main');

const fmtSize = bytes => `${Math.round(bytes / 1024 / 1024)} MB`;

(async () => {
    await boot('download');
    const meta = h('p', {class: 'muted small', style: 'margin:0'}, 'Checking the latest version…');
    const setupBtn = h('a', {class: 'btn primary', href: `${LATEST}/KbauBlocks-Setup.exe`}, 'Download installer');
    const portableBtn = h('a', {class: 'btn', href: `${LATEST}/KbauBlocks-Portable.exe`}, 'Portable version');
    main.append(
        h('h1', {}, 'KbauBlocks for Windows'),
        h('p', {class: 'muted', style: 'max-width:720px'},
            'The KbauBlocks editor as a desktop app that works without internet. Make projects offline and save them ',
            'to your computer as .sb3 files; open them later on the website to share them.'),
        h('section', {class: 'card', style: 'margin-bottom:22px'},
            h('div', {class: 'row', style: 'align-items:center;gap:18px'},
                h('img', {src: link('logo.png'), alt: '', width: 64, height: 64}),
                h('div', {style: 'flex:1;min-width:220px'},
                    h('h2', {style: 'margin:0 0 4px'}, 'KbauBlocks desktop'),
                    meta),
                h('div', {class: 'row'}, setupBtn, portableBtn)),
            h('p', {class: 'muted small', style: 'margin:14px 0 0'},
                'Windows 10 or 11, 64-bit. The installer adds a Start menu and desktop shortcut; the portable version runs without installing. ',
                'Windows SmartScreen may warn that the app is unrecognized because it isn\'t code-signed: click ',
                h('b', {}, 'More info → Run anyway'), '.')),
        h('div', {class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(260px,1fr))'},
            h('div', {class: 'card'},
                h('h3', {}, 'What works offline'),
                h('ul', {class: 'muted', style: 'margin:0;padding-left:20px'},
                    h('li', {}, 'The full editor: code, costumes, sounds, addons and themes'),
                    h('li', {}, 'Built-in extensions (pen, music, …)'),
                    h('li', {}, 'Save and load .sb3 files on your computer'),
                    h('li', {}, h('a', {href: link('extras#claude-mcp')}, 'Claude MCP'), ' (talks to the bridge on your computer)'))),
            h('div', {class: 'card'},
                h('h3', {}, 'Online only'),
                h('ul', {class: 'muted', style: 'margin:0;padding-left:20px'},
                    h('li', {}, 'Sharing, project pages, comments and your account'),
                    h('li', {}, 'Cloud variables'),
                    h('li', {}, 'The online Extras gallery and loading projects from links'),
                    h('li', {}, 'For those, use the ', h('a', {href: link('editor/')}, 'web editor'), '.')))));

    try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {headers: {Accept: 'application/vnd.github+json'}});
        if (res.status === 404) throw new Error('none');
        if (!res.ok) throw new Error(String(res.status));
        const release = await res.json();
        const asset = name => (release.assets || []).find(a => a.name === name);
        const setup = asset('KbauBlocks-Setup.exe');
        const portable = asset('KbauBlocks-Portable.exe');
        const version = String(release.tag_name || '').replace(/^desktop-v/, '');
        const date = new Date(release.published_at).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
        meta.textContent = `Version ${version} · ${date}${setup ? ` · installer ${fmtSize(setup.size)}` : ''}`;
        if (setup) setupBtn.href = setup.browser_download_url;
        if (portable) portableBtn.href = portable.browser_download_url;
    } catch (e) {
        meta.textContent = e.message === 'none' ?
            'The first build is being made. Check back in a few minutes.' :
            'Latest version for Windows 10 and 11 (64-bit).';
    }
})();
