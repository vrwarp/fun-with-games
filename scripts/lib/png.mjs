/**
 * A minimal PNG encoder (8-bit RGBA, no interlacing).
 *
 * Exists so app icons can be *generated* rather than committed as opaque
 * binaries. An icon in a diff is a thing no reviewer can check; a function
 * that draws one is. It also means re-running the generator produces
 * byte-identical output, which CI asserts.
 *
 * Node's zlib does the compression; everything else here is chunk framing.
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * CRC-32, implemented here rather than taken from `zlib.crc32` because that
 * helper is a relatively recent addition and this file is not worth a Node
 * version floor.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encodes raw RGBA bytes (`width * height * 4`) as a PNG.
 *
 * Every scanline gets filter type 0 (None). Smarter filters would compress
 * better, but these are flat-colour icons a few kilobytes in size.
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Rasterizes an icon by sampling `shade(x, y)` per pixel, where both are in
 * normalized [-1, 1] coordinates with the origin at the centre.
 *
 * `shade` returns `[r, g, b, a]` with components in 0..255.
 */
export function drawIcon(size, shade) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1;
      const y = ((py + 0.5) / size) * 2 - 1;
      const [r, g, b, a] = shade(x, y);
      const offset = (py * size + px) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }
  return encodePng(size, size, rgba);
}
