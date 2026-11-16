// Node blob store: files under <dataDir>/blobs, content type in a sidecar file.
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';

export const createBlobStore = dataDir => {
    const root = path.join(dataDir, 'blobs');
    const file = key => {
        const p = path.join(root, ...key.split('/'));
        if (!p.startsWith(root)) throw new Error('bad key');
        return p;
    };
    return {
        put: async (key, bytes, type) => {
            const p = file(key);
            fs.mkdirSync(path.dirname(p), {recursive: true});
            fs.writeFileSync(`${p}.tmp`, bytes);
            fs.renameSync(`${p}.tmp`, p);
            fs.writeFileSync(`${p}.type`, type || 'application/octet-stream');
        },
        get: async key => {
            const p = file(key);
            if (!fs.existsSync(p)) return null;
            const type = fs.existsSync(`${p}.type`) ? fs.readFileSync(`${p}.type`, 'utf8') : 'application/octet-stream';
            return {body: Readable.toWeb(fs.createReadStream(p)), size: fs.statSync(p).size, type};
        }
    };
};
