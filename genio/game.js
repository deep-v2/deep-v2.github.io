/* ==========================================================================
   GENIO! — web remake of the PS4 homebrew (OpenOrbis)
   Direct port of genio/game.cpp: same rules, same 1920x1080 layout,
   same FNT1/SPR assets, same GNSV save format (stored in localStorage).
   ========================================================================== */
"use strict";

// ----------------------------------------------------------------------------
// Constants (must match game.cpp)
// ----------------------------------------------------------------------------
const GAME_W = 1920, GAME_H = 1080;
const NUM_VARIANTS = 10, NUM_TROPHIES = 5;
const ALL_VARIANTS = (1 << NUM_VARIANTS) - 1;
const ALL_TROPHIES = (1 << NUM_TROPHIES) - 1;
const TOAST_MS = 4500;

const SHOP_W = 1240, SHOP_H = 752;
const SHOP_X = (GAME_W - SHOP_W) / 2, SHOP_Y = 156;
const POP_W = 800, POP_H = 400;
const POP_X = (GAME_W - POP_W) / 2, POP_Y = (GAME_H - POP_H) / 2;

const MODE_MAIN = 0, MODE_SHOP = 1, MODE_POPUP = 2, MODE_TROPHIES = 3;
const ALIGN_L = 0, ALIGN_C = 1, ALIGN_R = 2;
const TINT_NONE = 0xFFFFFFFF;

const F_COUNTER = 0, F_TITLE = 1, F_BODY = 2, F_BTN = 3, F_SMALL = 4, F_NAME = 5;

const SFX_CLICK = 10, SFX_BUY = 11, SFX_TYPEWRITER = 12;

// order must match tools/prep_assets.py VARIANT_KEYS
const VARIANTS = [
  { name: "GENIO!",     price: 0,    mult: 1 },
  { name: "OAAA!",      price: 25,   mult: 2 },
  { name: "SUGOI!",     price: 100,  mult: 3 },
  { name: "BURRO!",     price: 250,  mult: 4 },
  { name: "PELOTUDO!",  price: 500,  mult: 5 },
  { name: "JUJEÑO!",    price: 800,  mult: 6 },
  { name: "IÑARANDU!",  price: 1100, mult: 7 },
  { name: "PRODIGIO!",  price: 1400, mult: 8 },
  { name: "EMINENCIA!", price: 1700, mult: 9 },
  { name: "GOD!",       price: 2000, mult: 10 },
];

const T_GEN100 = 0, T_GEN1000 = 1, T_GEN10000 = 2, T_FABRICA = 3, T_FOREVER = 4;
const TROPHIES = [
  { name: "GEN100!",           desc: "Llegar a los 100 GENIOs" },
  { name: "GEN1000!",          desc: "Llegar a los 1000 GENIOs" },
  { name: "GEN10000!",         desc: "Llegar a los 10000 GENIOs" },
  { name: "Fabrica de GENIOs", desc: "Comprar un GENIO!" },
  { name: "Forever a GENIO!",  desc: "Pasarse el juego al 100%." },
];

// mix level of every sound id (same as SFX_GAIN_PCT in main.cpp)
const SFX_GAIN = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 85, 55];
const MUSIC_GAIN = 3 / 2;   // the source file is quiet

// ----------------------------------------------------------------------------
// Canvas
// ----------------------------------------------------------------------------
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

function fitCanvas() {
  const s = Math.min(window.innerWidth / GAME_W, window.innerHeight / GAME_H);
  canvas.style.width = Math.round(GAME_W * s) + "px";
  canvas.style.height = Math.round(GAME_H * s) + "px";
}
window.addEventListener("resize", fitCanvas);
fitCanvas();

// ----------------------------------------------------------------------------
// Assets
// ----------------------------------------------------------------------------
const bg = new Array(NUM_VARIANTS).fill(null);      // equipped picture per variant
const spr = {};                                      // shopbtn, delbtn, buy_*, equip*, xglyph
const fonts = new Array(6).fill(null);               // parsed FNT1 atlases

function loadImage(url) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);                    // null -> grey fallback
    im.src = url;
  });
}

