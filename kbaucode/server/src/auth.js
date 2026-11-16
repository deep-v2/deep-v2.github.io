// Password hashing and session tokens.
import crypto from 'node:crypto';

const SCRYPT_PARAMS = {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
const KEYLEN = 64;
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const hashPassword = password => new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, KEYLEN, SCRYPT_PARAMS, (err, key) => {
        if (err) return reject(err);
        resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`);
    });
});

export const verifyPassword = (password, stored) => new Promise(resolve => {
    const [scheme, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltB64 || !keyB64) return resolve(false);
    const expected = Buffer.from(keyB64, 'base64');
    crypto.scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS, (err, key) => {
        if (err) return resolve(false);
        resolve(crypto.timingSafeEqual(key, expected));
    });
});

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
export const validatePassword = password => typeof password === 'string' && password.length >= 8 && password.length <= 200;
