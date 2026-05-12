/**
 * Generate build/icon.ico from resources/icon.png.
 *
 * Style: rounded white plate with subtle drop shadow + 1px hairline border,
 * figure inset 12% so it never touches the corners. The plate reads as a
 * modern app icon at all Windows shell sizes (16/32/48/64/128/256).
 *
 * Run after changing resources/icon.png:  node scripts/build-icon.mjs
 */

import { writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import toIco from 'to-ico';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'resources/icon.png');
const OUT_ICO = resolve(ROOT, 'build/icon.ico');
const OUT_PNG = resolve(ROOT, 'build/icon.png');

const SIZES = [16, 32, 48, 64, 128, 256];
const PNG_SIZE = 1024; // for Linux AppImage / macOS auto-generated .icns
const PAD_RATIO = 0.12;
const RADIUS_RATIO = 0.19;

function plateSvg(size) {
  const r = Math.max(2, Math.round(size * RADIUS_RATIO));
  const inset = Math.max(1, Math.round(size * 0.015));
  const blur = Math.max(0.6, size * 0.012);
  const w = size - 2 * inset;
  return Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>
      <defs>
        <filter id='s' x='-10%' y='-10%' width='120%' height='120%'>
          <feGaussianBlur stdDeviation='${blur}' />
          <feOffset dx='0' dy='${inset}' result='off' />
          <feFlood flood-color='#000' flood-opacity='0.18' />
          <feComposite in2='off' operator='in' />
        </filter>
      </defs>
      <rect x='${inset + 1}' y='${inset}' width='${w - 2}' height='${w - 2}' rx='${r}' ry='${r}' fill='#000' filter='url(#s)' opacity='0.4'/>
      <rect x='${inset}' y='${inset}' width='${w}' height='${w}' rx='${r}' ry='${r}' fill='#ffffff' stroke='#e5e7eb' stroke-width='1'/>
    </svg>`
  );
}

mkdirSync(dirname(OUT_ICO), { recursive: true });

async function composeAtSize(size) {
  const inset = Math.round(size * PAD_RATIO);
  const inner = size - inset * 2;
  const figure = await sharp(SRC)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const plate = await sharp(plateSvg(size)).png().toBuffer();
  return sharp(plate)
    .composite([{ input: figure, top: inset, left: inset }])
    .png()
    .toBuffer();
}

const buffers = [];
for (const s of SIZES) {
  buffers.push(await composeAtSize(s));
}

writeFileSync(OUT_ICO, await toIco(buffers));
console.log(`build/icon.ico written (${statSync(OUT_ICO).size} bytes, ${SIZES.length} sizes)`);

writeFileSync(OUT_PNG, await composeAtSize(PNG_SIZE));
console.log(`build/icon.png written (${statSync(OUT_PNG).size} bytes, ${PNG_SIZE}x${PNG_SIZE})`);
