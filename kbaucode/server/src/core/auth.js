// Password hashing and tokens using Web Crypto (works in Node >= 20 and Cloudflare Workers).
const enc = new TextEncoder();
// Cloudflare Workers caps PBKDF2 at 100,000 iterations.
const ITERATIONS = 100000;
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const toB64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toHex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

const derive = async (password, salt, iterations) => {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, key, 256);
};

export const hashPassword = async password => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await derive(password, salt, ITERATIONS);
    return `pbkdf2-sha256$${ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
};

export const verifyPassword = async (password, stored) => {
    const [scheme, iter, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2-sha256' || !iter || !saltB64 || !hashB64) return false;
    const bits = new Uint8Array(await derive(password, fromB64(saltB64), Number(iter)));
    const expected = fromB64(hashB64);
    if (bits.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
    return diff === 0;
};

export const newToken = () => toB64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const sha256Hex = async data => toHex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
export const hashToken = token => sha256Hex(token);

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
export const validatePassword = password => typeof password === 'string' && password.length >= 8 && password.length <= 200;
