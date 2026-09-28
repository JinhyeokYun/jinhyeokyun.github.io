/* ============================================
   Research lab — procedural cylinder-wake scene
   Kármán street drawn from a shedding amplitude A(t):
   vorticity blobs + shear layers splatted on a grid, dye streaklines
   advected by free stream + cylinder doublet + Lamb–Oseen vortices.
   World units: cylinder diameter d = 1, free stream u∞ = 1.
   ============================================ */
import { createField, lutDiverging, rgb, rng } from './core.js?v=2026q3';

const R = 0.5;              /* cylinder radius */
const U_C = 0.8;            /* convection speed of shed vortices */
const Y_HALF = 2.6;         /* half height of the view */
const X_LEFT = -1.25;

export function createWakeScene() {
    const field = createField();
    const rand = rng(11);
    const vort = [];                 /* shed vortices */
    const eddies = [];               /* small turbulent eddies */
    let lut = null, colors = null;
    let view = { w: 1, h: 1, scale: 1, xRight: 10 };
    let phaseUnwrapped = 0, lastPhase = 0, nextRelease = 0, upperNext = true, primed = false;
    let tier = 0, turbulent = true, amp = 1, simT = 0;

    /* streakline sources */
    let sources = [];
    function buildSources() {
        const per = tier >= 1 ? 220 : 420;
        const perRake = tier >= 1 ? 110 : 170;
        const rake = tier >= 2 ? [] : Array.from({ length: 10 }, (_, i) => -2.25 + i * 0.5).filter(y => Math.abs(y) > 0.3);
        sources = [
            { x: 0.03, y: R + 0.035, strong: true },
            { x: 0.03, y: -R - 0.035, strong: true },
            ...rake.map(y => ({ x: X_LEFT + 0.05, y, strong: false }))
        ].map(s => { const n = s.strong ? per : perRake; return { ...s, n, px: new Float32Array(n), py: new Float32Array(n), age: new Float32Array(n), alive: new Uint8Array(n), head: 0, acc: 0 }; });
    }
    buildSources();

    function formationLength(a) { return 1.4 + 0.8 * (1 - Math.min(1, a)); }

    function velocity(x, y, out) {
        const r2 = x * x + y * y;
        let u = 1, v = 0;
        if (r2 > 1e-6) {
            const r4 = r2 * r2, R2 = R * R;
            u -= R2 * (x * x - y * y) / r4;
            v -= 2 * R2 * x * y / r4;
        }
        for (let k = 0; k < vort.length; k++) {
            const w = vort[k];
            let dx = x - w.x, dy = y - w.y, d2 = dx * dx + dy * dy + 1e-6;
            let f = w.g / (2 * Math.PI * d2) * (1 - Math.exp(-d2 / w.rc2));
            u -= f * dy; v += f * dx;
            if (w.x < 3) {
                const q = R * R / (w.x * w.x + w.y * w.y);
                const ix = w.x * q, iy = w.y * q;
                dx = x - ix; dy = y - iy; d2 = dx * dx + dy * dy + 1e-6;
                f = -w.g / (2 * Math.PI * d2) * (1 - Math.exp(-d2 / w.rc2));
                u -= f * dy; v += f * dx;
            }
        }
        out[0] = u; out[1] = v;
    }

    const v1 = [0, 0], v2 = [0, 0];
    function advectParticles(dt) {
        const jitter = turbulent ? 0.05 : 0;
        for (const s of sources) {
            s.acc += dt;
            const every = s.strong ? 0.028 : 0.06;
            while (s.acc >= every) {
                s.acc -= every;
                const i = s.head;
                s.px[i] = s.x; s.py[i] = s.y + (s.strong ? 0 : 0); s.age[i] = 0; s.alive[i] = 1;
                s.head = (s.head + 1) % s.n;
            }
            for (let i = 0; i < s.n; i++) {
                if (!s.alive[i]) continue;
                let x = s.px[i], y = s.py[i];
                velocity(x, y, v1);
                velocity(x + v1[0] * dt, y + v1[1] * dt, v2);
                x += 0.5 * dt * (v1[0] + v2[0]);
                y += 0.5 * dt * (v1[1] + v2[1]);
                if (jitter && x > 1.5) {
                    x += (rand() - 0.5) * jitter * dt;
                    y += (rand() - 0.5) * jitter * dt;
                }
                const r2 = x * x + y * y;
                if (r2 < (R + 0.01) * (R + 0.01)) {
                    const r = Math.sqrt(r2) || 1, k = (R + 0.012) / r;
                    x *= k; y *= k;
                }
                s.px[i] = x; s.py[i] = y; s.age[i] += dt;
                if (x > view.xRight + 0.6 || Math.abs(y) > Y_HALF + 0.6) s.alive[i] = 0;
            }
        }
    }

    function release(sign, a) {
        const lf = formationLength(a);
        const sats = [];
        if (turbulent) {
            const n = tier >= 1 ? 5 : 9;
            for (let i = 0; i < n; i++) {
                sats.push({ r: 0.12 + rand() * 0.42, th: rand() * Math.PI * 2, spin: (rand() - 0.5) * 1.6, g: (rand() - 0.35) * 0.55, rc: 0.06 + rand() * 0.08 });
            }
        }
        vort.push({
            sats,
            x: lf, y: (sign < 0 ? 1 : -1) * (0.25 + 0.25 * a),
            y0: (sign < 0 ? 1 : -1) * (0.25 + 0.25 * a),
            g: sign * 1.6 * Math.max(0.06, a), g0: sign * 1.6 * Math.max(0.06, a),
            rc2: 0.3 * 0.3, xb: lf
        });
    }

    return {
        setTier(t) { tier = t; buildSources(); },
        setColors(c) {
            colors = c;
            lut = lutDiverging(c.labNeg, c.surface, c.labPos, { knee: 0.04, gamma: 0.8 });
        },
        resize(w, h) {
            const scale = h / (2 * Y_HALF);
            view = { w, h, scale, xRight: X_LEFT + w / scale };
            const nx = Math.max(120, Math.min(280, Math.round(w / 3.5)));
            const ny = Math.max(40, Math.round(nx * h / w));
            field.resize(nx, ny, X_LEFT, Y_HALF, (view.xRight - X_LEFT) / nx);
        },
        reset() {
            vort.length = 0; eddies.length = 0; primed = false; simT = 0;
            for (const s of sources) { s.alive.fill(0); s.head = 0; s.acc = 0; }
        },
        setRegime(key) { turbulent = key === 'turbulent'; },
        /* reflect the drawn flow about the centerline (y → −y, ω → −ω) */
        mirror() {
            for (const v of vort) { v.y = -v.y; v.y0 = -v.y0; v.g = -v.g; v.g0 = -v.g0; for (const q of v.sats) q.th = -q.th; }
            for (const e of eddies) { e.y = -e.y; e.g = -e.g; }
            for (const s of sources) { for (let i = 0; i < s.n; i++) s.py[i] = -s.py[i]; }
            const tmp = sources[0]; sources[0] = sources[1]; sources[1] = tmp;
            lastPhase = lastPhase + Math.PI; phaseUnwrapped += Math.PI; nextRelease += Math.PI;
        },
        toScreen(x, y) { return [(x - X_LEFT) * view.scale, (Y_HALF - y) * view.scale]; },
        get view() { return view; },

        /* advance the drawn flow by dt (tu) using the current amplitude/phase */
        advance(dt, a, phase) {
            amp = a; simT += dt;
            if (!primed) { lastPhase = phase; phaseUnwrapped = phase; nextRelease = Math.ceil(phase / Math.PI) * Math.PI; primed = true; }
            let d = phase - lastPhase;
            if (d > Math.PI) d -= 2 * Math.PI;
            if (d < -Math.PI) d += 2 * Math.PI;
            lastPhase = phase;
            phaseUnwrapped += d;
            while (phaseUnwrapped >= nextRelease) {
                const k = Math.round(nextRelease / Math.PI);
                release(k % 2 === 0 ? -1 : 1, a);
                upperNext = !upperNext;
                nextRelease += Math.PI;
            }
            for (let k = vort.length - 1; k >= 0; k--) {
                const w = vort[k];
                w.x += U_C * dt;
                const past = Math.max(0, w.x - w.xb);
                w.g = w.g0 * Math.exp(-past / 18);
                w.y = w.y0 * (1 + 0.045 * past);
                w.rc2 += 0.018 * dt;
                if (w.x > view.xRight + 1.5) vort.splice(k, 1);
            }
            if (turbulent) {
                const target = tier >= 1 ? 14 : 26;
                while (eddies.length < target) {
                    const x = 0.7 + rand() * 2.2;
                    const row = rand() < 0.5 ? 1 : -1;
                    eddies.push({ x, y: row * (0.4 + rand() * 0.25), g: -row * (0.1 + rand() * 0.16), rc: 0.09 + rand() * 0.06, life: 1 + rand() * 2, age: 0 });
                }
                for (let k = eddies.length - 1; k >= 0; k--) {
                    const e = eddies[k];
                    e.age += dt; e.x += (U_C + (rand() - 0.5) * 0.2) * dt; e.y += (rand() - 0.5) * 0.12 * dt;
                    if (e.age > e.life || e.x > view.xRight + 0.5) eddies.splice(k, 1);
                }
            }
            advectParticles(dt);
        },

        draw(ctx, info) {
            if (!colors) return;
            const { w, h, scale } = view;
            const a = amp;
            const lf = formationLength(a);
            const kx = info.omega / U_C;

            /* vorticity field */
            field.clear();
            const layers = 12;
            for (const side of [1, -1]) {
                for (let i = 0; i < layers; i++) {
                    const s = (i + 0.5) / layers;
                    const x = 0.05 + s * (lf - 0.15);
                    const flap = 0.22 * s * s * (info.aRe * Math.cos(kx * x) + info.aIm * Math.sin(kx * x));
                    const y = side * (R + 0.02 + 0.12 * s) - flap * 0.9;
                    field.splat(x, y, -side * 1.15 * (1 - 0.35 * s), 0.11 + 0.09 * s);
                }
            }
            /* forming vortices at the end of the shear layers */
            const frac = ((info.phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
            const gForm = 1.6 * Math.max(0.06, a);
            const upperGrow = frac, lowerGrow = (frac + 0.5) % 1;
            field.splat(lf * 0.92, (0.25 + 0.25 * a) * 1.05, -gForm * upperGrow * 0.8, 0.26);
            field.splat(lf * 0.92, -(0.25 + 0.25 * a) * 1.05, gForm * lowerGrow * 0.8, 0.26);
            for (const v of vort) {
                const rc = Math.sqrt(v.rc2);
                field.splat(v.x, v.y, v.g * (v.sats.length ? 0.78 : 1), rc);
                for (const q of v.sats) {
                    const th = q.th + q.spin * (v.x - v.xb);
                    const rr = q.r * (1 + 0.08 * (v.x - v.xb));
                    field.splat(v.x + rr * Math.cos(th), v.y + rr * Math.sin(th), v.g * (q.g + 0.18), q.rc + 0.012 * (v.x - v.xb));
                }
            }
            if (turbulent) for (const e of eddies) {
                const life = Math.sin(Math.PI * Math.min(1, e.age / e.life));
                field.splat(e.x, e.y, e.g * life, e.rc);
            }
            field.blit(ctx, lut, 1.35, 0, 0, w, h);

            /* streaklines */
            const X = x => (x - X_LEFT) * scale, Y = y => (Y_HALF - y) * scale;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            const buckets = 3;
            for (const s of sources) {
                const base = s.strong ? 0.85 : 0.24;
                ctx.lineWidth = s.strong ? 1.6 : 0.9;
                const col = s.strong ? colors.text2 : colors.text3;
                for (let b = 0; b < buckets; b++) {
                    const k0 = Math.floor(s.n * b / buckets), k1 = Math.floor(s.n * (b + 1) / buckets) + 1;
                    ctx.strokeStyle = rgb(col, base * (1 - b * 0.3));
                    ctx.beginPath();
                    let run = 0, qx = 0, qy = 0, px = 0, py = 0;
                    for (let k = k0; k < Math.min(s.n, k1); k++) {
                        const i = (s.head - 1 - k + s.n * 2) % s.n;
                        if (!s.alive[i]) { run = 0; continue; }
                        const x = X(s.px[i]), y = Y(s.py[i]);
                        if (run && (Math.abs(s.px[i] - px) > 0.3 || Math.abs(s.py[i] - py) > 0.3)) run = 0;
                        if (run === 0) { ctx.moveTo(x, y); qx = x; qy = y; }
                        else { const mx = (qx + x) / 2, my = (qy + y) / 2; ctx.quadraticCurveTo(qx, qy, mx, my); qx = x; qy = y; }
                        run++; px = s.px[i]; py = s.py[i];
                    }
                    ctx.stroke();
                }
            }

            /* cylinder */
            const cx = X(0), cy = Y(0), cr = R * scale;
            ctx.fillStyle = rgb(colors.surface2);
            ctx.strokeStyle = rgb(colors.text2);
            ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

            /* actuation slots: θ measured from the front stagnation point */
            const [t0, t1] = info.slot;
            const hl = info.highlight;
            for (const side of [1, -1]) {
                ctx.strokeStyle = rgb(colors.accent, hl === 'control' ? 1 : 0.85);
                ctx.lineWidth = 3;
                ctx.beginPath();
                const a0 = Math.PI - t0 * Math.PI / 180, a1 = Math.PI - t1 * Math.PI / 180;
                if (side > 0) ctx.arc(cx, cy, cr, -a0, -a1, false); else ctx.arc(cx, cy, cr, a1, a0, false);
                ctx.stroke();
                const psi = side * info.psi;
                const norm = Math.max(-1, Math.min(1, psi / info.psiScale));
                if (Math.abs(norm) > 0.02) {
                    for (let j = 0; j < 5; j++) {
                        const sN = (j - 2) / 2.5;
                        const th = (t0 + (t1 - t0) * (j + 0.5) / 5) * Math.PI / 180;
                        const nx = -Math.cos(th), ny = side * Math.sin(th);
                        const len = 34 * norm * (1 - sN * sN);
                        const bx = cx + nx * cr, by = cy - ny * cr;
                        const ex = bx + nx * len, ey = by - ny * len;
                        ctx.strokeStyle = rgb(colors.accent);
                        ctx.lineWidth = 1.6;
                        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
                        const ang = Math.atan2(ey - by, ex - bx);
                        ctx.beginPath();
                        ctx.moveTo(ex, ey);
                        ctx.lineTo(ex - 5 * Math.cos(ang - 0.45), ey - 5 * Math.sin(ang - 0.45));
                        ctx.moveTo(ex, ey);
                        ctx.lineTo(ex - 5 * Math.cos(ang + 0.45), ey - 5 * Math.sin(ang + 0.45));
                        ctx.stroke();
                    }
                }
            }

            /* sensor probe on the centerline */
            const sx = X(info.xs), sy = Y(0);
            const sensorOn = info.showSensor;
            if (sensorOn) {
                const dimY = Y(-1.85);
                ctx.setLineDash([2, 4]);
                ctx.strokeStyle = rgb(colors.text3, 0.7);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cx, cy + cr + 4); ctx.lineTo(cx, dimY + 5);
                ctx.moveTo(sx, sy + 10); ctx.lineTo(sx, dimY + 5);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.strokeStyle = rgb(colors.text2, 0.9);
                ctx.beginPath(); ctx.moveTo(cx, dimY); ctx.lineTo(sx, dimY); ctx.stroke();
                for (const ex of [cx, sx]) { ctx.beginPath(); ctx.moveTo(ex, dimY - 4); ctx.lineTo(ex, dimY + 4); ctx.stroke(); }
                ctx.fillStyle = rgb(colors.text2);
                ctx.font = `500 11px ${colors.fontMono}`;
                ctx.textAlign = 'center';
                ctx.fillStyle = rgb(colors.surface, 0.9);
                const label = `xs/d = ${info.xs.toFixed(2)}`;
                const tw = ctx.measureText(label).width + 10;
                ctx.fillRect((cx + sx) / 2 - tw / 2, dimY - 8, tw, 16);
                ctx.fillStyle = rgb(colors.text2);
                ctx.textBaseline = 'middle';
                ctx.fillText(label, (cx + sx) / 2, dimY);
                ctx.textBaseline = 'alphabetic';
                ctx.textAlign = 'left';

                const pulse = hl === 'sensor' ? 1 + 0.25 * Math.sin(simT * 5) : 1;
                ctx.strokeStyle = rgb(colors.accent);
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(sx, sy, 7 * pulse, 0, Math.PI * 2); ctx.stroke();
                ctx.fillStyle = rgb(colors.accent);
                ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill();
                const arrow = (val, color, width) => {
                    const len = Math.max(-34, Math.min(34, val * 16));
                    if (Math.abs(len) < 2) return;
                    ctx.strokeStyle = color; ctx.lineWidth = width;
                    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - len); ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(sx, sy - len);
                    ctx.lineTo(sx - 4, sy - len + Math.sign(len) * 6);
                    ctx.moveTo(sx, sy - len);
                    ctx.lineTo(sx + 4, sy - len + Math.sign(len) * 6);
                    ctx.stroke();
                };
                if (info.showRaw) arrow(info.rawNorm, rgb(colors.text3, 0.8), 1.2);
                arrow(info.avgNorm, rgb(colors.accentInk), 2.2);
            }

            /* wall-pressure taps (FCNN-PS inputs): pairs at ±θ, value = upper − lower */
            if (info.taps) {
                for (const tap of info.taps) {
                    for (const side of [1, -1]) {
                        const th = tap.theta * Math.PI / 180;
                        const px = cx - Math.cos(th) * cr, py = cy - side * Math.sin(th) * cr;
                        const v = Math.max(-1, Math.min(1, tap.value * side));
                        ctx.fillStyle = rgb(v >= 0 ? colors.labPos : colors.labNeg, 0.35 + 0.65 * Math.abs(v));
                        ctx.strokeStyle = rgb(colors.surface);
                        ctx.lineWidth = 1.5;
                        ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                    }
                }
            }

            /* x/d ticks */
            ctx.fillStyle = rgb(colors.text3);
            ctx.strokeStyle = rgb(colors.text3, 0.6);
            ctx.font = `500 10px ${colors.fontMono}`;
            ctx.textAlign = 'center';
            for (let x = 0; x <= view.xRight - 0.9; x += 2) {
                const px = X(x);
                ctx.beginPath(); ctx.moveTo(px, h - 16); ctx.lineTo(px, h - 11); ctx.stroke();
                ctx.fillText(String(x), px, h - 4);
            }
            ctx.textAlign = 'right';
            ctx.fillText('x/d', w - 8, h - 4);
            ctx.textAlign = 'left';
            ctx.font = `500 11px ${colors.fontMono}`;
            ctx.fillStyle = rgb(colors.text2);
            ctx.fillText('u∞ →', 12, 20);

            /* spanwise-averaging inset */
            if (sensorOn && info.spanwiseInset) {
                const iw = 132, ih = 58, ix = w - iw - 12, iy = 12;
                ctx.fillStyle = rgb(colors.surface, 0.92);
                ctx.strokeStyle = rgb(colors.border);
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.roundRect ? ctx.roundRect(ix, iy, iw, ih, 8) : ctx.rect(ix, iy, iw, ih); ctx.fill(); ctx.stroke();
                ctx.fillStyle = rgb(colors.text3);
                ctx.font = `500 10px ${colors.fontMono}`;
                ctx.fillText('spanwise 8 pts', ix + 8, iy + 13);
                const midY = iy + 36, bw = 10, gap = 4, bx0 = ix + 10;
                ctx.strokeStyle = rgb(colors.border);
                ctx.beginPath(); ctx.moveTo(ix + 6, midY); ctx.lineTo(ix + iw - 6, midY); ctx.stroke();
                for (let j = 0; j < info.rawSpan.length; j++) {
                    const v = Math.max(-1, Math.min(1, info.rawSpan[j] / (info.rms0 * 2.5)));
                    ctx.fillStyle = rgb(colors.text3, 0.75);
                    ctx.fillRect(bx0 + j * (bw + gap), midY, bw, -v * 16);
                }
                const avg = Math.max(-1, Math.min(1, info.avgNorm / 2.5));
                ctx.strokeStyle = rgb(colors.accentInk);
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(bx0 - 3, midY - avg * 16); ctx.lineTo(bx0 + 8 * (bw + gap) - gap + 3, midY - avg * 16); ctx.stroke();
            }
        }
    };
}
