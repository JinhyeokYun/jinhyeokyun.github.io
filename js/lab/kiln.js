/* ============================================
   Kiln surrogate explorable — conditional latent diffusion pipeline
   Side view of the kiln with axial slices, DDIM sampling (25 steps) in a 64×64×4 latent,
   VAE decoding to five fields, slice-by-slice 3D reconstruction, Table 5 comparison.
   No field is computed here: decoded tiles are the manuscript's own prediction (Fig. 16(b));
   latent tiles and the noise-to-field blend are schematic.
   ============================================ */
import {
    media, debug, readTokens, rgb, mixOklab, createSurface, createLoop, createSteps,
    announcer, mountLab, fontsReady, rng
} from './core.js?v=2026q3';

const STEPS_DDIM = 25, N_SLICE = 501, KILN_L = 25, SLICE_MS = 1140;
const FIELDS = [['T', '온도 T'], ['CO2', 'CO₂'], ['H2O', 'H₂O'], ['CO', 'CO'], ['NO', 'NO']];

/* Table 5 (manuscript): SD Full, CVAE, Deterministic, DeepONet, PCA+MLP, SD Adapter */
const MODELS = ['SD Full', 'CVAE', 'Deterministic', 'DeepONet', 'PCA+MLP', 'SD Adapter'];
const METRICS = {
    mae: { label: '5개 장 정규화 MAE (↓)', v: [0.895, 1.931, 2.363, 2.709, 2.936, 5.246], fmt: v => v.toFixed(3) },
    psnr: { label: 'PSNR, dB (↑)', v: [29.5, 28.0, 24.3, 24.2, 23.3, 20.9], fmt: v => v.toFixed(1) },
    tmae: { label: '온도 MAE, K (↓)', v: [4.47, 9.65, 11.81, 13.55, 14.68, 26.23], fmt: v => v.toFixed(2) },
    peak: { label: '온도 peak count error (↓)', v: [1.37, 14.83, 21.83, 26.33, 25.83, 27.38], fmt: v => v.toFixed(2) }
};

const PHASES = [
    { key: 'problem', mode: 'idle' },
    { key: 'data', mode: 'slices' },
    { key: 'diffusion', mode: 'diffusion' },
    { key: 'reconstruct', mode: 'stack' },
    { key: 'compare', mode: 'diffusion' }
];

const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
/* cumulative signal fraction of a cosine schedule, sampled at DDIM step k of 25 */
const signal = k => { const s = k / STEPS_DDIM; return Math.sin(s * Math.PI / 2) ** 2; };

function loadImage(src) {
    return new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
}