async function loadFont(idx) {
  const buf = await (await fetch(`fonts/font${idx}.fnt`)).arrayBuffer();
  const dv = new DataView(buf);
  const u32 = (o) => dv.getUint32(o, true);
  const i32 = (o) => dv.getInt32(o, true);
  if (u32(0) !== 0x31544E46 /* "FNT1" */) throw new Error(`font${idx}: bad magic`);

  const count = u32(8);
  const pool = 16 + count * 28;
  const glyphs = new Array(256).fill(null);
  for (let i = 0; i < count; i++) {
    const e = 16 + i * 28;
    const cp = u32(e);
    if (cp >= 256) continue;
    const adv = i32(e + 4), ox = i32(e + 8), oy = i32(e + 12);
    const w = u32(e + 16), h = u32(e + 20), off = u32(e + 24);
    let cvs = null;
    if (w && h) {
      cvs = document.createElement("canvas");
      cvs.width = w; cvs.height = h;
      cvs.__id = idx + ":" + cp;      // unique id for the tint cache
      const g = cvs.getContext("2d");
      const img = g.createImageData(w, h);
      img.data.set(new Uint8Array(buf, pool + off, w * h * 4));
      g.putImageData(img, 0, 0);
    }
    glyphs[cp] = { adv, ox, oy, w, h, cvs };
  }
  return glyphs;
}

// Tinted copies of a font (the C renderer replaces glyph RGB with a tint colour,
// keeping the glyph alpha). Cached per colour.
const tintCache = new Map();
function tintedGlyph(gl, tint) {
  if (!gl.cvs) return null;
  const key = tint + "|" + gl.cvs.__id;
  let hit = tintCache.get(key);
  if (hit) return hit;
  const cvs = document.createElement("canvas");
  cvs.width = gl.w; cvs.height = gl.h;
  const g = cvs.getContext("2d");
  g.drawImage(gl.cvs, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#" + tint.toString(16).padStart(6, "0");
  g.fillRect(0, 0, gl.w, gl.h);
  tintCache.set(key, cvs);
  return cvs;
}

// ----------------------------------------------------------------------------
// Text + sprite drawing (ports of drawText / drawSprite / drawPanel)
// ----------------------------------------------------------------------------
function textWidth(f, s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += f[cp > 255 ? 63 : cp].adv;
  }
  return w;
}

function drawText(f, s, x, baseline, align, tint) {
  if (align === ALIGN_C) x -= Math.floor(textWidth(f, s) / 2);
  else if (align === ALIGN_R) x -= textWidth(f, s);
  for (const ch of s) {
    let cp = ch.codePointAt(0);
    if (cp > 255) cp = 63;
    const gl = f[cp];
    if (gl.cvs) {
      const cvs = tint === TINT_NONE ? gl.cvs : tintedGlyph(gl, tint);
      ctx.drawImage(cvs, x + gl.ox, baseline + gl.oy);
    }
    x += gl.adv;
  }
}

function drawSprite(s, x, y) { if (s) ctx.drawImage(s, x, y); }

function drawPanel(x, y, w, h, border) {
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + border, y + border, w - 2 * border, h - 2 * border);
}

// ----------------------------------------------------------------------------
// Audio (ports the mixer thread in main.cpp: voices + looping music)
// ----------------------------------------------------------------------------
const AudioSys = {
  ctx: null, master: null, buffers: {}, voices: [], musicSrc: null,
  started: false, muted: false,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.loadAll();
  },

  async loadAll() {
    const files = {};
    for (let i = 0; i < NUM_VARIANTS; i++) files[i] = `audio/s${i}.mp3`;
    files[SFX_CLICK] = "audio/click.mp3";
    files[SFX_BUY] = "audio/buy.mp3";
    files[SFX_TYPEWRITER] = "audio/typewriter.mp3";
    for (const id of Object.keys(files)) {
      try {
        const ab = await (await fetch(files[id])).arrayBuffer();
        this.buffers[id] = await this.ctx.decodeAudioData(ab);
      } catch (e) { /* missing sound just stays silent, like on console */ }
    }
    try {
      const ab = await (await fetch("audio/music.ogg")).arrayBuffer();
      this.buffers.music = await this.ctx.decodeAudioData(ab);
      if (this.started) this.startMusic();
    } catch (e) { /* no music */ }
  },

  resume() {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state !== "running") this.ctx.resume();
    this.started = true;
    if (this.buffers.music && !this.musicSrc) this.startMusic();
  },

  startMusic() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.music;
    src.loop = true;                                  // seamless loop
    const g = this.ctx.createGain();
    g.gain.value = MUSIC_GAIN;
    src.connect(g).connect(this.master);
    src.start();
    this.musicSrc = src;
  },

  play(snd) {
    if (!this.ctx || !this.buffers[snd]) return;
    // typewriter retriggers instead of stacking (same as main.cpp)
    if (snd === SFX_TYPEWRITER)
      for (const v of this.voices)
        if (v.snd === snd) { try { v.src.stop(); } catch (e) {} }
    // all busy: steal the oldest
    while (this.voices.length >= 16) {
      const old = this.voices.shift();
      try { old.src.stop(); } catch (e) {}
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[snd];
    const g = this.ctx.createGain();
    g.gain.value = SFX_GAIN[snd] / 100;
    src.connect(g).connect(this.master);
    src.start();
    const v = { snd, src };
    this.voices.push(v);
    src.onended = () => { this.voices = this.voices.filter((x) => x !== v); };
  },

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
  },
};

