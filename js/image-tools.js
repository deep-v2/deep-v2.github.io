// Image cropper for profile pictures and banners, with animated GIF support. AGPL-3.0-or-later.
// Still images are cropped on a canvas. Animated GIFs are decoded frame by frame (ImageDecoder),
// cropped, and re-encoded with the small GIF encoder below, so they stay animated.
import {h} from './ui.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_UPLOAD = 8 * 1024 * 1024; // server limit for profile images
const MAX_SOURCE = 40 * 1024 * 1024;

export const isImageFile = f => f && (IMAGE_TYPES.includes(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name || ''));
const isGif = f => f.type === 'image/gif' || /\.gif$/i.test(f.name || '');

/**
 * Opens the cropper. Resolves with {blob, animated} or null if cancelled.
 * opts: {title, aspect (w/h), radius ('50%' or a fraction of the frame width), out: [w, h], gifOut: [w, h]}
 */
export const cropImage = (file, opts) => new Promise((resolve, reject) => {
    if (!isImageFile(file)) return reject(new Error('That isn\'t a PNG, JPEG, WebP or GIF image.'));
    if (file.size > MAX_SOURCE) return reject(new Error('That image is too big (over 40 MB).'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That image couldn\'t be opened.'));
    };
    img.onload = () => openCropper(file, img, opts, value => {
        URL.revokeObjectURL(url);
        resolve(value);
    }, err => {
        URL.revokeObjectURL(url);
        reject(err);
    });
    img.src = url;
});

