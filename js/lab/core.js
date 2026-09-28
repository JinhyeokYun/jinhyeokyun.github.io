/* ============================================
   Research lab — shared engine for the interactive explainers
   (loop, theme tokens, colormaps, field splatting, strip charts, UI helpers)
   ============================================ */

/* --- media state --- */
const mq = {
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)'),
    dark: window.matchMedia('(prefers-color-scheme: dark)'),
    narrow: window.matchMedia('(max-width: 768px)'),
    coarse: window.matchMedia('(pointer: coarse)')
};

export const media = {
    get reduced() { return mq.reduced.matches; },
    get dark() { return mq.dark.matches; },
    get narrow() { return mq.narrow.matches; },
    get coarse() { return mq.coarse.matches; },
    on(name, fn) {
        const q = mq[name];
        if (q.addEventListener) q.addEventListener('change', fn); else q.addListener(fn);
    }
};

export const debug = new URLSearchParams(location.search).has('labdebug');

/* --- colors from CSS tokens --- */
export function parseColor(str) {
    const s = (str || '').trim();
    if (s.startsWith('#')) {
        let h = s.slice(1);
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const n = parseInt(h.slice(0, 6), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return [p[0], p[1], p[2]];
    }
    return [128, 128, 128];
}

export function readTokens(el, names) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const n of names) out[n] = parseColor(cs.getPropertyValue(n));
    return out;
}

export const rgb = (c, a = 1) => a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/* sRGB <-> OKLab for perceptual interpolation */
const toLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = v => { const x = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(x * 255))); };

function toOklab([r, g, b]) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

function fromOklab([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
}

export function mixOklab(c1, c2, t) {
    const a = toOklab(c1), b = toOklab(c2);
    return fromOklab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

const littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
const pack = (r, g, b, a = 255) => littleEndian ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

/* Diverging LUT: index 0 = strongest negative, n-1 = strongest positive.
   Values inside ±knee stay exactly at the mid color so the background is clean. */
export function lutDiverging(neg, mid, pos, { n = 256, knee = 0.05, gamma = 0.85 } = {}) {
    const lut = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        const v = (i / (n - 1)) * 2 - 1;
        const a = Math.abs(v);
        let c = mid;
        if (a > knee) {
            const t = Math.pow((a - knee) / (1 - knee), gamma);
            c = mixOklab(mid, v < 0 ? neg : pos, t);
        }
        lut[i] = pack(c[0], c[1], c[2]);
    }
    return lut;
}

export function lutSequential(stops, n = 256) {
    const lut = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1) * (stops.length - 1);
        const k = Math.min(stops.length - 2, Math.floor(t));
        const c = mixOklab(stops[k], stops[k + 1], t - k);
        lut[i] = pack(c[0], c[1], c[2]);
    }
    return lut;
}

/* --- random --- */
export function rng(seed = 1) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* --- HiDPI canvas bound to a wrapper element --- */
export function createSurface(wrap, canvas, { dprCap = 2, onResize } = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const surf = { canvas, ctx, w: 1, h: 1, dpr: 1 };
    function fit() {
        const r = wrap.getBoundingClientRect();
        const cap = media.coarse ? Math.min(dprCap, 1.5) : dprCap;
        const dpr = Math.min(window.devicePixelRatio || 1, cap);
        const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        if (w === surf.w && h === surf.h && dpr === surf.dpr) return;
        surf.w = w; surf.h = h; surf.dpr = dpr;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (onResize) onResize(surf);
    }
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    fit();
    surf.fit = fit;
    return surf;
}