document.addEventListener("visibilitychange", () => {
  if (!AudioSys.ctx) return;
  if (document.hidden) AudioSys.ctx.suspend();
  else if (AudioSys.started) AudioSys.ctx.resume();
});

// ----------------------------------------------------------------------------
// Save (same 40-byte GNSV binary format + CRC32 as game.cpp, in localStorage)
// ----------------------------------------------------------------------------
const SAVE_KEY = "genio-save";
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ----------------------------------------------------------------------------
// Game state (port of struct Game + rules)
// ----------------------------------------------------------------------------
const G = {
  points: 0, total: 0, owned: 1, equipped: 0, trophies: 0,
  mode: MODE_MAIN, shopIdx: 0, popupSel: 1,
  toastQueue: [], toastCur: -1, toastEnd: 0,
  saveDirty: false, saveNow: false, lastSave: 0,
};

function loadSave() {
  let ok = false;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const bin = atob(raw);
      if (bin.length === 40) {
        const b = new Uint8Array(40);
        for (let i = 0; i < 40; i++) b[i] = bin.charCodeAt(i);
        const dv = new DataView(b.buffer);
        if (dv.getUint32(0, true) === 0x56534E47 /* 'GNSV' */ && dv.getUint32(4, true) === 1 &&
            crc32(b.subarray(0, 36)) === dv.getUint32(36, true)) {
          G.points = Number(dv.getBigUint64(8, true));
          G.total = Number(dv.getBigUint64(16, true));
          G.owned = dv.getUint32(24, true);
          G.equipped = dv.getUint32(28, true);
          G.trophies = dv.getUint32(32, true);
          ok = true;
        }
      }
    }
  } catch (e) { /* private mode etc: in-memory save only */ }

  if (!ok) { G.points = 0; G.total = 0; G.owned = 1; G.equipped = 0; G.trophies = 0; }
  G.owned |= 1;
  G.owned &= ALL_VARIANTS;
  G.trophies &= ALL_TROPHIES;
  if (G.equipped >= NUM_VARIANTS || !((G.owned >>> G.equipped) & 1)) G.equipped = 0;
  if (G.total < G.points) G.total = G.points;
}

function writeSave() {
  try {
    const b = new Uint8Array(40);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x56534E47, true);
    dv.setUint32(4, 1, true);
    dv.setBigUint64(8, BigInt(G.points), true);
    dv.setBigUint64(16, BigInt(G.total), true);
    dv.setUint32(24, G.owned >>> 0, true);
    dv.setUint32(28, G.equipped >>> 0, true);
    dv.setUint32(32, G.trophies >>> 0, true);
    dv.setUint32(36, crc32(b.subarray(0, 36)), true);
    let s = "";
    for (let i = 0; i < 40; i++) s += String.fromCharCode(b[i]);
    localStorage.setItem(SAVE_KEY, btoa(s));
  } catch (e) { /* storage full / blocked: keep playing */ }
}

function emit(s) { AudioSys.play(s); }

