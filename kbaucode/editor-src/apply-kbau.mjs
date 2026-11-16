#!/usr/bin/env node
/**
 * KbauBlocks editor patch set.
 *
 * Applies KbauBlocks changes on top of a pinned TurboWarp scratch-gui checkout
 * (see TURBOWARP_COMMIT). Every replacement is asserted: if TurboWarp's source
 * changes and an anchor no longer matches, this script fails loudly instead of
 * silently producing a half-patched editor.
 *
 * Usage: node apply-kbau.mjs <path-to-scratch-gui-checkout>
 *
 * License: GPL-3.0 (same as TurboWarp scratch-gui, which this modifies).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gui = path.resolve(process.argv[2] || '.');
if (!fs.existsSync(path.join(gui, 'src', 'lib', 'brand.js'))) {
    console.error(`Not a scratch-gui checkout: ${gui}`);
    process.exit(1);
}

let failures = 0;
const edit = (rel, pairs) => {
    const file = path.join(gui, rel);
    let text = fs.readFileSync(file, 'utf8');
    for (const [from, to] of pairs) {
        const matches = typeof from === 'string' ? text.split(from).length - 1 : (text.match(from) || []).length;
        if (matches !== 1) {
            console.error(`[kbau] ${rel}: expected exactly 1 match, found ${matches}:\n  ${String(from).slice(0, 120)}`);
            failures++;
            continue;
        }
        text = text.replace(from, to);
    }
    fs.writeFileSync(file, text);
    console.log(`[kbau] patched ${rel}`);
};

// 1. Copy overlay files (new files only; never overwrite upstream files).
const overlay = path.join(here, 'overlay');
const copyDir = (src, dest) => {
    for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(d, {recursive: true});
            copyDir(s, d);
        } else {
            if (fs.existsSync(d)) {
                console.error(`[kbau] overlay would overwrite upstream file: ${path.relative(gui, d)}`);
                failures++;
                continue;
            }
            fs.copyFileSync(s, d);
            console.log(`[kbau] added ${path.relative(gui, d)}`);
        }
    }
};
copyDir(overlay, gui);

// 2. Branding.
edit('src/lib/brand.js', [["APP_NAME: 'TurboWarp'", "APP_NAME: 'KbauBlocks'"]]);
{
    const file = path.join(gui, 'webpack.config.js');
    let text = fs.readFileSync(file, 'utf8');
    const count = text.split('`${APP_NAME} - Run Scratch projects faster`').length - 1;
    if (count < 1) {
        console.error('[kbau] webpack.config.js: page title anchor missing');
        failures++;
    }
    text = text.split('`${APP_NAME} - Run Scratch projects faster`').join('`${APP_NAME} Editor`');
    fs.writeFileSync(file, text);
    console.log(`[kbau] patched webpack.config.js (${count} titles)`);
}

// 3. Theme: dark grey (near-black) GUI by default, solid black top bar.
edit('src/lib/themes/gui/dark.js', [
    ["'ui-primary': '#111111'", "'ui-primary': '#0e0e0e'"],
    ["'ui-secondary': '#1e1e1e'", "'ui-secondary': '#161616'"],
    ["'ui-tertiary': '#2e2e2e'", "'ui-tertiary': '#262626'"],
    ["'ui-modal-overlay': '#333333aa'", "'ui-modal-overlay': '#000000b3'"],
    ["'ui-modal-background': '#111111'", "'ui-modal-background': '#121212'"],
    ["'ui-modal-header-background': '#333333'", "'ui-modal-header-background': '#000000'"],
    ["'ui-white': '#111111'", "'ui-white': '#121212'"],
    ["'menu-bar-background': '#333333',", "'menu-bar-background': '#000000',\n    'menu-bar-background-image': 'none',\n    'menu-bar-foreground': '#ffffff',"],
    ["'assets-background': '#111111'", "'assets-background': '#0e0e0e'"],
    ["'input-background': '#1e1e1e'", "'input-background': '#1a1a1a'"],
    ["'popover-background': '#1e1e1e'", "'popover-background': '#1a1a1a'"],
    ["'badge-background': '#16202c'", "'badge-background': '#1f1f1f'"],
    ["'badge-border': '#203652'", "'badge-border': '#333333'"],
    ["'fullscreen-background': '#111111'", "'fullscreen-background': '#0a0a0a'"],
    ["'fullscreen-accent': '#111111'", "'fullscreen-accent': '#0a0a0a'"],
    ["'page-background': '#111111'", "'page-background': '#0e0e0e'"],
    ["'link-color': '#44aaff'", "'link-color': '#1fd1a0'"],
    ["workspace: '#1e1e1e'", "workspace: '#161616'"],
    ["toolboxSelected: '#1e1e1e'", "toolboxSelected: '#202020'"],
    ["toolbox: '#111111'", "toolbox: '#0e0e0e'"],
    ["flyout: '#111111'", "flyout: '#111111'"],
    ["valueReportBackground: '#1e1e1e'", "valueReportBackground: '#1a1a1a'"],
    ["contextMenuBackground: '#111111'", "contextMenuBackground: '#121212'"],
    ["gridColor: '#484848'", "gridColor: '#2c2c2c'"]
]);
edit('src/lib/themes/gui/light.js', [
    ["'menu-bar-background': 'var(--looks-secondary)'", "'menu-bar-background': '#000000'"]
]);
edit('src/lib/themes/index.js', [
    ["import * as accentRainbow from './accent/rainbow';", "import * as accentRainbow from './accent/rainbow';\nimport * as accentKbau from './accent/kbau';"],
    ["const ACCENT_RAINBOW = 'rainbow';", "const ACCENT_RAINBOW = 'rainbow';\nconst ACCENT_KBAU = 'kbau';"],
    ['[ACCENT_RAINBOW]: accentRainbow\n', '[ACCENT_RAINBOW]: accentRainbow,\n    [ACCENT_KBAU]: accentKbau\n'],
    ['const ACCENT_DEFAULT = ACCENT_RED;', 'const ACCENT_DEFAULT = ACCENT_KBAU;'],
    ['const GUI_DEFAULT = GUI_LIGHT;', 'const GUI_DEFAULT = GUI_DARK;'],
    ['    ACCENT_RAINBOW,\n    ACCENT_MAP,', '    ACCENT_RAINBOW,\n    ACCENT_KBAU,\n    ACCENT_MAP,']
]);
edit('src/lib/themes/themePersistance.js', [
    // KbauBlocks defaults to dark unless the user explicitly picks light (or needs high contrast).
    [`    if (PREFERS_DARK_QUERY && PREFERS_DARK_QUERY.matches) {
        return Theme.dark;
    }
    return Theme.light;`, `    return Theme.dark;`],
    ["const STORAGE_KEY = 'tw:theme';", "const STORAGE_KEY = 'kbau:theme';"]
]);
edit('src/components/menu-bar/tw-theme-accent.jsx', [
    ['import {ACCENT_BLUE, ACCENT_MAP, ACCENT_PURPLE, ACCENT_RED, ACCENT_RAINBOW, Theme}',
        'import {ACCENT_BLUE, ACCENT_KBAU, ACCENT_MAP, ACCENT_PURPLE, ACCENT_RED, ACCENT_RAINBOW, Theme}'],
    ['const options = defineMessages({\n', `const options = defineMessages({
    [ACCENT_KBAU]: {
        defaultMessage: 'Mint',
        description: 'Name of the KbauBlocks mint color scheme, used by default.',
        id: 'kbau.accent.mint'
    },
`]
]);

// 4. Menu bar: KbauBlocks home link + "Save to KbauBlocks".
edit('src/components/menu-bar/menu-bar.jsx', [
    ["import {APP_NAME} from '../../lib/brand.js';",
        `import {APP_NAME} from '../../lib/brand.js';
import kbauLogo from './kbau-logo.svg';
import {KbauError, saveToKbau, siteUrl} from '../../lib/kbau-cloud.js';`],
    ["            'handleClickSave',\n", "            'handleClickSave',\n            'handleClickKbauSave',\n"],
    ['    handleClickSave () {\n', `    async handleClickKbauSave () {
        this.props.onRequestCloseFile();
        if (this.state && this.state.kbauSaving) return;
        this.setState({kbauSaving: true});
        try {
            const result = await saveToKbau(this.props.vm, this.props.projectTitle);
            // eslint-disable-next-line no-alert
            if (window.confirm(result.created ?
                'Saved to KbauBlocks as an unshared project. Open its page to add a description and share it?' :
                'Saved to KbauBlocks. Open the project page?')) {
                window.open(result.url, '_blank');
            }
        } catch (e) {
            if (e instanceof KbauError && e.message === 'NOT_SIGNED_IN') {
                // eslint-disable-next-line no-alert
                if (window.confirm('Sign in to KbauBlocks to save projects online. Open the sign-in page in a new tab?')) {
                    window.open(siteUrl('login.html'), '_blank');
                }
            } else {
                // eslint-disable-next-line no-alert
                alert(\`Could not save to KbauBlocks: \${e.message}\`);
            }
        } finally {
            this.setState({kbauSaving: false});
        }
    }
    handleClickSave () {
`],
    ['                <div className={styles.mainMenu}>\n                    <div className={styles.fileGroup}>\n',
        `                <div className={styles.mainMenu}>
                    <div className={styles.fileGroup}>
                        <a
                            className={classNames(styles.menuBarItem, styles.hoverable, styles.kbauHome)}
                            href={siteUrl('index.html')}
                            title={\`\${APP_NAME} home\`}
                        >
                            <img
                                className={styles.kbauLogo}
                                src={kbauLogo}
                                alt=""
                                draggable={false}
                            />
                            <span className={classNames(styles.collapsibleLabel, styles.kbauWordmark)}>{APP_NAME}</span>
                        </a>
`],
    [`                                    <MenuSection>
                                        <MenuItem
                                            onClick={this.props.onStartSelectingFileUpload}
                                        >`, `                                    <MenuSection>
                                        <MenuItem onClick={this.handleClickKbauSave}>
                                            {(this.state && this.state.kbauSaving) ?
                                                'Saving to KbauBlocks…' :
                                                'Save to KbauBlocks'}
                                        </MenuItem>
                                    </MenuSection>
                                    <MenuSection>
                                        <MenuItem
                                            onClick={this.props.onStartSelectingFileUpload}
                                        >`]
]);
// Feedback / error-report links go to KbauBlocks, not to TurboWarp's maintainer.
const replaceAll = (rel, from, to) => {
    const file = path.join(gui, rel);
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split(from).length - 1;
    if (count < 1) {
        console.error(`[kbau] ${rel}: anchor missing: ${from}`);
        failures++;
        return;
    }
    fs.writeFileSync(file, text.split(from).join(to));
    console.log(`[kbau] patched ${rel} (${count} occurrences)`);
};
for (const rel of [
    'src/components/menu-bar/menu-bar.jsx',
    'src/addons/settings/settings.jsx',
    'src/components/tw-invalid-embed/invalid-embed.jsx',
    'src/playground/render-interface.jsx'
]) {
    replaceAll(rel,
        'https://scratch.mit.edu/users/GarboMuffin/#comments',
        'https://github.com/deep-v2/deep-v2.github.io/issues');
}
fs.appendFileSync(path.join(gui, 'src/components/menu-bar/menu-bar.css'), `
/* KbauBlocks */
.kbau-home {
    gap: 0.4rem;
    color: inherit;
    text-decoration: none;
    font-weight: 800;
    letter-spacing: -0.01em;
}
.kbau-logo {
    width: 1.5rem;
    height: 1.5rem;
}
.kbau-wordmark {
    font-size: 0.95rem;
}
`);
console.log('[kbau] patched src/components/menu-bar/menu-bar.css');

// 4b. Load projects from the KbauBlocks server with ?kbau_project=<id>, and use that id for cloud variables.
edit('src/lib/project-fetcher-hoc.jsx', [
    ["import storage from './storage';", "import storage from './storage';\nimport {fetchKbauProject} from './kbau-cloud.js';"],
    [`            if (projectUrl) {
                if (`, `            const kbauProject = typeof URLSearchParams === 'undefined' ?
                null :
                new URLSearchParams(location.search).get('kbau_project');
            if (kbauProject && !projectUrl) {
                assetPromise = fetchKbauProject(kbauProject).then(buffer => ({data: buffer}));
            } else if (projectUrl) {
                if (`]
]);
edit('src/lib/cloud-provider.js', [
    ['        msg.project_id = this.projectId;\n', `        // KbauBlocks: projects hosted on a KbauBlocks server use their server id for cloud rooms.
        msg.project_id = (typeof URLSearchParams !== 'undefined' &&
            new URLSearchParams(location.search).get('kbau_project')) || this.projectId;
`]
]);

// 5. Credits: keep upstream credits, add KbauBlocks notice at the top.
edit('src/playground/credits/credits.jsx', [
    ["<main className={styles.main}>", `<main className={styles.main}>
        <section>
            <h2>KbauBlocks</h2>
            <p>
                KbauBlocks is a modified version of TurboWarp (GPL-3.0), which is a modified version of Scratch.
                It is not affiliated with TurboWarp, PenguinMod, Scratch Addons or the Scratch Foundation.
                Source code: <a href="https://github.com/deep-v2/deep-v2.github.io/tree/main/kbaucode">github.com/deep-v2/deep-v2.github.io</a>.
            </p>
        </section>`]
]);

if (failures) {
    console.error(`[kbau] ${failures} patch step(s) failed.`);
    process.exit(1);
}
console.log('[kbau] all patches applied.');
