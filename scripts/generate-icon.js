'use strict';

// The production icon is an authored 1024px asset in assets/icon.png. Keep this
// guard instead of embedding a stale placeholder that can silently overwrite it.
//
// It also derives the sidebar's brand mark from that same file, so the app has
// one mark and not two that drift. `assets/` is a build-time input and
// is absent from package.json's `files`, so the renderer cannot reference it at
// runtime; the derived copy lives under `src/` and ships with the existing
// `src/**/*` glob.
//
// The derivation lifts the hanger off its plate and recolours it white, so the
// mark can follow the app's own theme instead of carrying the icon's background
// into the sidebar. Done by hand against `zlib` rather than with an image
// library: the source is the simplest PNG there is (8-bit truecolour, no alpha,
// no interlacing) and this script must run with nothing installed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OUT_SIZE = 128;

// Two tests, both needed. Brightness separates the mark from the near-black
// plate; the hue test drops the plate's rim highlight, which is just as bright
// as the mark but neutral gray, where the mark is teal. Partial alpha between
// the thresholds is what keeps the artwork's anti-aliased edges.
const INK_MIN = 45;
const INK_FULL = 200;
const INK_HUE = 25;   // green minus red

/** Decode an 8-bit non-interlaced truecolour PNG into { width, height, rgb }. */
function decodeRgbPng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');

  let width = 0, height = 0;
  const idat = [];
  for (let pos = 8; pos < buf.length; ) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colour !== 2 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth=${depth} colour=${colour} interlace=${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 3;
  const stride = width * bpp;
  const rgb = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rgb[y * stride + x - bpp] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rgb[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter}`);
      }
      rgb[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, rgb };
}

/** Encode an 8-bit RGBA image, one unfiltered scanline at a time. */
function encodeRgbaPng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconPath = path.resolve(__dirname, '..', 'assets', 'icon.png');
if (!fs.existsSync(iconPath)) {
  console.error(`Missing CliHanger icon: ${iconPath}`);
  process.exit(1);
}

const { width, height, rgb } = decodeRgbPng(fs.readFileSync(iconPath));

// Alpha map of the ink alone. Colour is dropped here — the mark is painted a
// flat white, so only coverage carries over from the artwork.
const alpha = new Float64Array(width * height);
let minX = width, minY = height, maxX = -1, maxY = -1;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    const v = Math.max(r, g, b);
    if (v <= INK_MIN || g - r <= INK_HUE) continue;
    alpha[y * width + x] = Math.min(1, (v - INK_MIN) / (INK_FULL - INK_MIN));
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
if (maxX < 0) {
  console.error('No ink found in the icon — the thresholds no longer match the artwork.');
  process.exit(1);
}

// Square the crop around the mark and add a little breathing room, so the glyph
// sits in its box the way the other sidebar icons do.
const side = Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 1.06);
const originX = Math.round((minX + maxX + 1 - side) / 2);
const originY = Math.round((minY + maxY + 1 - side) / 2);

// Area-average down to OUT_SIZE. An exact box filter, not point sampling: at
// ~6.3 source pixels per output pixel, dropping the rest would shred the
// hairline strokes of the `>_`.
const rgba = Buffer.alloc(OUT_SIZE * OUT_SIZE * 4);
const scale = side / OUT_SIZE;
for (let oy = 0; oy < OUT_SIZE; oy++) {
  for (let ox = 0; ox < OUT_SIZE; ox++) {
    let sum = 0, weight = 0;
    const y0 = originY + oy * scale, y1 = y0 + scale;
    const x0 = originX + ox * scale, x1 = x0 + scale;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
      for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
        weight += w;
        if (sy < 0 || sy >= height || sx < 0 || sx >= width) continue;
        sum += alpha[sy * width + sx] * w;
      }
    }
    const o = (oy * OUT_SIZE + ox) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
    rgba[o + 3] = Math.round(Math.min(1, weight ? sum / weight : 0) * 255);
  }
}

const markPath = path.resolve(__dirname, '..', 'src', 'renderer', 'brand-mark.png');
fs.writeFileSync(markPath, encodeRgbaPng(OUT_SIZE, OUT_SIZE, rgba));

console.log(`CliHanger icon is ready: ${iconPath}`);
console.log(`Sidebar brand mark regenerated: ${markPath}`);
