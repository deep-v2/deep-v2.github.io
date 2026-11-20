// Extras: KbauBlocks' own extras (Claude MCP) + unified extension catalog: TurboWarp gallery + PenguinMod gallery + custom URLs, all opening in the KbauBlocks editor.
import {$, boot, errorNotice, h, link, toast} from '../ui.js';

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

const openUrl = url => `${link('editor/')}?extension=${encodeURIComponent(url)}`;

(async () => {
    await boot('extras');
    main.append(h('h1', {}, 'Extras'),
        h('p', {class: 'muted', style: 'max-width:720px'},
            'Extras add new blocks to the editor. Pick one to open the editor with it loaded. ',
            'Unsandboxed extensions ask for your permission before running.'));

    main.append(claudeMcpCard());

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

function claudeMcpCard () {
    const bridgeUrl = link('kbaucode/mcp/kbaublocks-mcp.mjs');
    const extUrl = link('editor/extras/claude-mcp.js');
    const codeBlock = text => {
        const pre = h('pre', {class: 'code'}, h('code', {}, text));
        const copy = h('button', {class: 'btn small ghost copy-btn', type: 'button', onclick: async () => {
            try {
                await navigator.clipboard.writeText(text);
                toast('Copied');
            } catch (e) {
                // ignore
            }
        }}, 'Copy');
        return h('div', {class: 'code-wrap'}, pre, copy);
    };
    return h('section', {class: 'card claude-mcp', id: 'claude-mcp', style: 'margin-bottom:22px'},
        h('div', {class: 'row', style: 'align-items:flex-start;gap:18px'},
            h('img', {src: link('kbaucode/editor-src/overlay/src/lib/libraries/extensions/kbau/claude-mcp-small.png'), alt: '', width: 56, height: 56}),
            h('div', {style: 'flex:1;min-width:240px'},
                h('h2', {style: 'margin:0 0 4px'}, 'Claude MCP'),
                h('p', {class: 'muted', style: 'margin:0'},
                    'Let Claude build in your project: it can draw sprites and backdrops, write scripts, make variables, ',
                    'run the project and look at the stage. It works through MCP (Model Context Protocol) with a small bridge ',
                    'program on your computer, in the web editor and in the desktop app.'))),
        h('ol', {class: 'steps'},
            h('li', {}, 'Install ', h('a', {href: 'https://nodejs.org/', target: '_blank', rel: 'noopener'}, 'Node.js'), ' (version 18 or newer).'),
            h('li', {}, 'Download the bridge: ',
                h('a', {class: 'btn small', href: bridgeUrl, download: 'kbaublocks-mcp.mjs'}, 'kbaublocks-mcp.mjs'),
                ' and save it somewhere permanent, e.g. ', h('code', {}, 'C:\\KbauBlocks\\kbaublocks-mcp.mjs'), '.'),
            h('li', {}, 'Add it to Claude.',
                h('div', {class: 'muted small', style: 'margin:8px 0 4px'}, 'Claude Code:'),
                codeBlock('claude mcp add kbaublocks -- node "C:\\KbauBlocks\\kbaublocks-mcp.mjs"'),
                h('div', {class: 'muted small', style: 'margin:10px 0 4px'}, 'Claude Desktop (Settings → Developer → Edit Config), inside "mcpServers":'),
                codeBlock('"kbaublocks": {\n  "command": "node",\n  "args": ["C:\\\\KbauBlocks\\\\kbaublocks-mcp.mjs"]\n}')),
            h('li', {}, 'Open the editor and add ', h('b', {}, 'Claude MCP'), ' from the Extras list (bottom-left button). ',
                'It connects by itself; the "connected to Claude?" block turns true.'),
            h('li', {}, 'Ask Claude, e.g. ', h('i', {}, '"Make a game where a cat catches falling apples"'), '.')),
        h('div', {class: 'row'},
            h('a', {class: 'btn primary', href: `${link('editor/')}?extension=${encodeURIComponent(extUrl)}`}, 'Open editor with Claude MCP'),
            h('a', {class: 'btn ghost', href: bridgeUrl, download: 'kbaublocks-mcp.mjs'}, 'Download bridge')),
        h('p', {class: 'muted small', style: 'margin:12px 0 0'},
            'The bridge only listens on your own computer (127.0.0.1) and only accepts the KbauBlocks editor. ',
            'Your project goes to Claude only when Claude asks for it with a tool you approve.'));
}
