/* ============================================
   Ship-operation concept model (pure, Node-importable)
   Background flow: uniform inflow + a Re = 100-like vortex street (procedural);
   emission ∝ v³ as Gaussian puffs; 4th-order Bézier path (N_cp = 5) and Bézier speed profile.
   ============================================ */
export const DOM = { x0: -3, x1: 3, y0: -2, y1: 2 };
export const START = [-1.9, -1.7], END = [2.7, 0.6];
export const ZONES_P = [[-1.6, 1.35, 1.2, 2.0], [-3.0, -0.2, -2.4, 2.0]];
export const ZONE_X = [-0.2, -1.95, 0.8, -1.15];
export const AUX = 2;                                   /* auxiliary load: economic speed v = (a/2)^(1/3) = 1 */
export const V_MIN = 0.5, V_MAX = 1.6;
export const DIFF = 0.012, EMIT_DT = 0.05, SIG0 = 0.09;

/* Table 2, Ocean Engineering 362 (2026) 126293 */
export const PAPER = {
    south: { base: [0.2653, 0.7526], pts: [[1, 0.1045, 0.8303], [2, 0.0809, 0.8905], [3, 0.1256, 0.7788], [4, 0.1019, 0.8745], [5, 0.1776, 0.7586], [6, 0.2089, 0.7265], [7, 0.0728, 1.0316], [8, 0.0570, 1.0886], [9, 0.0946, 0.8770]] },
    east: { base: [0.4255, 0.7526], pts: [[1, 0.3064, 0.7824], [2, 0.5150, 0.7412], [3, 0.1097, 0.8383], [4, 0.1666, 0.7951], [5, 0.3523, 0.7619], [6, 0.3626, 0.7427]] }
};

export const STEPS = [
    { key: 'problem', sensors: false, handles: false, search: false },
    { key: 'sensing', sensors: true, handles: false, search: false },
    { key: 'design', sensors: false, handles: true, search: false },
    { key: 'pareto', sensors: false, handles: true, search: true },
    { key: 'explore', sensors: false, handles: true, search: true }
];

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function bez4(p, t) {
    const u = 1 - t;
    const w = [u * u * u * u, 4 * u * u * u * t, 6 * u * u * t * t, 4 * u * t * t * t, t * t * t * t];
    if (typeof p[0] === 'number') return w.reduce((s, wi, i) => s + wi * p[i], 0);
    return [w.reduce((s, wi, i) => s + wi * p[i][0], 0), w.reduce((s, wi, i) => s + wi * p[i][1], 0)];
}
export function inRect(x, y, r) { return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; }

export function baselinePolicy() {
    const pts = [0.25, 0.5, 0.75].map(t => [lerp(START[0], END[0], t), lerp(START[1], END[1], t)]);
    return { p: pts, v: [1, 1, 1, 1, 1] };
}
export const clonePolicy = pol => ({ p: pol.p.map(q => [...q]), v: [...pol.v] });

/* --- procedural background flow --- */
export function createFlow(inflow) {
    const dir = inflow === 'south' ? [0, 1] : [-1, 0];
    const nrm = [-dir[1], dir[0]];
    const Uc = 0.85, period = 1 / 0.2, gam = 0.95, rc = 0.26;
    function vortices(t) {
        const out = [];
        const n0 = Math.floor((t * Uc - 4.6) / (Uc * period / 2)) - 1;
        for (let n = n0; n < n0 + 8; n++) {
            const xi = t * Uc - n * Uc * period / 2 - 4.6;
            if (xi < -4.6 || xi > 4.8) continue;
            const s = n % 2 === 0 ? 1 : -1;
            const eta = 0.32 * s + 0.05;
            out.push([dir[0] * xi + nrm[0] * eta + 0.2, dir[1] * xi + nrm[1] * eta - 0.1, -s * gam]);
        }
        return out;
    }
    function velocity(x, y, vs) {
        let u = dir[0], v = dir[1];
        for (const [vx, vy, g] of vs) {
            const dx = x - vx, dy = y - vy, r2 = dx * dx + dy * dy + rc * rc;
            u += -g * dy / (2 * Math.PI * r2) * 2.2;
            v += g * dx / (2 * Math.PI * r2) * 2.2;
        }
        return [u * 0.55, v * 0.55];
    }
    return { dir, vortices, velocity };
}