/* --- scalar field with Gaussian splats, blitted through a LUT --- */
export function createField() {
    const f = {
        nx: 1, ny: 1, data: new Float32Array(1), img: null, buf: null, cvs: null, cctx: null,
        x0: 0, y0: 0, dx: 1
    };
    const stamps = new Map();

    f.resize = (nx, ny, x0, y0, dx) => {
        f.nx = nx; f.ny = ny; f.x0 = x0; f.y0 = y0; f.dx = dx;
        f.data = new Float32Array(nx * ny);
        f.cvs = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(nx, ny) : Object.assign(document.createElement('canvas'), { width: nx, height: ny });
        f.cctx = f.cvs.getContext('2d');
        f.img = f.cctx.createImageData(nx, ny);
        f.buf = new Uint32Array(f.img.data.buffer);
        stamps.clear();
    };

    f.clear = () => f.data.fill(0);

    function stamp(rc) {
        const key = Math.max(1, Math.round(rc / f.dx * 4));
        let s = stamps.get(key);
        if (!s) {
            const r = key / 4;
            const half = Math.ceil(r * 3);
            const size = half * 2 + 1;
            const k = new Float32Array(size * size);
            for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
                const dx = i - half, dy = j - half;
                k[j * size + i] = Math.exp(-(dx * dx + dy * dy) / (r * r));
            }
            s = { half, size, k };
            stamps.set(key, s);
        }
        return s;
    }

    /* world coordinates (x right, y up); amp added at the center */
    f.splat = (x, y, amp, rc) => {
        const s = stamp(rc);
        const ci = Math.round((x - f.x0) / f.dx);
        const cj = Math.round((f.y0 - y) / f.dx);
        const { half, size, k } = s;
        const i0 = Math.max(0, ci - half), i1 = Math.min(f.nx - 1, ci + half);
        const j0 = Math.max(0, cj - half), j1 = Math.min(f.ny - 1, cj + half);
        const d = f.data, nx = f.nx;
        for (let j = j0; j <= j1; j++) {
            const kr = (j - cj + half) * size - ci + half;
            const dr = j * nx;
            for (let i = i0; i <= i1; i++) d[dr + i] += amp * k[kr + i];
        }
    };

    f.blit = (ctx, lut, vmax, dx, dy, dw, dh) => {
        const n = lut.length - 1, d = f.data, buf = f.buf, inv = 0.5 / vmax;
        for (let p = 0; p < d.length; p++) {
            let t = d[p] * inv + 0.5;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            buf[p] = lut[(t * n) | 0];
        }
        f.cctx.putImageData(f.img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(f.cvs, dx, dy, dw, dh);
    };

    return f;
}

/* --- animation loop with auto-pause (offscreen, hidden tab, reduced motion) --- */
export function createLoop({ root, tick, draw, maxDt = 0.05, onTier }) {
    let raf = 0, last = 0, playing = false, wanted = !media.reduced, visible = true, onscreen = false;
    const frames = new Float32Array(90);
    let fi = 0, filled = 0, tier = 0;

    function frame(now) {
        raf = requestAnimationFrame(frame);
        const dt = last ? Math.min(maxDt, (now - last) / 1000) : 1 / 60;
        const cost = performance.now();
        last = now;
        tick(dt);
        draw();
        frames[fi] = performance.now() - cost;
        fi = (fi + 1) % frames.length;
        if (filled < frames.length) filled++;
        if (filled === frames.length && tier < 2) {
            let avg = 0;
            for (let i = 0; i < frames.length; i++) avg += frames[i];
            avg /= frames.length;
            const budget = media.coarse ? 22 : 11;
            if (avg > budget) { tier++; filled = 0; if (onTier) onTier(tier); }
        }
    }

    function update() {
        const run = wanted && visible && onscreen;
        if (run && !playing) { playing = true; last = 0; raf = requestAnimationFrame(frame); }
        if (!run && playing) { playing = false; cancelAnimationFrame(raf); }
    }

    const io = new IntersectionObserver(es => { onscreen = es.some(e => e.isIntersecting); update(); }, { rootMargin: '200px' });
    io.observe(root);
    document.addEventListener('visibilitychange', () => { visible = !document.hidden; update(); });

    return {
        play() { wanted = true; update(); },
        pause() { wanted = false; update(); if (draw) draw(); },
        toggle() { wanted ? this.pause() : this.play(); return wanted; },
        get wanted() { return wanted; },
        get running() { return playing; },
        stats() {
            let avg = 0;
            for (let i = 0; i < filled; i++) avg += frames[i];
            return { avg: filled ? avg / filled : 0, tier };
        }
    };
}

