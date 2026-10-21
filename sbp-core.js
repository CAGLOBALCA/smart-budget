/* Smart Budget Planner – on-device page reader (no dependencies). Works in browsers and Node.
   Input: grayscale Uint8Array (w*h). Pipeline: corner markers -> homography -> page-ID bits -> cell crops -> MLP digits. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SBP = factory();
}(this, function () {
  'use strict';

  // ---------- model ----------
  function b64ToInt8(b64) {
    if (typeof atob === 'function') { const s = atob(b64); const a = new Int8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = (s.charCodeAt(i) << 24) >> 24; return a; }
    const buf = Buffer.from(b64, 'base64'); return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  }
  function deq(t) { const q = b64ToInt8(t.data), f = new Float32Array(q.length); for (let i = 0; i < q.length; i++) f[i] = q[i] * t.scale; return f; }
  function loadModel(json) {
    const W1 = deq(json.W1), b1 = deq(json.b1), W2 = deq(json.W2), b2 = deq(json.b2);
    const H = json.b1.shape[0];
    return function predict(x /* Float32Array 784 */) {
      const h = new Float32Array(H);
      for (let j = 0; j < H; j++) h[j] = b1[j];
      for (let i = 0; i < 784; i++) { const v = x[i]; if (!v) continue; const o = i * H; for (let j = 0; j < H; j++) h[j] += v * W1[o + j]; }
      const z = new Float32Array(10); for (let k = 0; k < 10; k++) z[k] = b2[k];
      for (let j = 0; j < H; j++) { const v = h[j] > 0 ? h[j] : 0; if (!v) continue; const o = j * 10; for (let k = 0; k < 10; k++) z[k] += v * W2[o + k]; }
      let m = -1e9; for (const v of z) m = Math.max(m, v); let s = 0; const p = z.map(v => { const e = Math.exp(v - m); s += e; return e; });
      let best = 0; for (let k = 0; k < 10; k++) { p[k] /= s; if (p[k] > p[best]) best = k; }
      return { digit: best, conf: p[best], probs: p };
    };
  }

  // ---------- marker detection ----------
  function findMarkers(gray, w, h) {
    const f = Math.max(1, Math.ceil(Math.max(w, h) / 1000)), sw = Math.floor(w / f), sh = Math.floor(h / f);
    const s = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let a = 0; for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) a += gray[(y * f + dy) * w + x * f + dx];
      s[y * sw + x] = a / (f * f);
    }
    const I = new Float64Array((sw + 1) * (sh + 1));
    for (let y = 0; y < sh; y++) { let r = 0; for (let x = 0; x < sw; x++) { r += s[y * sw + x]; I[(y + 1) * (sw + 1) + x + 1] = I[y * (sw + 1) + x + 1] + r; } }
    const R = Math.max(8, Math.round(Math.max(sw, sh) / 16)), dark = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(sw, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(sh, y + R + 1);
      const m = (I[y1 * (sw + 1) + x1] - I[y0 * (sw + 1) + x1] - I[y1 * (sw + 1) + x0] + I[y0 * (sw + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const v = s[y * sw + x]; dark[y * sw + x] = (v < m * 0.72 && v < m - 20) ? 1 : 0;
    }
    const lab = new Int32Array(sw * sh), cands = [], stack = new Int32Array(sw * sh); let L = 0;
    for (let p0 = 0; p0 < sw * sh; p0++) {
      if (!dark[p0] || lab[p0]) continue; L++; let sp = 0; stack[sp++] = p0; lab[p0] = L;
      let n = 0, sx = 0, sy = 0, mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1;
      while (sp) {
        const p = stack[--sp], x = p % sw, y = (p / sw) | 0; n++; sx += x; sy += y;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
        const nb = [p - 1, p + 1, p - sw, p + sw];
        for (let k = 0; k < 4; k++) { const q = nb[k]; if (q < 0 || q >= sw * sh) continue; if (k < 2 && ((q / sw) | 0) !== y) continue; if (dark[q] && !lab[q]) { lab[q] = L; stack[sp++] = q; } }
      }
      const bw = mxx - mnx + 1, bh = mxy - mny + 1;
      if (n >= 20 && bw >= 4 && bh >= 4 && bw / bh > 0.5 && bw / bh < 2 && n / (bw * bh) > 0.7 && Math.max(bw, bh) < 0.12 * Math.max(sw, sh))
        cands.push({ x: (sx / n + 0.5) * f, y: (sy / n + 0.5) * f, area: n * f * f });
    }
    if (cands.length < 4) return null;
    const maxA = Math.max(...cands.map(c => c.area)); const big = cands.filter(c => c.area >= 0.3 * maxA);
    if (big.length < 4) return null;
    const pick = fn => big.reduce((a, b) => fn(b) > fn(a) ? b : a);
    const tl = pick(c => -(c.x + c.y)), br = pick(c => c.x + c.y), tr = pick(c => c.x - c.y), bl = pick(c => c.y - c.x);
    const q = [tl, tr, br, bl]; if (new Set(q).size < 4) return null;
    return q.map(c => [c.x, c.y]);
  }

  // ---------- homography (page pt -> image px) ----------
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let c = 0; c < 8; c++) {
      let piv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < 8; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let j = c; j < 8; j++) A[r][j] -= k * A[c][j]; b[r] -= k * b[c]; }
    }
    const H = b.map((v, i) => v / A[i][i]); H.push(1); return H;
  }
  function project(H, x, y) { const d = H[6] * x + H[7] * y + 1; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; }

  function sampler(gray, w, h) {
    return function (u, v) {
      if (u < 0 || v < 0 || u >= w - 1 || v >= h - 1) return 255;
      const x = u | 0, y = v | 0, fx = u - x, fy = v - y, i = y * w + x;
      return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy;
    };
  }
  // sample page-rect [x,y,w,h] (pt) into gw x gh grid
  function grab(S, H, x, y, rw, rh, gw, gh) {
    const g = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const p = project(H, x + (i + 0.5) * rw / gw, y + (j + 0.5) * rh / gh); g[j * gw + i] = S(p[0], p[1]); }
    return g;
  }
  function inkMap(g) {
    const srt = Array.from(g).sort((a, b) => a - b); const bg = Math.max(60, srt[Math.floor(srt.length * 0.9)]);
    return g.map(v => Math.max(0, Math.min(1, (bg - v) / bg)));
  }

  // ---------- page id ----------
  function readId(S, H, L) {
    const { x0, y, size, pitch, n } = L.id, bits = [];
    const white = grab(S, H, x0, y - size * 0.9, n * pitch, size * 0.5, n * 4, 2); let ws = 0; for (const v of white) ws += v; const wm = ws / white.length;
    for (let i = 0; i < n; i++) {
      const bx = x0 + i * pitch + (pitch - size) / 2, g = grab(S, H, bx + size * 0.25, y + size * 0.25, size * 0.5, size * 0.5, 4, 4);
      let m = 0; for (const v of g) m += v; m /= g.length; bits.push(m < wm * 0.55 ? 1 : 0);
    }
    const d = bits.slice(1, 9), par = d.reduce((a, b) => a + b, 0) % 2;
    const ok = bits[0] === 1 && bits[10] === 0 && bits[11] === 1 && bits[9] === par;
    return ok ? d.reduce((a, b) => a * 2 + b, 0) : null;
  }

  // ---------- digit cell ----------
  function cellToMnist(S, H, cell) {
    const [x, y, cw, ch] = cell, ix = cw * 0.14, iy = ch * 0.11, GW = 32, GH = 40;
    const ink = inkMap(grab(S, H, x + ix, y + iy, cw - 2 * ix, ch - 2 * iy, GW, GH));
    const bin = new Uint8Array(GW * GH); for (let i = 0; i < bin.length; i++) bin[i] = ink[i] > 0.3 ? 1 : 0;
    // connected components; drop border-line remnants and specks
    const lab = new Int32Array(GW * GH), comps = []; let L = 0;
    for (let p0 = 0; p0 < bin.length; p0++) {
      if (!bin[p0] || lab[p0]) continue; L++; const st = [p0]; lab[p0] = L; const px = [];
      let mnx = 1e9, mxx = -1, mny = 1e9, mxy = -1;
      while (st.length) {
        const p = st.pop(), cx = p % GW, cy = (p / GW) | 0; px.push(p);
        mnx = Math.min(mnx, cx); mxx = Math.max(mxx, cx); mny = Math.min(mny, cy); mxy = Math.max(mxy, cy);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const q = ny * GW + nx; if (bin[q] && !lab[q]) { lab[q] = L; st.push(q); }
        }
      }
      const bw = mxx - mnx + 1, bh = mxy - mny + 1;
      const line = (bw <= 3 && bh > GH * 0.5 && (mnx === 0 || mxx === GW - 1)) || (bh <= 3 && bw > GW * 0.5 && (mny === 0 || mxy === GH - 1));
      if (!line) comps.push(px);
    }
    if (!comps.length) return null;
    const big = Math.max(...comps.map(c => c.length)); const keep = new Uint8Array(GW * GH); let cnt = 0;
    for (const c of comps) if (c.length >= Math.max(4, 0.15 * big)) for (const p of c) { keep[p] = 1; cnt++; }
    if (cnt < 0.025 * GW * GH) return null;   // empty cell
    let mnx = GW, mxx = -1, mny = GH, mxy = -1;
    for (let p = 0; p < keep.length; p++) if (keep[p]) { const cx = p % GW, cy = (p / GW) | 0; mnx = Math.min(mnx, cx); mxx = Math.max(mxx, cx); mny = Math.min(mny, cy); mxy = Math.max(mxy, cy); }
    const bw = mxx - mnx + 1, bh = mxy - mny + 1, sc = 20 / Math.max(bw, bh), tw = Math.max(1, Math.round(bw * sc)), th = Math.max(1, Math.round(bh * sc));
    // dilate kept mask by 1 so anti-aliased edges survive
    const small = new Float32Array(tw * th);
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
      // area-average source box
      const sx0 = mnx + i / sc, sx1 = mnx + (i + 1) / sc, sy0 = mny + j / sc, sy1 = mny + (j + 1) / sc; let a = 0, n = 0;
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
        if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue; const p = yy * GW + xx;
        let k = keep[p]; if (!k) { for (const q of [p - 1, p + 1, p - GW, p + GW]) if (q >= 0 && q < keep.length && keep[q]) k = 1; }
        a += k ? ink[p] : 0; n++;
      }
      small[j * tw + i] = n ? a / n : 0;
    }
    let mx = 0; for (const v of small) mx = Math.max(mx, v);
    let m = 0, cx = 0, cy = 0;
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) { const v = small[j * tw + i] / mx; small[j * tw + i] = Math.min(1, v * 1.0); m += v; cx += v * i; cy += v * j; }
    const ox = Math.round(14 - cx / m), oy = Math.round(14 - cy / m), out = new Float32Array(784);
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) { const X = i + ox, Y = j + oy; if (X >= 0 && Y >= 0 && X < 28 && Y < 28) out[Y * 28 + X] = small[j * tw + i]; }
    return out;
  }
  function boxInk(S, H, b) {
    const [x, y, w, h] = b, g = inkMap(grab(S, H, x + w * 0.18, y + h * 0.18, w * 0.64, h * 0.64, 16, 16));
    let c = 0; for (const v of g) if (v > 0.3) c++; return c / g.length;
  }

  // ---------- full page ----------
  function readPage(gray, w, h, layouts, predict) {
    const corners = findMarkers(gray, w, h);
    if (!corners) return { ok: false, error: 'markers' };
    const S = sampler(gray, w, h); let H = null, typeId = null;
    for (let k = 0; k < 4 && typeId === null; k++) {
      const dst = [0, 1, 2, 3].map(i => corners[(i + k) % 4]); const Hk = homography(layouts.markers, dst);
      const id = readId(S, H = Hk, layouts); if (id !== null && layouts.types[String(id >> 0)]) typeId = id;
    }
    if (typeId === null) return { ok: false, error: 'pageid', corners };
    const T = layouts.types[String(typeId)], fields = [];
    for (const f of T.fields) {
      if (f.kind === 'digits') {
        let txt = '', conf = 1; const cells = [];
        for (const c of f.cells) {
          const x = cellToMnist(S, H, c);
          if (!x) { cells.push(null); continue; }
          const r = predict(x); cells.push({ d: r.digit, conf: r.conf }); txt += r.digit; conf = Math.min(conf, r.conf);
        }
        fields.push({ key: f.key, row: f.row, col: f.col, kind: f.kind, value: txt, conf: txt ? conf : 1, cells });
      } else {
        const ink = f.boxes.map(b => boxInk(S, H, b));
        if (f.kind === 'check') fields.push({ key: f.key, row: f.row, col: f.col, kind: f.kind, value: ink[0] > 0.08, conf: Math.abs(ink[0] - 0.08) > 0.04 ? 1 : 0.5 });
        else {
          const order = ink.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]); const sel = order[0][0] > 0.08 ? f.options[order[0][1]] : '';
          const amb = order[0][0] > 0.08 && order[1][0] > 0.6 * order[0][0];
          fields.push({ key: f.key, row: f.row, col: f.col, kind: f.kind, value: sel, conf: amb ? 0.4 : 1, options: f.options });
        }
      }
    }
    return { ok: true, typeId, typeName: T.name, corners, fields };
  }
  return { loadModel, findMarkers, homography, readPage, cellToMnist, sampler };
}));