/* --- voyage kinematics --- */
export function voyage(pol) {
    const pts = [START, ...pol.p, END];
    const N = 120, xs = [], cum = [0];
    for (let i = 0; i <= N; i++) xs.push(bez4(pts, i / N));
    for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(xs[i][0] - xs[i - 1][0], xs[i][1] - xs[i - 1][1]));
    const L = cum[N];
    const speed = tau => clamp(bez4(pol.v, clamp(tau, 0, 1)), V_MIN * 0.9, V_MAX * 1.05);
    /* integrate arc length s with ds/dt = v(τ(s)) */
    const tl = [0], sl = [0];
    let s = 0, t = 0;
    while (s < L && tl.length < 4000) { const v = speed(s / L); s += v * 0.02; t += 0.02; tl.push(t); sl.push(Math.min(s, L)); }
    const T = t;
    function at(time) {
        const k = clamp(Math.floor(time / 0.02), 0, sl.length - 1);
        const sc = sl[k], tau = sc / L;
        let i = 1; while (i < N && cum[i] < sc) i++;
        const f = (sc - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
        return { x: lerp(xs[i - 1][0], xs[i][0], f), y: lerp(xs[i - 1][1], xs[i][1], f), v: speed(tau), tau, hx: xs[i][0] - xs[i - 1][0], hy: xs[i][1] - xs[i - 1][1] };
    }
    let inX = 0;
    for (const q of xs) if (inRect(q[0], q[1], ZONE_X)) inX++;
    return { xs, L, T, at, speed, xFrac: inX / xs.length };
}

const PROBE = [];
for (const r of ZONES_P) for (let i = 0; i < 7; i++) for (let j = 0; j < 4; j++) PROBE.push([lerp(r[0], r[2], (i + 0.5) / 7), lerp(r[1], r[3], (j + 0.5) / 4)]);

/* offline evaluation of a policy: J1 = peak concentration over Ω_P, J2 = ∫(v³ + a) dt */
export function evaluate(pol, flow) {
    const vy = voyage(pol);
    const Ttot = vy.T + 2.5, dt = 0.05;
    const puffs = [];
    let J1 = 0, J2 = 0, emitAcc = 0;
    for (let t = 0, k = 0; t < Ttot; t += dt, k++) {
        const vs = flow.vortices(t);
        if (t < vy.T) {
            const s = vy.at(t);
            J2 += (s.v * s.v * s.v + AUX) * dt;
            emitAcc += dt;
            if (emitAcc >= EMIT_DT * 2) { emitAcc = 0; puffs.push({ x: s.x, y: s.y, m: s.v * s.v * s.v * EMIT_DT * 2, s2: SIG0 * SIG0 }); }
        }
        for (const p of puffs) {
            const [u1, v1] = flow.velocity(p.x, p.y, vs);
            const [u2, v2] = flow.velocity(p.x + u1 * dt, p.y + v1 * dt, vs);
            p.x += 0.5 * (u1 + u2) * dt; p.y += 0.5 * (v1 + v2) * dt; p.s2 += 2 * DIFF * dt;
        }
        if (k % 2 === 0) {
            for (const [px, py] of PROBE) {
                let c = 0;
                for (const p of puffs) {
                    const dx = px - p.x, dy = py - p.y, r2 = dx * dx + dy * dy;
                    if (r2 < 9 * p.s2) c += p.m / (2 * Math.PI * p.s2) * Math.exp(-r2 / (2 * p.s2));
                }
                if (c > J1) J1 = c;
            }
        }
    }
    const penalty = 1 + 8 * vy.xFrac;
    return { J1: J1 * penalty, J2: J2 * penalty, feasible: vy.xFrac === 0 };
}

