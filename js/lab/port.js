/* ============================================
   Ship-operation explorable — route & speed policy vs peak exposure (J1) and fuel (J2)
   Background flow: uniform inflow + a Re = 100-like vortex street (procedural);
   emission ∝ v³ as Gaussian puffs; 4th-order Bézier path (N_cp = 5) and Bézier speed profile.
   The objective-space search is a random search for illustration, not the paper's qLogEHVI MOBO.
   ============================================ */
import {
    media, debug, readTokens, rgb, mixOklab, lutSequential, createSurface, createField, createLoop,
    createSteps, announcer, mountLab, fontsReady, rng
} from './core.js?v=2026q3';

import {
    DOM, START, END, ZONES_P, ZONE_X, V_MIN, V_MAX, DIFF, EMIT_DT, SIG0, PAPER, STEPS,
    lerp, clamp, bez4, baselinePolicy, clonePolicy, createFlow, voyage, evaluate
} from './port-model.js?v=2026q3';

const TIME_SCALE = 1.3;

mountLab(document.querySelector('[data-lab="port"]'), async root => {
    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));
    const stageWrap = q('.lab-canvas-wrap'), stageCanvas = q('.lab-canvas');
    const objWrap = q('.lab-obj-wrap'), objCanvas = q('.lab-obj-canvas');
    const speedWrap = q('.lab-speed-wrap'), speedCanvas = q('.lab-speed-canvas');
    const paperWrap = q('.lab-pareto-wrap'), paperCanvas = q('.lab-pareto-canvas');
    const captionEl = q('.lab-caption');
    const say = announcer(q('.lab-sr'));
    const playBtn = q('[data-act="play"]'), resetBtn = q('[data-act="reset"]'), searchBtn = q('[data-act="search"]');
    const objText = q('.lab-obj-text');
    const barJ1 = q('[data-bar="j1"]'), barJ2 = q('[data-bar="j2"]');
    const debugEl = q('.lab-debug');
    const captions = {};
    qa('template[data-caption]').forEach(t => { captions[t.dataset.caption] = { html: t.innerHTML.trim(), text: t.content.textContent.trim() }; });

    let inflow = 'south', flow = createFlow(inflow);
    let policy = baselinePolicy(), vy = voyage(policy);
    let base = null, cur = null, candidates = [], searching = 0, selected = -1;
    let colors = null, lut = null, loop = null, ready = false, stepIndex = 0;
    let t = 0, emitAcc = 0, puffs = [], hold = 0;
    let dragging = -1, activeHandle = 1, objScale = { xr: [0, 2], yr: [0.8, 1.6], pad: 30 };
    const tracers = [];
    const rand = rng(7);
    const field = createField();
    const view = { w: 1, h: 1, s: 1, ox: 0, oy: 0 };

    await fontsReady();

    function readColors() {
        const tk = readTokens(root, ['--surface', '--surface-2', '--border', '--text', '--text-2', '--text-3', '--accent', '--accent-soft', '--accent-ink', '--primary', '--warn-ink', '--warn-soft', '--lab-neg', '--lab-pos']);
        const cs = getComputedStyle(root);
        colors = {
            surface: tk['--surface'], surface2: tk['--surface-2'], border: tk['--border'],
            text: tk['--text'], text2: tk['--text-2'], text3: tk['--text-3'],
            accent: tk['--accent'], accentSoft: tk['--accent-soft'], accentInk: tk['--accent-ink'],
            primary: tk['--primary'], warnInk: tk['--warn-ink'], warnSoft: tk['--warn-soft'], labNeg: tk['--lab-neg'], labPos: tk['--lab-pos'],
            fontMono: cs.getPropertyValue('--font-mono').trim() || 'monospace'
        };
        /* field.blit maps 0 → LUT centre, so the sequential ramp occupies the upper half */
        const seq = lutSequential([colors.surface, mixOklab(colors.surface, colors.labPos, 0.45), colors.labPos, mixOklab(colors.labPos, colors.warnInk, 0.6)], 128);
        lut = new Uint32Array(256);
        lut.fill(seq[0], 0, 128);
        lut.set(seq, 128);
    }

    const stage = createSurface(stageWrap, stageCanvas, {
        onResize: s => {
            view.w = s.w; view.h = s.h;
            view.s = Math.min(s.w / (DOM.x1 - DOM.x0), (s.h - 16) / (DOM.y1 - DOM.y0));
            view.ox = (s.w - (DOM.x1 - DOM.x0) * view.s) / 2;
            view.oy = (s.h - (DOM.y1 - DOM.y0) * view.s) / 2;
            const nx = Math.max(90, Math.min(200, Math.round(s.w / 5)));
            const dx = (DOM.x1 - DOM.x0) / nx;
            field.resize(nx, Math.round((DOM.y1 - DOM.y0) / dx), DOM.x0, DOM.y1, dx);
            if (ready && !loop.running) render();
        }
    });
    const SX = x => view.ox + (x - DOM.x0) * view.s;
    const SY = y => view.oy + (DOM.y1 - y) * view.s;
    const WX = px => DOM.x0 + (px - view.ox) / view.s;
    const WY = py => DOM.y1 - (py - view.oy) / view.s;
    const objSurf = createSurface(objWrap, objCanvas, { onResize: () => { if (ready) drawObjective(); } });
    const speedSurf = createSurface(speedWrap, speedCanvas, { onResize: () => { if (ready) drawSpeed(); } });
    const paperSurf = createSurface(paperWrap, paperCanvas, { onResize: () => { if (ready) drawPaper(); } });

    /* --- evaluation & search --- */
    function reevaluate() {
        vy = voyage(policy);
        cur = evaluate(policy, flow);
        updateBars();
        drawObjective();
    }
    function rebaseline() {
        flow = createFlow(inflow);
        base = evaluate(baselinePolicy(), flow);
        candidates = []; selected = -1; searching = 0;
        reevaluate();
        drawPaper();
    }
    function randomPolicy() {
        const b = baselinePolicy();
        return {
            p: b.p.map(([x, y]) => [clamp(x + (rand() - 0.5) * 2.4, -2.8, 2.8), clamp(y + (rand() - 0.5) * 2.4, -1.9, 1.2)]),
            v: b.v.map(() => lerp(V_MIN, V_MAX, rand()))
        };
    }
    function pareto(list) {
        return list.map((c, i) => ({ c, i })).filter(({ c }) => c.feasible && !list.some(o => o.feasible && o !== c && o.J1 <= c.J1 && o.J2 <= c.J2 && (o.J1 < c.J1 || o.J2 < c.J2))).map(o => o.i);
    }
    function searchTick() {
        if (searching <= 0) return;
        const n = Math.min(2, searching);
        for (let k = 0; k < n; k++) {
            const pol = candidates.length < 6 ? randomPolicy() : mutate();
            const r = evaluate(pol, flow);
            candidates.push({ pol, ...r });
            searching--;
        }
        if (searching === 0) {
            const front = pareto(candidates);
            if (front.length && STEPS[stepIndex].key === 'pareto') {
                const best = front.reduce((a, b) => candidates[a].J1 <= candidates[b].J1 ? a : b);
                selectCandidate(best);
            }
            say('탐색을 완료하였다. 목적 공간의 Pareto 해를 선택하면 해당 경로와 속도 분포가 지도에 표시된다.');
        }
        drawObjective();
    }
    function mutate() {
        const front = pareto(candidates);
        const src = front.length ? candidates[front[Math.floor(rand() * front.length)]].pol : baselinePolicy();
        const p = clonePolicy(src);
        p.p = p.p.map(([x, y]) => [clamp(x + (rand() - 0.5) * 0.8, -2.8, 2.8), clamp(y + (rand() - 0.5) * 0.8, -1.9, 1.2)]);
        p.v = p.v.map(v => clamp(v + (rand() - 0.5) * 0.35, V_MIN, V_MAX));
        return p;
    }

    function updateBars() {
        if (!base || !cur) return;
        const r1 = cur.J1 / Math.max(1e-9, base.J1), r2 = cur.J2 / Math.max(1e-9, base.J2);
        barJ1.style.setProperty('--v', String(clamp(r1 / 2, 0, 1)));
        barJ2.style.setProperty('--v', String(clamp(r2 / 2, 0, 1)));
        barJ1.dataset.state = r1 < 0.97 ? 'better' : r1 > 1.03 ? 'worse' : 'same';
        barJ2.dataset.state = r2 < 0.99 ? 'better' : r2 > 1.01 ? 'worse' : 'same';
        const word = (r, eps) => r < 1 - eps ? '감소' : r > 1 + eps ? '증가' : '유사';
        objText.textContent = `기준 경로 대비 J₁ ${word(r1, 0.03)}, J₂ ${word(r2, 0.01)}${cur.feasible ? '' : ' · 통항 제한 구역 침범'}`;
    }

    /* --- live voyage animation --- */
    function restartVoyage() { t = 0; emitAcc = 0; puffs = []; hold = 0; }
    function stepSim(dt) {
        if (hold > 0) { hold -= dt; if (hold <= 0) restartVoyage(); return; }
        t += dt;
        const vs = flow.vortices(t);
        if (t < vy.T) {
            emitAcc += dt;
            while (emitAcc >= EMIT_DT) {
                emitAcc -= EMIT_DT;
                const s = vy.at(t);
                puffs.push({ x: s.x, y: s.y, m: s.v * s.v * s.v * EMIT_DT, s2: SIG0 * SIG0 });
            }
        }
        for (const p of puffs) {
            const [u1, v1] = flow.velocity(p.x, p.y, vs);
            p.x += u1 * dt; p.y += v1 * dt; p.s2 += 2 * DIFF * dt;
        }
        puffs = puffs.filter(p => p.x > DOM.x0 - 1 && p.x < DOM.x1 + 1 && p.y > DOM.y0 - 1 && p.y < DOM.y1 + 1);
        const want = media.coarse ? 120 : 220;
        while (tracers.length < want) tracers.push({ x: lerp(DOM.x0, DOM.x1, rand()), y: lerp(DOM.y0, DOM.y1, rand()), age: rand() * 3 });
        for (const p of tracers) {
            const [u, v] = flow.velocity(p.x, p.y, vs);
            p.px = p.x; p.py = p.y;
            p.x += u * dt; p.y += v * dt; p.age += dt;
            if (p.age > 3 || p.x < DOM.x0 || p.x > DOM.x1 || p.y < DOM.y0 || p.y > DOM.y1) {
                p.x = lerp(DOM.x0, DOM.x1, rand()); p.y = lerp(DOM.y0, DOM.y1, rand()); p.px = p.x; p.py = p.y; p.age = 0;
            }
        }
        if (t > vy.T + 2.5) hold = 0.8;
    }
    function advance(dtWorld) {
        const n = Math.max(1, Math.ceil(dtWorld / 0.03));
        for (let i = 0; i < n; i++) stepSim(dtWorld / n);
        searchTick();
    }

    /* --- drawing --- */
    function render() {
        if (!colors) return;
        const { ctx, w, h } = stage;
        const st = STEPS[stepIndex];
        ctx.fillStyle = rgb(colors.surface);
        ctx.fillRect(0, 0, w, h);

        field.clear();
        for (const p of puffs) field.splat(p.x, p.y, p.m / (2 * Math.PI * p.s2) * 0.6, Math.sqrt(p.s2) * 1.4);
        field.blit(ctx, lut, 1, SX(DOM.x0), SY(DOM.y1), (DOM.x1 - DOM.x0) * view.s, (DOM.y1 - DOM.y0) * view.s);

        /* zones */
        for (const r of ZONES_P) {
            ctx.strokeStyle = rgb(colors.accentInk, 0.9); ctx.lineWidth = 1.5;
            ctx.fillStyle = rgb(colors.accent, 0.08);
            ctx.fillRect(SX(r[0]), SY(r[3]), (r[2] - r[0]) * view.s, (r[3] - r[1]) * view.s);
            ctx.strokeRect(SX(r[0]) + 0.5, SY(r[3]) + 0.5, (r[2] - r[0]) * view.s - 1, (r[3] - r[1]) * view.s - 1);
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(SX(ZONE_X[0]), SY(ZONE_X[3]), (ZONE_X[2] - ZONE_X[0]) * view.s, (ZONE_X[3] - ZONE_X[1]) * view.s); ctx.clip();
        ctx.strokeStyle = rgb(colors.text3, 0.55); ctx.lineWidth = 1;
        for (let x = -400; x < 400; x += 9) { ctx.beginPath(); ctx.moveTo(SX(ZONE_X[0]) + x, SY(ZONE_X[1])); ctx.lineTo(SX(ZONE_X[0]) + x + 200, SY(ZONE_X[1]) - 200); ctx.stroke(); }
        ctx.restore();
        ctx.strokeStyle = rgb(colors.text2); ctx.lineWidth = 1.2;
        ctx.strokeRect(SX(ZONE_X[0]) + 0.5, SY(ZONE_X[3]) + 0.5, (ZONE_X[2] - ZONE_X[0]) * view.s - 1, (ZONE_X[3] - ZONE_X[1]) * view.s - 1);

        /* flow tracers */
        ctx.strokeStyle = rgb(colors.text3, 0.45); ctx.lineWidth = 1;
        ctx.beginPath();
        for (const p of tracers) {
            if (p.px === undefined) continue;
            const dx = p.x - p.px, dy = p.y - p.py;
            ctx.moveTo(SX(p.x), SY(p.y)); ctx.lineTo(SX(p.x - dx * 6), SY(p.y - dy * 6));
        }
        ctx.stroke();

        /* sparse sensors */
        if (st.sensors) {
            const vs = flow.vortices(t);
            for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
                const x = lerp(DOM.x0 + 0.4, DOM.x1 - 0.4, i / 6), y = lerp(DOM.y0 + 0.3, DOM.y1 - 0.3, j / 6);
                const [u, v] = flow.velocity(x, y, vs);
                ctx.strokeStyle = rgb(colors.primary); ctx.fillStyle = rgb(colors.primary); ctx.lineWidth = 1.6;
                ctx.beginPath(); ctx.moveTo(SX(x), SY(y)); ctx.lineTo(SX(x + u * 0.5), SY(y + v * 0.5)); ctx.stroke();
                ctx.beginPath(); ctx.arc(SX(x), SY(y), 3.4, 0, Math.PI * 2); ctx.fill();
            }
        }

        /* baseline and current path */
        const bpts = [START, ...baselinePolicy().p, END];
        ctx.setLineDash([5, 5]); ctx.strokeStyle = rgb(colors.text3); ctx.lineWidth = 1.2;
        ctx.beginPath(); for (let i = 0; i <= 40; i++) { const [x, y] = bez4(bpts, i / 40); i ? ctx.lineTo(SX(x), SY(y)) : ctx.moveTo(SX(x), SY(y)); } ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = rgb(colors.primary); ctx.lineWidth = 2.4;
        ctx.beginPath(); vy.xs.forEach(([x, y], i) => i ? ctx.lineTo(SX(x), SY(y)) : ctx.moveTo(SX(x), SY(y))); ctx.stroke();
        if (st.handles) {
            const cp = [START, ...policy.p, END];
            ctx.setLineDash([2, 4]); ctx.strokeStyle = rgb(colors.text3, 0.8); ctx.lineWidth = 1;
            ctx.beginPath(); cp.forEach(([x, y], i) => i ? ctx.lineTo(SX(x), SY(y)) : ctx.moveTo(SX(x), SY(y))); ctx.stroke(); ctx.setLineDash([]);
            policy.p.forEach(([x, y], i) => {
                ctx.fillStyle = rgb(colors.surface); ctx.strokeStyle = rgb(i === activeHandle ? colors.warnInk : colors.primary); ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(SX(x), SY(y), 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = rgb(colors.text2); ctx.font = `600 10px ${colors.fontMono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(String(i + 1), SX(x), SY(y) + 0.5);
            });
        }
        for (const [p, lab] of [[START, '출발'], [END, '도착']]) {
            ctx.fillStyle = rgb(colors.text); ctx.beginPath(); ctx.arc(SX(p[0]), SY(p[1]), 4.5, 0, Math.PI * 2); ctx.fill();
            ctx.font = `500 11px ${colors.fontMono}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            ctx.fillText(lab, SX(p[0]) + 8, SY(p[1]) + 14);
        }

        /* ship */
        if (t < vy.T && hold <= 0) {
            const s = vy.at(t), a = Math.atan2(-s.hy, s.hx);
            ctx.save(); ctx.translate(SX(s.x), SY(s.y)); ctx.rotate(a);
            ctx.fillStyle = rgb(colors.text); ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -5); ctx.lineTo(-4, 0); ctx.lineTo(-6, 5); ctx.closePath(); ctx.fill();
            ctx.restore();
        }

        /* labels */
        ctx.font = `500 11px ${colors.fontMono}`;
        ctx.fillStyle = rgb(colors.accentInk); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('보호구역 Ω_P', SX(ZONES_P[0][0]) + 6, SY(ZONES_P[0][1]) - 6);
        ctx.fillStyle = rgb(colors.text2);
        ctx.fillText('통항 제한 Ω_X', SX(ZONE_X[0]), SY(ZONE_X[3]) - 6);
        const d = flow.dir;
        const ax = w - 70, ay = 44;
        ctx.strokeStyle = rgb(colors.text2); ctx.fillStyle = rgb(colors.text2); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ax - d[0] * 18, ay + d[1] * 18); ctx.lineTo(ax + d[0] * 18, ay - d[1] * 18); ctx.stroke();
        const hx = ax + d[0] * 18, hy = ay - d[1] * 18;
        ctx.beginPath(); ctx.moveTo(hx + d[0] * 6, hy - d[1] * 6); ctx.lineTo(hx - d[1] * 5, hy - d[0] * 5); ctx.lineTo(hx + d[1] * 5, hy + d[0] * 5); ctx.closePath(); ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillText(inflow === 'south' ? '남풍 유입' : '동풍 유입', ax, ay + 34);

        if (debugEl) { const s = loop.stats(); debugEl.textContent = `${s.avg.toFixed(1)} ms · tier ${s.tier} · puffs ${puffs.length}`; }
    }

    function drawObjective() {
        if (!colors) return;
        const { ctx, w, h } = objSurf;
        ctx.fillStyle = rgb(colors.surface); ctx.fillRect(0, 0, w, h);
        if (!base) return;
        const pad = 30;
        const rx = [1], ry = [1];
        for (const c of candidates) { rx.push(c.J1 / base.J1); ry.push(c.J2 / base.J2); }
        if (cur) { rx.push(cur.J1 / base.J1); ry.push(cur.J2 / base.J2); }
        const qt = (arr, f) => { const v = [...arr].sort((m, n) => m - n); return v[Math.min(v.length - 1, Math.floor(f * (v.length - 1)))]; };
        const xr = [Math.max(0, Math.min(...rx) * 0.9), Math.min(3, Math.max(1.2, qt(rx, 0.92)) * 1.05)];
        const yr = [Math.min(...ry) - 0.02, Math.min(2.5, Math.max(1.05, qt(ry, 0.9))) + 0.02];
        objScale = { xr, yr, pad };
        const X = r => pad + clamp((r - xr[0]) / (xr[1] - xr[0]), 0, 1) * (w - pad - 12);
        const Y = r => h - pad - clamp((r - yr[0]) / (yr[1] - yr[0]), 0, 1) * (h - pad - 12);
        ctx.strokeStyle = rgb(colors.border); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad, 8); ctx.lineTo(pad, h - pad); ctx.lineTo(w - 8, h - pad); ctx.stroke();
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(X(1), 8); ctx.lineTo(X(1), h - pad); ctx.moveTo(pad, Y(1)); ctx.lineTo(w - 8, Y(1)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `500 10px ${colors.fontMono}`; ctx.fillStyle = rgb(colors.text3);
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('J₁ 최대 노출 (기준 대비) →', (pad + w) / 2, h - 10);
        ctx.save(); ctx.translate(12, (h - pad) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('J₂ 연료 (기준 대비) →', 0, 0); ctx.restore();
        const front = new Set(pareto(candidates));
        candidates.forEach((c, i) => {
            const r1 = c.J1 / base.J1, r2 = c.J2 / base.J2;
            const on = front.has(i);
            ctx.fillStyle = rgb(on ? colors.accentInk : colors.text3, on ? 0.95 : 0.35);
            ctx.beginPath(); ctx.arc(X(r1), Y(r2), on ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
            if (i === selected) { ctx.strokeStyle = rgb(colors.warnInk); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(r1), Y(r2), 7, 0, Math.PI * 2); ctx.stroke(); }
        });
        const fr = [...front].map(i => candidates[i]).sort((a, b) => a.J1 - b.J1);
        if (fr.length > 1) {
            ctx.strokeStyle = rgb(colors.accentInk, 0.6); ctx.lineWidth = 1.2;
            ctx.beginPath(); fr.forEach((c, k) => { const x = X(c.J1 / base.J1), y = Y(c.J2 / base.J2); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
        }
        ctx.strokeStyle = rgb(colors.text); ctx.lineWidth = 1.6;
        const bx = X(1), by = Y(1);
        ctx.beginPath(); ctx.moveTo(bx - 5, by - 5); ctx.lineTo(bx + 5, by + 5); ctx.moveTo(bx + 5, by - 5); ctx.lineTo(bx - 5, by + 5); ctx.stroke();
        if (cur) {
            ctx.fillStyle = rgb(colors.primary);
            const cx = X(cur.J1 / base.J1), cy = Y(cur.J2 / base.J2);
            ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx + 6, cy); ctx.lineTo(cx, cy + 6); ctx.lineTo(cx - 6, cy); ctx.closePath(); ctx.fill();
        }
    }

    function drawSpeed() {
        if (!colors) return;
        const { ctx, w, h } = speedSurf;
        ctx.fillStyle = rgb(colors.surface); ctx.fillRect(0, 0, w, h);
        const pad = 14;
        const X = tau => pad + tau * (w - 2 * pad);
        const Y = v => h - pad - (v - V_MIN) / (V_MAX - V_MIN) * (h - 2 * pad);
        ctx.setLineDash([3, 4]); ctx.strokeStyle = rgb(colors.border);
        ctx.beginPath(); ctx.moveTo(pad, Y(1)); ctx.lineTo(w - pad, Y(1)); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle = rgb(colors.primary); ctx.lineWidth = 2;
        ctx.beginPath(); for (let i = 0; i <= 50; i++) { const tau = i / 50; const v = bez4(policy.v, tau); i ? ctx.lineTo(X(tau), Y(v)) : ctx.moveTo(X(tau), Y(v)); } ctx.stroke();
        policy.v.forEach((v, i) => {
            ctx.fillStyle = rgb(colors.surface); ctx.strokeStyle = rgb(colors.primary); ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(X(i / 4), Y(v), 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        });
        if (t < vy.T) {
            const s = vy.at(t);
            ctx.strokeStyle = rgb(colors.warnInk, 0.8); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(X(s.tau), pad - 4); ctx.lineTo(X(s.tau), h - pad + 4); ctx.stroke();
        }
        ctx.font = `500 10px ${colors.fontMono}`; ctx.fillStyle = rgb(colors.text3); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('v(τ)', 4, 11);
        ctx.textAlign = 'right'; ctx.fillText('τ →', w - 4, h - 3);
    }

    function drawPaper() {
        if (!colors) return;
        const { ctx, w, h } = paperSurf;
        ctx.fillStyle = rgb(colors.surface); ctx.fillRect(0, 0, w, h);
        const d = PAPER[inflow];
        const padL = 44, padB = 30, padT = 10, padR = 12;
        const x0 = 0, x1 = 0.55, y0 = 0.7, y1 = 1.12;
        const X = v => padL + (v - x0) / (x1 - x0) * (w - padL - padR);
        const Y = v => h - padB - (v - y0) / (y1 - y0) * (h - padB - padT);
        ctx.strokeStyle = rgb(colors.border); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();
        ctx.font = `500 10px ${colors.fontMono}`; ctx.fillStyle = rgb(colors.text3);
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        for (const v of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) ctx.fillText(v.toFixed(1), X(v), h - padB + 13);
        ctx.fillText('J₁', w - padR - 6, h - padB - 4);
        ctx.textAlign = 'right';
        for (const v of [0.8, 0.9, 1.0, 1.1]) ctx.fillText(v.toFixed(1), padL - 5, Y(v) + 3);
        ctx.textAlign = 'left'; ctx.fillText('J₂', padL + 4, padT + 8);
        ctx.strokeStyle = rgb(colors.text); ctx.lineWidth = 1.6;
        const bx = X(d.base[0]), by = Y(d.base[1]);
        ctx.beginPath(); ctx.moveTo(bx - 5, by - 5); ctx.lineTo(bx + 5, by + 5); ctx.moveTo(bx + 5, by - 5); ctx.lineTo(bx - 5, by + 5); ctx.stroke();
        ctx.fillStyle = rgb(colors.text2); ctx.textAlign = 'left'; ctx.fillText('기준', bx + 7, by + 3);
        for (const [id, j1, j2] of d.pts) {
            const better = j1 < d.base[0] && j2 < d.base[1];
            ctx.fillStyle = rgb(better ? colors.warnInk : colors.accentInk);
            ctx.beginPath(); ctx.arc(X(j1), Y(j2), 4.2, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = rgb(colors.text2); ctx.fillText(String(id), X(j1) + 6, Y(j2) - 4);
        }
    }

    loop = createLoop({ root, tick: dt => advance(dt * TIME_SCALE), draw: () => { render(); drawSpeed(); } });

    /* --- interaction: drag path control points and speed control points --- */
    function hitHandle(px, py) {
        let best = -1, bd = 16;
        policy.p.forEach(([x, y], i) => { const dd = Math.hypot(SX(x) - px, SY(y) - py); if (dd < bd) { bd = dd; best = i; } });
        return best;
    }
    let evalTimer = 0;
    function scheduleEval() { clearTimeout(evalTimer); evalTimer = setTimeout(() => { reevaluate(); restartVoyage(); if (!loop.running) { render(); drawSpeed(); } }, 60); }
    stageCanvas.addEventListener('pointerdown', e => {
        if (!STEPS[stepIndex].handles) return;
        const r = stageCanvas.getBoundingClientRect();
        const i = hitHandle(e.clientX - r.left, e.clientY - r.top);
        if (i < 0) return;
        dragging = i; activeHandle = i; selected = -1;
        stageCanvas.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    stageCanvas.addEventListener('pointermove', e => {
        const r = stageCanvas.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        if (dragging < 0) { stageCanvas.style.cursor = STEPS[stepIndex].handles && hitHandle(px, py) >= 0 ? 'grab' : ''; return; }
        policy.p[dragging] = [clamp(WX(px), -2.9, 2.9), clamp(WY(py), -1.95, 1.95)];
        vy = voyage(policy);
        if (!loop.running) render();
        scheduleEval();
    });
    const endDrag = () => { if (dragging >= 0) { dragging = -1; scheduleEval(); toExplore(); } };
    stageCanvas.addEventListener('pointerup', endDrag);
    stageCanvas.addEventListener('pointercancel', endDrag);
    stageCanvas.addEventListener('keydown', e => {
        if (!STEPS[stepIndex].handles) return;
        if (['1', '2', '3'].includes(e.key)) { activeHandle = +e.key - 1; render(); return; }
        const m = { ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[e.key];
        if (!m) return;
        e.preventDefault();
        const p = policy.p[activeHandle];
        policy.p[activeHandle] = [clamp(p[0] + m[0], -2.9, 2.9), clamp(p[1] + m[1], -1.95, 1.95)];
        vy = voyage(policy); scheduleEval(); render();
    });

    let sDrag = -1;
    function speedIndex(px, py) {
        const { w, h } = speedSurf, pad = 14;
        let best = -1, bd = 18;
        policy.v.forEach((v, i) => { const x = pad + i / 4 * (w - 2 * pad), y = h - pad - (v - V_MIN) / (V_MAX - V_MIN) * (h - 2 * pad); const dd = Math.hypot(x - px, y - py); if (dd < bd) { bd = dd; best = i; } });
        return best;
    }
    speedCanvas.addEventListener('pointerdown', e => {
        const r = speedCanvas.getBoundingClientRect();
        const i = speedIndex(e.clientX - r.left, e.clientY - r.top);
        if (i < 0) return;
        sDrag = i; selected = -1; speedCanvas.setPointerCapture(e.pointerId); e.preventDefault();
    });
    speedCanvas.addEventListener('pointermove', e => {
        if (sDrag < 0) return;
        const r = speedCanvas.getBoundingClientRect(), { h } = speedSurf, pad = 14;
        policy.v[sDrag] = clamp(V_MIN + (h - pad - (e.clientY - r.top)) / (h - 2 * pad) * (V_MAX - V_MIN), V_MIN, V_MAX);
        vy = voyage(policy); drawSpeed(); scheduleEval();
    });
    const endS = () => { if (sDrag >= 0) { sDrag = -1; toExplore(); } };
    speedCanvas.addEventListener('pointerup', endS);
    speedCanvas.addEventListener('pointercancel', endS);

    objCanvas.addEventListener('click', e => {
        if (!base || !candidates.length) return;
        const r = objCanvas.getBoundingClientRect(), { w, h } = objSurf, { xr, yr, pad } = objScale;
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const front = pareto(candidates);
        let best = -1, bd = 20;
        for (const i of front) {
            const c = candidates[i];
            const x = pad + clamp((c.J1 / base.J1 - xr[0]) / (xr[1] - xr[0]), 0, 1) * (w - pad - 12), y = h - pad - clamp((c.J2 / base.J2 - yr[0]) / (yr[1] - yr[0]), 0, 1) * (h - pad - 12);
            const dd = Math.hypot(x - px, y - py); if (dd < bd) { bd = dd; best = i; }
        }
        if (best < 0) return;
        selectCandidate(best);
    });
    function selectCandidate(i) {
        selected = i;
        policy = clonePolicy(candidates[i].pol);
        reevaluate(); restartVoyage(); drawSpeed();
        say('선택한 Pareto 해의 경로와 속도 분포를 표시하였다.');
        if (!loop.running) render();
    }

    /* --- steps, controls --- */
    function selectStep(i) {
        stepIndex = i;
        const st = STEPS[i];
        root.dataset.step = st.key;
        stageCanvas.tabIndex = st.handles ? 0 : -1;
        if (ready && i < STEPS.length - 1) {
            policy = baselinePolicy();
            reevaluate(); restartVoyage();
            if (st.search && !candidates.length) { searching = 70; }
            if (st.key === 'pareto') {
                for (let k = 0; k < 40 && searching > 0; k++) searchTick();
            }
        }
        const c = captions[st.key] || { html: '', text: '' };
        captionEl.innerHTML = c.html;
        say(c.text);
        if (ready) { render(); drawSpeed(); drawObjective(); }
    }
    const steps = createSteps(q('.lab-steps'), selectStep);
    const toExplore = () => { if (steps.current !== STEPS.length - 1) steps.select(STEPS.length - 1); };

    qa('input[name="lab-inflow"]').forEach(r => r.addEventListener('change', () => {
        if (!r.checked) return;
        inflow = r.value;
        root.querySelectorAll('[data-inflow-text]').forEach(el => { el.hidden = el.dataset.inflowText !== inflow; });
        rebaseline(); restartVoyage();
        if (STEPS[stepIndex].search) searching = 70;
        if (!loop.running) { render(); drawSpeed(); }
    }));
    searchBtn.addEventListener('click', () => {
        candidates = []; selected = -1; searching = 70;
        if (media.reduced) while (searching > 0) searchTick();
        toExplore(); drawObjective();
    });
    q('[data-act="baseline"]').addEventListener('click', () => {
        policy = baselinePolicy(); selected = -1; reevaluate(); restartVoyage(); drawSpeed(); if (!loop.running) render();
    });
    playBtn.addEventListener('click', () => {
        const playing = loop.toggle();
        playBtn.textContent = playing ? '일시정지' : '재생';
        playBtn.setAttribute('aria-label', playing ? '애니메이션 일시정지' : '애니메이션 재생');
    });
    resetBtn.addEventListener('click', () => { candidates = []; searching = 0; selected = -1; steps.select(0); });
    media.on('dark', () => { readColors(); render(); drawSpeed(); drawObjective(); drawPaper(); });

    readColors();
    rebaseline();
    for (let i = 0; i < 60; i++) advance(0.05);
    playBtn.textContent = media.reduced ? '재생' : '일시정지';
    if (debug && debugEl) debugEl.hidden = false;
    ready = true;
    if (media.reduced) { restartVoyage(); for (let i = 0; i < vy.T * 0.85 / 0.04; i++) stepSim(0.04); }
    const qs = new URLSearchParams(location.search);
    steps.select(qs.has('labstep') ? Math.max(0, Math.min(STEPS.length - 1, (+qs.get('labstep') || 1) - 1)) : 0);
});
