/* ============================================
   FCNN-PS explorable — planar symmetry of the learned sensor
   Wake scene + wall-pressure taps + network view + closed loop.
   The flow is the procedural P-control model; the network is a small
   illustrative net with arbitrary weights (structure demo, not the trained model).
   ============================================ */
import {
    media, debug, readTokens, rgb, createSurface, createLoop, createStripChart,
    createSteps, announcer, mountLab, fontsReady
} from './core.js?v=2026q3';
import { createWakeScene } from './wake.js?v=2026q3';
import { createModel, rmsFor, REGIMES, DT, gaussian, mulberry32 } from './pcontrol-model.js?v=2026q3';

const TIME_SCALE = 3.3;

/* taps: θ from the front stagnation point; Re = 3900 as in the thesis, Re = 60 equally spaced outside the slot */
const REG = {
    turbulent: { model: 'turbulent', taps: [10, 20, 30, 40, 110, 120, 130, 140], hidden: [8, 8], predNoise: 0.45 },
    laminar60: { model: 'laminar60', taps: [15, 40, 65, 115, 140, 165], hidden: [4], predNoise: 0.04 }
};

const STEPS = [
    { key: 'symmetry', net: 'ps', control: false, highlight: 'taps', sensor: true },
    { key: 'conventional', net: 'conv', control: true, highlight: 'net', sensor: true },
    { key: 'fcnnps', net: 'ps', control: false, highlight: 'net', sensor: true },
    { key: 'loop', net: 'ps', control: true, highlight: 'control', sensor: true },
    { key: 'explore', net: null, control: null, highlight: null, sensor: true }
];
const PREROLL = { symmetry: [60, 0], conventional: [24, 60], fcnnps: [60, 0], loop: [24, 36] };

/* small fully-connected net: FCNN (bias, p^U and p^L inputs) or FCNN-PS (no bias, tanh, BN-PS scale) */
function createNet(sizes, seed) {
    const r = mulberry32(seed);
    const W = [], B = [], G = [];
    for (let l = 1; l < sizes.length; l++) {
        const m = new Float32Array(sizes[l] * sizes[l - 1]);
        for (let i = 0; i < m.length; i++) m[i] = (r() - 0.5) * 3.2 / Math.sqrt(sizes[l - 1]);
        W.push(m);
        const b = new Float32Array(sizes[l]), g = new Float32Array(sizes[l]);
        for (let i = 0; i < b.length; i++) { b[i] = (r() - 0.5) * 1.2; g[i] = 0.8 + 0.4 * r(); }
        B.push(b); G.push(g);
    }
    function forward(x, withBias) {
        const acts = [x];
        let a = x;
        for (let l = 0; l < W.length; l++) {
            const n = sizes[l + 1], p = sizes[l], out = new Float64Array(n), last = l === W.length - 1;
            for (let i = 0; i < n; i++) {
                let z = withBias ? B[l][i] : 0;
                for (let j = 0; j < p; j++) z += W[l][i * p + j] * a[j];
                out[i] = last ? z : withBias ? Math.tanh(z) : G[l][i] * Math.tanh(z);
            }
            acts.push(out);
            a = out;
        }
        return acts;
    }
    return { sizes, forward };
}