function unlockTrophy(t) {
  if (G.trophies & (1 << t)) return;
  G.trophies |= 1 << t;
  if (G.toastQueue.length < 8) G.toastQueue.push(t);
  G.saveNow = true;
}

function checkTrophies() {
  if (G.total >= 100) unlockTrophy(T_GEN100);
  if (G.total >= 1000) unlockTrophy(T_GEN1000);
  if (G.total >= 10000) unlockTrophy(T_GEN10000);
  if (G.owned & ~1) unlockTrophy(T_FABRICA);
  // "Forever a GENIO!": every variant bought + every other trophy earned.
  if ((G.owned & ALL_VARIANTS) === ALL_VARIANTS &&
      (G.trophies & (ALL_TROPHIES & ~(1 << T_FOREVER))) === (ALL_TROPHIES & ~(1 << T_FOREVER)))
    unlockTrophy(T_FOREVER);
}

function doClick() {
  const gain = VARIANTS[G.equipped].mult;
  G.points += gain;
  G.total += gain;
  emit(G.equipped);             // voices are sound ids 0..9
  G.saveDirty = true;
  checkTrophies();
}

function shopAction() {
  const i = G.shopIdx;
  emit(SFX_CLICK);
  if (!((G.owned >>> i) & 1)) {
    if (G.points >= VARIANTS[i].price) {
      G.points -= VARIANTS[i].price;
      G.owned |= 1 << i;
      emit(SFX_BUY);
      G.saveNow = true;
      checkTrophies();
    }
  } else if (G.equipped !== i) {
    G.equipped = i;
    G.saveNow = true;
  }
}

function resetSave() {
  G.points = 0;
  G.total = 0;
  G.owned = 1;
  G.equipped = 0;
  G.shopIdx = 0;
  G.saveNow = true;                       // trophies are deliberately kept
}

function update(now) {
  // trophy toasts
  if (G.toastCur >= 0 && now >= G.toastEnd) G.toastCur = -1;
  if (G.toastCur < 0 && G.toastQueue.length > 0) {
    G.toastCur = G.toastQueue.shift();
    G.toastEnd = now + TOAST_MS;
  }

  // saving: immediately for purchases/equips/trophies/reset, at most every 500 ms for clicks
  if (G.saveNow || (G.saveDirty && now - G.lastSave >= 500)) {
    writeSave();
    G.saveNow = G.saveDirty = false;
    G.lastSave = now;
  }
}

// One poll worth of input edges (like struct Input)
const pending = { x: false, square: false, triangle: false, options: false, navX: 0, navY: 0 };

function applyInput(now) {
  // copy the edges into a fresh struct, like pollInput() returning an Input by value
  const inE = { x: pending.x, square: pending.square, triangle: pending.triangle, options: pending.options, navX: pending.navX, navY: pending.navY };
  pending.x = pending.square = pending.triangle = pending.options = false;
  pending.navX = pending.navY = 0;

  switch (G.mode) {
    case MODE_MAIN:
      if (inE.square) { G.mode = MODE_SHOP; G.shopIdx = G.equipped; }
      else if (inE.triangle) { G.mode = MODE_POPUP; G.popupSel = 1; }
      else if (inE.options) G.mode = MODE_TROPHIES;
      else if (inE.x) doClick();
      break;

    case MODE_SHOP:
      if (inE.square) G.mode = MODE_MAIN;
      else if (inE.navX !== 0) {
        G.shopIdx = (G.shopIdx + (inE.navX > 0 ? 1 : NUM_VARIANTS - 1)) % NUM_VARIANTS;
        emit(SFX_TYPEWRITER);
      }
      else if (inE.x) shopAction();
      break;

    case MODE_POPUP:
      if (inE.triangle) G.mode = MODE_MAIN;
      else if (inE.navX !== 0 || inE.navY !== 0) {
        if (inE.navX < 0) G.popupSel = 0;
        else if (inE.navX > 0) G.popupSel = 1;
        else G.popupSel ^= 1;
      }
      else if (inE.x) {
        emit(SFX_CLICK);
        if (G.popupSel === 0) resetSave();
        G.mode = MODE_MAIN;
      }
      break;

    case MODE_TROPHIES:
      if (inE.options) G.mode = MODE_MAIN;
      break;
  }
  update(now);
}

