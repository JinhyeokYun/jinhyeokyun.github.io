/* ============================================
   Research lineage (main page): small looping sketches per research card
   and highlighting of the sensing → model → actuation/decision stages.
   ============================================ */
import { media, readTokens, rgb } from './core.js?v=2026q3';

const root = document.getElementById('highlights');
if (root) init();

function init() {
    const stages = Array.from(root.querySelectorAll('.lineage-stage'));
    const cards = Array.from(root.querySelectorAll('.lineage-card'));
    const light = keys => stages.forEach(s => s.classList.toggle('is-on', keys.some(k => s.dataset.stage.split(' ').includes(k))));
    cards.forEach(c => {
        const keys = c.dataset.stages.split(' ');
        const on = () => { light(keys); root.classList.add('has-focus'); };
        const off = () => { light([]); root.classList.remove('has-focus'); };
        c.addEventListener('mouseenter', on); c.addEventListener('mouseleave', off);
        c.addEventListener('focusin', on); c.addEventListener('focusout', off);
    });

    let colors = null;
    const readColors = () => {
        const t = readTokens(root, ['--surface', '--border', '--text-2', '--text-3', '--accent', '--accent-ink', '--primary', '--warn-ink', '--lab-neg', '--lab-pos']);
        colors = { surface: t['--surface'], border: t['--border'], text2: t['--text-2'], text3: t['--text-3'], accent: t['--accent'], accentInk: t['--accent-ink'], primary: t['--primary'], warn: t['--warn-ink'], neg: t['--lab-neg'], pos: t['--lab-pos'] };
    };
    readColors();
    media.on('dark', () => { readColors(); drawAll(lastT); });

    const items = Array.from(root.querySelectorAll('canvas.lineage-anim')).map(cv => ({ cv, ctx: cv.getContext('2d'), kind: cv.dataset.anim, w: 0, h: 0, visible: false }));
    const fit = it => {
        const r = it.cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
        it.w = Math.max(1, Math.round(r.width)); it.h = Math.max(1, Math.round(r.height));
        it.cv.width = it.w * dpr; it.cv.height = it.h * dpr; it.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(() => { items.forEach(fit); drawAll(lastT); });
    items.forEach(it => ro.observe(it.cv));
    const io = new IntersectionObserver(es => es.forEach(e => { const it = items.find(i => i.cv === e.target); if (it) it.visible = e.isIntersecting; update(); }), { rootMargin: '100px' });
    items.forEach(it => io.observe(it.cv));

    let raf = 0, lastT = 2.2, t0 = 0;
    function frame(now) {
        raf = requestAnimationFrame(frame);
        if (!t0) t0 = now;
        lastT = (now - t0) / 1000;
        items.forEach(it => { if (it.visible) draw(it, lastT); });
    }
    function update() {
        const run = !media.reduced && !document.hidden && items.some(i => i.visible);
        if (run && !raf) { t0 = 0; raf = requestAnimationFrame(frame); }
        if (!run && raf) { cancelAnimationFrame(raf); raf = 0; drawAll(lastT); }
    }
    document.addEventListener('visibilitychange', update);
    media.on('reduced', update);
    function drawAll(t) { items.forEach(it => draw(it, t)); }

    function draw(it, t) {
        const { ctx, w, h } = it;
        if (!w || !colors) return;
        ctx.clearRect(0, 0, w, h);
        (SKETCH[it.kind] || (() => {}))(ctx, w, h, t, colors);
    }
    requestAnimationFrame(() => { items.forEach(fit); drawAll(lastT); update(); });
}

const TAU = Math.PI * 2;
const SKETCH = {
    /* F: near-wall counter-rotating vortices, sensing plane and opposing wall velocity */
    channel(ctx, w, h, t, c) {
        const wall = h - 10, ys = wall - h * 0.2;
        ctx.strokeStyle = rgb(c.text2); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, wall); ctx.lineTo(w, wall); ctx.stroke();
        ctx.setLineDash([3, 3]); ctx.strokeStyle = rgb(c.accentInk, 0.7); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, ys); ctx.lineTo(w, ys); ctx.stroke(); ctx.setLineDash([]);
        const damp = 0.55 + 0.45 * Math.cos(t * 0.6);
        for (let k = 0; k < 3; k++) {
            const cx = (k + 0.5) / 3 * w + Math.sin(t * 0.7 + k) * 6, cy = wall - h * 0.5;
            for (const s of [-1, 1]) {
                const x = cx + s * w * 0.07, r = h * 0.16 * damp;
                ctx.strokeStyle = rgb(s > 0 ? c.pos : c.neg, 0.9); ctx.lineWidth = 2;
                const a0 = t * 2 * s;
                ctx.beginPath(); ctx.arc(x, cy, r, a0, a0 + 4.6); ctx.stroke();
            }
            const v = Math.sin(t * 1.3 + k * 2) * damp;
            ctx.strokeStyle = rgb(c.accent); ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(cx, wall); ctx.lineTo(cx, wall - v * h * 0.16); ctx.stroke();
        }
    },
    /* C: oblique vortex shedding convected downstream */
    udf(ctx, w, h, t, c) {
        ctx.fillStyle = rgb(c.border); ctx.fillRect(4, 6, 12, h - 12);
        const sp = w * 0.13;
        for (let k = -2; k < 9; k++) {
            const x0 = 24 + ((k * sp + t * 26) % (sp * 9));
            for (const [col, off] of [[c.neg, 0], [c.pos, 4]]) {
                ctx.strokeStyle = rgb(col, Math.max(0, 1 - x0 / w) * 0.95); ctx.lineWidth = 2.4;
                ctx.beginPath(); ctx.moveTo(x0 + off, h - 6); ctx.lineTo(x0 + off - h * 0.22, 6); ctx.stroke();
            }
        }
    },
    /* E: shedding amplitude damped by proportional feedback */
    pcontrol(ctx, w, h, t, c) {
        const mid = h / 2, per = 6, u = (t % per) / per;
        ctx.strokeStyle = rgb(c.border); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
        ctx.strokeStyle = rgb(c.primary); ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i <= w; i += 2) {
            const s = i / w;
            const on = s > 0.35 ? Math.exp(-(s - 0.35) * 4.5) : 1;
            const y = mid - Math.sin(s * 26 - u * TAU) * h * 0.36 * on;
            i ? ctx.lineTo(i, y) : ctx.moveTo(i, y);
        }
        ctx.stroke();
        ctx.setLineDash([3, 3]); ctx.strokeStyle = rgb(c.accent);
        ctx.beginPath(); ctx.moveTo(w * 0.35, 4); ctx.lineTo(w * 0.35, h - 4); ctx.stroke(); ctx.setLineDash([]);
    },
    /* D: prediction F(x) and its planar-symmetry image F(−x) = −F(x) */
    symmetry(ctx, w, h, t, c) {
        const mid = h / 2;
        ctx.setLineDash([4, 4]); ctx.strokeStyle = rgb(c.accentInk, 0.7); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke(); ctx.setLineDash([]);
        const f = s => Math.sin(s * 9 + t * 1.6) * 0.6 + Math.sin(s * 17 - t) * 0.25;
        for (const [sgn, col] of [[1, c.primary], [-1, c.warn]]) {
            ctx.strokeStyle = rgb(col); ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i <= w; i += 2) { const y = mid - sgn * f(i / w) * h * 0.4; i ? ctx.lineTo(i, y) : ctx.moveTo(i, y); }
            ctx.stroke();
        }
    },
    /* B: slices stacked along the kiln axis */
    kiln(ctx, w, h, t, c) {
        const x0 = 10, x1 = w - 12, cy = h / 2, r = h * 0.36, ex = r * 0.3;
        ctx.strokeStyle = rgb(c.text3); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x0, cy - r); ctx.lineTo(x1, cy - r); ctx.moveTo(x0, cy + r); ctx.lineTo(x1, cy + r); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(x0, cy, ex, r, 0, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(x1, cy, ex, r, 0, 0, TAU); ctx.stroke();
        const n = Math.floor(((t * 0.18) % 1) * 40);
        for (let k = 0; k <= n; k++) {
            const x = x0 + k / 40 * (x1 - x0);
            ctx.strokeStyle = rgb(k === n ? c.accentInk : c.accent, k === n ? 1 : 0.35); ctx.lineWidth = k === n ? 2 : 1;
            ctx.beginPath(); ctx.ellipse(x, cy, ex, r, 0, 0, TAU); ctx.stroke();
        }
        ctx.fillStyle = rgb(c.warn); ctx.beginPath(); ctx.ellipse(x0, cy, ex * 0.35, r * 0.25, 0, 0, TAU); ctx.fill();
    },
    /* A: ship route and emitted plume drifting with the wind */
    port(ctx, w, h, t, c) {
        ctx.strokeStyle = rgb(c.accentInk, 0.8); ctx.lineWidth = 1.2;
        ctx.strokeRect(w * 0.18, 4, w * 0.5, h * 0.2);
        const P = s => [8 + s * (w - 16), h - 10 - s * h * 0.45 - Math.sin(s * Math.PI) * h * 0.18];
        ctx.strokeStyle = rgb(c.primary); ctx.lineWidth = 2;
        ctx.beginPath(); for (let i = 0; i <= 30; i++) { const [x, y] = P(i / 30); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
        const u = (t * 0.12) % 1;
        for (let k = 0; k < 18; k++) {
            const s = u - k * 0.03; if (s < 0) continue;
            const [x, y] = P(s), age = k * 0.03 / 0.12;
            ctx.fillStyle = rgb(c.pos, Math.max(0, 0.55 - k * 0.03));
            ctx.beginPath(); ctx.arc(x, y - age * h * 0.12, 3 + k * 0.5, 0, TAU); ctx.fill();
        }
        const [sx, sy] = P(u);
        ctx.fillStyle = rgb(c.text2); ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, TAU); ctx.fill();
    }
};
