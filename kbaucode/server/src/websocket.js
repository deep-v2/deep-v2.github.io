// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close). No dependencies.
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
    constructor (socket) {
        super();
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.closed = false;
        socket.on('data', chunk => this._onData(chunk));
        socket.on('close', () => this._finish());
        socket.on('error', () => this._finish());
    }

    _finish () {
        if (this.closed) return;
        this.closed = true;
        this.emit('close');
    }

    _onData (chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
            if (this.buffer.length < 2) return;
            const b0 = this.buffer[0];
            const b1 = this.buffer[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (this.buffer.length < 4) return;
                len = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (len === 127) {
                if (this.buffer.length < 10) return;
                const big = this.buffer.readBigUInt64BE(2);
                if (big > BigInt(MAX_MESSAGE)) return this.close(1009);
                len = Number(big);
                offset = 10;
            }
            if (len > MAX_MESSAGE) return this.close(1009);
            if (!masked) return this.close(1002); // clients must mask
            if (this.buffer.length < offset + 4 + len) return;
            const mask = this.buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            this.buffer = this.buffer.subarray(offset + 4 + len);

            if (opcode === 0x8) return this.close(1000);
            if (opcode === 0x9) {
                this._send(0xA, payload);
                continue;
            }
            if (opcode === 0xA) continue;
            if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
                this.fragments.push(payload);
                const total = this.fragments.reduce((n, f) => n + f.length, 0);
                if (total > MAX_MESSAGE) return this.close(1009);
                if (fin) {
                    const message = Buffer.concat(this.fragments).toString('utf8');
                    this.fragments = [];
                    this.emit('message', message);
                }
            }
        }
    }

    _send (opcode, payload) {
        if (this.closed || this.socket.destroyed) return;
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.from([0x80 | opcode, len]);
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }
        this.socket.write(Buffer.concat([header, payload]));
    }

    send (text) {
        this._send(0x1, Buffer.from(text, 'utf8'));
    }

    close (code = 1000) {
        if (this.closed) return;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        this._send(0x8, payload);
        this.socket.end();
        this._finish();
    }
}

export const acceptUpgrade = (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return null;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '', ''
    ].join('\r\n'));
    socket.setNoDelay(true);
    return new WebSocketConnection(socket);
};