function confirmPopup(sel) {          // clicking Si/No selects and confirms
  G.popupSel = sel;
  emit(SFX_CLICK);
  if (sel === 0) resetSave();
  G.mode = MODE_MAIN;
}

// ----------------------------------------------------------------------------
// Rendering (ports Game::render + drawShop/drawPopup/drawTrophies/drawToast)
// ----------------------------------------------------------------------------
function drawShop() {
  const px = SHOP_X, py = SHOP_Y;
  const v = VARIANTS[G.shopIdx];
  drawPanel(px, py, SHOP_W, SHOP_H, 14);

  drawText(fonts[F_TITLE], v.name, GAME_W / 2, py + 112, ALIGN_C, TINT_NONE);

  // page arrows
  drawText(fonts[F_TITLE], "<", px + 70, py + 130 + 210 + 28, ALIGN_C, TINT_NONE);
  drawText(fonts[F_TITLE], ">", px + SHOP_W - 70, py + 130 + 210 + 28, ALIGN_C, TINT_NONE);

  // picture in a black frame
  const bx = px + (SHOP_W - 736) / 2, by = py + 130;
  ctx.fillStyle = "#000";
  ctx.fillRect(bx, by, 736, 421);
  if (bg[G.shopIdx]) ctx.drawImage(bg[G.shopIdx], bx + 8, by + 8, 720, 405);
  else { ctx.fillStyle = "#C0C0C0"; ctx.fillRect(bx + 8, by + 8, 720, 405); }

  const line = v.price === 0
    ? `Price: Free | Multi: ${v.mult} Click`
    : `Price: ${v.price} Clicks | Multi: ${v.mult} ${v.mult === 1 ? "Click" : "Clicks"}`;
  drawText(fonts[F_BODY], line, GAME_W / 2, py + 605, ALIGN_C, TINT_NONE);

  const own = (G.owned >>> G.shopIdx) & 1;
  let btn;
  if (!own) btn = G.points >= v.price ? spr.buy_on : spr.buy_off;
  else if (G.equipped === G.shopIdx) btn = spr.equipped;
  else btn = spr.equip_on;
  if (btn) drawSprite(btn, GAME_W / 2 - btn.width / 2, py + 632);
}

function drawPopup() {
  drawPanel(POP_X, POP_Y, POP_W, POP_H, 14);
  drawText(fonts[F_TITLE], "Seguro?", GAME_W / 2, POP_Y + 140, ALIGN_C, TINT_NONE);

  const bw = 260, bh = 100, gap = 60;
  const x0 = POP_X + (POP_W - (2 * bw + gap)) / 2, by = POP_Y + 215;
  const labels = ["Si", "No"];
  for (let i = 0; i < 2; i++) {
    const bx = x0 + i * (bw + gap);
    const sel = G.popupSel === i;
    if (sel) {
      ctx.fillStyle = "#000";
      ctx.fillRect(bx, by, bw, bh);
      drawText(fonts[F_BTN], labels[i], bx + bw / 2, by + bh / 2 + 23, ALIGN_C, 0xFFFFFF);
    } else {
      drawPanel(bx, by, bw, bh, 10);
      drawText(fonts[F_BTN], labels[i], bx + bw / 2, by + bh / 2 + 23, ALIGN_C, TINT_NONE);
    }
    if (sel) drawSprite(spr.xglyph, bx - 24, by - 24);
  }
}

function drawTrophies() {
  const px = SHOP_X, py = SHOP_Y;
  drawPanel(px, py, SHOP_W, SHOP_H, 14);
  drawText(fonts[F_TITLE], "Trofeos", GAME_W / 2, py + 112, ALIGN_C, TINT_NONE);

  for (let i = 0; i < NUM_TROPHIES; i++) {
    const top = py + 150 + i * 112;
    const got = (G.trophies >> i) & 1;
    const col = got ? 0x000000 : 0x8C8C8C;
    drawText(fonts[F_NAME], TROPHIES[i].name, px + 60, top + 50, ALIGN_L, col);
    drawText(fonts[F_SMALL], TROPHIES[i].desc, px + 60, top + 90, ALIGN_L, col);
    drawText(fonts[F_SMALL], got ? "Desbloqueado" : "Bloqueado", px + SHOP_W - 60, top + 70, ALIGN_R, col);
    if (i < NUM_TROPHIES - 1) {
      ctx.fillStyle = "#000";
      ctx.fillRect(px + 40, top + 104, SHOP_W - 80, 4);
    }
  }
}

