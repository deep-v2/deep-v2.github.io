// Copies the offline editor build into ./app and bundles the Nunito font (no Google Fonts offline).
// Usage: node prepare-app.mjs <path-to-offline-editor-build>
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(build, 'editor.html'))) {
    console.error(`Not an editor build: ${build}`);
    process.exit(1);
}
const app = path.join(here, 'app');
fs.rmSync(app, {recursive: true, force: true});
fs.cpSync(build, app, {recursive: true});
// The app opens the editor at kbau://app/ (index.html); TurboWarp's player page becomes player.html.
fs.renameSync(path.join(app, 'index.html'), path.join(app, 'player.html'));
fs.copyFileSync(path.join(app, 'editor.html'), path.join(app, 'index.html'));

const fonts = path.join(app, 'fonts');
fs.mkdirSync(fonts, {recursive: true});
const files = path.join(here, 'node_modules/@fontsource/nunito/files');
let css = '';
for (const weight of [400, 600, 700, 800, 900]) {
    for (const subset of ['latin', 'latin-ext']) {
        const name = `nunito-${subset}-${weight}-normal.woff2`;
        if (!fs.existsSync(path.join(files, name))) continue;
        fs.copyFileSync(path.join(files, name), path.join(fonts, name));
        css += `@font-face{font-family:"Nunito";font-style:normal;font-display:swap;font-weight:${weight};src:url(${name}) format("woff2");}\n`;
    }
}
if (!css) {
    console.error('Nunito font files not found (npm ci first).');
    process.exit(1);
}
fs.writeFileSync(path.join(fonts, 'nunito.css'), css);
console.log(`App ready in ${app}`);