mountLab(document.querySelector('[data-lab="kiln"]'), async root => {
    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));
    const stageWrap = q('.lab-canvas-wrap'), stageCanvas = q('.lab-canvas');
    const barWrap = q('.lab-bar-wrap'), barCanvas = q('.lab-bar-canvas');
    const captionEl = q('.lab-caption');
    const say = announcer(q('.lab-sr'));
    const playBtn = q('[data-act="play"]'), resetBtn = q('[data-act="reset"]'), seedBtn = q('[data-act="seed"]');
    const stepIn = q('#lab-ddim'), stepOut = q('output[for="lab-ddim"]');
    const debugEl = q('.lab-debug');
    const base = root.dataset.assets;
    const captions = {};
    qa('template[data-caption]').forEach(t => { captions[t.dataset.caption] = { html: t.innerHTML.trim(), text: t.content.textContent.trim() }; });

    let colors = null, loop = null, ready = false, phase = 0, metric = 'mae';
    let ddim = 0, ddimAuto = true, tAnim = 0, stack = 0, seed = 5;
    const images = await Promise.all(FIELDS.map(([k]) => loadImage(`${base}/pred-${k}.jpg`)));
    await fontsReady();

    /* schematic latent / noise textures */
    const LAT = 32;
    const latCanvas = document.createElement('canvas'); latCanvas.width = LAT; latCanvas.height = LAT;
    const latCtx = latCanvas.getContext('2d');
    const noiseCanvas = document.createElement('canvas'); noiseCanvas.width = 64; noiseCanvas.height = 64;
    const noiseCtx = noiseCanvas.getContext('2d');
    let latNoise = [], latStruct = [];
    function reseed() {
        const r = rng(seed);
        latNoise = Array.from({ length: 4 }, () => Float32Array.from({ length: LAT * LAT }, () => (r() + r() + r() - 1.5) * 1.4));
        latStruct = Array.from({ length: 4 }, (_, c) => {
            const a = new Float32Array(LAT * LAT), ph = r() * 6.28, k = 1.4 + c * 0.6;
            for (let j = 0; j < LAT; j++) for (let i = 0; i < LAT; i++) {
                const x = i / LAT - 0.5, y = j / LAT - 0.5, rr = Math.hypot(x, y), th = Math.atan2(y, x);
                a[j * LAT + i] = Math.cos(k * 9 * rr + ph + (c % 2 ? th : -th)) * Math.exp(-rr * 3) + 0.25 * Math.sin((c + 1) * 3 * x + ph);
            }
            return a;
        });
        const img = noiseCtx.createImageData(64, 64);
        for (let p = 0; p < 64 * 64; p++) { const v = Math.floor(r() * 255); img.data.set([v, v * 0.35, v * 0.2, 255], p * 4); }
        noiseCtx.putImageData(img, 0, 0);
    }
    reseed();

    function readColors() {
        const tk = readTokens(root, ['--surface', '--surface-2', '--border', '--border-strong', '--text', '--text-2', '--text-3', '--accent', '--accent-soft', '--accent-ink', '--primary', '--warn-ink', '--lab-neg', '--lab-pos']);
        const cs = getComputedStyle(root);
        colors = {
            surface: tk['--surface'], surface2: tk['--surface-2'], border: tk['--border'], borderStrong: tk['--border-strong'],
            text: tk['--text'], text2: tk['--text-2'], text3: tk['--text-3'],
            accent: tk['--accent'], accentSoft: tk['--accent-soft'], accentInk: tk['--accent-ink'],
            primary: tk['--primary'], warnInk: tk['--warn-ink'], labNeg: tk['--lab-neg'], labPos: tk['--lab-pos'],
            fontMono: cs.getPropertyValue('--font-mono').trim() || 'monospace'
        };
    }

    const stage = createSurface(stageWrap, stageCanvas, { onResize: () => { if (ready && !loop.running) render(); } });
    const barSurf = createSurface(barWrap, barCanvas, { onResize: () => { if (ready) drawBars(); } });

    function drawLatent(ctx, x, y, size, c, a) {
        const img = latCtx.createImageData(LAT, LAT), n = latNoise[c], s = latStruct[c];
        for (let p = 0; p < LAT * LAT; p++) {
            const v = Math.max(-1, Math.min(1, (1 - a) * n[p] + a * s[p]));
            const col = v < 0 ? mixOklab(colors.surface, colors.labNeg, -v) : mixOklab(colors.surface, colors.labPos, v);
            img.data.set([col[0], col[1], col[2], 255], p * 4);
        }
        latCtx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(latCanvas, x, y, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.strokeStyle = rgb(colors.border); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    }

    function render() {
        if (!colors) return;
        const { ctx, w, h } = stage;
        const ph = PHASES[phase];
        ctx.fillStyle = rgb(colors.surface); ctx.fillRect(0, 0, w, h);
        const narrow = w < 640;
        const leftW = narrow ? w : w * 0.52;

        /* --- kiln side view --- */
        const kx0 = 28, kx1 = leftW - 24, ky = narrow ? h * 0.27 + 8 : h * 0.52, kr = Math.min(narrow ? h * 0.1 : h * 0.2, 90), ex = kr * 0.32;
        const Z = z => kx0 + z / KILN_L * (kx1 - kx0);
        ctx.fillStyle = rgb(colors.surface2);
        ctx.beginPath(); ctx.moveTo(kx0, ky - kr); ctx.lineTo(kx1, ky - kr); ctx.ellipse(kx1, ky, ex, kr, 0, -Math.PI / 2, Math.PI / 2); ctx.lineTo(kx0, ky + kr); ctx.ellipse(kx0, ky, ex, kr, 0, Math.PI / 2, -Math.PI / 2); ctx.fill();
        ctx.strokeStyle = rgb(colors.text3); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(kx0, ky - kr); ctx.lineTo(kx1, ky - kr); ctx.moveTo(kx0, ky + kr); ctx.lineTo(kx1, ky + kr); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(kx1, ky, ex, kr, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(kx0, ky, ex, kr, 0, 0, Math.PI * 2); ctx.stroke();
        /* burner */
        ctx.fillStyle = rgb(colors.warnInk);
        ctx.beginPath(); ctx.ellipse(kx0, ky, ex * 0.3, kr * 0.22, 0, 0, Math.PI * 2); ctx.fill();
        ctx.font = `500 11px ${colors.fontMono}`; ctx.fillStyle = rgb(colors.text2); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('버너 (z = 0)', kx0 - 6, ky - kr - 10);
        /* axial ticks */
        ctx.strokeStyle = rgb(colors.text3, 0.7); ctx.fillStyle = rgb(colors.text3); ctx.textAlign = 'center';
        for (let z = 0; z <= KILN_L; z += 5) { const x = Z(z); ctx.beginPath(); ctx.moveTo(x, ky + kr + 6); ctx.lineTo(x, ky + kr + 11); ctx.stroke(); ctx.fillText(`${z}`, x, ky + kr + 24); }
        ctx.textAlign = 'right'; ctx.fillText('z [m]', kx1 + ex, ky + kr + 38);

        /* slices */
        const drawSlice = (z, alpha, color, lw) => { ctx.strokeStyle = rgb(color, alpha); ctx.lineWidth = lw; ctx.beginPath(); ctx.ellipse(Z(z), ky, ex, kr, 0, 0, Math.PI * 2); ctx.stroke(); };
        if (ph.mode === 'slices') {
            for (let k = 0; k < N_SLICE; k += 10) drawSlice(k / (N_SLICE - 1) * KILN_L, 0.35, colors.primary, 1);
            const zp = (tAnim * 2) % KILN_L;
            drawSlice(zp, 1, colors.accentInk, 2);
        } else if (ph.mode === 'stack') {
            const n = Math.floor(stack);
            for (let k = 0; k < n; k += 4) drawSlice(k / (N_SLICE - 1) * KILN_L, 0.22, colors.accent, 1);
            if (n < N_SLICE) drawSlice(n / (N_SLICE - 1) * KILN_L, 1, colors.accentInk, 2);
            ctx.fillStyle = rgb(colors.text); ctx.textAlign = 'left'; ctx.font = `600 12px ${colors.fontMono}`;
            const secs = n * SLICE_MS / 1000;
            ctx.fillText(`단면 ${Math.min(n, N_SLICE)} / ${N_SLICE}`, kx0, ky - kr - 30);
            ctx.font = `500 11px ${colors.fontMono}`; ctx.fillStyle = rgb(colors.text2);
            const tText = `누적 추론 시간 ≈ ${Math.floor(secs / 60)}분 ${Math.round(secs % 60)}초${narrow ? '' : ' (단면당 1.14 s)'}`;
            if (narrow) ctx.fillText(tText, kx0 + 104, ky - kr - 30); else ctx.fillText(tText, kx0 + 120, ky - kr - 30);
        } else {
            drawSlice(0.5, 1, colors.accentInk, 2);
        }

        /* --- pipeline (latent → decoder → fields) --- */
        const px0 = narrow ? 16 : leftW + 12, pw = narrow ? w - 32 : w - leftW - 28;
        const a = ph.mode === 'idle' || ph.mode === 'slices' ? 0 : ph.mode === 'stack' ? 1 : signal(ddim);
        const lat = Math.min(narrow ? 60 : 84, (pw - 3 * 8) / 4 * 0.66);
        const tileMax = Math.min((pw - 4 * 6) / 5, narrow ? 64 : 124);
        const blockH = 14 + lat + 36 + tileMax + 34;
        const py0 = narrow ? h * 0.53 : Math.max(18, (h - blockH) / 2);
        ctx.font = `500 11px ${colors.fontMono}`; ctx.fillStyle = rgb(colors.text2); ctx.textAlign = 'left';
        ctx.fillText(`latent 64 × 64 × 4 · DDIM ${ph.mode === 'idle' || ph.mode === 'slices' ? 0 : ph.mode === 'stack' ? STEPS_DDIM : ddim} / ${STEPS_DDIM}`, px0, py0 + 4);
        for (let c = 0; c < 4; c++) drawLatent(ctx, px0 + c * (lat + 8), py0 + 14, lat, c, ph.mode === 'stack' ? 1 : a);
        const ay = py0 + 14 + lat + 10;
        ctx.strokeStyle = rgb(colors.text3); ctx.fillStyle = rgb(colors.text3); ctx.lineWidth = 1.2;
        const acx = px0 + (4 * lat + 24) / 2;
        ctx.beginPath(); ctx.moveTo(acx, ay); ctx.lineTo(acx, ay + 16); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(acx - 4, ay + 11); ctx.lineTo(acx, ay + 17); ctx.lineTo(acx + 4, ay + 11); ctx.fill();
        ctx.fillText('VAE decoder → 512 × 512 × 5', acx + 10, ay + 13);
        const ty = ay + 26, tile = tileMax;
        FIELDS.forEach(([, label], i) => {
            const x = px0 + i * (tile + 6);
            ctx.fillStyle = rgb(colors.surface2); ctx.fillRect(x, ty, tile, tile);
            if (a < 1) { ctx.globalAlpha = 1 - a; ctx.imageSmoothingEnabled = false; ctx.drawImage(noiseCanvas, (i * 11) % 32, (i * 7) % 32, 32, 32, x, ty, tile, tile); ctx.imageSmoothingEnabled = true; }
            if (images[i] && a > 0) { ctx.globalAlpha = a; ctx.drawImage(images[i], x, ty, tile, tile); }
            ctx.globalAlpha = 1;
            ctx.strokeStyle = rgb(colors.border); ctx.strokeRect(x + 0.5, ty + 0.5, tile - 1, tile - 1);
            ctx.fillStyle = rgb(colors.text2); ctx.textAlign = 'center'; ctx.font = `500 11px ${colors.fontMono}`;
            ctx.fillText(label, x + tile / 2, ty + tile + 14);
        });
        ctx.textAlign = 'left'; ctx.fillStyle = rgb(colors.text3); ctx.font = `500 10px ${colors.fontMono}`;
        ctx.fillText(narrow ? '최종 단면: 원고 Fig. 16(b) 모델 예측' : '최종 단면: 검증 사례의 모델 예측 (ẑ = 0.020, 원고 Fig. 16(b))', px0, ty + tile + 30);

        if (debugEl) { const d = loop.stats(); debugEl.textContent = `${d.avg.toFixed(1)} ms · tier ${d.tier}`; }
    }

    function drawBars() {
        if (!colors) return;
        const { ctx, w, h } = barSurf;
        ctx.fillStyle = rgb(colors.surface); ctx.fillRect(0, 0, w, h);
        const m = METRICS[metric];
        const max = Math.max(...m.v) * 1.12;
        const padL = 112, padR = 64, rowH = (h - 20) / MODELS.length;
        ctx.font = `500 12px ${colors.fontMono}`; ctx.textBaseline = 'middle';
        MODELS.forEach((name, i) => {
            const y = 10 + i * rowH + rowH / 2;
            ctx.fillStyle = rgb(i === 0 ? colors.text : colors.text2); ctx.textAlign = 'right';
            ctx.fillText(name, padL - 10, y);
            const bw = m.v[i] / max * (w - padL - padR);
            ctx.fillStyle = rgb(i === 0 ? colors.accent : colors.text3, i === 0 ? 1 : 0.55);
            ctx.fillRect(padL, y - rowH * 0.3, bw, rowH * 0.6);
            ctx.fillStyle = rgb(colors.text); ctx.textAlign = 'left';
            ctx.fillText(m.fmt(m.v[i]), padL + bw + 8, y);
        });
    }

    function advance(dt) {
        tAnim += dt;
        const ph = PHASES[phase];
        if (ph.mode === 'diffusion' && ddimAuto) {
            const cycle = 7, u = (tAnim % cycle) / cycle;
            const k = Math.min(STEPS_DDIM, Math.floor(smooth(Math.min(1, u / 0.75)) * STEPS_DDIM + 0.001));
            if (k !== ddim) { ddim = k; stepIn.value = k; stepOut.textContent = String(k); }
            if (u < 0.02 && tAnim > 1) { seed++; reseed(); }
        }
        if (ph.mode === 'stack') { stack = Math.min(N_SLICE, stack + dt * 45); if (stack >= N_SLICE && tAnim > 16) { stack = 0; tAnim = 0; } }
    }

    loop = createLoop({ root, tick: dt => advance(dt), draw: render });

    function selectPhase(i) {
        phase = i;
        const ph = PHASES[i];
        tAnim = 0; stack = ph.mode === 'stack' ? 0 : stack;
        if (ph.mode === 'diffusion') { ddimAuto = true; ddim = media.reduced ? STEPS_DDIM : 0; }
        if (media.reduced && ph.mode === 'stack') stack = N_SLICE;
        stepIn.value = ddim; stepOut.textContent = String(ddim);
        root.dataset.phase = ph.key;
        const c = captions[ph.key] || { html: '', text: '' };
        captionEl.innerHTML = c.html;
        say(c.text);
        if (ready) render();
    }
    const steps = createSteps(q('.lab-steps'), selectPhase);

    stepIn.addEventListener('input', () => {
        ddimAuto = false; ddim = +stepIn.value; stepOut.textContent = String(ddim);
        stepIn.setAttribute('aria-valuetext', `DDIM ${ddim} / 25`);
        if (PHASES[phase].mode !== 'diffusion') steps.select(2);
        render();
    });
    seedBtn.addEventListener('click', () => { seed += 17; reseed(); ddimAuto = true; tAnim = 0; if (PHASES[phase].mode !== 'diffusion') steps.select(2); render(); });
    qa('input[name="lab-metric"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { metric = r.value; drawBars(); } }));
    playBtn.addEventListener('click', () => {
        const playing = loop.toggle();
        playBtn.textContent = playing ? '일시정지' : '재생';
        playBtn.setAttribute('aria-label', playing ? '애니메이션 일시정지' : '애니메이션 재생');
    });
    resetBtn.addEventListener('click', () => steps.select(0));
    media.on('dark', () => { readColors(); render(); drawBars(); });

    readColors();
    playBtn.textContent = media.reduced ? '재생' : '일시정지';
    if (debug && debugEl) debugEl.hidden = false;
    ready = true;
    drawBars();
    const qs = new URLSearchParams(location.search);
    steps.select(qs.has('labstep') ? Math.max(0, Math.min(PHASES.length - 1, (+qs.get('labstep') || 1) - 1)) : 0);
});