function drawToast() {
  // Sits just below the shop/trophy panels so it never covers their buttons.
  const w = 900, h = 148, x = (GAME_W - w) / 2, y = GAME_H - h - 14;
  drawPanel(x, y, w, h, 8);
  drawText(fonts[F_SMALL], "¡Trofeo desbloqueado!", GAME_W / 2, y + 38, ALIGN_C, 0x8C8C8C);
  drawText(fonts[F_NAME], TROPHIES[G.toastCur].name, GAME_W / 2, y + 86, ALIGN_C, TINT_NONE);
  drawText(fonts[F_SMALL], TROPHIES[G.toastCur].desc, GAME_W / 2, y + 126, ALIGN_C, TINT_NONE);
}

function render() {
  const back = bg[G.equipped];
  if (back) ctx.drawImage(back, 0, 0, GAME_W, GAME_H);
  else { ctx.fillStyle = "#C0C0C0"; ctx.fillRect(0, 0, GAME_W, GAME_H); }

  // top row: delete-save button (left), counter (center), shop button (right)
  drawSprite(spr.delbtn, 30, 24);
  if (spr.shopbtn) drawSprite(spr.shopbtn, GAME_W - 30 - spr.shopbtn.width, 24);
  drawText(fonts[F_COUNTER], String(G.points), GAME_W / 2, 140, ALIGN_C, TINT_NONE);

  if (G.mode === MODE_SHOP) drawShop();
  else if (G.mode === MODE_POPUP) drawPopup();
  else if (G.mode === MODE_TROPHIES) drawTrophies();

  if (G.toastCur >= 0) drawToast();
}

// ----------------------------------------------------------------------------
// Pointer / touch input (maps clicks onto the controller edges of the original)
// ----------------------------------------------------------------------------
function toGame(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width * GAME_W,
    y: (e.clientY - r.top) / r.height * GAME_H,
  };
}
const inRect = (p, x, y, w, h) => p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;

const hint = document.getElementById("hint");

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  AudioSys.resume();
  if (hint) hint.classList.add("gone");
  const p = toGame(e);

  switch (G.mode) {
    case MODE_MAIN:
      if (spr.shopbtn && inRect(p, GAME_W - 30 - spr.shopbtn.width, 24, spr.shopbtn.width, spr.shopbtn.height))
        pending.square = true;                       // shop button = Square
      else if (spr.delbtn && inRect(p, 30, 24, spr.delbtn.width, spr.delbtn.height))
        pending.triangle = true;                     // delete-save button = Triangle
      else
        pending.x = true;                            // click anywhere = X
      break;

    case MODE_SHOP:
      if (inRect(p, SHOP_X + 20, SHOP_Y + 300, 100, 140)) pending.navX = -1;
      else if (inRect(p, SHOP_X + SHOP_W - 120, SHOP_Y + 300, 100, 140)) pending.navX = 1;
      else if (!inRect(p, SHOP_X, SHOP_Y, SHOP_W, SHOP_H)) pending.square = true;  // outside = close
      else pending.x = true;                                                    // panel = X
      break;

    case MODE_POPUP: {
      const bw = 260, bh = 100, gap = 60;
      const x0 = POP_X + (POP_W - (2 * bw + gap)) / 2, by = POP_Y + 215;
      if (inRect(p, x0, by, bw, bh)) confirmPopup(0);            // Si
      else if (inRect(p, x0 + bw + gap, by, bw, bh)) confirmPopup(1);  // No
      else if (!inRect(p, POP_X, POP_Y, POP_W, POP_H)) pending.triangle = true;  // outside = cancel
      break;
    }

    case MODE_TROPHIES:
      if (!inRect(p, SHOP_X, SHOP_Y, SHOP_W, SHOP_H)) pending.options = true;
      break;
  }
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ----------------------------------------------------------------------------
// Keyboard input (S/T/O = Square/Triangle/Options, arrows = d-pad)
// ----------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  switch (e.code) {
    case "Space": case "Enter": case "KeyX": pending.x = true; break;
    case "KeyS": pending.square = true; break;
    case "KeyT": pending.triangle = true; break;
    case "KeyO": pending.options = true; break;
    case "ArrowLeft": pending.navX = -1; break;
    case "ArrowRight": pending.navX = 1; break;
    case "ArrowUp": pending.navY = -1; break;
    case "ArrowDown": pending.navY = 1; break;
    case "Escape":
      if (G.mode === MODE_SHOP) pending.square = true;
      else if (G.mode === MODE_POPUP) pending.triangle = true;
      else if (G.mode === MODE_TROPHIES) pending.options = true;
      break;
    case "KeyM": AudioSys.toggleMute(); return;
    default: return;
  }
  e.preventDefault();
  AudioSys.resume();
  if (hint) hint.classList.add("gone");
});

