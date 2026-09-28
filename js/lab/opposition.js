/* ============================================
   Opposition-control explorable — turbulent channel flow, y–z cross-section
   Near-wall streamwise vortices (2D point vortices with wall images), sensing plane y+ = 10,
   wall blowing/suction opposite to the sensed (or ANN-predicted) wall-normal velocity.
   Conceptual animation; reductions and correlations quoted from the M.S. thesis only.
   ============================================ */
import {
    media, debug, readTokens, rgb, mixOklab, lutDiverging, createSurface, createField, createLoop,
    createStripChart, createSteps, announcer, mountLab, fontsReady, rng
} from './core.js?v=2026q3';

const TIME_SCALE = 5;             /* conceptual wall time units per second */
const Y_MAX = 44, Y_SENSE = 10;
const TEMPLATE = 15 * 4.35;       /* 15 points × Δz+ = 4.35 */

/* drag reduction (Table 6, Sec. 3.2.2) and prediction correlation (Fig. 16, 21) */
const MODES = {
    none: { dr: 0, noise: 0, predicted: false },
    original: { dr: 0.198, noise: 0, predicted: false },
    pressure: { dr: 0.161, noise: 0.62, predicted: true },
    shear: { dr: 0.202, noise: 0.48, predicted: true }
};

const STEPS = [
    { key: 'vortex', mode: 'none', control: false, template: false },
    { key: 'opposition', mode: 'original', control: true, template: false },
    { key: 'pressure', mode: 'pressure', control: true, template: true },
    { key: 'result', mode: 'pressure', control: true, template: true },
    { key: 'explore', mode: null, control: null, template: true }
];
const PREROLL = { vortex: [120, 0], opposition: [60, 140], pressure: [60, 80], result: [40, 260] };

const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

