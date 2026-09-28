/* ============================================
   UDF explorable — unsteady distributed forcing of the cylinder wake
   x–z plane (top) view: spanwise-travelling forcing on the upper/lower slots,
   Kármán rollers vs oblique vortex shedding, recirculation length, force histories.
   Conceptual animation; trends follow thesis Part I Fig. 3.1–3.2 (no model numbers are shown).
   ============================================ */
import {
    media, debug, readTokens, rgb, mixOklab, createSurface, createLoop, createStripChart,
    createSteps, announcer, mountLab, fontsReady, rng
} from './core.js?v=2026q3';

const TIME_SCALE = 1.4;           /* tu per second of playback */
const LZ = Math.PI;               /* spanwise domain = forcing wavelength (m = 1) */
const ST = 0.211;                 /* uncontrolled Strouhal number */
const CD0 = 1.018, CL0 = 0.195;   /* uncontrolled LES values (thesis Table 3.1) */
const Z_A = 0.2 * LZ, Z_C = Z_A + LZ / 2;

/* trend of thesis Fig. 3.1 (V0/u∞ = 0.4, m = 1), used only to shape the conceptual response */
const FREQ = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
const TREND = {
    SI: { cd: [0.81, 1.22, 1.05, 0.58, 0.60, 0.63, 0.70, 0.75, 0.80, 0.91], cl: [0.05, 0.70, 0.38, 0.005, 0.01, 0.015, 0.03, 0.05, 0.075, 0.11] },
    SO: { cd: [0.84, 1.07, 0.75, 0.58, 0.60, 0.63, 0.70, 0.75, 0.80, 0.91], cl: [0.05, 0.54, 0.05, 0.005, 0.01, 0.015, 0.03, 0.05, 0.075, 0.11] },
    O: { cd: [0.81, 1.06, 0.91, 0.61, 0.60, 0.63, 0.70, 0.75, 0.80, 0.91], cl: [0.05, 0.35, 0.25, 0.015, 0.01, 0.015, 0.03, 0.05, 0.075, 0.11] }
};
const OVS = [0, 0, 0.5, 1, 0.9, 0.8, 0.6, 0.5, 0.45, 0.35];   /* coherence of oblique vortex shedding vs f_m* */

function interp(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + t * (ys[i] - ys[i - 1]); }
    return ys[ys.length - 1];
}
const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const amplitudeGain = v0 => smooth(v0 / 0.4) * (v0 > 0 ? 1 : 0);     /* saturates at V0/u∞ ≥ 0.4 */

function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function noise1(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return (hash(i) * (1 - u) + hash(i + 1) * u) * 2 - 1; }

const STEPS = [
    { key: 'none', control: false, cfg: 'SI', f: 0.75, v0: 0.4, sections: false },
    { key: 'sdf', control: true, cfg: 'SI', f: 0, v0: 0.4, sections: false },
    { key: 'udf', control: true, cfg: 'SI', f: 0.75, v0: 0.4, sections: false },
    { key: 'desync', control: true, cfg: 'SI', f: 0.75, v0: 0.4, sections: true },
    { key: 'explore', control: null, sections: true }
];
const PREROLL = { none: [40, 0], sdf: [16, 50], udf: [16, 50], desync: [10, 60] };
const PRESETS = {
    optimum: { cfg: 'SI', f: 0.75, v0: 0.4 },
    low: { cfg: 'SI', f: 0.25, v0: 0.4 },
    high: { cfg: 'SI', f: 3, v0: 0.4 },
    sdf: { cfg: 'SI', f: 0, v0: 0.4 }
};

