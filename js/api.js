// KbauBlocks API client. Shares session storage keys with the editor (kbau-cloud.js).
// AGPL-3.0-or-later.

const TOKEN_KEY = 'kbau:token';
const USER_KEY = 'kbau:user';
const API_OVERRIDE_KEY = 'kbau:api';

export const siteRoot = new URL('../', import.meta.url).href;

const safeGet = key => {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
};
const safeSet = (key, value) => {
    try {
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch (e) {
        // ignore
    }
};

export class ApiError extends Error {
    constructor (status, message) {
        super(message);
        this.status = status;
    }
}

let apiBasePromise = null;
export const getApiBase = () => {
    if (!apiBasePromise) {
        apiBasePromise = (async () => {
            const override = safeGet(API_OVERRIDE_KEY);
            if (override) return override.replace(/\/+$/, '');
            try {
                const res = await fetch(new URL('config.json', siteRoot).href, {cache: 'no-store'});
                if (res.ok) {
                    const config = await res.json();
                    if (config && typeof config.apiBase === 'string' && config.apiBase) {
                        return new URL(config.apiBase, siteRoot).href.replace(/\/+$/, '');
                    }
                }
            } catch (e) {
                // ignore
            }
            return '';
        })();
    }
    return apiBasePromise;
};
export const setApiOverride = url => {
    safeSet(API_OVERRIDE_KEY, url ? url.replace(/\/+$/, '') : null);
    apiBasePromise = null;
};
export const getApiOverride = () => safeGet(API_OVERRIDE_KEY) || '';

let healthPromise = null;
/** @returns {Promise<boolean>} whether a KbauBlocks server is reachable */
export const serverAvailable = () => {
    if (!healthPromise) {
        healthPromise = (async () => {
            const base = await getApiBase();
            if (!base) return false;
            try {
                const res = await fetch(`${base}/health`, {cache: 'no-store'});
                if (!res.ok) return false;
                const body = await res.json();
                return body && body.name === 'KbauBlocks';
            } catch (e) {
                return false;
            }
        })();
    }
    return healthPromise;
};

export const getToken = () => safeGet(TOKEN_KEY);
export const getCachedUser = () => {
    try {
        return JSON.parse(safeGet(USER_KEY) || 'null');
    } catch (e) {
        return null;
    }
};
export const setSession = (token, user) => {
    safeSet(TOKEN_KEY, token);
    safeSet(USER_KEY, user ? JSON.stringify(user) : null);
};
export const updateCachedUser = user => safeSet(USER_KEY, JSON.stringify(user));

/** Absolute URL for a path returned by the API (e.g. thumbnailUrl). */
export const apiUrl = async p => {
    if (!p) return null;
    if (/^https?:/.test(p)) return p;
    return `${await getApiBase()}${p}`;
};

/**
 * URL for an image served by the API. When signed in, the image is fetched with your token (as a blob URL),
 * so thumbnails of your own unshared projects show up too; a plain <img src> can't send the token.
 */
export const imageUrl = async p => {
    const url = await apiUrl(p);
    const token = getToken();
    if (!url || !token) return url;
    try {
        const res = await fetch(url, {headers: {Authorization: `Bearer ${token}`}});
        if (!res.ok) return url;
        return URL.createObjectURL(await res.blob());
    } catch (e) {
        return url;
    }
};

export const request = async (method, path, body, {form = false} = {}) => {
    const base = await getApiBase();
    if (!base) throw new ApiError(0, 'No KbauBlocks server is configured.');
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
        if (form) {
            payload = body;
        } else {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
    }
    let res;
    try {
        res = await fetch(`${base}${path}`, {method, headers, body: payload});
    } catch (e) {
        throw new ApiError(0, 'Could not reach the KbauBlocks server.');
    }
    let data = null;
    try {
        data = await res.json();
    } catch (e) {
        // ignore
    }
    if (res.status === 401 && token && path !== '/auth/login') {
        // Session expired or revoked.
        setSession(null, null);
    }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
    return data;
};

export const api = {
    request,
    get: p => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: p => request('DELETE', p),
    upload: (method, p, formData) => request(method, p, formData, {form: true})
};

/** Refresh the signed-in user from the server. */
export const refreshMe = async () => {
    if (!getToken()) return null;
    try {
        const {user} = await api.get('/auth/me');
        if (user) updateCachedUser(user);
        else setSession(null, null);
        return user;
    } catch (e) {
        return getCachedUser();
    }
};

export const signOut = async () => {
    try {
        await api.post('/auth/logout');
    } catch (e) {
        // ignore
    }
    setSession(null, null);
};

export const editorUrl = async (params = {}) => {
    const url = new URL('editor/', siteRoot);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    if (params.kbau_project) {
        const ws = await cloudHost(params.kbau_project);
        if (ws) url.searchParams.set('cloud_host', ws);
    }
    return url.href;
};
export const embedUrl = async id => {
    const url = new URL('editor/embed.html', siteRoot);
    url.searchParams.set('kbau_project', id);
    const ws = await cloudHost(id);
    if (ws) url.searchParams.set('cloud_host', ws);
    return url.href;
};
/** Cloud variable server for one project (each project has its own room). */
export const cloudHost = async projectId => {
    const base = await getApiBase();
    if (!base) return '';
    const u = new URL(`${base}/cloud/${encodeURIComponent(projectId)}`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
};

