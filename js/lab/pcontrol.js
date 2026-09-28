/* ============================================
   P-control explorable — wiring (model + wake scene + chart + UI)
   ============================================ */
import {
    media, debug, readTokens, parseColor, createSurface, createLoop, createStripChart,
    createSteps, announcer, mountLab, fontsReady
} from './core.js?v=2026q3';
import { createWakeScene } from './wake.js?v=2026q3';
import { createModel, rmsFor, phaseFit, REGIMES, DT } from './pcontrol-model.js?v=2026q3';

const TIME_SCALE = 3.3;          /* tu per second of playback (~1.4 s per shedding cycle) */

const STEPS = [
    { key: 'problem', control: false, highlight: 'vortex', sensor: false },
    { key: 'sensor', control: false, highlight: 'sensor', sensor: true },
    { key: 'control', control: true, highlight: 'control', sensor: true },
    { key: 'result', control: true, highlight: 'result', sensor: true },
    { key: 'explore', control: null, highlight: null, sensor: true }
];

const PRESETS = {
    paper: p => ({ ...p }),
    far: p => ({ ...p, xs: 3.6 }),
    raw: p => ({ ...p, ta: 0, spanwise: false }),
    over: (p, reg) => ({ ...p, ta: Math.round(10 / reg.st) / 10 })
};

function fmt(key, v) {
    if (key === 'alpha') return v < 0.1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toFixed(2);
    return v.toFixed(2);
}

