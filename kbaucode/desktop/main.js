// KbauBlocks desktop: the KbauBlocks editor as an offline Windows app.
// The editor is served from the app itself (kbau://app/); every network request is blocked except
// ws://127.0.0.1 / localhost (used by the Claude MCP extra to talk to the local MCP bridge).
// GPL-3.0-or-later.
const {app, BrowserWindow, dialog, protocol, net, shell, session, Menu} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');

const APP_DIR = path.join(__dirname, 'app');

protocol.registerSchemesAsPrivileged([{
    scheme: 'kbau',
    privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true}
}]);

// One window per launch; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

const isLocal = url => {
    try {
        const u = new URL(url);
        if (['kbau:', 'data:', 'blob:', 'devtools:', 'chrome-extension:'].includes(u.protocol)) return true;
        if (['ws:', 'http:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return true;
        return false;
    } catch (e) {
        return false;
    }
};

const createWindow = () => {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 640,
        minHeight: 480,
        backgroundColor: '#0e0e0e',
        title: 'KbauBlocks',
        icon: path.join(__dirname, 'icon.png'),
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            spellcheck: false
        }
    });
    Menu.setApplicationMenu(null);

    // Links to the outside world open in the user's browser (e.g. extension docs), never in the app.
    win.webContents.setWindowOpenHandler(({url}) => {
        if (/^https?:\/\//.test(url) && !isLocal(url)) shell.openExternal(url);
        return {action: 'deny'};
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('kbau://app/')) {
            event.preventDefault();
            if (/^https?:\/\//.test(url)) shell.openExternal(url);
        }
    });

    // "Leave site? Changes you made may not be saved." → ask before closing.
    win.webContents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(win, {
            type: 'question',
            buttons: ['Quit', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'KbauBlocks',
            message: 'You have unsaved changes. Quit anyway?',
            detail: 'Use File → Save to your computer to keep your project.'
        });
        if (choice === 0) event.preventDefault();
    });

    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'F11') {
            win.setFullScreen(!win.isFullScreen());
            event.preventDefault();
        } else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
            win.webContents.toggleDevTools();
            event.preventDefault();
        } else if (input.control && (input.key === '=' || input.key === '+')) {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
            event.preventDefault();
        } else if (input.control && input.key === '-') {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
            event.preventDefault();
        } else if (input.control && input.key === '0') {
            win.webContents.setZoomLevel(0);
            event.preventDefault();
        }
    });

    win.loadURL('kbau://app/');
    return win;
};

app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
    }
});

app.whenReady().then(() => {
    // Serve the editor from the app folder.
    protocol.handle('kbau', request => {
        const {pathname} = new URL(request.url);
        let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        const file = path.normalize(path.join(APP_DIR, rel));
        if (!file.startsWith(APP_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return new Response('Not found', {status: 404});
        }
        return net.fetch(pathToFileURL(file).toString());
    });

    // Offline: block every request that would leave this computer.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({cancel: !isLocal(details.url)});
    });
    // No camera/microphone/etc. prompts from projects unless the user allows them in the dialog.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (['clipboard-sanitized-write', 'fullscreen', 'pointerLock'].includes(permission)) {
            callback(true);
            return;
        }
        if (['media', 'microphone', 'camera'].includes(permission)) {
            const choice = dialog.showMessageBoxSync({
                type: 'question',
                buttons: ['Allow', 'Block'],
                defaultId: 1,
                cancelId: 1,
                message: 'This project wants to use your camera or microphone. Allow it?'
            });
            callback(choice === 0);
            return;
        }
        callback(false);
    });

    createWindow();
});

app.on('window-all-closed', () => app.quit());
