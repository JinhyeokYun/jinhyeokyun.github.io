/* ============================================
   P-control explorable — reduced-order model (no DOM)
   Conceptual model only: a Stuart–Landau oscillator for the
   vortex-shedding amplitude with a delayed, averaged, noisy sensor.
   It reproduces trends of Yun & Lee, Phys. Fluids 34, 095133 (2022);
   it is NOT the LES of the paper.
   Time unit: d/u∞.
   ============================================ */

export const REGIMES = {
    turbulent: {
        key: 'turbulent',
        re: 3900,
        st: 0.21,
        sigma: 0.2,
        b: 27,
        sensorNoise: 0.8,
        forcing: 0.045,
        slot: [80, 100],
        alphaMax: 0.03,
        alphaStep: 0.0005,
        psiClip: 0.03,
        psiShow: 0.015,
        paper: { xs: 1.69, ta: 1.44, alpha: 0.01, spanwise: true }
    },
    laminar60: {
        key: 'laminar60',
        re: 60,
        st: 0.136,
        sigma: 0.07,
        b: 0.9,
        sensorNoise: 0,
        forcing: 0.002,
        slot: [80, 100],
        alphaMax: 0.5,
        alphaStep: 0.01,
        psiClip: 0.5,
        psiShow: 0.3,
        paper: { xs: 1.0, ta: 0.12, alpha: 0.2, spanwise: false }
    },
    laminar: {
        key: 'laminar',
        re: 100,
        st: 0.164,
        sigma: 0.12,
        b: 0.25,
        sensorNoise: 0,
        forcing: 0.004,
        slot: [105, 125],
        alphaMax: 0.8,
        alphaStep: 0.01,
        psiClip: 0.6,
        psiShow: 0.5,
        paper: { xs: 1.5, ta: 4.0, alpha: 0.4, spanwise: false }
    }
};