/* --- multi-lane strip chart --- */
export function createStripChart(wrap, canvas, { lanes, span, sampleDt = 0.1 }) {
    let chart = null;
    const surf = createSurface(wrap, canvas, { dprCap: 2, onResize: () => { if (chart) chart.draw(); } });
    const cap = Math.ceil(span / sampleDt) + 2;
    const t = new Float32Array(cap);
    const vals = lanes.map(() => new Float32Array(cap));
    const vals2 = lanes.map(l => l.second ? new Float32Array(cap) : null);
    let head = 0, count = 0, lastT = -Infinity;
    const marks = [];
    let colors = null;

    chart = {
        lanes,
        setColors(c) { colors = c; },
        clear() { head = 0; count = 0; lastT = -Infinity; marks.length = 0; },
        push(time, row) {
            if (time - lastT < sampleDt) return;
            lastT = time;
            t[head] = time;
            lanes.forEach((l, k) => {
                vals[k][head] = row[l.key];
                if (vals2[k]) vals2[k][head] = row[l.second];
            });
            head = (head + 1) % cap;
            if (count < cap) count++;
        },
        mark(time, kind, until) { marks.push({ time, kind, until }); if (marks.length > 8) marks.shift(); },
        draw() {
            if (!colors) return;
            const { ctx, w, h } = surf;
            ctx.fillStyle = rgb(colors.surface);
            ctx.fillRect(0, 0, w, h);
            if (!count) return;
            const tEnd = t[(head - 1 + cap) % cap];
            const tStart = tEnd - span;
            const padL = 86, padR = 10, laneH = h / lanes.length;
            const X = tt => padL + (tt - tStart) / span * (w - padL - padR);
            ctx.font = `500 11px ${colors.fontMono}`;
            ctx.textBaseline = 'middle';

            for (const m of marks) {
                if (m.kind === 'ramp' && m.until > tStart) {
                    ctx.fillStyle = rgb(colors.accentSoft);
                    const a = Math.max(padL, X(m.time)), b = Math.min(w - padR, X(m.until));
                    if (b > a) ctx.fillRect(a, 0, b - a, h);
                }
            }
            lanes.forEach((l, k) => {
                const y0 = k * laneH, mid = y0 + laneH / 2, amp = (laneH / 2 - 6) / l.range;
                ctx.strokeStyle = rgb(colors.border);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(padL, Math.round(y0 + laneH) - 0.5);
                ctx.lineTo(w - padR, Math.round(y0 + laneH) - 0.5);
                ctx.stroke();
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                const base = l.base ?? 0;
                ctx.moveTo(padL, mid - (base - (l.center ?? 0)) * amp);
                ctx.lineTo(w - padR, mid - (base - (l.center ?? 0)) * amp);
                ctx.stroke();
                if (l.envelope) {
                    ctx.strokeStyle = rgb(colors.text3, 0.55);
                    for (const s of [-1, 1]) {
                        ctx.beginPath();
                        const yy = mid - (s * l.envelope() - 0) * amp;
                        ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
                    }
                }
                ctx.setLineDash([]);
                ctx.fillStyle = rgb(colors.text2);
                ctx.fillText(l.label, 8, mid);

                const drawSeries = (arr, color, width) => {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = width;
                    ctx.beginPath();
                    let started = false;
                    for (let i = 0; i < count; i++) {
                        const idx = (head - count + i + cap) % cap;
                        if (t[idx] < tStart) continue;
                        let v = (arr[idx] - (l.center ?? 0)) * amp;
                        v = Math.max(-laneH / 2 + 2, Math.min(laneH / 2 - 2, v));
                        const x = X(t[idx]), y = mid - v;
                        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                };
                if (vals2[k]) drawSeries(vals2[k], rgb(colors.text3, 0.7), 1);
                drawSeries(vals[k], rgb(colors[l.color] || colors.text), 1.6);
            });
            for (const m of marks) {
                if (m.kind === 'on' && m.time > tStart) {
                    const x = Math.round(X(m.time)) + 0.5;
                    ctx.strokeStyle = rgb(colors.accent);
                    ctx.setLineDash([4, 3]);
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
                    ctx.setLineDash([]);
                }
            }
        },
        surf
    };
    return chart;
}

/* --- accessible step tabs (roving tabindex, arrow keys) --- */
export function createSteps(tablist, onSelect) {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    let current = 0;
    function select(i, focus = false) {
        current = (i + tabs.length) % tabs.length;
        tabs.forEach((t, k) => {
            const on = k === current;
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
        });
        if (focus) tabs[current].focus();
        onSelect(current);
    }
    tabs.forEach((t, k) => t.addEventListener('click', () => select(k)));
    tablist.addEventListener('keydown', e => {
        const map = { ArrowRight: 1, ArrowLeft: -1 };
        if (e.key in map) { e.preventDefault(); select(current + map[e.key], true); }
        if (e.key === 'Home') { e.preventDefault(); select(0, true); }
        if (e.key === 'End') { e.preventDefault(); select(tabs.length - 1, true); }
    });
    return { select, get current() { return current; }, count: tabs.length };
}

/* --- polite live region (debounced) --- */
export function announcer(el) {
    let timer = 0;
    return text => {
        clearTimeout(timer);
        timer = setTimeout(() => { el.textContent = text; }, 120);
    };
}

/* --- mount with graceful fallback --- */
export function mountLab(root, factory) {
    const live = root.querySelector('.lab-live');
    const fallback = root.querySelector('.lab-fallback');
    const fail = err => {
        if (live) live.hidden = true;
        if (fallback) fallback.hidden = false;
        root.classList.remove('is-live');
        console.error('[lab]', err);
    };
    if (!root) return;
    try {
        if (live) live.hidden = false;
        if (fallback) fallback.hidden = true;
        root.classList.add('is-live');
        const r = factory(root);
        if (r && typeof r.catch === 'function') r.catch(fail);
    } catch (err) {
        fail(err);
    }
}

export async function fontsReady() {
    try { await document.fonts.ready; } catch (e) { /* ignore */ }
}