function openCropper (file, img, opts, done, fail) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const animated = isGif(file);
    const aspect = opts.aspect;

    // Stage and crop frame sizes (CSS px), fitted to the window.
    const stageW = Math.min(620, window.innerWidth - 32 - 44);
    const frameW = Math.round(stageW - 48);
    const frameH = Math.round(frameW / aspect);
    // Wide frames (banners) get extra room above and below, so you can see what you're cropping out.
    const stageH = Math.min(Math.max(frameH + 48, Math.round(stageW * 0.5)), Math.round(window.innerHeight * 0.55));
    const fw = Math.min(frameW, Math.round((stageH - 48) * aspect));
    const fh = Math.round(fw / aspect);
    const fx = Math.round((stageW - fw) / 2);
    const fy = Math.round((stageH - fh) / 2);

    const minScale = Math.max(fw / nw, fh / nh);
    const maxScale = minScale * 8;
    let s = minScale;
    let x = fx + (fw - nw * s) / 2;
    let y = fy + (fh - nh * s) / 2;

    img.className = 'crop-img';
    img.draggable = false;
    const radius = opts.radius === '50%' ? '50%' : `${Math.round((opts.radius || 0) * fw)}px`;
    const frame = h('div', {class: 'crop-frame', style: `left:${fx}px;top:${fy}px;width:${fw}px;height:${fh}px;border-radius:${radius}`},
        h('div', {class: 'crop-grid'}));
    const stage = h('div', {class: 'crop-stage', style: `width:${stageW}px;height:${stageH}px`, tabindex: '0',
        'aria-label': 'Drag to move the image, scroll or use the slider to zoom'}, img, frame);
    const zoom = h('input', {type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Zoom', class: 'crop-zoom'});

    const clamp = () => {
        s = Math.min(maxScale, Math.max(minScale, s));
        x = Math.min(fx, Math.max(fx + fw - nw * s, x));
        y = Math.min(fy, Math.max(fy + fh - nh * s, y));
    };
    const toSlider = () => Math.round(1000 * Math.log(s / minScale) / Math.log(maxScale / minScale));
    const render = () => {
        clamp();
        img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
        zoom.value = String(toSlider());
    };
    // Zoom keeping the point (px, py) in stage coordinates still.
    const zoomAt = (next, px, py) => {
        const k = Math.min(maxScale, Math.max(minScale, next)) / s;
        x = px - (px - x) * k;
        y = py - (py - y) * k;
        s *= k;
        render();
    };
    const center = () => [fx + fw / 2, fy + fh / 2];

    zoom.addEventListener('input', () => {
        const next = minScale * Math.pow(maxScale / minScale, Number(zoom.value) / 1000);
        zoomAt(next, ...center());
    });
    stage.addEventListener('wheel', e => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, {passive: false});

    // Drag to pan; two fingers to pinch-zoom.
    const pointers = new Map();
    let pinch = null;
    stage.addEventListener('pointerdown', e => {
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        stage.classList.add('dragging');
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = {dist: Math.hypot(a[0] - b[0], a[1] - b[1]), s};
        }
    });
    stage.addEventListener('pointermove', e => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (pointers.size === 2 && pinch) {
            const [a, b] = [...pointers.values()];
            const r = stage.getBoundingClientRect();
            zoomAt(pinch.s * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.dist,
                (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
        } else if (pointers.size === 1) {
            x += e.clientX - prev[0];
            y += e.clientY - prev[1];
            render();
        }
    });
    const up = e => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (!pointers.size) stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('dblclick', () => {
        s = minScale;
        x = fx + (fw - nw * s) / 2;
        y = fy + (fh - nh * s) / 2;
        render();
    });
    stage.addEventListener('keydown', e => {
        const step = e.shiftKey ? 20 : 4;
        const moves = {ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step]};
        if (moves[e.key]) {
            e.preventDefault();
            x += moves[e.key][0];
            y += moves[e.key][1];
            render();
        } else if (e.key === '+' || e.key === '=') {
            zoomAt(s * 1.1, ...center());
        } else if (e.key === '-') {
            zoomAt(s / 1.1, ...center());
        }
    });

    const status = h('div', {class: 'muted small crop-status'},
        animated ? 'Animated GIF: it stays animated after cropping.' : `${nw} × ${nh} px`);
    const apply = h('button', {class: 'btn primary', type: 'button'}, 'Apply');
    const cancel = h('button', {class: 'btn', type: 'button'}, 'Cancel');
    const close = value => {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        done(value);
    };
    const onKey = e => {
        if (e.key === 'Escape' && !apply.disabled) close(null);
        if (e.key === 'Enter' && document.activeElement !== cancel && !apply.disabled) apply.click();
    };
    cancel.addEventListener('click', () => close(null));
    apply.addEventListener('click', async () => {
        apply.disabled = cancel.disabled = true;
        stage.classList.add('busy');
        const rect = {sx: (fx - x) / s, sy: (fy - y) / s, sw: fw / s, sh: fh / s};
        try {
            const result = animated ?
                await cropGif(file, img, rect, opts, msg => {
                    status.textContent = msg;
                }) :
                await cropStill(img, rect, opts);
            close(result);
        } catch (e) {
            document.removeEventListener('keydown', onKey);
            backdrop.remove();
            fail(e);
        }
    });

    const backdrop = h('div', {class: 'modal-backdrop'},
        h('div', {class: 'modal crop-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title},
            h('h2', {}, opts.title),
            h('p', {class: 'muted small', style: 'margin:-6px 0 12px'}, 'Drag to move, scroll or pinch to zoom. Double-click to reset.'),
            stage,
            h('div', {class: 'crop-controls'},
                h('span', {class: 'crop-zoom-icon', 'aria-hidden': 'true'}, '−'), zoom, h('span', {class: 'crop-zoom-icon', 'aria-hidden': 'true'}, '+')),
            h('div', {class: 'row', style: 'margin-top:14px'}, status, h('span', {class: 'spacer'}), cancel, apply)));
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    render();
    stage.focus();
}

// Output size: the requested size, but never upscaled past the cropped source pixels.
const outSize = ([w, hh], rect) => {
    const k = Math.min(1, rect.sw / w, rect.sh / hh);
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(hh * k))];
};

const canvasBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

async function cropStill (img, rect, opts) {
    const [w, hh] = outSize(opts.out, rect);
    const canvas = h('canvas', {width: w, height: hh});
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, hh);
    let blob = await canvasBlob(canvas, 'image/webp', 0.92);
    if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/png');
    if (blob.size > MAX_UPLOAD) blob = await canvasBlob(canvas, 'image/jpeg', 0.9);
    return {blob, animated: false};
}