mountLab(document.querySelector('[data-lab="symmetry"]'), async root => {
    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));
    const stageWrap = q('.lab-canvas-wrap'), stageCanvas = q('.lab-canvas');
    const netWrap = q('.lab-net-wrap'), netCanvas = q('.lab-net-canvas');
    const chartWrap = q('.lab-chart-wrap'), chartCanvas = q('.lab-chart');
    const captionEl = q('.lab-caption');
    const alertEl = q('.lab-alert');
    const say = announcer(q('.lab-sr'));
    const playBtn = q('[data-act="play"]'), resetBtn = q('[data-act="reset"]');
    const mirrorBtn = q('[data-act="mirror"]'), shuffleBtn = q('[data-act="shuffle"]');
    const ctrlBtn = q('[data-param="control"]');
    const symValue = q('.lab-sym-value'), symText = q('.lab-sym-text'), symBar = q('.lab-sym-bar');
    const netTitle = q('.lab-net-title');
    const debugEl = q('.lab-debug');
    const captions = {};
    qa('template[data-caption]').forEach(t => { captions[t.dataset.caption] = { html: t.innerHTML.trim(), text: t.content.textContent.trim() }; });

    let regimeKey = 'turbulent', reg = REG[regimeKey], regime = REGIMES[reg.model];
    let netType = 'ps', seed = 21;
    let model = null, colors = null, stepIndex = 0, loop = null, ready = false;
    let nets = null;
    let bias = 0, predErr = 0, sigVar = 1, clOffset = 0, mirrorFlash = 0;
    let lastSym = { res: 0, out: 0, acts: null };
    const noiseRng = mulberry32(5);
    const scene = createWakeScene();
    await fontsReady();

    function buildNets() {
        const n = reg.taps.length;
        nets = {
            ps: createNet([n, ...reg.hidden, 1], seed),
            conv: createNet([2 * n, ...reg.hidden, 1], seed + 1)
        };
    }

    function readColors() {
        const t = readTokens(root, ['--surface', '--surface-2', '--border', '--text', '--text-2', '--text-3', '--accent', '--accent-soft', '--accent-ink', '--primary', '--warn-ink', '--lab-neg', '--lab-pos']);
        const cs = getComputedStyle(root);
        colors = {
            surface: t['--surface'], surface2: t['--surface-2'], border: t['--border'],
            text: t['--text'], text2: t['--text-2'], text3: t['--text-3'],
            accent: t['--accent'], accentSoft: t['--accent-soft'], accentInk: t['--accent-ink'],
            primary: t['--primary'], warnInk: t['--warn-ink'], labNeg: t['--lab-neg'], labPos: t['--lab-pos'],
            fontMono: cs.getPropertyValue('--font-mono').trim() || 'monospace'
        };
        scene.setColors(colors);
        chart.setColors(colors);
    }

    const stage = createSurface(stageWrap, stageCanvas, { onResize: s => { scene.resize(s.w, s.h); if (ready && !loop.running) render(); } });
    const netSurf = createSurface(netWrap, netCanvas, { onResize: () => { if (ready) drawNet(); } });
    const chart = createStripChart(chartWrap, chartCanvas, {
        span: 60,
        lanes: [
            { key: 'pred', second: 'truth', label: '센싱 vₛ', range: 2.6, color: 'accentInk' },
            { key: 'sym', label: '대칭 오차', range: 0.5, color: 'warnInk' },
            { key: 'psi', label: '가진 ψ/u∞', range: 1, color: 'accent' },
            { key: 'cl', label: '양력 CL', range: 1.9, color: 'primary', envelope: () => Math.SQRT2 }
        ]
    });

    /* wall-pressure difference p⁻_w at the taps (procedural: follows the shedding mode) */
    function pressureDiff() {
        const s = model.state, out = new Float64Array(reg.taps.length);
        reg.taps.forEach((th, j) => {
            const ph = (th / 180) * Math.PI * 0.9;
            out[j] = 0.9 * (s.aRe * Math.cos(ph) + s.aIm * Math.sin(ph)) * (0.55 + 0.45 * Math.sin(th * Math.PI / 180));
        });
        return out;
    }
    const meanCp = th => -0.95 + 1.95 * Math.exp(-((th / 42) ** 2));

    /* network input for the current (or mirrored) flow */
    function netInput(diff, mirrored) {
        const n = diff.length;
        if (netType === 'ps') return diff.map(v => mirrored ? -v : v);
        const x = new Float64Array(2 * n);
        for (let j = 0; j < n; j++) {
            const pm = meanCp(reg.taps[j]);
            const up = pm + diff[j] / 2, lo = pm - diff[j] / 2;
            x[j] = mirrored ? lo : up;          /* y → −y swaps upper and lower taps */
            x[n + j] = mirrored ? up : lo;
        }
        return x;
    }

    function symmetryCheck() {
        const diff = pressureDiff();
        const net = nets[netType], withBias = netType === 'conv';
        const a = net.forward(netInput(diff, false), withBias);
        const b = net.forward(netInput(diff, true), withBias);
        const ya = a[a.length - 1][0], yb = b[b.length - 1][0];
        lastSym = { res: ya + yb, out: ya, acts: a };
        return lastSym;
    }

    /* predicted sensing velocity used by the controller (procedural stand-in for the trained net) */
    function predictor(trueAvg, s) {
        const rms0 = s.rms0 || 1;
        sigVar += (trueAvg * trueAvg - sigVar) * DT / 20;
        const dec = Math.exp(-DT / 0.8);
        predErr = predErr * dec + Math.sqrt(1 - dec * dec) * gaussian(noiseRng);
        const scale = Math.max(Math.sqrt(sigVar), 0.05 * rms0);
        let v = trueAvg + reg.predNoise * scale * predErr;
        if (netType === 'conv') v += bias * rms0;
        return v;
    }

    function buildModel(preroll = true) {
        model = createModel(reg.model, 7);
        model.set(regime.paper);
        model.state.rms0 = rmsFor(reg.model, regime.paper);
        model.state.predict = predictor;
        for (let i = 0; i < Math.round(40 / DT); i++) model.step();
        scene.setRegime(reg.model);
        scene.reset();
        chart.clear();
        bias = 0.03; predErr = 0; sigVar = model.state.rms0 ** 2; clOffset = 0;
        if (preroll) for (let i = 0; i < 90; i++) advance(0.1);
        else for (let i = 0; i < 30; i++) scene.advance(0.1, model.amplitude(), model.phase());
    }

    const clGain = () => 0.9 / regime.psiShow;
    function advance(dt) {
        const n = Math.max(1, Math.round(dt / DT));
        for (let i = 0; i < n; i++) {
            const s = model.state;
            /* FCNN: the small steady-state error feeds back through the actuation and slowly grows */
            if (netType === 'conv' && s.control) bias = Math.min(3, bias * (1 + DT / 20) + 0.00002);
            model.step();
            /* mean lift from the biased (non-zero-mean) actuation */
            const target = netType === 'conv' ? clGain() * s.alpha * s.ramp * bias : 0;
            clOffset += (target - clOffset) * DT / 4;
            if (i === n - 1 || i % 5 === 0) {
                const sym = symmetryCheck();
                chart.push(s.t, {
                    pred: s.used / s.rms0, truth: s.sensorAvg / s.rms0,
                    sym: sym.res, psi: s.psi / regime.psiShow * 0.85, cl: s.cl + clOffset
                });
            }
        }
        scene.advance(n * DT, model.amplitude(), model.phase());
        if (mirrorFlash > 0) mirrorFlash = Math.max(0, mirrorFlash - dt * 0.35);
    }

    function setControl(on) {
        model.setControl(on);
        ctrlBtn.setAttribute('aria-pressed', String(on));
        if (on) { chart.mark(model.state.t, 'on'); chart.mark(model.state.t, 'ramp', model.state.t + 14); }
        stageCanvas.setAttribute('aria-label', `원형 실린더 후류와 벽 압력 센서의 개념 애니메이션. 신경망 ${netType === 'ps' ? 'FCNN-PS' : 'FCNN'}, 제어 ${on ? '적용' : '미적용'}.`);
    }

    function setNet(type) {
        netType = type;
        qa('input[name="lab-net"]').forEach(r => { r.checked = r.value === type; });
        root.dataset.net = type;
        netTitle.textContent = type === 'ps' ? 'FCNN-PS · 입력 p⁻_w · 바이어스 없음' : 'FCNN · 입력 pᵁ_w, pᴸ_w · 바이어스 b';
        if (ready) { symmetryCheck(); drawNet(); }
    }

    function drawNet() {
        if (!colors || !model || !lastSym.acts) return;
        const { ctx, w, h } = netSurf;
        ctx.fillStyle = rgb(colors.surface);
        ctx.fillRect(0, 0, w, h);
        const acts = lastSym.acts, net = nets[netType], sizes = net.sizes, L = sizes.length;
        const conv = netType === 'conv';
        const padL = 34, padR = 34, padT = 14, padB = conv ? 26 : 14;
        const colX = l => padL + l * (w - padL - padR) / (L - 1);
        const rowY = (l, i) => sizes[l] === 1 ? (padT + h - padB) / 2 : padT + i * (h - padT - padB) / (sizes[l] - 1);
        const r0 = Math.max(3, Math.min(7, (h - padT - padB) / sizes[0] / 2.4));
        for (let l = 0; l < L - 1; l++) {
            for (let i = 0; i < sizes[l + 1]; i++) for (let j = 0; j < sizes[l]; j++) {
                const a = Math.min(1, Math.abs(acts[l][j]));
                ctx.strokeStyle = rgb(colors.text3, 0.06 + 0.28 * a);
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(colX(l), rowY(l, j)); ctx.lineTo(colX(l + 1), rowY(l + 1, i)); ctx.stroke();
            }
        }
        if (conv) {
            for (let l = 1; l < L; l++) {
                const bx = (colX(l - 1) + colX(l)) / 2, by = h - 11;
                for (let i = 0; i < sizes[l]; i++) {
                    ctx.strokeStyle = rgb(colors.warnInk, 0.25);
                    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(colX(l), rowY(l, i)); ctx.stroke();
                }
                ctx.fillStyle = rgb(colors.warnInk);
                ctx.fillRect(bx - 8, by - 7, 16, 14);
                ctx.fillStyle = rgb(colors.surface);
                ctx.font = `600 10px ${colors.fontMono}`;
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText('b', bx, by + 0.5);
            }
        }
        for (let l = 0; l < L; l++) {
            const scale = l === 0 ? (conv ? 1.2 : 2.2) : l === L - 1 ? 1.2 : 1;
            for (let i = 0; i < sizes[l]; i++) {
                const v = Math.max(-1, Math.min(1, acts[l][i] * scale));
                const x = colX(l), y = rowY(l, i), rr = l === 0 ? r0 : l === L - 1 ? 8 : 6;
                ctx.fillStyle = rgb(colors.surface);
                ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = rgb(v >= 0 ? colors.labPos : colors.labNeg, 0.12 + 0.88 * Math.abs(v));
                ctx.fill();
                ctx.strokeStyle = rgb(colors.border); ctx.lineWidth = 1; ctx.stroke();
            }
        }
        ctx.font = `500 10px ${colors.fontMono}`;
        ctx.fillStyle = rgb(colors.text3);
        ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
        if (conv) {
            const n = sizes[0] / 2;
            ctx.fillText('pᵁ', padL - 10, (rowY(0, 0) + rowY(0, n - 1)) / 2);
            ctx.fillText('pᴸ', padL - 10, (rowY(0, n) + rowY(0, 2 * n - 1)) / 2);
        } else ctx.fillText('p⁻', padL - 10, (rowY(0, 0) + rowY(0, sizes[0] - 1)) / 2);
        ctx.textAlign = 'left';
        ctx.fillText('v̂s', colX(L - 1) + 12, rowY(L - 1, 0));
    }

    function updateSymReadout() {
        const r = lastSym.res, rel = Math.abs(r) / Math.max(0.05, Math.abs(lastSym.out));
        symValue.textContent = (Math.abs(r) < 5e-13 ? 0 : r).toFixed(3);
        symBar.style.setProperty('--v', String(Math.min(1, rel)));
        root.classList.toggle('is-sym-broken', netType === 'conv');
        symText.textContent = netType === 'ps'
            ? '가중치와 무관하게 0이다. 바이어스가 없고 모든 층이 odd function이기 때문이다.'
            : '0이 아니다. 바이어스 b와 상·하면 압력을 개별 입력으로 받는 구조가 대칭성을 깨뜨린다.';
    }

    function render() {
        if (!colors || !model) return;
        const s = model.state, st = STEPS[stepIndex];
        const diff = pressureDiff();
        scene.draw(stage.ctx, {
            omega: model.omega, aRe: s.aRe, aIm: s.aIm, phase: model.phase(),
            psi: s.psi, psiScale: regime.psiClip * 0.4, slot: regime.slot,
            xs: regime.paper.xs, showSensor: st.sensor, showRaw: true,
            rawNorm: s.sensorAvg / s.rms0, avgNorm: s.used / s.rms0,
            rawSpan: s.rawSpan, rms0: s.rms0,
            spanwiseInset: false, highlight: st.highlight,
            taps: reg.taps.map((th, j) => ({ theta: th, value: diff[j] * 1.8 }))
        });
        if (mirrorFlash > 0) {
            const { ctx, w } = stage;
            const [, cy] = scene.toScreen(0, 0);
            ctx.save();
            ctx.strokeStyle = rgb(colors.accent, mirrorFlash);
            ctx.setLineDash([8, 6]); ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = rgb(colors.accentInk, mirrorFlash);
            ctx.font = `600 12px ${colors.fontMono}`;
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            ctx.fillText('y → −y', 14, cy - 8);
            ctx.restore();
        }
        chart.draw();
        drawNet();
        updateSymReadout();
        alertEl.hidden = !(netType === 'conv' && s.control && Math.abs(clOffset) > 0.12);
        ctrlBtn.classList.toggle('is-ramping', s.control && s.ramp < 0.98);
        if (debugEl) { const d = loop.stats(); debugEl.textContent = `${d.avg.toFixed(1)} ms · tier ${d.tier}`; }
    }

    loop = createLoop({ root, tick: dt => advance(dt * TIME_SCALE), draw: render, onTier: t => scene.setTier(t) });

    function caption(key) {
        return captions[`${key}-${regimeKey}`] || captions[key] || { html: '', text: '' };
    }

    function selectStep(i) {
        stepIndex = i;
        const st = STEPS[i];
        if (st.net) setNet(st.net);
        if (st.control !== null && ready) {
            buildModel(false);
            const [off, on] = PREROLL[st.key];
            for (let k = 0; k < off * 10; k++) advance(0.1);
            if (st.control) { setControl(true); for (let k = 0; k < on * 10; k++) advance(0.1); } else setControl(false);
        }
        const c = caption(st.key);
        captionEl.innerHTML = c.html;
        say(c.text);
        if (ready) render();
    }

    const steps = createSteps(q('.lab-steps'), selectStep);
    const toExplore = () => { if (steps.current !== STEPS.length - 1) steps.select(STEPS.length - 1); };

    qa('input[name="lab-net"]').forEach(r => r.addEventListener('change', () => {
        if (!r.checked) return;
        setNet(r.value);
        bias = 0.03;
        toExplore();
        render();
    }));
    mirrorBtn.addEventListener('click', () => {
        model.mirror();
        scene.mirror();
        mirrorFlash = 1;
        symmetryCheck();
        say(netType === 'ps'
            ? '평면 대칭 변환을 적용하였다. FCNN-PS의 출력은 부호만 반전된다.'
            : '평면 대칭 변환을 적용하였다. FCNN의 출력은 정확히 반전되지 않는다.');
        render();
    });
    shuffleBtn.addEventListener('click', () => {
        seed += 2;
        buildNets();
        symmetryCheck();
        say(netType === 'ps' ? '가중치를 재생성하였다. 대칭 오차는 0으로 유지된다.' : '가중치를 재생성하였다. 대칭 오차는 변하지만 0이 되지 않는다.');
        render();
    });
    ctrlBtn.addEventListener('click', () => {
        setControl(ctrlBtn.getAttribute('aria-pressed') !== 'true');
        toExplore();
        if (media.reduced) { for (let k = 0; k < 400; k++) advance(0.1); }
        render();
    });
    qa('input[name="lab-regime"]').forEach(r => r.addEventListener('change', () => {
        if (!r.checked) return;
        regimeKey = r.value; reg = REG[regimeKey]; regime = REGIMES[reg.model];
        buildNets();
        root.querySelectorAll('[data-regime-text]').forEach(el => { el.hidden = el.dataset.regimeText !== regimeKey; });
        buildModel();
        setControl(false);
        steps.select(0);
    }));
    playBtn.addEventListener('click', () => {
        const playing = loop.toggle();
        playBtn.textContent = playing ? '일시정지' : '재생';
        playBtn.setAttribute('aria-label', playing ? '애니메이션 일시정지' : '애니메이션 재생');
    });
    resetBtn.addEventListener('click', () => { buildModel(); setControl(false); steps.select(0); });
    media.on('dark', () => { readColors(); render(); });

    buildNets();
    readColors();
    buildModel();
    setControl(false);
    setNet('ps');
    playBtn.textContent = media.reduced ? '재생' : '일시정지';
    if (debug && debugEl) debugEl.hidden = false;
    ready = true;
    const qs = new URLSearchParams(location.search);
    if (qs.get('labregime') === 'laminar60') {
        const r = root.querySelector('input[name="lab-regime"][value="laminar60"]');
        if (r) { r.checked = true; r.dispatchEvent(new Event('change')); }
    }
    steps.select(qs.has('labstep') ? Math.max(0, Math.min(STEPS.length - 1, (+qs.get('labstep') || 1) - 1)) : 0);
});
