// Minimal, dependency-free animated GIF encoder (GIF89a + LZW + NETSCAPE loop).
// Global palette built by median-cut over sampled pixels. Good enough for
// brand-consistent, limited-palette marketing clips.

function buildPalette(frames, maxColors) {
  // Collect a sample of unique-ish colors (downsample for speed).
  const buckets = [];
  const step = 4 * Math.max(1, Math.floor(frames.length * frames[0].width * frames[0].height / 120000));
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += step) {
      buckets.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  // Median cut.
  let boxes = [buckets];
  while (boxes.length < maxColors) {
    // pick box with largest range to split
    let bi = -1, bestRange = -1, bestCh = 0;
    for (let k = 0; k < boxes.length; k++) {
      const b = boxes[k];
      if (b.length < 2) continue;
      for (let ch = 0; ch < 3; ch++) {
        let mn = 255, mx = 0;
        for (const c of b) { if (c[ch] < mn) mn = c[ch]; if (c[ch] > mx) mx = c[ch]; }
        const r = mx - mn;
        if (r > bestRange) { bestRange = r; bi = k; bestCh = ch; }
      }
    }
    if (bi < 0 || bestRange <= 0) break;
    const box = boxes[bi];
    box.sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  const palette = boxes.map(b => {
    const n = b.length || 1;
    let r = 0, g = 0, bl = 0;
    for (const c of b) { r += c[0]; g += c[1]; bl += c[2]; }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
  while (palette.length < maxColors) palette.push([0, 0, 0]);
  return palette;
}

function nearestFactory(palette) {
  const cache = new Map();
  return (r, g, b) => {
    const key = (r >> 2) << 12 | (g >> 2) << 6 | (b >> 2);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(key, best);
    return best;
  };
}

// LZW encode (GIF variable-width codes).
function lzwEncode(minCodeSize, indices) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < clear; i++) dict.set(String(i), i);
    return clear + 2;
  };
  let next = reset();
  const out = [];
  let cur = 0, curBits = 0;
  const push = (code) => {
    cur |= code << curBits; curBits += codeSize;
    while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
  };
  push(clear);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const comb = prefix + ',' + k;
    if (dict.has(comb)) { prefix = comb; }
    else {
      push(dict.get(prefix));
      dict.set(comb, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      if (next >= 4096) { push(clear); next = reset(); codeSize = minCodeSize + 1; }
      prefix = String(k);
    }
  }
  push(dict.get(prefix));
  push(eoi);
  if (curBits > 0) out.push(cur & 0xff);
  return out;
}

function encodeGIF(frames, { delayCs = 6, loop = 0 } = {}) {
  const W = frames[0].width, H = frames[0].height;
  const palette = buildPalette(frames, 256);
  const nearest = nearestFactory(palette);
  const bytes = [];
  const put = (...b) => bytes.push(...b);
  const putStr = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
  const putShort = (v) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };

  putStr('GIF89a');
  putShort(W); putShort(H);
  put(0xF7, 0, 0); // global color table, 256 colors, 8 bits
  for (const c of palette) put(c[0], c[1], c[2]);

  // NETSCAPE loop
  put(0x21, 0xFF, 11); putStr('NETSCAPE2.0'); put(3, 1); putShort(loop); put(0);

  const minCode = 8;
  for (const f of frames) {
    // Graphic control extension (delay + no transparency)
    put(0x21, 0xF9, 4, 0x00); putShort(delayCs); put(0x00, 0x00);
    // Image descriptor
    put(0x2C); putShort(0); putShort(0); putShort(W); putShort(H); put(0x00);
    // Indices
    const d = f.data;
    const idx = new Uint8Array(W * H);
    for (let p = 0, j = 0; j < d.length; j += 4, p++) idx[p] = nearest(d[j], d[j + 1], d[j + 2]);
    put(minCode);
    const lzw = lzwEncode(minCode, idx);
    for (let i = 0; i < lzw.length; i += 255) {
      const chunk = lzw.slice(i, i + 255);
      put(chunk.length, ...chunk);
    }
    put(0x00);
  }
  put(0x3B);
  return Buffer.from(bytes);
}

module.exports = { encodeGIF };
