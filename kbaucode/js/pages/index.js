import {$, api, boot, h, link, offlineNotice, projectGrid, errorNotice} from '../ui.js';

const main = $('#main');
const blocksArt = `<svg class="blocks" viewBox="0 0 360 300" aria-hidden="true">
  <g font-family="Nunito, sans-serif" font-weight="800" font-size="17">
    <path d="M20 40h40l8 8h24l8-8h220a10 10 0 0 1 10 10v34a10 10 0 0 1-10 10H100l-8 8H68l-8-8H30a10 10 0 0 1-10-10z" fill="#ffb648"/>
    <text x="36" y="73" fill="#2b1a00">when ⚑ clicked</text>
    <path d="M20 104h40l8 8h24l8-8h200a10 10 0 0 1 10 10v34a10 10 0 0 1-10 10H100l-8 8H68l-8-8H30a10 10 0 0 1-10-10z" fill="#1fd1a0"/>
    <text x="36" y="137" fill="#03140e">forever</text>
    <path d="M44 168h40l8 8h24l8-8h176a10 10 0 0 1 10 10v34a10 10 0 0 1-10 10H124l-8 8H92l-8-8H54a10 10 0 0 1-10-10z" fill="#6a8cff"/>
    <text x="60" y="201" fill="#060d26">move 10 steps</text>
    <path d="M44 232h40l8 8h24l8-8h136a10 10 0 0 1 10 10v34a10 10 0 0 1-10 10H54a10 10 0 0 1-10-10z" fill="#c779ff"/>
    <text x="60" y="265" fill="#1b0629">next costume</text>
  </g></svg>`;

const features = [
    ['#1fd1a0', '⚡', 'Compiled for speed', 'Projects compile to JavaScript with the TurboWarp compiler, plus turbo mode, custom framerates and removable limits.'],
    ['#ffb648', '🧩', 'Extensions, unified', 'Browse the TurboWarp and PenguinMod galleries in one place, or load any custom extension by URL.'],
    ['#6a8cff', '🛠', 'Editor superpowers', 'Built-in Scratch Addons: block search, debugger, themes, editor tweaks and dozens more, all toggleable.'],
    ['#c779ff', '🌍', 'Share with everyone', 'Publish straight from the editor, then get loves, favorites, comments and remixes with attribution.']
];

(async () => {
    const {user, online} = await boot('home');
    main.append(h('section', {class: 'hero', html: blocksArt},
        h('div', {class: 'hero-content'},
            h('h1', {}, user ? `Welcome back, ${user.displayName || user.username}!` : 'Build anything, block by block.'),
            h('p', {}, 'KbauBlocks is a fast, open-source creative coding studio that runs your Scratch 3 projects and lets you share them with a community.'),
            h('div', {class: 'row'},
                h('a', {class: 'btn primary', href: link('editor/editor.html')}, 'Start creating'),
                h('a', {class: 'btn', href: link('explore.html')}, 'Explore projects')))));
    main.append(h('div', {class: 'feature-grid'}, features.map(([color, icon, title, text]) => h('div', {class: 'card feature'},
        h('div', {class: 'icon', style: `background:${color}`}, icon), h('h3', {}, title), h('p', {class: 'muted small'}, text)))));

    if (!online) {
        main.append(h('div', {style: 'margin-top:28px'}, offlineNotice()));
        return;
    }
    const sections = [['trending', 'Trending'], ['recent', 'Recently shared'], ['popular', 'Most popular']];
    for (const [sort, title] of sections) {
        const body = h('div', {}, h('p', {class: 'empty'}, 'Loading…'));
        main.append(h('div', {class: 'section-head'}, h('h2', {}, title), h('a', {href: link('explore.html', {sort})}, 'See all')), body);
        api.get(`/explore?sort=${sort}&limit=8`)
            .then(({projects}) => body.replaceChildren(projectGrid(projects, 'No shared projects yet. Be the first!')))
            .catch(e => body.replaceChildren(errorNotice(e)));
    }
})();