async function cropGif (file, img, rect, opts, progress) {
    const full = rect.sx < 1 && rect.sy < 1 &&
        Math.abs(rect.sw - img.naturalWidth) < 1.5 && Math.abs(rect.sh - img.naturalHeight) < 1.5;
    // Untouched and already the right shape: keep the original file.
    if (full && file.size <= MAX_UPLOAD) return {blob: file, animated: true};
    if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported('image/gif'))) {
        if (file.size <= MAX_UPLOAD) return {blob: file, animated: true, uncropped: true};
        throw new Error('This browser can\'t crop GIFs and the GIF is over 8 MB. Try Chrome, Edge or Firefox.');
    }
    progress('Reading GIF…');
    const decoder = new ImageDecoder({data: await file.arrayBuffer(), type: 'image/gif'});
    await decoder.tracks.ready;
    await decoder.completed;
    const count = Math.min(decoder.tracks.selectedTrack.frameCount, 600);
    let [w, hh] = outSize(opts.gifOut || opts.out, rect);
    for (let attempt = 0; attempt < 4; attempt++) {
        const canvas = h('canvas', {width: w, height: hh});
        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.imageSmoothingQuality = 'high';
        const frames = [];
        for (let i = 0; i < count; i++) {
            if (i % 5 === 0) {
                progress(`Cropping frame ${i + 1} of ${count}…`);
                await new Promise(r => setTimeout(r));
            }
            const {image} = await decoder.decode({frameIndex: i});
            ctx.clearRect(0, 0, w, hh);
            ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, hh);
            const delay = image.duration ? Math.round(image.duration / 10000) : 10;
            image.close();
            frames.push({data: ctx.getImageData(0, 0, w, hh).data, delay});
        }
        progress('Encoding GIF…');
        await new Promise(r => setTimeout(r));
        const bytes = encodeGif(w, hh, frames);
        if (bytes.length <= MAX_UPLOAD) {
            decoder.close();
            return {blob: new Blob([bytes], {type: 'image/gif'}), animated: true};
        }
        // Too big for the server: shrink and try again.
        w = Math.max(32, Math.round(w * 0.72));
        hh = Math.max(16, Math.round(hh * 0.72));
    }
    decoder.close();
    throw new Error('That GIF is too long to fit in 8 MB, even when shrunk. Try a shorter one.');
}

// ---------- GIF encoder ----------
// One global palette (median cut over sampled pixels), frame differencing for opaque GIFs, LZW.

const TRANSPARENT = 255;