export const DT = 0.02;
export const U_C = 0.8;
export const SPAN_POINTS = 8;
const HISTORY = 40;            /* tu of amplitude history kept for the sensor delay */

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function gaussian(rand) {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/* Sensor coherence grows with distance from the cylinder: the shear layers
   have not rolled up yet right behind the body. */
export function sensorGain(xs) {
    const s = (xs - 0.5) / 0.9;
    return 1 - Math.exp(-s * s);
}

export function omegaOf(regime) {
    return 2 * Math.PI * regime.st;
}

/* Phase lag of the averaged signal: convective delay + half the boxcar. */
export function loopPhase(regime, xs, ta) {
    const w = omegaOf(regime);
    return w * Math.max(0, xs - 0.5) / U_C + w * ta / 2;
}

/* Boxcar attenuation of a sinusoid of frequency ω. */
export function boxcarGain(regime, ta) {
    const x = omegaOf(regime) * ta / 2;
    return x < 1e-6 ? 1 : Math.sin(x) / x;
}

/* Conceptual "phase fit" of a sensor setting relative to the paper optimum,
   including the coherent share of the normalized signal. Range about −1…1. */
export function phaseFit(regime, xs, ta, spanwise) {
    const p = regime.paper;
    const dStar = loopPhase(regime, p.xs, p.ta);
    const d = loopPhase(regime, xs, ta);
    const g = sensorGain(xs) * boxcarGain(regime, ta);
    const nStd = regime.sensorNoise * (spanwise ? noiseSpanFactor() : 1) * noiseTimeFactor(ta);
    const coherent = g / Math.SQRT2;
    const share = coherent / Math.sqrt(coherent * coherent + nStd * nStd + 1e-9);
    return share * Math.cos(d - dStar) * Math.sign(g || 1);
}

function noiseSpanFactor() {
    /* 8 points with weak inter-point correlation ρ = 0.1 */
    const rho = 0.1;
    return Math.sqrt((1 + (SPAN_POINTS - 1) * rho) / SPAN_POINTS);
}

function noiseTimeFactor(ta) {
    /* OU noise (τ = 0.25) averaged over ta */
    const tau = 0.25;
    if (ta <= DT) return 1;
    const r = ta / tau;
    return Math.sqrt((2 / r) * (1 - (1 - Math.exp(-r)) / r));
}

export function createModel(regimeKey = 'turbulent', seed = 7) {
    const regime = REGIMES[regimeKey];
    const w = omegaOf(regime);
    const theta = loopPhase(regime, regime.paper.xs, regime.paper.ta);
    const beta = { re: -regime.b * Math.cos(theta), im: -regime.b * Math.sin(theta) };

    const rand = mulberry32(seed);
    const histLen = Math.round(HISTORY / DT);
    const histRe = new Float32Array(histLen);
    let histHead = 0;

    const noise = new Float32Array(SPAN_POINTS);
    const raw = new Float32Array(SPAN_POINTS);
    let fRe = 0, fIm = 0;                       /* turbulent forcing (complex OU) */

    let boxBuf = new Float32Array(1);
    let boxHead = 0, boxSum = 0, boxN = 1;

    const s = {
        regime,
        t: 0,
        aRe: 0.05, aIm: 0,
        xs: regime.paper.xs,
        ta: regime.paper.ta,
        alpha: regime.paper.alpha,
        spanwise: regime.paper.spanwise,
        control: false,
        tOn: null,
        rms0: 1,
        sensorRaw: 0,
        sensorAvg: 0,
        error: 0,
        psi: 0,
        ramp: 0,
        cl: 0,
        cd: 0,
        rawSpan: raw,
        used: 0,
        predict: null
    };

    function setAveraging(ta) {
        s.ta = ta;
        boxN = Math.max(1, Math.round(ta / DT));
        boxBuf = new Float32Array(boxN);
        boxHead = 0;
        boxSum = 0;
    }
    setAveraging(s.ta);

    function readDelayed(tau) {
        const k = Math.min(histLen - 1, Math.max(0, Math.round(tau / DT)));
        return histRe[(histHead - 1 - k + histLen * 2) % histLen];
    }

    function rhs(aRe, aIm, psi, out) {
        const mag2 = aRe * aRe + aIm * aIm;
        const sig = regime.sigma;
        out[0] = sig * aRe - w * aIm - sig * mag2 * aRe + beta.re * psi + regime.forcing * fRe;
        out[1] = sig * aIm + w * aRe - sig * mag2 * aIm + beta.im * psi + regime.forcing * fIm;
    }

    const k1 = [0, 0], k2 = [0, 0];

    function step() {
        /* turbulent forcing of the amplitude (OU, τ = 1) */
        const dec = Math.exp(-DT / 1.0), amp = Math.sqrt(1 - dec * dec);
        fRe = fRe * dec + amp * gaussian(rand);
        fIm = fIm * dec + amp * gaussian(rand);

        /* sensor: delayed coherent part + spanwise OU noise */
        const g = sensorGain(s.xs);
        const coherent = g * readDelayed(Math.max(0, s.xs - 0.5) / U_C);
        const nDec = Math.exp(-DT / 0.25), nAmp = Math.sqrt(1 - nDec * nDec) * regime.sensorNoise;
        const common = gaussian(rand);
        let sum = 0;
        for (let j = 0; j < SPAN_POINTS; j++) {
            const e = Math.sqrt(0.1) * common + Math.sqrt(0.9) * gaussian(rand);
            noise[j] = noise[j] * nDec + nAmp * e;
            raw[j] = coherent + noise[j];
            sum += raw[j];
        }
        const reading = s.spanwise && regime.sensorNoise > 0 ? sum / SPAN_POINTS : raw[0];
        s.sensorRaw = raw[0];

        boxSum += reading - boxBuf[boxHead];
        boxBuf[boxHead] = reading;
        boxHead = (boxHead + 1) % boxN;
        s.sensorAvg = boxSum / boxN;

        s.used = s.predict ? s.predict(s.sensorAvg, s) : s.sensorAvg;
        s.error = s.used / (s.rms0 || 1);
        if (s.control && s.tOn !== null) {
            s.ramp = 1 / (1 + Math.exp(-(s.t - s.tOn - 10) / 1));
        } else {
            s.ramp = 0;
        }
        const psi = Math.max(-regime.psiClip, Math.min(regime.psiClip, s.alpha * s.ramp * s.error));
        s.psi = psi;

        /* Heun step of the Stuart–Landau oscillator */
        rhs(s.aRe, s.aIm, psi, k1);
        const pRe = s.aRe + DT * k1[0], pIm = s.aIm + DT * k1[1];
        rhs(pRe, pIm, psi, k2);
        s.aRe += 0.5 * DT * (k1[0] + k2[0]);
        s.aIm += 0.5 * DT * (k1[1] + k2[1]);

        histRe[histHead] = s.aRe;
        histHead = (histHead + 1) % histLen;

        s.t += DT;
        s.cl = Math.SQRT2 * s.aRe;
        const mag2 = s.aRe * s.aRe + s.aIm * s.aIm;
        s.cd = 0.87 + 0.13 * mag2 + 0.02 * (s.aRe * s.aRe - s.aIm * s.aIm);
    }

    /* rms of the averaged sensor signal for the uncontrolled flow (normalization e = ṽs/ṽs,rms,0) */
    function calibrate(duration = 200) {
        const saved = { control: s.control, tOn: s.tOn };
        s.control = false;
        s.tOn = null;
        let n = 0, acc = 0;
        const warm = Math.round(60 / DT), steps = Math.round(duration / DT);
        for (let i = 0; i < warm; i++) step();
        for (let i = 0; i < steps; i++) {
            step();
            acc += s.sensorAvg * s.sensorAvg;
            n++;
        }
        s.rms0 = Math.sqrt(acc / Math.max(1, n)) || 1;
        s.control = saved.control;
        s.tOn = saved.tOn;
        return s.rms0;
    }

    function setControl(on) {
        if (on && !s.control) s.tOn = s.t;
        if (!on) s.tOn = null;
        s.control = on;
    }

    function set(params) {
        if ('xs' in params) s.xs = params.xs;
        if ('alpha' in params) s.alpha = params.alpha;
        if ('spanwise' in params) s.spanwise = params.spanwise;
        if ('ta' in params && params.ta !== s.ta) setAveraging(params.ta);
    }

    /* planar-symmetry transformation y → −y of the current flow state */
    function mirror() {
        s.aRe = -s.aRe; s.aIm = -s.aIm;
        for (let i = 0; i < histLen; i++) histRe[i] = -histRe[i];
        for (let i = 0; i < boxBuf.length; i++) boxBuf[i] = -boxBuf[i];
        boxSum = -boxSum;
        for (let j = 0; j < SPAN_POINTS; j++) noise[j] = -noise[j];
        fRe = -fRe; fIm = -fIm;
        s.sensorAvg = -s.sensorAvg;
    }

    return {
        state: s,
        regime,
        omega: w,
        step,
        mirror,
        calibrate,
        setControl,
        set,
        amplitude: () => Math.hypot(s.aRe, s.aIm),
        phase: () => Math.atan2(s.aIm, s.aRe)
    };
}

/* Uncontrolled rms of the averaged sensor for a given setting (normalization). */
export function rmsFor(regimeKey, params, seed = 5) {
    const m = createModel(regimeKey, seed);
    m.set(params);
    return m.calibrate(160);
}

/* Run a scenario without rendering and return rms/mean statistics. */
export function simulate({ regime = 'turbulent', seed = 7, xs, ta, alpha, spanwise, off = 60, on = 140 } = {}) {
    const m = createModel(regime, seed);
    const p = m.regime.paper;
    m.set({ xs: xs ?? p.xs, ta: ta ?? p.ta, alpha: alpha ?? p.alpha, spanwise: spanwise ?? p.spanwise });
    m.calibrate();
    const stats = (n) => {
        let cl2 = 0, cd = 0, psi2 = 0, amp = 0;
        for (let i = 0; i < n; i++) {
            m.step();
            cl2 += m.state.cl * m.state.cl;
            cd += m.state.cd;
            psi2 += m.state.psi * m.state.psi;
            amp += m.amplitude();
        }
        return { clRms: Math.sqrt(cl2 / n), cd: cd / n, psiRms: Math.sqrt(psi2 / n), amp: amp / n };
    };
    const base = stats(Math.round(off / DT));
    m.setControl(true);
    for (let i = 0; i < Math.round(30 / DT); i++) m.step();
    const ctrl = stats(Math.round(on / DT));
    return { base, ctrl, rms0: m.state.rms0 };
}
