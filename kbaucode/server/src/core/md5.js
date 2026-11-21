// MD5 of bytes, in plain JS (Workers' and Node's WebCrypto don't offer MD5).
// Scratch names every asset by the MD5 of its contents, so the server uses this to check uploads.
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

/**
 * @param {Uint8Array} bytes data
 * @returns {string} lowercase hex digest
 */
export const md5Hex = bytes => {
    const len = bytes.length;
    const padded = new Uint8Array(((len + 8) >>> 6) + 1 << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
    let a0 = 0x67452301;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) M[i] = view.getInt32(off + i * 4, true);
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) & 15;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) & 15;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) & 15;
            }
            const tmp = d;
            d = c;
            c = b;
            const x = (a + f + K[i] + M[g]) | 0;
            b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
            a = tmp;
        }
        a0 = (a0 + a) | 0;
        b0 = (b0 + b) | 0;
        c0 = (c0 + c) | 0;
        d0 = (d0 + d) | 0;
    }
    let out = '';
    for (const v of [a0, b0, c0, d0]) {
        for (let i = 0; i < 4; i++) out += ((v >>> (i * 8)) & 255).toString(16).padStart(2, '0');
    }
    return out;
};

/**
 * MD5 using the platform's native digest when it has one (Cloudflare Workers support 'MD5'),
 * falling back to the JS version (Node's WebCrypto doesn't).
 * @param {Uint8Array} bytes data
 * @returns {Promise<string>} lowercase hex digest
 */
export const md5 = async bytes => {
    try {
        const digest = new Uint8Array(await crypto.subtle.digest('MD5', bytes));
        return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        return md5Hex(bytes);
    }
};
