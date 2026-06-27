// Renders the Karafilt animations with headless Chromium and produces
// mobile-friendly previews: a WebM video + looping GIFs + still frames.
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { encodeGIF } = require('./gifenc.js');

const DIR = path.resolve(__dirname, '..');
const OUT = path.join(DIR, 'preview');
fs.mkdirSync(OUT, { recursive: true });

// ---- tiny PNG decoder (8-bit, color type 2/6) -> {width,height,data:RGBA} ----
function decodePNG(buf) {
  let p = 8; // skip signature
  let w, h, ct, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = ct === 6 ? 4 : 3;
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = Buffer.from(raw.slice(rp, rp + stride)); rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      line[x] = v;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = line[x * channels];
      out[(y * w + x) * 4 + 1] = line[x * channels + 1];
      out[(y * w + x) * 4 + 2] = line[x * channels + 2];
      out[(y * w + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width: w, height: h, data: out };
}

// box-average downscale RGBA -> RGBA
function downscale(src, dw, dh) {
  const { width: sw, height: sh, data } = src;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * sh / dh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * sw / dw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
        const i = (yy * sw + xx) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: dw, height: dh, data: out };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();

  // -------- PASS A: record the reel to WebM --------
  const ctxV = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const pv = await ctxV.newPage();
  await pv.goto('file://' + path.join(DIR, 'karafilt-reel.html'));
  await sleep(23000); // one full loop (~22s) + margin
  await pv.close();
  await ctxV.close();
  // rename the produced video
  const vids = fs.readdirSync(OUT).filter(f => f.endsWith('.webm'));
  if (vids.length) fs.renameSync(path.join(OUT, vids[0]), path.join(OUT, 'karafilt-reel.webm'));
  console.log('webm done');

  // -------- PASS B: frame grabs --------
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  // Logo GIF (short, clean loop) — from the animated SVG
  await page.goto('file://' + path.join(DIR, 'logo-animated.svg'));
  await sleep(400);
  const logoFrames = [];
  const LOGO_N = 36, LOGO_MS = 70; // ~2.5s @ ~14fps
  for (let i = 0; i < LOGO_N; i++) {
    const png = decodePNG(await page.screenshot({ clip: { x: 0, y: 0, width: 528, height: 120 } }));
    logoFrames.push(downscale(png, 440, 100));
    await sleep(LOGO_MS);
  }
  fs.writeFileSync(path.join(OUT, 'logo.gif'), encodeGIF(logoFrames, { delayCs: 7, loop: 0 }));
  console.log('logo.gif done', logoFrames.length, 'frames');

  // Reel GIF (downscaled, ~9fps over one loop)
  await page.goto('file://' + path.join(DIR, 'karafilt-reel.html'));
  await sleep(300);
  const reelFrames = [];
  const REEL_N = 150, REEL_MS = 150; // ~22.5s @ ~6.6fps
  for (let i = 0; i < REEL_N; i++) {
    const png = decodePNG(await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } }));
    reelFrames.push(downscale(png, 480, 270));
    await sleep(REEL_MS);
  }
  fs.writeFileSync(path.join(OUT, 'reel.gif'), encodeGIF(reelFrames, { delayCs: 15, loop: 0 }));
  console.log('reel.gif done', reelFrames.length, 'frames');

  // A couple of full-res stills for slides
  const stills = [800, 5200, 9800, 14400, 18800];
  await page.goto('file://' + path.join(DIR, 'karafilt-reel.html'));
  let last = 0;
  for (let k = 0; k < stills.length; k++) {
    await sleep(stills[k] - last); last = stills[k];
    await page.screenshot({ path: path.join(OUT, `still-${k + 1}.png`) });
  }
  console.log('stills done');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