function buildPalette (frames) {
    const total = frames.reduce((n, f) => n + f.data.length / 4, 0);
    const step = Math.max(1, Math.floor(total / 120000));
    const samples = [];
    let k = 0;
    for (const f of frames) {
        const d = f.data;
        for (let i = 0; i < d.length; i += 4) {
            if (k++ % step || d[i + 3] < 128) continue;
            samples.push((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
    }
    if (!samples.length) samples.push(0);
    const boxes = [samples];
    const ch = (c, n) => (c >> (16 - 8 * n)) & 255;
    const range = box => {
        let best = 0;
        let bestN = 0;
        for (let n = 0; n < 3; n++) {
            let lo = 255;
            let hi = 0;
            for (const c of box) {
                const v = ch(c, n);
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            if (hi - lo > best) {
                best = hi - lo;
                bestN = n;
            }
        }
        return [best, bestN];
    };
    while (boxes.length < 255) {
        let pick = -1;
        let pickScore = 0;
        let pickN = 0;
        for (let b = 0; b < boxes.length; b++) {
            if (boxes[b].length < 2) continue;
            const [r, n] = range(boxes[b]);
            const score = r * Math.sqrt(boxes[b].length);
            if (r > 0 && score > pickScore) {
                pick = b;
                pickScore = score;
                pickN = n;
            }
        }
        if (pick < 0) break;
        const box = boxes[pick].sort((a, b) => ch(a, pickN) - ch(b, pickN));
        const mid = box.length >> 1;
        boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
    }
    return boxes.map(box => {
        let r = 0;
        let g = 0;
        let b = 0;
        for (const c of box) {
            r += (c >> 16) & 255;
            g += (c >> 8) & 255;
            b += c & 255;
        }
        const n = box.length;
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
}

function encodeGif (w, hh, frames) {
    const palette = buildPalette(frames);
    const cache = new Int16Array(32768).fill(-1);
    const nearest = (r, g, b) => {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let idx = cache[key];
        if (idx >= 0) return idx;
        let best = Infinity;
        for (let i = 0; i < palette.length; i++) {
            const p = palette[i];
            const dr = p[0] - r;
            const dg = p[1] - g;
            const db = p[2] - b;
            const dist = dr * dr * 2 + dg * dg * 3 + db * db;
            if (dist < best) {
                best = dist;
                idx = i;
            }
        }
        cache[key] = idx;
        return idx;
    };
    const quantize = data => {
        const out = new Uint8Array(w * hh);
        for (let i = 0, p = 0; p < out.length; i += 4, p++) {
            out[p] = data[i + 3] < 128 ? TRANSPARENT : nearest(data[i], data[i + 1], data[i + 2]);
        }
        return out;
    };
    const hasAlpha = frames.some(f => {
        for (let i = 3; i < f.data.length; i += 4) if (f.data[i] < 128) return true;
        return false;
    });

    const out = new ByteWriter();
    out.str('GIF89a');
    out.u16(w);
    out.u16(hh);
    out.byte(0xf7); // global color table, 8 bits
    out.byte(0);
    out.byte(0);
    for (let i = 0; i < 256; i++) {
        const p = palette[i] || [0, 0, 0];
        out.byte(p[0]);
        out.byte(p[1]);
        out.byte(p[2]);
    }
    if (frames.length > 1) {
        out.bytes([0x21, 0xff, 0x0b]);
        out.str('NETSCAPE2.0');
        out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]); // loop forever
    }

    let prev = null;
    let pending = null; // frame waiting for its delay to be final (identical frames are merged)
    const flush = () => {
        if (!pending) return;
        const {x0, y0, fw, fh, pixels, disposal, delay} = pending;
        out.bytes([0x21, 0xf9, 0x04, (disposal << 2) | 1]);
        out.u16(Math.max(2, delay));
        out.bytes([TRANSPARENT, 0x00]);
        out.byte(0x2c);
        out.u16(x0);
        out.u16(y0);
        out.u16(fw);
        out.u16(fh);
        out.byte(0);
        lzw(pixels, 8, out);
        pending = null;
    };
    for (const f of frames) {
        const idx = quantize(f.data);
        if (prev && !hasAlpha) {
            // Only the changed rectangle; unchanged pixels inside it are transparent.
            let minX = w;
            let minY = hh;
            let maxX = -1;
            let maxY = -1;
            for (let yy = 0, p = 0; yy < hh; yy++) {
                for (let xx = 0; xx < w; xx++, p++) {
                    if (idx[p] !== prev[p]) {
                        if (xx < minX) minX = xx;
                        if (xx > maxX) maxX = xx;
                        if (yy < minY) minY = yy;
                        if (yy > maxY) maxY = yy;
                    }
                }
            }
            if (maxX < 0) {
                pending.delay += f.delay;
                continue;
            }
            flush();
            const fw = maxX - minX + 1;
            const fh = maxY - minY + 1;
            const pixels = new Uint8Array(fw * fh);
            for (let yy = 0; yy < fh; yy++) {
                for (let xx = 0; xx < fw; xx++) {
                    const p = (yy + minY) * w + xx + minX;
                    pixels[yy * fw + xx] = idx[p] === prev[p] ? TRANSPARENT : idx[p];
                }
            }
            pending = {x0: minX, y0: minY, fw, fh, pixels, disposal: 1, delay: f.delay};
        } else {
            flush();
            pending = {x0: 0, y0: 0, fw: w, fh: hh, pixels: idx, disposal: hasAlpha ? 2 : 1, delay: f.delay};
        }
        prev = idx;
    }
    flush();
    out.byte(0x3b);
    return out.result();
}

function lzw (indices, minCodeSize, out) {
    out.byte(minCodeSize);
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;
    let codeSize = minCodeSize + 1;
    let next = eoi + 1;
    let dict = new Map();
    let buf = 0;
    let bits = 0;
    const block = new Uint8Array(255);
    let blockLen = 0;
    const pushByte = b => {
        block[blockLen++] = b;
        if (blockLen === 255) {
            out.byte(255);
            out.bytes(block);
            blockLen = 0;
        }
    };
    const emit = code => {
        buf |= code << bits;
        bits += codeSize;
        while (bits >= 8) {
            pushByte(buf & 255);
            buf >>>= 8;
            bits -= 8;
        }
    };
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        const found = dict.get(key);
        if (found !== undefined) {
            prefix = found;
            continue;
        }
        emit(prefix);
        if (next === 4096) {
            emit(clear);
            dict = new Map();
            codeSize = minCodeSize + 1;
            next = eoi + 1;
        } else {
            if (next >= (1 << codeSize)) codeSize++;
            dict.set(key, next++);
        }
        prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (bits > 0) pushByte(buf & 255);
    if (blockLen) {
        out.byte(blockLen);
        out.bytes(block.subarray(0, blockLen));
    }
    out.byte(0);
}

class ByteWriter {
    constructor () {
        this.buf = new Uint8Array(1 << 20);
        this.len = 0;
    }
    grow (n) {
        if (this.len + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.len + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
    byte (b) {
        this.grow(1);
        this.buf[this.len++] = b;
    }
    bytes (arr) {
        this.grow(arr.length);
        this.buf.set(arr, this.len);
        this.len += arr.length;
    }
    u16 (v) {
        this.byte(v & 255);
        this.byte((v >> 8) & 255);
    }
    str (s) {
        for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
    }
    result () {
        return this.buf.slice(0, this.len);
    }
}

export const _test = {encodeGif};