mountLab(document.querySelector('[data-lab="opposition"]'), async root => {
    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));
    const stageWrap = q('.lab-canvas-wrap'), stageCanvas = q('.lab-canvas');
    const chartWrap = q('.lab-chart-wrap'), chartCanvas = q('.lab-chart');
    const scatterWrap = q('.lab-scatter-wrap'), scatterCanvas = q('.lab-scatter-canvas');
    const scatterText = q('.lab-scatter-text');
    const captionEl = q('.lab-caption');
    const say = announcer(q('.lab-sr'));
    const playBtn = q('[data-act="play"]'), resetBtn = q('[data-act="reset"]');
    const ctrlBtn = q('[data-param="control"]');
    const debugEl = q('.lab-debug');
    const captions = {}, modeNotes = {};
    qa('template[data-caption]').forEach(t => { captions[t.dataset.caption] = { html: t.innerHTML.trim(), text: t.content.textContent.trim() }; });
    qa('template[data-mode]').forEach(t => { modeNotes[t.dataset.mode] = t.innerHTML.trim(); });

    let mode = 'none', control = false, tOn = 0, t = 0, ramp = 0, dp = 1, stepIndex = 0;
    let colors = null, lut = null, pLut = [], loop = null, ready = false;
    let vortices = [], nextSpawn = 0;
    const rand = rng(23);
    const field = createField();
    const view = { w: 1, h: 1, s: 1, z1: 150, top: 40, bottom: 34 };
    const NS = 96;
    const vTrue = new Float32Array(NS), vUsed = new Float32Array(NS), pw = new Float32Array(NS), errW = new Float32Array(NS);
    const errPh = Array.from({ length: 5 }, () => ({ k: 1 + Math.floor(rand() * 5), ph: rand() * 6.28, w: 0.02 + rand() * 0.04 }));
    const pPh = Array.from({ length: 4 }, () => ({ k: 1 + Math.floor(rand() * 3), ph: rand() * 6.28, w: 0.01 + rand() * 0.02 }));
    const scatter = new Float32Array(900 * 2);
    let scHead = 0, scCount = 0, vScale = 1;

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
        lut = lutDiverging(colors.labNeg, colors.surface, colors.labPos, { knee: 0.05, gamma: 0.8 });
        pLut = [];
        for (let i = 0; i <= 32; i++) {
            const v = i / 16 - 1;
            pLut.push(rgb(v < 0 ? mixOklab(colors.surface2, colors.text2, -v) : mixOklab(colors.surface2, colors.warnInk, v)));
        }
        chart.setColors(colors);
    }

    const stage = createSurface(stageWrap, stageCanvas, {
        onResize: s => {
            view.w = s.w; view.h = s.h;
            view.s = Math.max(8, s.h - view.top - view.bottom) / Y_MAX;
            view.z1 = s.w / view.s;
            const nx = Math.max(90, Math.min(220, Math.round(s.w / 4)));
            const dx = view.z1 / nx;
            field.resize(nx, Math.ceil(Y_MAX / dx) + 1, 0, Y_MAX, dx);
            if (ready && !loop.running) render();
        }
    });
    const Zp = z => z * view.s;
    const Yp = y => view.h - view.bottom - y * view.s;
    const scatterSurf = createSurface(scatterWrap, scatterCanvas, { onResize: () => { if (ready) drawScatter(); } });

    const chart = createStripChart(chartWrap, chartCanvas, {
        span: 120, sampleDt: 0.25,
        lanes: [
            { key: 'v', second: 'vt', label: '센싱 v (y⁺=10)', range: 2.8, color: 'accentInk' },
            { key: 'phi', label: '벽면 가진 φ_w', range: 2.8, color: 'accent' },
            { key: 'dp', label: '평균 압력 변화', range: 0.22, center: 0.9, base: 1, color: 'warnInk' }
        ]
    });

    /* counter-rotating pair of near-wall streamwise vortices */
    function spawn(z) {
        const zc = z ?? rand() * view.z1, sep = 18 + rand() * 10, sgn = rand() < 0.5 ? -1 : 1;
        const life = 60 + rand() * 60, y = 14 + rand() * 12;
        for (const side of [-1, 1]) {
            const g = sgn * side * (0.9 + 0.4 * rand());
            vortices.push({ z: ((zc + side * sep / 2) % view.z1 + view.z1) % view.z1, y: y + (rand() - 0.5) * 4, g0: g, g: 0, age: 0, life, rc: 5.5 + rand() * 2 });
        }
    }

    function induced(z, y, skip) {
        let u = 0, v = 0;
        for (const vx of vortices) {
            if (vx === skip) continue;
            for (const sgn of [1, -1]) {
                const yi = sgn * vx.y, gi = sgn * vx.g;
                for (const shift of [-view.z1, 0, view.z1]) {
                    const dz = z - (vx.z + shift), dy = y - yi;
                    const r2 = dz * dz + dy * dy + vx.rc * vx.rc;
                    u += -gi * dy / r2; v += gi * dz / r2;
                }
            }
        }
        return [u * 3.2, v * 3.2];
    }

    function stepSim(dt) {
        t += dt;
        ramp = control ? smooth((t - tOn) / 20) : Math.max(0, ramp - dt / 20);
        const m = MODES[mode];
        const damp = 1 - 2.2 * m.dr * ramp;
        const target = 1 - m.dr * ramp;
        dp += (target - dp) * (1 - Math.exp(-dt / 40));
        if (t >= nextSpawn && vortices.length < 2 * Math.max(2, Math.round(view.z1 / 60))) { spawn(); nextSpawn = t + 10 + rand() * 12; }
        for (const vx of vortices) {
            vx.age += dt;
            const env = smooth(vx.age / 18) * smooth((vx.life - vx.age) / 18);
            vx.g = vx.g0 * env * damp;
            const [u, v] = induced(vx.z, vx.y, vx);
            /* self-image drift parallel to the wall */
            const self = -vx.g / (2 * vx.y) * 3.2 * 0.5;
            vx.z += (u + self) * dt;
            vx.y += (v * 0.4 + (rand() - 0.5) * 0.4) * dt;
            vx.y = Math.max(9, Math.min(34, vx.y));
            vx.z = (vx.z % view.z1 + view.z1) % view.z1;
        }
        vortices = vortices.filter(vx => vx.age < vx.life);

        /* sensing plane, prediction, wall pressure, actuation */
        let ss = 0;
        for (let i = 0; i < NS; i++) {
            const z = (i + 0.5) / NS * view.z1;
            vTrue[i] = induced(z, Y_SENSE)[1];
            ss += vTrue[i] * vTrue[i];
        }
        const std = Math.sqrt(ss / NS) || 1;
        vScale += (Math.max(std, 0.05) - vScale) * (1 - Math.exp(-dt / 30));
        for (let i = 0; i < NS; i++) {
            const x = i / NS;
            let e = 0;
            for (const p of errPh) e += Math.sin(2 * Math.PI * p.k * x + p.ph + t * p.w);
            const dec = Math.exp(-dt / 4);
            errW[i] = errW[i] * dec + Math.sqrt(1 - dec * dec) * (rand() * 2 - 1) * 1.73;
            e = 0.7 * e / Math.sqrt(errPh.length / 2) + 0.7 * errW[i];
            vUsed[i] = m.predicted ? vTrue[i] + m.noise * vScale * e : vTrue[i];
            let lowP = 0;
            for (const vx of vortices) {
                const dz = Math.min(Math.abs((i + 0.5) / NS * view.z1 - vx.z), view.z1 - Math.abs((i + 0.5) / NS * view.z1 - vx.z));
                lowP -= vx.g * vx.g * Math.exp(-(dz * dz) / (2 * 14 * 14)) / (vx.y / 15);
            }
            let bg = 0;
            for (const p of pPh) bg += Math.sin(2 * Math.PI * p.k * x + p.ph + t * p.w);
            pw[i] = 0.45 * lowP + 0.55 * bg / 2;
        }
        /* zero net mass flux of the actuation */
        let mean = 0;
        for (let i = 0; i < NS; i++) mean += vUsed[i];
        mean /= NS;
        for (let i = 0; i < NS; i++) vUsed[i] -= mean;
    }

    function sample() {
        const i0 = Math.round(NS * 0.42);
        const phi = mode === 'none' ? 0 : -vUsed[i0] * ramp;
        chart.push(t, { v: (mode === 'none' ? vTrue[i0] : vUsed[i0]) / vScale, vt: vTrue[i0] / vScale, phi: phi / vScale, dp });
        if (MODES[mode].predicted || mode === 'original') {
            for (let k = 0; k < 3; k++) {
                const i = Math.floor(rand() * NS);
                scatter[scHead * 2] = vTrue[i] / vScale; scatter[scHead * 2 + 1] = vUsed[i] / vScale;
                scHead = (scHead + 1) % 900; if (scCount < 900) scCount++;
            }
        }
    }

    function advance(dtWorld) {
        const n = Math.max(1, Math.ceil(dtWorld / 0.5));
        const dt = dtWorld / n;
        for (let i = 0; i < n; i++) { stepSim(dt); sample(); }
    }

    function reset() {
        t = 0; ramp = 0; dp = 1; control = false; vortices = []; nextSpawn = 0; scHead = 0; scCount = 0;
        chart.clear();
        for (let i = 0; i < Math.max(2, Math.round(view.z1 / 70)); i++) { spawn(i / Math.max(2, Math.round(view.z1 / 70)) * view.z1); const a = rand() * 50; vortices[vortices.length - 1].age = a; vortices[vortices.length - 2].age = a; }
        for (let i = 0; i < 40; i++) advance(1);
    }

    function arrow(ctx, x, y0, len, color, width) {
        if (Math.abs(len) < 1.5) return;
        const y1 = y0 - len;
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        const d = Math.sign(len) * 4;
        ctx.beginPath(); ctx.moveTo(x, y1 - d * 0.2); ctx.lineTo(x - 3, y1 + d); ctx.lineTo(x + 3, y1 + d); ctx.closePath(); ctx.fill();
    }

    function render() {
        if (!colors) return;
        const { ctx, w, h } = stage;
        const st = STEPS[stepIndex];
        ctx.fillStyle = rgb(colors.surface);
        ctx.fillRect(0, 0, w, h);

        /* streamwise vorticity of the near-wall vortices (with wall images) */
        field.clear();
        for (const vx of vortices) {
            for (const shift of [-view.z1, 0, view.z1]) {
                field.splat(vx.z + shift, vx.y, vx.g, vx.rc * 0.75);
            }
        }
        const yTop = Yp(Y_MAX), yWall = Yp(0);
        field.blit(ctx, lut, 0.95, 0, yTop, w, yWall - yTop);
        /* rotation sense of each vortex */
        for (const vx of vortices) {
            const a = Math.min(1, Math.abs(vx.g));
            if (a < 0.15) continue;
            const cx = Zp(vx.z), cy = Yp(vx.y), r = vx.rc * 1.35 * view.s;
            const ccw = vx.g > 0;
            ctx.strokeStyle = rgb(colors.text2, 0.55 * a); ctx.fillStyle = rgb(colors.text2, 0.55 * a); ctx.lineWidth = 1.3;
            const a0 = -0.6, a1 = 3.6;
            ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1, false); ctx.stroke();
            const end = ccw ? a0 : a1, dir = ccw ? -1 : 1;
            const ex = cx + r * Math.cos(end), ey = cy + r * Math.sin(end);
            const tx = -Math.sin(end) * dir, ty = Math.cos(end) * dir;
            ctx.beginPath(); ctx.moveTo(ex + tx * 5, ey + ty * 5); ctx.lineTo(ex - ty * 3.5, ey + tx * 3.5); ctx.lineTo(ex + ty * 3.5, ey - tx * 3.5); ctx.closePath(); ctx.fill();
        }

        /* sensing plane */
        const ys = Yp(Y_SENSE);
        ctx.setLineDash([5, 5]); ctx.strokeStyle = rgb(colors.accentInk, 0.8); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, ys); ctx.lineTo(w, ys); ctx.stroke(); ctx.setLineDash([]);

        /* sensed wall-normal velocity arrows */
        const stride = Math.max(2, Math.round(NS / Math.max(12, w / 28)));
        const aScale = view.s * 7 / vScale;
        for (let i = Math.floor(stride / 2); i < NS; i += stride) {
            const x = Zp((i + 0.5) / NS * view.z1);
            arrow(ctx, x, ys, vTrue[i] * aScale * 0.6, rgb(colors.text2, 0.8), 1.2);
        }

        /* wall, wall pressure strip, actuation */
        ctx.fillStyle = rgb(colors.surface2);
        ctx.fillRect(0, yWall, w, h - yWall);
        const cells = NS;
        let pMax = 0.05;
        for (let i = 0; i < NS; i++) pMax = Math.max(pMax, Math.abs(pw[i]));
        for (let i = 0; i < cells; i++) {
            const v = Math.max(-1, Math.min(1, pw[i] / pMax));
            ctx.fillStyle = pLut[Math.round((v + 1) * 16)];
            ctx.fillRect(Zp(i / NS * view.z1), yWall + 2, Zp(view.z1 / NS) + 0.6, 7);
        }
        ctx.strokeStyle = rgb(colors.text2); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(0, yWall + 0.5); ctx.lineTo(w, yWall + 0.5); ctx.stroke();
        if (mode !== 'none' && ramp > 0.02) {
            for (let i = Math.floor(stride / 2); i < NS; i += stride) {
                const x = Zp((i + 0.5) / NS * view.z1);
                const len = -vUsed[i] * ramp * aScale * 0.55;
                if (len >= 0) arrow(ctx, x, yWall, len, rgb(colors.accent), 1.8);
                else arrow(ctx, x, yWall + len, len, rgb(colors.accent), 1.8);
            }
        }

        /* ANN input template and prediction point */
        const m = MODES[mode];
        if (st.template && m.predicted) {
            const z0 = (Math.round(NS * 0.42) + 0.5) / NS * view.z1;
            const xa = Zp(z0 - TEMPLATE / 2), xb = Zp(z0 + TEMPLATE / 2), xc = Zp(z0);
            ctx.strokeStyle = rgb(colors.warnInk); ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(xa, yWall + 14); ctx.lineTo(xa, yWall + 11); ctx.lineTo(xb, yWall + 11); ctx.lineTo(xb, yWall + 14); ctx.stroke();
            ctx.setLineDash([3, 3]); ctx.strokeStyle = rgb(colors.warnInk, 0.7);
            ctx.beginPath(); ctx.moveTo(xa, yWall); ctx.lineTo(xc, ys); ctx.lineTo(xb, yWall); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = rgb(colors.warnInk);
            ctx.beginPath(); ctx.arc(xc, ys, 4.5, 0, Math.PI * 2); ctx.fill();
            ctx.font = `500 11px ${colors.fontMono}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.fillText(mode === 'shear' ? '벽 전단응력 템플릿 → ANN → v̂' : '벽 압력 템플릿 15×15 → ANN → v̂', xc, yWall + 27);
        }

        /* labels */
        ctx.font = `500 11px ${colors.fontMono}`;
        ctx.fillStyle = rgb(colors.accentInk);
        ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('센싱 평면 y⁺ = 10', w - 8, ys - 6);
        ctx.fillStyle = rgb(colors.text3);
        ctx.textAlign = 'left';
        ctx.fillText('y⁺', 6, yTop + 12);
        for (const y of [20, 40]) { ctx.fillText(String(y), 6, Yp(y) + 4); }
        ctx.fillText('벽 (y⁺ = 0)', 6, yWall - 5);
        ctx.textAlign = 'right';
        ctx.fillText('z⁺ →', w - 8, h - 6);
        if (!(st.template && m.predicted)) {
            ctx.textAlign = 'left';
            ctx.fillText('벽 압력 p_w', 6, h - 6);
        }

        chart.draw();
        drawScatter();
        ctrlBtn.classList.toggle('is-ramping', control && ramp < 0.98);
        if (debugEl) { const d = loop.stats(); debugEl.textContent = `${d.avg.toFixed(1)} ms · tier ${d.tier}`; }
    }

    function drawScatter() {
        if (!colors) return;
        const { ctx, w, h } = scatterSurf;
        ctx.fillStyle = rgb(colors.surface);
        ctx.fillRect(0, 0, w, h);
        const pad = 14, R = 3;
        const X = v => pad + (v + R) / (2 * R) * (w - 2 * pad);
        const Y = v => h - pad - (v + R) / (2 * R) * (h - 2 * pad);
        ctx.strokeStyle = rgb(colors.border); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(-R), Y(0)); ctx.lineTo(X(R), Y(0)); ctx.moveTo(X(0), Y(-R)); ctx.lineTo(X(0), Y(R)); ctx.stroke();
        ctx.setLineDash([3, 3]); ctx.strokeStyle = rgb(colors.text3);
        ctx.beginPath(); ctx.moveTo(X(-R), Y(-R)); ctx.lineTo(X(R), Y(R)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = rgb(colors.accentInk, 0.35);
        for (let i = 0; i < scCount; i++) {
            const a = scatter[i * 2], b = scatter[i * 2 + 1];
            if (Math.abs(a) > R || Math.abs(b) > R) continue;
            ctx.fillRect(X(a) - 1, Y(b) - 1, 2, 2);
        }
        ctx.font = `500 10px ${colors.fontMono}`;
        ctx.fillStyle = rgb(colors.text3);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('v̂', 4, 12);
        ctx.textAlign = 'right';
        ctx.fillText('v (DNS)', w - 4, h - 3);
        scatterText.innerHTML = modeNotes[mode] || '';
    }

    loop = createLoop({ root, tick: dt => advance(dt * TIME_SCALE), draw: render });

    function setMode(key) {
        mode = key;
        qa('input[name="lab-mode"]').forEach(r => { r.checked = r.value === key; });
        scHead = 0; scCount = 0;
    }

    function setControl(on) {
        if (on && !control) { tOn = t; chart.mark(t, 'on'); chart.mark(t, 'ramp', t + 30); }
        control = on;
        ctrlBtn.setAttribute('aria-pressed', String(on));
        stageCanvas.setAttribute('aria-label', `난류 채널 유동 y–z 단면의 벽 근처 와류와 반대 제어 개념 애니메이션. 제어 ${on ? '적용' : '미적용'}.`);
    }

    function selectStep(i) {
        stepIndex = i;
        const st = STEPS[i];
        if (st.control !== null && ready) {
            reset();
            setMode(st.mode);
            const [off, on] = PREROLL[st.key];
            for (let k = 0; k < off / 2; k++) advance(2);
            if (st.control) { setControl(true); for (let k = 0; k < on / 2; k++) advance(2); } else setControl(false);
        }
        const c = captions[st.key] || { html: '', text: '' };
        captionEl.innerHTML = c.html;
        say(c.text);
        if (ready) render();
    }

    const steps = createSteps(q('.lab-steps'), selectStep);
    const toExplore = () => { if (steps.current !== STEPS.length - 1) steps.select(STEPS.length - 1); };

    qa('input[name="lab-mode"]').forEach(r => r.addEventListener('change', () => {
        if (!r.checked) return;
        setMode(r.value);
        toExplore();
        if (r.value === 'none') setControl(false); else if (!control) setControl(true);
        if (media.reduced) for (let n = 0; n < 150; n++) advance(2);
        render();
    }));
    ctrlBtn.addEventListener('click', () => {
        if (mode === 'none') setMode('pressure');
        setControl(!control);
        toExplore();
        if (media.reduced) for (let n = 0; n < 150; n++) advance(2);
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
    reset();
    playBtn.textContent = media.reduced ? '재생' : '일시정지';
    if (debug && debugEl) debugEl.hidden = false;
    ready = true;
    const qs = new URLSearchParams(location.search);
    steps.select(qs.has('labstep') ? Math.max(0, Math.min(STEPS.length - 1, (+qs.get('labstep') || 1) - 1)) : 0);
});
