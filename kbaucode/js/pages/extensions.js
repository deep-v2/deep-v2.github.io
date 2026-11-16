// Unified extension catalog: TurboWarp gallery + PenguinMod gallery + custom URLs, all opening in the KbauBlocks editor.
import {$, boot, errorNotice, h, link} from '../ui.js';

const main = $('#main');

const SOURCES = {
    turbowarp: {
        label: 'TurboWarp gallery',
        note: 'Reviewed extensions from extensions.turbowarp.org. Fully compatible with KbauBlocks.',
        async load () {
            const res = await fetch('https://extensions.turbowarp.org/generated-metadata/extensions-v0.json');
            if (!res.ok) throw new Error(`TurboWarp gallery returned ${res.status}`);
            const {extensions} = await res.json();
            return extensions.map(e => ({
                name: e.name,
                description: e.description,
                by: (e.by || []).map(b => b.name).join(', '),
                url: `https://extensions.turbowarp.org/${e.slug}.js`,
                image: e.image ? `https://extensions.turbowarp.org/${e.image}` : null,
                docs: e.docs ? `https://extensions.turbowarp.org/${e.slug}` : null
            }));
        }
    },
    penguinmod: {
        label: 'PenguinMod gallery',
        note: 'Community extensions from extensions.penguinmod.com. Many work in KbauBlocks; some rely on PenguinMod-only features and may fail to load.',
        async load () {
            const res = await fetch('https://raw.githubusercontent.com/PenguinMod/PenguinMod-ExtensionsGallery/main/src/lib/extensions.js');
            if (!res.ok) throw new Error(`PenguinMod gallery returned ${res.status}`);
            return parsePenguinModList(await res.text()).map(e => ({
                name: e.name,
                description: e.description,
                by: e.creatorAlias || e.creator || '',
                url: `https://extensions.penguinmod.com/extensions/${e.code}`,
                image: e.banner ? `https://extensions.penguinmod.com/images/${e.banner}` : null,
                unstable: !!e.unstable
            }));
        }
    }
};

/**
 * The PenguinMod gallery list is a JS module containing an object literal.
 * We never execute it: convert the literal to JSON with a small tokenizer.
 */
function parsePenguinModList (source) {
    const start = source.indexOf('[', source.indexOf('export default'));
    const end = source.lastIndexOf(']');
    const literal = source.slice(start, end + 1);
    let out = '';
    let i = 0;
    while (i < literal.length) {
        const c = literal[i];
        if (c === '"' || c === '\'' || c === '`') {
            // String: re-encode as a JSON string.
            let j = i + 1;
            let value = '';
            while (j < literal.length && literal[j] !== c) {
                if (literal[j] === '\\') {
                    const n = literal[j + 1];
                    value += n === 'n' ? '\n' : n === 't' ? '\t' : n;
                    j += 2;
                } else {
                    value += literal[j++];
                }
            }
            out += JSON.stringify(value);
            i = j + 1;
        } else if (c === '/' && literal[i + 1] === '/') {
            while (i < literal.length && literal[i] !== '\n') i++;
        } else if (c === '/' && literal[i + 1] === '*') {
            i = literal.indexOf('*/', i + 2) + 2;
        } else if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < literal.length && /[\w$]/.test(literal[j])) j++;
            const word = literal.slice(i, j);
            out += ['true', 'false', 'null'].includes(word) ? word : JSON.stringify(word);
            i = j;
        } else {
            out += c;
            i++;
        }
    }
    // Remove trailing commas.
    out = out.replace(/,(\s*[\]}])/g, '$1');
    return JSON.parse(out).filter(e => e && e.name && e.code);
}

const openUrl = url => `${link('editor/editor.html')}?extension=${encodeURIComponent(url)}`;

(async () => {
    await boot('extensions');
    main.append(h('h1', {}, 'Extensions'),
        h('p', {class: 'muted', style: 'max-width:720px'},
            'One catalog for every extension ecosystem. Pick an extension to open the editor with it loaded. ',
            'Unsandboxed extensions ask for your permission before running.'));

    const customUrl = h('input', {type: 'url', id: 'ext-url', placeholder: 'https://example.com/my-extension.js'});
    main.append(h('form', {class: 'card', style: 'margin-bottom:22px', onsubmit: e => {
        e.preventDefault();
        if (customUrl.value.trim()) location.href = openUrl(customUrl.value.trim());
    }},
    h('label', {for: 'ext-url'}, 'Load a custom extension by URL'),
    h('div', {class: 'row'}, h('div', {style: 'flex:1;min-width:220px'}, customUrl), h('button', {class: 'btn primary', type: 'submit'}, 'Open in editor'))));

    const filter = h('input', {type: 'search', placeholder: 'Filter extensions', 'aria-label': 'Filter extensions', style: 'max-width:320px'});
    const tabs = h('div', {class: 'tabs', style: 'margin:0'});
    const note = h('p', {class: 'muted small'});
    const grid = h('div', {class: 'grid'});
    main.append(h('div', {class: 'row', style: 'margin-bottom:10px'}, tabs, h('span', {class: 'spacer'}), filter), note, grid);

    const cache = {};
    let current = 'turbowarp';
    const render = () => {
        const term = filter.value.trim().toLowerCase();
        const list = (cache[current] || []).filter(e => !term || `${e.name} ${e.description} ${e.by}`.toLowerCase().includes(term));
        grid.replaceChildren(...list.map(e => h('div', {class: 'ext-card'},
            h('div', {class: 'banner'}, e.image ? h('img', {src: e.image, alt: '', loading: 'lazy'}) : null),
            h('div', {class: 'meta'},
                h('div', {style: 'font-weight:800'}, e.name, e.unstable ? h('span', {class: 'badge warn', style: 'margin-left:6px'}, 'unstable') : null),
                e.by ? h('div', {class: 'muted small'}, `by ${e.by}`) : null,
                h('div', {class: 'desc'}, e.description),
                h('div', {class: 'row'},
                    h('a', {class: 'btn small primary', href: openUrl(e.url)}, 'Open in editor'),
                    e.docs ? h('a', {class: 'btn small ghost', href: e.docs, target: '_blank', rel: 'noopener'}, 'Docs') : null)))));
        if (!list.length) grid.replaceChildren(h('p', {class: 'empty'}, 'No extensions match.'));
    };
    const show = async key => {
        current = key;
        tabs.replaceChildren(...Object.entries(SOURCES).map(([k, s]) => h('button', {class: k === key ? 'active' : '', onclick: () => show(k)}, s.label)));
        note.textContent = SOURCES[key].note;
        if (!cache[key]) {
            grid.replaceChildren(h('p', {class: 'empty'}, 'Loading…'));
            try {
                cache[key] = await SOURCES[key].load();
            } catch (e) {
                grid.replaceChildren(errorNotice(e));
                return;
            }
        }
        if (current === key) render();
    };
    filter.addEventListener('input', render);
    show('turbowarp');
})();