mountLab(document.querySelector('[data-lab="pcontrol"]'), async root => {
    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));

    const stageWrap = q('.lab-canvas-wrap');
    const stageCanvas = q('.lab-canvas');
    const chartWrap = q('.lab-chart-wrap');
    const chartCanvas = q('.lab-chart');
    const fitCanvas = q('.lab-fit-canvas');
    const captionEl = q('.lab-caption');
    const fitText = q('.lab-fit-text');
    const say = announcer(q('.lab-sr'));
    const playBtn = q('[data-act="play"]');
    const resetBtn = q('[data-act="reset"]');
    const ctrlBtn = q('[data-param="control"]');
    const spanBtn = q('[data-param="spanwise"]');
    const inputs = { xs: q('#lab-xs'), ta: q('#lab-ta'), alpha: q('#lab-alpha') };
    const outputs = { xs: q('output[for="lab-xs"]'), ta: q('output[for="lab-ta"]'), alpha: q('output[for="lab-alpha"]') };
    const marks = { xs: q('[data-mark="xs"]'), ta: q('[data-mark="ta"]'), alpha: q('[data-mark="alpha"]') };
    const debugEl = q('.lab-debug');
    const captions = {};
    qa('template[data-caption]').forEach(t => { captions[t.dataset.caption] = { html: t.innerHTML.trim(), text: t.content.textContent.trim() }; });

    let regimeKey = 'turbulent';
    let regime = REGIMES[regimeKey];
    let params = { ...regime.paper };
    let model = null, colors = null, stepIndex = 0, rampMarked = false, loop = null, ready = false;
    const scene = createWakeScene();

    await fontsReady();

    function readColors() {
        const t = readTokens(root, ['--surface', '--surface-2', '--border', '--text', '--text-2', '--text-3', '--accent', '--accent-soft', '--accent-ink', '--primary', '--warn-ink', '--lab-neg', '--lab-pos']);
        const cs = getComputedStyle(root);
        colors = {
            surface: t['--surface'], surface2: t['--surface-2'], border: t['--border'],
            text: t['--text'], text2: t['--text-2'], text3: t['--text-3'],
            accent: t['--accent'], accentSoft: t['--accent-soft'], accentInk: t['--accent-ink'],
            primary: t['--primary'], warnInk: t['--warn-ink'],
            labNeg: t['--lab-neg'], labPos: t['--lab-pos'],
            fontMono: cs.getPropertyValue('--font-mono').trim() || 'monospace'
        };
        scene.setColors(colors);
        chart.setColors(colors);
    }

    const stage = createSurface(stageWrap, stageCanvas, {
        dprCap: 2,
        onResize: s => { scene.resize(s.w, s.h); if (ready && !loop.running) render(); }
    });

    const chart = createStripChart(chartWrap, chartCanvas, {
        span: 60,
        lanes: [
            { key: 'avg', second: 'raw', label: '센싱 vₛ', range: 2.6, color: 'accentInk' },
            { key: 'psi', label: '가진 ψ/u∞', range: 1, color: 'accent' },
            { key: 'cl', label: '양력 CL', range: 1.9, color: 'primary', envelope: () => Math.SQRT2 },
            { key: 'cd', label: '항력 CD', range: 0.11, center: 0.955, base: 1.0, color: 'warnInk' }
        ]
    });

    function buildModel(preroll = true) {
        model = createModel(regimeKey, 7);
        model.set(params);
        model.state.rms0 = rmsFor(regimeKey, params);
        for (let i = 0; i < Math.round(40 / DT); i++) model.step();
        scene.setRegime(regimeKey);
        scene.reset();
        chart.clear();
        rampMarked = false;
        model.setControl(false);
        /* pre-roll the drawn flow so the street is already developed */
        if (preroll) for (let i = 0; i < 90; i++) advanceModel(0.1);
        else for (let i = 0; i < 30; i++) scene.advance(0.1, model.amplitude(), model.phase());
    }

    let rmsTimer = 0;
    function applyParams(changed) {
        model.set(params);
        if (changed.some(k => k === 'xs' || k === 'ta' || k === 'spanwise')) {
            clearTimeout(rmsTimer);
            rmsTimer = setTimeout(() => { model.state.rms0 = rmsFor(regimeKey, params); }, 150);
        }
        syncControls();
        drawFit();
        if (ready && !loop.running) render();
    }

    function setControl(on) {
        model.setControl(on);
        ctrlBtn.setAttribute('aria-pressed', String(on));
        stageCanvas.setAttribute('aria-label', `원형 실린더 후류 와도장의 개념 애니메이션. 제어 ${on ? '적용' : '미적용'}.`);
        if (on) { chart.mark(model.state.t, 'on'); chart.mark(model.state.t, 'ramp', model.state.t + 14); rampMarked = true; }
    }

    function syncControls() {
        for (const k of ['xs', 'ta', 'alpha']) {
            const el = inputs[k];
            el.value = params[k];
            const text = fmt(k, params[k]);
            outputs[k].textContent = text;
            el.setAttribute('aria-valuetext', k === 'xs' ? `x_s/d ${text}` : k === 'ta' ? `T_a u∞/d ${text}` : `α ${text}`);
        }
        spanBtn.setAttribute('aria-pressed', String(params.spanwise));
        spanBtn.closest('.lab-field').hidden = regime.sensorNoise === 0;
        placeMarks();
    }

    function placeMarks() {
        for (const k of ['xs', 'ta', 'alpha']) {
            const el = inputs[k];
            const min = +el.min, max = +el.max;
            const pos = (regime.paper[k] - min) / (max - min) * 100;
            marks[k].style.setProperty('--pos', String(Math.max(0, Math.min(1, pos / 100))));
        }
    }

    function configureRanges() {
        inputs.alpha.max = regime.alphaMax;
        inputs.alpha.step = regime.alphaStep;
        inputs.ta.max = regimeKey === 'turbulent' ? 5 : 7;
        root.querySelectorAll('[data-regime-text]').forEach(el => { el.hidden = el.dataset.regimeText !== regimeKey; });
    }

    /* --- phase-fit mini plot --- */
    const fitSurf = createSurface(fitCanvas.parentElement, fitCanvas, { dprCap: 2, onResize: () => drawFit() });
    function drawFit() {
        if (!colors) return;
        const { ctx, w, h } = fitSurf;
        ctx.fillStyle = `rgb(${colors.surface})`;
        ctx.fillRect(0, 0, w, h);
        const x0 = +inputs.xs.min, x1 = +inputs.xs.max;
        const X = x => 6 + (x - x0) / (x1 - x0) * (w - 12);
        const Y = v => h / 2 - v * (h / 2 - 8);
        ctx.strokeStyle = `rgb(${colors.border})`;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(6, Y(0)); ctx.lineTo(w - 6, Y(0)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = `rgb(${colors.accentInk})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i <= 120; i++) {
            const x = x0 + (x1 - x0) * i / 120;
            const v = phaseFit(regime, x, params.ta, params.spanwise);
            i ? ctx.lineTo(X(x), Y(v)) : ctx.moveTo(X(x), Y(v));
        }
        ctx.stroke();
        const px = regime.paper.xs;
        ctx.strokeStyle = `rgb(${colors.warnInk})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(px), 4); ctx.lineTo(X(px), h - 4); ctx.stroke();
        const v = phaseFit(regime, params.xs, params.ta, params.spanwise);
        ctx.fillStyle = `rgb(${colors.accent})`;
        ctx.beginPath(); ctx.arc(X(params.xs), Y(v), 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgb(${colors.text3})`;
        ctx.font = `500 10px ${colors.fontMono}`;
        ctx.fillText('+ 감쇠', 8, 12);
        ctx.fillText('− 증폭', 8, h - 5);
        const label = v > 0.6 ? '위상 정합 — 강한 감쇠' : v > 0.25 ? '부분 정합 — 약한 감쇠' : v > -0.25 ? '위상 불일치 — 제어 효과 미미' : '역위상 — 보텍스 쉐딩 증폭';
        fitText.textContent = label;
    }

    /* --- simulation advance & render --- */
    function advanceModel(dtWorld) {
        const n = Math.max(1, Math.round(dtWorld / DT));
        for (let i = 0; i < n; i++) {
            model.step();
            const s = model.state;
            chart.push(s.t, { avg: s.sensorAvg / s.rms0, raw: s.sensorRaw / s.rms0, psi: s.psi / regime.psiShow * 0.85, cl: s.cl, cd: s.cd });
        }
        scene.advance(n * DT, model.amplitude(), model.phase());
    }

    function render() {
        if (!colors) return;
        const s = model.state;
        const st = STEPS[stepIndex];
        stage.ctx.save();
        scene.draw(stage.ctx, {
            omega: model.omega, aRe: s.aRe, aIm: s.aIm, phase: model.phase(),
            psi: s.psi, psiScale: regime.psiClip * 0.4, slot: regime.slot,
            xs: params.xs, showSensor: st.sensor || s.control, showRaw: regime.sensorNoise > 0,
            rawNorm: s.sensorRaw / s.rms0, avgNorm: s.sensorAvg / s.rms0,
            rawSpan: s.rawSpan, rms0: s.rms0,
            spanwiseInset: regime.sensorNoise > 0 && params.spanwise && (st.key === 'sensor' || st.key === 'explore'),
            highlight: st.highlight
        });
        stage.ctx.restore();
        chart.draw();
        ctrlBtn.classList.toggle('is-ramping', s.control && s.ramp < 0.98);
        if (debugEl) { const st2 = loop.stats(); debugEl.textContent = `${st2.avg.toFixed(1)} ms · tier ${st2.tier}`; }
    }

    loop = createLoop({
        root,
        tick: dt => advanceModel(dt * TIME_SCALE),
        draw: render,
        onTier: t => scene.setTier(t)
    });

    /* reduced motion: deterministic snapshot per step */
    function snapshot() {
        render();
    }

    /* guided steps start from a reproducible history so the chart shows before/after at once */
    const PREROLL = { problem: [60, 0], sensor: [60, 0], control: [48, 0.4], result: [24, 36] };

    function selectStep(i) {
        stepIndex = i;
        const st = STEPS[i];
        if (st.control !== null && ready) {
            params = { ...regime.paper };
            buildModel(false);
            const [off, on] = PREROLL[st.key];
            for (let k = 0; k < off * 10; k++) advanceModel(0.1);
            if (st.control) {
                setControl(true);
                for (let k = 0; k < on * 10; k++) advanceModel(0.1);
            } else setControl(false);
            syncControls();
            drawFit();
        }
        const c = captions[`${st.key}-${regimeKey}`] || captions[st.key] || { html: '', text: '' };
        captionEl.innerHTML = c.html;
        say(c.text);
        if (!ready) return;
        if (media.reduced) snapshot(); else if (!loop.running) render();
    }

    /* --- events --- */
    const steps = createSteps(q('.lab-steps'), selectStep);

    for (const k of ['xs', 'ta', 'alpha']) {
        inputs[k].addEventListener('input', () => {
            params[k] = +inputs[k].value;
            if (steps.current !== STEPS.length - 1) steps.select(STEPS.length - 1);
            applyParams([k]);
        });
    }
    spanBtn.addEventListener('click', () => {
        params.spanwise = !params.spanwise;
        if (steps.current !== STEPS.length - 1) steps.select(STEPS.length - 1);
        applyParams(['spanwise']);
    });
    ctrlBtn.addEventListener('click', () => {
        const on = ctrlBtn.getAttribute('aria-pressed') !== 'true';
        setControl(on);
        if (steps.current !== STEPS.length - 1) steps.select(STEPS.length - 1);
        if (media.reduced) { for (let i = 0; i < 70; i++) advanceModel(0.1); render(); }
    });
    qa('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
        params = PRESETS[btn.dataset.preset](regime.paper, regime);
        steps.select(STEPS.length - 1);
        applyParams(['xs', 'ta', 'alpha', 'spanwise']);
        if (!model.state.control) setControl(true);
        if (media.reduced) { for (let i = 0; i < 70; i++) advanceModel(0.1); render(); }
    }));
    qa('input[name="lab-regime"]').forEach(r => r.addEventListener('change', () => {
        if (!r.checked) return;
        regimeKey = r.value;
        regime = REGIMES[regimeKey];
        params = { ...regime.paper };
        configureRanges();
        buildModel();
        setControl(false);
        steps.select(0);
        syncControls();
        drawFit();
        render();
    }));
    playBtn.addEventListener('click', () => {
        const playing = loop.toggle();
        playBtn.textContent = playing ? '일시정지' : '재생';
        playBtn.setAttribute('aria-label', playing ? '애니메이션 일시정지' : '애니메이션 재생');
    });
    resetBtn.addEventListener('click', () => {
        buildModel();
        setControl(false);
        steps.select(0);
    });
    media.on('dark', () => { readColors(); drawFit(); render(); });

    /* --- init --- */
    configureRanges();
    readColors();
    buildModel();
    setControl(false);
    syncControls();
    drawFit();
    steps.select(0);
    playBtn.textContent = media.reduced ? '재생' : '일시정지';
    if (debug && debugEl) debugEl.hidden = false;
    ready = true;
    const qs = new URLSearchParams(location.search);
    if (qs.has('labregime') && REGIMES[qs.get('labregime')]) {
        const r = root.querySelector(`input[name="lab-regime"][value="${qs.get('labregime')}"]`);
        if (r) { r.checked = true; r.dispatchEvent(new Event('change')); }
    }
    steps.select(qs.has('labstep') ? Math.max(0, Math.min(STEPS.length - 1, (+qs.get('labstep') || 1) - 1)) : 0);
    if (qs.has('labpreset') && PRESETS[qs.get('labpreset')]) root.querySelector(`[data-preset="${qs.get('labpreset')}"]`).click();
    render();
});