// ----------------------------------------------------------------------------
// Gamepad input (DualShock 4 / DualSense through the Gamepad API)
// ----------------------------------------------------------------------------
const padPrev = [];
const padZone = [];

function stickZone(prev, v) {          // same hysteresis as main.cpp
  if (prev < 0 && v <= -0.11) return -1;
  if (prev > 0 && v >= 0.11) return 1;
  if (v <= -0.25) return -1;
  if (v >= 0.25) return 1;
  return 0;
}

function pollPads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = 0; i < pads.length; i++) {
    const gp = pads[i];
    if (!gp) continue;
    if (!padPrev[i]) { padPrev[i] = 0; padZone[i] = [0, 0]; }
    const cur = gp.buttons.reduce((m, b, j) => m | (b.pressed ? (1 << j) : 0), 0);
    const e = cur & ~padPrev[i];

    if (e & (1 << 0)) pending.x = true;           // Cross
    if (e & (1 << 2)) pending.square = true;      // Square
    if (e & (1 << 3)) pending.triangle = true;    // Triangle
    if (e & (1 << 9)) pending.options = true;     // Options
    if (e & (1 << 12)) pending.navY = -1;         // d-pad
    if (e & (1 << 13)) pending.navY = 1;
    if (e & (1 << 14)) pending.navX = -1;
    if (e & (1 << 15)) pending.navX = 1;

    const zx = stickZone(padZone[i][0], gp.axes[0] || 0);   // left stick
    const zy = stickZone(padZone[i][1], gp.axes[1] || 0);
    if (zx !== 0 && zx !== padZone[i][0]) pending.navX = zx;
    if (zy !== 0 && zy !== padZone[i][1]) pending.navY = zy;
    padZone[i] = [zx, zy];
    padPrev[i] = cur;

    if (e) { AudioSys.resume(); if (hint) hint.classList.add("gone"); }
  }
}

// ----------------------------------------------------------------------------
// Boot: loading screen, then the main loop
// ----------------------------------------------------------------------------
function drawLoading(pct) {
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, GAME_W, GAME_H);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 90px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("GENIO!", GAME_W / 2, GAME_H / 2 - 40);
  ctx.font = "28px system-ui, sans-serif";
  ctx.fillText("cargando… " + Math.round(pct * 100) + "%", GAME_W / 2, GAME_H / 2 + 30);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.strokeRect(GAME_W / 2 - 250, GAME_H / 2 + 70, 500, 26);
  ctx.fillRect(GAME_W / 2 - 247, GAME_H / 2 + 73, 494 * pct, 20);
}

async function boot() {
  drawLoading(0);

  const jobs = [];
  let done = 0, total = 0;
  const track = (p) => { total++; jobs.push(p.then((r) => { done++; drawLoading(done / total); return r; })); return p; };

  for (let i = 0; i < NUM_VARIANTS; i++)
    track(loadImage(`img/v${i}.webp`).then((im) => { bg[i] = im; }));
  for (const n of ["shopbtn", "delbtn", "buy_on", "buy_off", "equip_on", "equipped", "xglyph"])
    track(loadImage(`img/${n}.png`).then((im) => { spr[n] = im; }));
  for (let i = 0; i < 6; i++)
    track(loadFont(i).then((f) => { fonts[i] = f; }));
  await Promise.all(jobs);

  loadSave();
  G.shopIdx = G.equipped;

  // main loop: input edges -> update -> render
  function frame(now) {
    pollPads();
    applyInput(now);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
