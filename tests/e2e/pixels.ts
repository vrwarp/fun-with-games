import { inflateSync } from 'node:zlib';

/**
 * A just-enough PNG decoder for asserting on screenshots.
 *
 * Playwright's screenshots are 8-bit RGB(A) PNGs, and the assertions that need
 * them are of the form "this patch of the frame is not black" — a question a
 * golden-image comparison answers far too brittly on a software rasteriser,
 * where every antialiased edge wobbles run to run. Decoding the pixels and
 * averaging a region is stable against all of that, and needs no dependency:
 * a PNG is zlib-inflated scanlines behind one of five per-line filters.
 */
export function decodePng(buffer: Buffer): { width: number; height: number; data: Buffer } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colourType = data[9] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    raw.copy(current, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (current[i - channels] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0;
      let value = current[i] ?? 0;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels >= 3) {
        out[d] = current[s] ?? 0;
        out[d + 1] = current[s + 1] ?? 0;
        out[d + 2] = current[s + 2] ?? 0;
        out[d + 3] = channels === 4 ? (current[s + 3] ?? 0) : 255;
      } else {
        const grey = current[s] ?? 0;
        out[d] = out[d + 1] = out[d + 2] = grey;
        out[d + 3] = channels === 2 ? (current[s + 1] ?? 0) : 255;
      }
    }
    current.copy(previous);
  }
  return { width, height, data: out };
}

/**
 * Mean RGB level of a rectangular region, 0-255. The region is given in
 * fractions of the frame so the same assertion holds at any viewport size.
 */
export function regionLevel(
  screenshot: Buffer,
  region: { left: number; top: number; right: number; bottom: number },
): number {
  const png = decodePng(screenshot);
  const x0 = Math.floor(region.left * png.width);
  const x1 = Math.ceil(region.right * png.width);
  const y0 = Math.floor(region.top * png.height);
  const y1 = Math.ceil(region.bottom * png.height);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      sum += ((png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0)) / 3;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}
