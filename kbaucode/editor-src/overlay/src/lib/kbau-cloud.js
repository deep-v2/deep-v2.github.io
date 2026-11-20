/**
 * KbauBlocks community client used by the editor.
 * Shares authentication with the KbauBlocks website: both live on the same
 * origin and read the same localStorage keys (see kbaucode/js/api.js).
 * Part of the KbauBlocks patch set, GPL-3.0.
 */

const TOKEN_KEY = 'kbau:token';
const API_OVERRIDE_KEY = 'kbau:api';
// The editor is served from <site>/editor/, so the site root is one level up.
const SITE_ROOT = new URL('../', window.location.href).href;

let cachedApiBase;

const getApiBase = async () => {
    if (typeof cachedApiBase === 'string') return cachedApiBase;
    try {
        const override = localStorage.getItem(API_OVERRIDE_KEY);
        if (override) {
            cachedApiBase = override.replace(/\/+$/, '');
            return cachedApiBase;
        }
    } catch (e) {
        // ignore
    }
    try {
        const res = await fetch(new URL('config.json', SITE_ROOT).href, {cache: 'no-store'});
        if (res.ok) {
            const config = await res.json();
            if (config && typeof config.apiBase === 'string' && config.apiBase) {
                cachedApiBase = new URL(config.apiBase, SITE_ROOT).href.replace(/\/+$/, '');
                return cachedApiBase;
            }
        }
    } catch (e) {
        // ignore
    }
    cachedApiBase = '';
    return cachedApiBase;
};

const getToken = () => {
    try {
        return localStorage.getItem(TOKEN_KEY);
    } catch (e) {
        return null;
    }
};

const siteUrl = path => new URL(path, SITE_ROOT).href;

const getKbauProjectId = () => new URLSearchParams(window.location.search).get('kbau_project');

const setKbauProjectId = id => {
    const params = new URLSearchParams(window.location.search);
    params.set('kbau_project', id);
    params.delete('project_url');
    history.replaceState(history.state, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
};

const snapshot = vm => new Promise(resolve => {
    try {
        vm.renderer.requestSnapshot(dataURL => resolve(dataURL));
    } catch (e) {
        resolve(null);
    }
});

class KbauError extends Error {}

/**
 * Save the open project to the KbauBlocks community server.
 * Creates a new (unshared) project the first time, updates it afterwards.
 * @param {VM} vm the VM
 * @param {string} title project title
 * @returns {Promise<{id: string, url: string, created: boolean}>} result
 */
const saveToKbau = async (vm, title) => {
    const api = await getApiBase();
    if (!api) {
        throw new KbauError('No KbauBlocks community server is configured. Set one up on the website (Settings → Server).');
    }
    const token = getToken();
    if (!token) {
        throw new KbauError('NOT_SIGNED_IN');
    }
    const sb3 = await vm.saveProjectSb3();
    const thumbnail = await snapshot(vm);
    const form = new FormData();
    form.append('project', sb3, 'project.sb3');
    form.append('title', title || 'Untitled');
    if (thumbnail) {
        const blob = await (await fetch(thumbnail)).blob();
        form.append('thumbnail', blob, 'thumbnail.png');
    }
    const existing = getKbauProjectId();
    const remixOf = new URLSearchParams(window.location.search).get('kbau_remix');
    if (!existing && remixOf) form.append('remixOf', remixOf);
    const res = await fetch(existing ? `${api}/projects/${encodeURIComponent(existing)}/content` : `${api}/projects`, {
        method: existing ? 'PUT' : 'POST',
        headers: {Authorization: `Bearer ${token}`},
        body: form
    });
    let body = null;
    try {
        body = await res.json();
    } catch (e) {
        // ignore
    }
    if (res.status === 401) throw new KbauError('NOT_SIGNED_IN');
    if (res.status === 403 && existing) {
        // Not ours: save as a new remix instead.
        const params = new URLSearchParams(window.location.search);
        params.delete('kbau_project');
        history.replaceState(history.state, '', `${window.location.pathname}?${params.toString()}`);
        return saveToKbau(vm, title);
    }
    if (!res.ok) throw new KbauError((body && body.error) || `Server responded with ${res.status}`);
    setKbauProjectId(body.project.id);
    return {
        id: body.project.id,
        url: siteUrl(`project?id=${encodeURIComponent(body.project.id)}`),
        created: !existing
    };
};

/**
 * Save the open project to KbauBlocks and share it with everyone (the editor's Share button).
 * @param {VM} vm the VM
 * @param {string} title project title
 * @returns {Promise<{id: string, url: string, created: boolean}>} result
 */
const shareToKbau = async (vm, title) => {
    const saved = await saveToKbau(vm, title);
    const api = await getApiBase();
    const res = await fetch(`${api}/projects/${encodeURIComponent(saved.id)}/share`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${getToken()}`}
    });
    if (res.status === 401) throw new KbauError('NOT_SIGNED_IN');
    if (!res.ok) {
        let body = null;
        try {
            body = await res.json();
        } catch (e) {
            // ignore
        }
        throw new KbauError((body && body.error) || `Server responded with ${res.status}`);
    }
    return saved;
};

/**
 * For a project opened with ?kbau_project=<id>: is it yours, and is it shared?
 * @returns {Promise<{shared: boolean, canEdit: boolean}|null>} info, or null if unknown
 */
const getKbauProjectInfo = async () => {
    const id = getKbauProjectId();
    const api = await getApiBase();
    if (!id || !api) return null;
    try {
        const token = getToken();
        const res = await fetch(`${api}/projects/${encodeURIComponent(id)}`, {
            headers: token ? {Authorization: `Bearer ${token}`} : {}
        });
        if (!res.ok) return null;
        const {project} = await res.json();
        return {shared: !!project.shared, canEdit: !!project.canEdit};
    } catch (e) {
        return null;
    }
};

export {
    KbauError,
    getApiBase,
    getKbauProjectInfo,
    getToken,
    saveToKbau,
    shareToKbau,
    siteUrl
};

/**
 * Download a project from the KbauBlocks server (used for ?kbau_project=<id>).
 * Sends the session token so owners can open their unshared projects.
 * @param {string} id project id
 * @returns {Promise<ArrayBuffer>} sb3 data
 */
export const fetchKbauProject = async id => {
    const api = await getApiBase();
    if (!api) throw new Error('No KbauBlocks community server is configured.');
    const token = getToken();
    const res = await fetch(`${api}/projects/${encodeURIComponent(id)}/sb3`, {
        headers: token ? {Authorization: `Bearer ${token}`} : {}
    });
    if (!res.ok) throw new Error(`KbauBlocks server returned status ${res.status}`);
    return res.arrayBuffer();
};