mountLab(document.querySelector('[data-lab="udf"]'), async root => {
    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));
    const stageWrap = q('.lab-canvas-wrap'), stageCanvas = q('.lab-canvas');
    const chartWrap = q('.lab-chart-wrap'), chartCanvas = q('.lab-chart');
    const captionEl = q('.lab-caption');
    const say = announcer(q('.lab-sr'));
    const playBtn = q('[data-act="play"]'), resetBtn = q('[data-act="reset"]');
    const ctrlBtn = q('[data-param="control"]');
    const inputs = { f: q('#lab-fm'), v0: q('#lab-v0') };
    const outputs = { f: q('output[for="lab-fm"]'), v0: q('output[for="lab-v0"]') };
    const marks = { f: q('[data-mark="fm"]'), v0: q('[data-mark="v0"]') };
    const cfgText = q('.lab-cfg-text');
    const debugEl = q('.lab-debug');
    const captions = {}, cfgDesc = {};
    qa('template[data-caption]').forEach(t => { captions[t.dataset.caption] = { html: t.innerHTML.trim(), text: t.content.textContent.trim() }; });
    qa('template[data-cfg]').forEach(t => { cfgDesc[t.dataset.cfg] = t.innerHTML.trim(); });

    let params = { cfg: 'SI', f: 0.75, v0: 0.4 };
    let control = false, tOn = 0, t = 0, stepIndex = 0, colors = null, loop = null, ready = false;
    let K = 1, cdMean = 1, coh = 0, lr = 1.36, thetaK = 0, clNoise = 0, ramp = 0;
    const secNoise = new Float32Array(16);
    let rollers = [], nextRoller = 0, rollerSide = 1;
    const eddies = [];
    const rand = rng(11);
    const view = { w: 1, h: 1, s: 1, x0: -1.1, x1: 9, top: 56, bottom: 30 };
    let forcingLut = [];

    await fontsReady();

    function readColors() {
        const tk = readTokens(root, ['--surface', '--surface-2', '--border', '--text', '--text-2', '--text-3', '--accent', '--accent-soft', '--accent-ink', '--primary', '--warn-ink', '--lab-neg', '--lab-pos']);
        const cs = getComputedStyle(root);
        colors = {
            surface: tk['--surface'], surface2: tk['--surface-2'], border: tk['--border'],
            text: tk['--text'], text2: tk['--text-2'], text3: tk['--text-3'],
            accent: tk['--accent'], accentSoft: tk['--accent-soft'], accentInk: tk['--accent-ink'],
            primary: tk['--primary'], warnInk: tk['--warn-ink'], labNeg: tk['--lab-neg'], labPos: tk['--lab-pos'],
            fontMono: cs.getPropertyValue('--font-mono').trim() || 'monospace'
        };
        forcingLut = [];
        for (let i = 0; i <= 32; i++) {
            const v = i / 16 - 1;
            forcingLut.push(rgb(v < 0 ? mixOklab(colors.surface2, colors.text3, -v) : mixOklab(colors.surface2, colors.accent, v)));
        }
        chart.setColors(colors);
    }

    const stage = createSurface(stageWrap, stageCanvas, {
        onResize: s => {
            view.w = s.w; view.h = s.h;
            view.s = Math.max(8, s.h - view.top - view.bottom) / LZ;
            view.x1 = view.x0 + s.w / view.s;
            if (ready && !loop.running) render();
        }
    });
    const X = x => (x - view.x0) * view.s;
    const Z = z => view.h - view.bottom - z * view.s;

    const chart = createStripChart(chartWrap, chartCanvas, {
        span: 24, sampleDt: 0.05,
        lanes: [
            { key: 'fa', second: 'fc', label: '가진 ψ(z)', range: 1.3, color: 'accentInk' },
            { key: 'da', second: 'dc', label: '단면 항력', range: 0.42, center: 0.85, base: 1, color: 'accentInk' },
            { key: 'cd', label: '전체 항력', range: 0.42, center: 0.85, base: 1, color: 'warnInk' },
            { key: 'cl', label: '양력 CL', range: 2.8, color: 'primary', envelope: () => Math.SQRT2 }
        ]
    });

    /* --- forcing ψ(t, z)/V0 = sin 2π(mz/Lz − f_m t), m = 1 (thesis Eq. 2.1; UDF-SI / UDF-SO / UDF-O) --- */
    function forcing(side, z) {
        const f = params.f, cfg = params.cfg;
        const dir = side < 0 && cfg === 'O' ? -1 : 1;
        const zeta = side < 0 && cfg === 'SO' ? Math.PI : 0;
        return Math.sin(2 * Math.PI * (z / LZ - dir * f * t) + zeta);
    }

    function targets() {
        const tr = TREND[params.cfg];
        const g = amplitudeGain(params.v0) * ramp;
        const cdN = 1 + (interp(FREQ, tr.cd, params.f) / CD0 - 1) * g;
        const clN = 1 + (interp(FREQ, tr.cl, params.f) / CL0 - 1) * g;
        const c = interp(FREQ, OVS, params.f) * g;
        return { cdN, clN, c };
    }

    function stepSim(dt) {
        t += dt;
        ramp = control ? smooth((t - tOn) / 6) : Math.max(0, ramp - dt / 6);
        const tg = targets();
        const k = 1 - Math.exp(-dt / 8), kc = 1 - Math.exp(-dt / 5);
        K += (Math.sqrt(tg.clN) - K) * k;
        cdMean += (tg.cdN - cdMean) * k;
        coh += (tg.c - coh) * kc;
        const lrT = 1.36 + (3.10 - 1.36) * smooth((1 - cdMean) / (1 - 0.579 / CD0));
        lr += (lrT - lr) * k;
        thetaK += 2 * Math.PI * ST * dt * (1 + 0.04 * noise1(t * 0.3));
        const dec = Math.exp(-dt / 1.2);
        clNoise = clNoise * dec + Math.sqrt(1 - dec * dec) * (rand() * 2 - 1) * 1.2;
        for (let i = 0; i < secNoise.length; i++) secNoise[i] = secNoise[i] * dec + Math.sqrt(1 - dec * dec) * (rand() * 2 - 1);

        /* Kármán rollers: released alternately from the upper and lower sides */
        if (t >= nextRoller) {
            rollers.push({ tb: t, side: rollerSide, seed: rand() * 100 });
            rollerSide = -rollerSide;
            nextRoller = t + 0.5 / ST;
        }
        rollers = rollers.filter(r => 1.1 + 0.8 * (t - r.tb) < view.x1 + 1);

        /* small-scale turbulent eddies advected downstream */
        const want = media.coarse ? 70 : 130;
        while (eddies.length < want) eddies.push({ x: 1.2 + rand() * (view.x1 - 1.2), z: rand() * LZ, a: rand() * Math.PI, l: 0.08 + rand() * 0.14 });
        for (const e of eddies) {
            e.x += 0.8 * dt; e.a += (rand() - 0.5) * 0.3;
            if (e.x > view.x1 + 0.3) { e.x = 1.2 + rand() * 0.6; e.z = rand() * LZ; }
        }
    }

    function sectionalDrag(z, idx) {
        const kFluct = 0.05 * K * (Math.cos(2 * thetaK + 0.6 * noise1(z * 0.7 + 3)) * 0.8 + 0.6 * secNoise[idx % secNoise.length]);
        const local = 0.088 * coh * forcing(1, z);
        return cdMean + kFluct + local;
    }

    function sample() {
        let sum = 0;
        const n = 16;
        for (let i = 0; i < n; i++) {
            const z = (i + 0.5) / n * LZ;
            sum += cdMean + 0.05 * K * (Math.cos(2 * thetaK + 0.6 * noise1(z * 0.7 + 3)) * 0.8 + 0.6 * secNoise[i]) + 0.088 * coh * forcing(1, z);
        }
        const a = ramp * params.v0 / 0.4;
        chart.push(t, {
            fa: forcing(1, Z_A) * a,
            fc: forcing(1, Z_C) * a,
            da: sectionalDrag(Z_A, 3), dc: sectionalDrag(Z_C, 11),
            cd: sum / n,
            cl: K * (Math.SQRT2 * Math.cos(thetaK) * 0.92 + 0.25 * clNoise)
        });
    }

    function advance(dtWorld) {
        const n = Math.max(1, Math.ceil(dtWorld / 0.02));
        const dt = dtWorld / n;
        for (let i = 0; i < n; i++) { stepSim(dt); if (i === n - 1 || i % 3 === 0) sample(); }
    }

    function reset() {
        t = 0; K = 1; cdMean = 1; coh = 0; lr = 1.36; thetaK = 0; ramp = 0; control = false;
        rollers = []; nextRoller = 0; eddies.length = 0; chart.clear();
        for (let i = 0; i < 40; i++) advance(0.25);
    }

    /* --- drawing --- */
    function drawTube(pts, color, alpha, width) {
        if (pts.length < 2 || alpha <= 0.01) return;
        const { ctx } = stage;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = rgb(color, alpha * 0.22);
        ctx.lineWidth = width * 2.6;
        ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
        ctx.strokeStyle = rgb(color, alpha);
        ctx.lineWidth = width;
        ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    }

    function render() {
        if (!colors) return;
        const { ctx, w, h } = stage;
        const st = STEPS[stepIndex];
        const showSections = st.sections;
        ctx.fillStyle = rgb(colors.surface);
        ctx.fillRect(0, 0, w, h);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, view.top - 4, w, h - view.top - view.bottom + 8); ctx.clip();

        /* recirculation region */
        const xr0 = X(0.5), xr1 = X(0.5 + lr);
        ctx.fillStyle = rgb(colors.text3, 0.07);
        ctx.fillRect(xr0, Z(LZ), xr1 - xr0, Z(0) - Z(LZ));
        ctx.setLineDash([4, 4]); ctx.strokeStyle = rgb(colors.text3, 0.7); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xr1, Z(LZ)); ctx.lineTo(xr1, Z(0)); ctx.stroke(); ctx.setLineDash([]);

        /* turbulent eddies */
        ctx.lineWidth = 1.2;
        const eddyAlpha = 0.07 + 0.08 * Math.min(1.6, K) + 0.04 * coh;
        ctx.strokeStyle = rgb(colors.text3, eddyAlpha);
        ctx.beginPath();
        for (const e of eddies) {
            if (e.x < 0.6 + lr * 0.8) continue;
            const x = X(e.x), z = Z(e.z), r = e.l * view.s * 0.6;
            ctx.moveTo(x + r * Math.cos(e.a), z + r * Math.sin(e.a));
            ctx.arc(x, z, r, e.a, e.a + 2.4);
        }
        ctx.stroke();

        /* Kármán rollers: nominally spanwise-parallel, alternating upper/lower */
        const sdf = params.f < 0.02 ? amplitudeGain(params.v0) * ramp : 0;
        const rollerAlpha = Math.min(1, K * 0.9);
        for (const r of rollers) {
            const x0 = 1.1 + 0.8 * (t - r.tb);
            if (x0 < 0.7) continue;
            const pts = [];
            for (let i = 0; i <= 24; i++) {
                const z = i / 24 * LZ;
                const wav = 0.22 * noise1(z * 1.3 + r.seed) * Math.min(1.5, 0.6 + 0.3 * (x0 - 1)) * Math.max(0.6, K);
                const standing = 0.45 * sdf * Math.sin(2 * Math.PI * z / LZ) * r.side;
                pts.push([X(x0 + wav + standing), Z(z)]);
            }
            const fade = smooth((x0 - 0.8) / 0.8) * Math.exp(-Math.max(0, x0 - 6) / 3);
            drawTube(pts, r.side > 0 ? colors.labNeg : colors.labPos, rollerAlpha * fade * 0.9, 3.4 + 1.6 * Math.max(0, K - 1));
        }

        /* oblique vortex shedding: crests of the travelling forcing convected downstream */
        if (coh > 0.02 && params.f > 0.02) {
            const Uo = 0.55, xs = 0.55, f = params.f;
            const width = Math.max(1.3, Math.min(4.2, 3.2 * Math.sqrt(0.75 / f)));
            for (const side of [1, -1]) {
                const dir = side < 0 && params.cfg === 'O' ? -1 : 1;
                const phi0 = side < 0 && params.cfg === 'SO' ? 0.5 : 0;
                const offset = side < 0 && params.cfg === 'SI' ? 0.07 : 0;
                const kMin = Math.floor(f * (t - (view.x1 - xs) / Uo) - 2), kMax = Math.ceil(f * t + 2);
                for (let k = kMin; k <= kMax; k++) {
                    const pts = [];
                    let alphaSum = 0;
                    for (let i = 0; i <= 28; i++) {
                        const z = i / 28 * LZ;
                        const tau = (k + dir * z / LZ - phi0 - 0.25) / f;
                        const age = t - tau;
                        const x = xs + Uo * age + offset;
                        if (age < 0) continue;
                        const wig = 0.06 * Math.max(0, x - 2) * noise1(z * 2.1 + k * 3.7 + side * 11);
                        pts.push([X(x + wig), Z(z)]);
                        alphaSum += smooth(age / 0.6) * Math.exp(-Math.max(0, x - xs) / (1.6 + 2.2 * coh));
                    }
                    const a = coh * alphaSum / 29;
                    drawTube(pts, side > 0 ? colors.labNeg : colors.labPos, Math.min(1, a * 1.25), width);
                }
            }
        }
        ctx.restore();

        /* cylinder (top view) with the two actuation slots */
        const cx0 = X(-0.5), cx1 = X(0.5), zt = Z(LZ), zb = Z(0);
        const grd = ctx.createLinearGradient(cx0, 0, cx1, 0);
        grd.addColorStop(0, rgb(colors.border)); grd.addColorStop(0.5, rgb(colors.surface2)); grd.addColorStop(1, rgb(colors.border));
        ctx.fillStyle = grd;
        ctx.fillRect(cx0, zt, cx1 - cx0, zb - zt);
        ctx.strokeStyle = rgb(colors.text2); ctx.lineWidth = 1.2;
        ctx.strokeRect(cx0 + 0.5, zt + 0.5, cx1 - cx0 - 1, zb - zt - 1);
        const g = ramp * params.v0 / 0.4;
        const strips = [[-0.25, -0.05, 1], [0.05, 0.25, -1]];
        const cells = Math.max(24, Math.round((zb - zt) / 4));
        for (const [a, b, side] of strips) {
            const xa = X(a), xb = X(b);
            for (let i = 0; i < cells; i++) {
                const z = (i + 0.5) / cells * LZ;
                const v = Math.max(-1, Math.min(1, forcing(side, z) * Math.min(1.5, g)));
                ctx.fillStyle = forcingLut[Math.round((v + 1) * 16)];
                ctx.fillRect(xa, Z((i + 1) / cells * LZ), xb - xa, (zb - zt) / cells + 0.5);
            }
            ctx.strokeStyle = rgb(colors.text3, 0.8); ctx.lineWidth = 1;
            ctx.strokeRect(xa, zt, xb - xa, zb - zt);
        }

        /* labels and axes */
        ctx.font = `500 11px ${colors.fontMono}`;
        ctx.fillStyle = rgb(colors.text2);
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        const arrowU = params.f > 0.02 && ramp > 0.05 ? ' ↑' : '';
        const arrowL = params.f > 0.02 && ramp > 0.05 ? (params.cfg === 'O' ? ' ↓' : ' ↑') : '';
        ctx.fillText('ψᵁ' + arrowU, X(-0.15), zt - 8);
        ctx.fillText('ψᴸ' + arrowL, X(0.15), zt - 8);
        ctx.textAlign = 'left';
        ctx.fillStyle = rgb(colors.text3);
        ctx.fillText('u∞ →', X(0.8), zt - 8);
        ctx.textAlign = 'left';
        ctx.fillText('L_r', xr1 + 4, zt + 14);

        ctx.strokeStyle = rgb(colors.text3, 0.6); ctx.lineWidth = 1;
        ctx.textAlign = 'center';
        for (let x = 0; x <= view.x1 - 0.4; x += 2) {
            const px = X(x);
            ctx.beginPath(); ctx.moveTo(px, zb + 4); ctx.lineTo(px, zb + 9); ctx.stroke();
            ctx.fillText(String(x), px, zb + 21);
        }
        ctx.textAlign = 'right';
        ctx.fillText('x/d', w - 8, zb + 21);
        ctx.textAlign = 'left';
        const zTicks = [[0, '0'], [LZ / 2, 'π/2'], [LZ, 'π']];
        for (const [z, lab] of zTicks) ctx.fillText(lab, 6, Z(z) + 4);
        ctx.fillText('z/d', 6, zt - 8 < 12 ? 12 : zt - 8);

        if (showSections) {
            ctx.setLineDash([3, 4]);
            for (const [z, lab] of [[Z_A, 'z_A'], [Z_C, 'z_C']]) {
                ctx.strokeStyle = rgb(colors.accentInk, 0.8);
                ctx.beginPath(); ctx.moveTo(X(-0.5), Z(z)); ctx.lineTo(w - 36, Z(z)); ctx.stroke();
                ctx.fillStyle = rgb(colors.accentInk);
                ctx.textAlign = 'right';
                ctx.fillText(lab, w - 8, Z(z) + 4);
            }
            ctx.setLineDash([]);
        }

        chart.draw();
        ctrlBtn.classList.toggle('is-ramping', control && ramp < 0.98);
        if (debugEl) { const d = loop.stats(); debugEl.textContent = `${d.avg.toFixed(1)} ms · tier ${d.tier}`; }
    }

    loop = createLoop({ root, tick: dt => advance(dt * TIME_SCALE), draw: render });

    function fmt(k, v) { return k === 'f' ? v.toFixed(2) : v.toFixed(2); }
    function syncControls() {
        for (const k of ['f', 'v0']) {
            inputs[k].value = params[k];
            outputs[k].textContent = fmt(k, params[k]);
            inputs[k].setAttribute('aria-valuetext', k === 'f' ? `f_m* ${fmt(k, params[k])}` : `V0/u∞ ${fmt(k, params[k])}`);
        }
        marks.f.style.setProperty('--pos', String(0.75 / +inputs.f.max));
        marks.v0.style.setProperty('--pos', String(0.4 / +inputs.v0.max));
        qa('input[name="lab-cfg"]').forEach(r => { r.checked = r.value === params.cfg; });
        cfgText.innerHTML = cfgDesc[params.cfg] || '';
    }

    function setControl(on) {
        if (on && !control) { tOn = t; chart.mark(t, 'on'); chart.mark(t, 'ramp', t + 8); }
        control = on;
        ctrlBtn.setAttribute('aria-pressed', String(on));
        stageCanvas.setAttribute('aria-label', `원형 실린더 후류 x–z 평면의 와류 구조 개념 애니메이션. 제어 ${on ? '적용' : '미적용'}.`);
    }

    function selectStep(i) {
        stepIndex = i;
        const st = STEPS[i];
        if (st.control !== null && ready) {
            params = { cfg: st.cfg, f: st.f, v0: st.v0 };
            syncControls();
            reset();
            const [off, on] = PREROLL[st.key];
            for (let k = 0; k < off * 4; k++) advance(0.25);
            if (st.control) { setControl(true); for (let k = 0; k < on * 4; k++) advance(0.25); } else setControl(false);
        }
        const c = captions[st.key] || { html: '', text: '' };
        captionEl.innerHTML = c.html;
        say(c.text);
        if (ready) render();
    }

    const steps = createSteps(q('.lab-steps'), selectStep);
    const toExplore = () => { if (steps.current !== STEPS.length - 1) steps.select(STEPS.length - 1); };

    for (const k of ['f', 'v0']) {
        inputs[k].addEventListener('input', () => {
            params[k] = +inputs[k].value;
            toExplore();
            syncControls();
            if (!control) setControl(true);
            if (media.reduced) for (let n = 0; n < 200; n++) advance(0.25);
            render();
        });
    }
    qa('input[name="lab-cfg"]').forEach(r => r.addEventListener('change', () => {
        if (!r.checked) return;
        params.cfg = r.value;
        toExplore();
        syncControls();
        if (!control) setControl(true);
        if (media.reduced) for (let n = 0; n < 200; n++) advance(0.25);
        render();
    }));
    qa('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
        params = { ...PRESETS[btn.dataset.preset] };
        toExplore();
        syncControls();
        if (!control) setControl(true);
        if (media.reduced) for (let n = 0; n < 200; n++) advance(0.25);
        render();
    }));
    ctrlBtn.addEventListener('click', () => {
        setControl(!control);
        toExplore();
        if (media.reduced) for (let n = 0; n < 200; n++) advance(0.25);
        render();
    });
    playBtn.addEventListener('click', () => {
        const playing = loop.toggle();
        playBtn.textContent = playing ? '일시정지' : '재생';
        playBtn.setAttribute('aria-label', playing ? '애니메이션 일시정지' : '애니메이션 재생');
    });
    resetBtn.addEventListener('click', () => steps.select(0));
    media.on('dark', () => { readColors(); render(); });

    readColors();
    syncControls();
    reset();
    playBtn.textContent = media.reduced ? '재생' : '일시정지';
    if (debug && debugEl) debugEl.hidden = false;
    ready = true;
    const qs = new URLSearchParams(location.search);
    steps.select(qs.has('labstep') ? Math.max(0, Math.min(STEPS.length - 1, (+qs.get('labstep') || 1) - 1)) : 0);
    if (qs.has('labpreset') && PRESETS[qs.get('labpreset')]) q(`[data-preset="${qs.get('labpreset')}"]`).click();
});
