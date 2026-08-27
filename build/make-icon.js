'use strict';
// Генерирует assets/icon.png (256×256) и assets/icon.ico без зависимостей:
// фигуры считаются попиксельно (SDF + суперсэмплинг), PNG кодируется руками
// через zlib. Хочешь свою иконку — просто замени assets/icon.ico.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');
const S = 256;   // итоговый размер
const SS = 4;    // суперсэмплинг

// SDF скруглённого прямоугольника (центр cx,cy; полуразмеры hw,hh; радиус r)
function rrect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function inTri(x, y, p1, p2, p3) {
  const s = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const b1 = s(p1, p2) < 0, b2 = s(p2, p3) < 0, b3 = s(p3, p1) < 0;
  return b1 === b2 && b2 === b3;
}

const AMBER = [255, 180, 84, 255];
const DARK = [34, 28, 20, 255];
const LIGHT = [255, 243, 224, 255];

// координаты в системе 64×64 (масштабируются), как в public/favicon.svg
function colorAt(x, y) {
  const u = x * 64, v = y * 64;
  let c = null;
  if (rrect(u, v, 32, 32, 30, 30, 14) <= 0) c = AMBER;
  if (!c) return null;
  // большой тёмный пузырь: прямоугольник + хвост вниз-влево
  const big = rrect(u, v, 26, 27.5, 17, 11.5, 6) <= 0 || inTri(u, v, [17, 37], [25, 37], [17, 46]);
  if (big) c = DARK;
  // малый светлый пузырь с тёмной обводкой, хвост вниз-вправо
  const smallD = rrect(u, v, 44.5, 40.5, 12, 8.5, 5);
  const smallTail = inTri(u, v, [45, 47], [52, 47], [52, 55]);
  if (smallD <= 2.2 || smallTail) c = DARK;      // обводка/хвост
  if (smallD <= -0.3) c = LIGHT;                  // заливка
  if (smallTail && rrect(u, v, 48.5, 49, 3.4, 3.2, 1) <= 0) c = LIGHT;
  return c;
}

function render() {
  const img = Buffer.alloc(S * S * 4);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) / S, (py + (sy + 0.5) / SS) / S);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
        }
      }
      const n = SS * SS, i = (py * S + px) * 4;
      const alpha = a / n;
      // премультипликации PNG не требует; усредняем цвет по покрытым сэмплам
      const cov = a > 0 ? a / 255 : 1;
      img[i] = Math.round(r / cov);
      img[i + 1] = Math.round(g / cov);
      img[i + 2] = Math.round(b / cov);
      img[i + 3] = Math.round(alpha);
    }
  }
  return img;
}

// --- PNG ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO (одна PNG-запись 256×256 — Windows сам масштабирует) ---
function encodeIco(png) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // тип: icon
  header.writeUInt16LE(1, 4); // записей
  header[6] = 0;  // 256
  header[7] = 0;  // 256
  header[8] = 0;  // палитра
  header[9] = 0;
  header.writeUInt16LE(1, 10);  // planes
  header.writeUInt16LE(32, 12); // bpp
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // offset
  return Buffer.concat([header, png]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const rgba = render();
const png = encodePng(rgba, S, S);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(png));
console.log('assets/icon.png + assets/icon.ico готовы');
