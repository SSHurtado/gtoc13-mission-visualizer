/**
 * GTOC13 solution checker.
 *
 * Verifies that a submission file describes ONE continuous trajectory that is
 * feasible in the GTOC13 simplified dynamics (Keplerian conics around Altaira,
 * patched-conic flybys, ideal solar sail), as stated in:
 *   - GTOC13 Problem Statement: Sec. 4 (initial state), Sec. 5 (sail model),
 *     Sec. 7 (constraints and tolerances), Appendix 1 (dynamics, flybys);
 *   - GTOC13 Solution File Format Specification v1.0 (Secs. 2-4).
 *
 * The spacecraft state is never allowed to jump in time, position or velocity
 * between patches (except the velocity change of a planetary flyby), every
 * conic arc must be Keplerian, every sail arc must be consistent with one RK4
 * step of the sail dynamics, and every flyby must happen at the body.
 *
 * All computations use km, km/s and s (seconds past t = 0), with the official
 * constants; nothing here depends on the AU/year units used for rendering.
 */

import { GTOC13_BODIES } from './gtoc13Bodies.js';

// ─── Constants (Problem Statement, Tables 3 and 4) ───────────────────────────
export const MU = 139348062043.343;          // km^3/s^2, Altaira
export const AU = 149597870.691;             // km
export const DAY = 86400;                    // s
export const YEAR = 365.25 * DAY;            // s
const SAIL_ACC_1AU = (2 * 5.4026e-6 * 15000 / 500) / 1000; // 2CA/m in km/s^2 at r0 = 1 AU
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

// ─── Tolerances (Problem Statement, Sec. 7) ──────────────────────────────────
export const TOL = {
  pos: 0.1,        // km    conic position, initial position, flyby position
  vel: 1e-7,       // km/s  conic velocity, initial velocity
  vinf: 1e-7,      // km/s  v-infinity equality
  rk4Rel: 1e-4,    //       one RK4 step per propagated segment
  minStep: 60,     // s     minimum step in propagated arcs (format 3.3.2)
  alt: 0.1,        // km    flyby altitude
  peri: 1.0,       // km    perihelion
};
// "Time, Position & Velocity continuity tolerance: to all reported digits of
// accuracy". Two values that must be equal may differ by half a unit in the
// last digit printed by the less precise of the two, plus double-precision
// rounding noise (relative 1e-13). This is never allowed to exceed the physical
// tolerances above, so a jump of more than 100 m / 0.1 mm/s is always caught.
const FP_REL = 1e-13;
const MAX_MESSAGES_PER_CHECK = 25;

const T_MAX = 200 * YEAR;
const R_LOW = 0.05 * AU;     // all close approaches but one
const R_MIN = 0.01 * AU;     // the single allowed lower passage

export const isPlanet = id => id >= 1 && id <= 10;
export const isSmallBody = id => (id >= 1001 && id <= 1257) || (id >= 2001 && id <= 2042);

// ─── Small vector helpers (arrays of 3) ──────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => Math.sqrt(dot(a, a));
const unit = a => { const n = norm(a); return n > 0 ? scl(a, 1 / n) : [0, 0, 0]; };

const R = row => [row.x_km, row.y_km, row.z_km];
const V = row => [row.vx_kms, row.vy_kms, row.vz_kms];
const C = row => [row.c1, row.c2, row.c3];
const fmtT = t => `t=${t.toFixed(3)} s (${(t / YEAR).toFixed(4)} yr)`;
const where = row => `line ${row.line ?? '?'}`;

// ─── Printed precision ───────────────────────────────────────────────────────
/** Value of one unit in the last printed digit of a numeric token. */
export function printUnit(token) {
  const m = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(token).trim());
  if (!m) return 0;
  const decimals = m[2] ? m[2].length : 0;
  const exp = m[3] ? parseInt(m[3], 10) : 0;
  return Math.pow(10, exp - decimals);
}
const unitsOf = (row, k0) => row.units ? [row.units[k0], row.units[k0 + 1], row.units[k0 + 2]] : [0, 0, 0];

/** Tolerance for "a and b are the same vector to all reported digits". */
function vecTol(rowA, rowB, a, b, k0, cap) {
  const ua = unitsOf(rowA, k0), ub = unitsOf(rowB, k0);
  let d2 = 0;
  for (let j = 0; j < 3; j++) { const u = 0.5 * Math.max(ua[j], ub[j]); d2 += u * u; }
  return Math.min(cap, Math.max(Math.sqrt(d2), FP_REL * Math.max(norm(a), norm(b))));
}
/** Tolerance for "two epochs are the same", capped at the time equivalent of 100 m. */
function timeTol(rowA, rowB) {
  const ua = rowA.units ? rowA.units[2] : 0, ub = rowB.units ? rowB.units[2] : 0;
  const speed = Math.max(norm(V(rowA)), norm(V(rowB)), 1e-3);
  const t = Math.max(Math.abs(rowA.epoch_s), Math.abs(rowB.epoch_s));
  return Math.min(TOL.pos / speed, Math.max(0.5 * Math.max(ua, ub), FP_REL * t));
}

// ─── Body ephemeris (Appendix 1) ─────────────────────────────────────────────
function solveKeplerEllipse(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 100; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-15) break;
  }
  return E;
}

/** Heliocentric state {r, v} (km, km/s) of a GTOC13 body at t seconds past t = 0. */
export function bodyState(id, t) {
  const b = GTOC13_BODIES[id];
  if (!b) return null;
  const { a, e } = b;
  const n = Math.sqrt(MU / (a * a * a));
  let M = (b.M0 * DEG + n * t) % TWO_PI;
  if (M < 0) M += TWO_PI;
  const E = solveKeplerEllipse(M, e);
  const cE = Math.cos(E), sE = Math.sin(E);
  const rn = a * (1 - e * cE);
  const sq = Math.sqrt(1 - e * e);
  const xp = a * (cE - e), yp = a * sq * sE;
  const k = Math.sqrt(MU * a) / rn;
  const vxp = -k * sE, vyp = k * sq * cE;
  const cO = Math.cos(b.raan * DEG), sO = Math.sin(b.raan * DEG);
  const cw = Math.cos(b.argp * DEG), sw = Math.sin(b.argp * DEG);
  const ci = Math.cos(b.i * DEG), si = Math.sin(b.i * DEG);
  const P = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  return {
    r: [xp * P[0] + yp * Q[0], xp * P[1] + yp * Q[1], xp * P[2] + yp * Q[2]],
    v: [vxp * P[0] + vyp * Q[0], vxp * P[1] + vyp * Q[1], vxp * P[2] + vyp * Q[2]],
  };
}

export function bodyPeriod(id) {
  const b = GTOC13_BODIES[id];
  return b ? TWO_PI * Math.sqrt(b.a ** 3 / MU) : undefined;
}

// ─── Spacecraft Keplerian propagation (universal variables) ──────────────────
function stumpffC(z) {
  if (z > 1) { const s = Math.sqrt(z); const h = Math.sin(s / 2); return 2 * h * h / z; }
  if (z < -1) { const s = Math.sqrt(-z); const h = Math.sinh(s / 2); return 2 * h * h / (-z); }
  let term = 0.5, sum = 0.5;                        // sum_k (-z)^k / (2k+2)!
  for (let k = 1; k < 20; k++) { term *= -z / ((2 * k + 1) * (2 * k + 2)); sum += term; }
  return sum;
}
function stumpffS(z) {
  if (z > 1) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * z); }
  if (z < -1) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * -z); }
  let term = 1 / 6, sum = 1 / 6;                    // sum_k (-z)^k / (2k+3)!
  for (let k = 1; k < 20; k++) { term *= -z / ((2 * k + 2) * (2 * k + 3)); sum += term; }
  return sum;
}

/** Two-body propagation of (r0, v0) by dt >= 0 seconds around Altaira. */
export function keplerPropagate(r0, v0, dt) {
  const sqmu = Math.sqrt(MU);
  const r0n = norm(r0);
  const alpha = 2 / r0n - dot(v0, v0) / MU;          // 1/a
  if (alpha > 0) {                                   // ellipse: remove whole revolutions
    const T = TWO_PI / Math.sqrt(MU * alpha * alpha * alpha);
    dt -= T * Math.floor(dt / T);
  }
  const rv = dot(r0, v0) / sqmu;
  const F = x => {
    const z = alpha * x * x, c = stumpffC(z), s = stumpffS(z);
    return {
      F: rv * x * x * c + (1 - alpha * r0n) * x * x * x * s + r0n * x - sqmu * dt,
      dF: rv * x * (1 - z * s) + (1 - alpha * r0n) * x * x * c + r0n,
    };
  };
  // F is increasing in x (dF = r > 0): bracket the root, then safeguarded Newton.
  let lo = 0, hi;
  if (alpha > 0) hi = TWO_PI / Math.sqrt(alpha);
  else { hi = Math.max(sqmu * dt / r0n, 1); while (F(hi).F < 0) hi *= 2; }
  let x = Math.min(Math.max(alpha > 0 ? sqmu * dt * alpha : sqmu * dt / r0n, lo), hi);
  for (let k = 0; k < 200; k++) {
    const { F: f, dF } = F(x);
    if (f < 0) lo = x; else hi = x;
    let xn = x - f / dF;
    if (!(xn > lo && xn < hi)) xn = 0.5 * (lo + hi);
    const done = Math.abs(xn - x) <= 1e-15 * Math.max(1, Math.abs(xn));
    x = xn;
    if (done || hi - lo <= 1e-15 * Math.max(1, Math.abs(x))) break;
  }
  const z = alpha * x * x, c = stumpffC(z), s = stumpffS(z);
  const f = 1 - x * x * c / r0n;
  const g = dt - x * x * x * s / sqmu;
  const r = add(scl(r0, f), scl(v0, g));
  const rn = norm(r);
  const fd = sqmu / (rn * r0n) * x * (z * s - 1);
  const gd = 1 - x * x * c / rn;
  return { r, v: add(scl(r0, fd), scl(v0, gd)) };
}

// ─── Sail dynamics (Sec. 5) and the RK4 check (Sec. 7) ───────────────────────
function deriv(r, v, u) {
  const rn = norm(r);
  const g = -MU / (rn * rn * rn);
  const ur = scl(r, -1 / rn);                        // spacecraft -> Altaira
  const cosA = dot(u, ur);
  const k = -SAIL_ACC_1AU * (AU / rn) * (AU / rn) * cosA * cosA;
  return [v, [g * r[0] + k * u[0], g * r[1] + k * u[1], g * r[2] + k * u[2]]];
}
function rk4(r0, v0, h, u0, um, u1) {
  const [a1, b1] = deriv(r0, v0, u0);
  const [a2, b2] = deriv(add(r0, scl(a1, h / 2)), add(v0, scl(b1, h / 2)), um);
  const [a3, b3] = deriv(add(r0, scl(a2, h / 2)), add(v0, scl(b2, h / 2)), um);
  const [a4, b4] = deriv(add(r0, scl(a3, h)), add(v0, scl(b3, h)), u1);
  const comb = (p, q, s, w) => [0, 1, 2].map(j => (p[j] + 2 * q[j] + 2 * s[j] + w[j]) * h / 6);
  return { r: add(r0, comb(a1, a2, a3, a4)), v: add(v0, comb(b1, b2, b3, b4)) };
}
/**
 * Relative RK4 error of one propagated segment. The organisers use the file's
 * controls at both ends and choose the interior control themselves (minimising
 * the integration error); RK4 only samples the interior at the midpoint, so we
 * search the midpoint sail direction too.
 */
function rk4SegmentError(rowA, rowB) {
  const r0 = R(rowA), v0 = V(rowA), r1 = R(rowB), v1 = V(rowB);
  const h = rowB.epoch_s - rowA.epoch_s;
  const u0 = unit(C(rowA)), u1 = unit(C(rowB));
  const dr = norm(sub(r1, r0)), dv = norm(sub(v1, v0));
  const err = um => {
    const x = rk4(r0, v0, h, u0, um, u1);
    return Math.max(norm(sub(x.r, r1)) / dr, norm(sub(x.v, v1)) / dv);
  };
  const mid = norm(add(u0, u1)) > 1e-9 ? unit(add(u0, u1)) : u0;
  let best = mid, bestErr = err(mid);
  for (const u of [u0, u1]) { const e = err(u); if (e < bestErr) { best = u; bestErr = e; } }
  if (bestErr < TOL.rk4Rel) return bestErr;
  // Pattern search over the midpoint direction (two angles around the best guess).
  const basis = () => {
    const a = Math.abs(best[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = unit(sub(a, scl(best, dot(a, best))));
    const e2 = [best[1] * e1[2] - best[2] * e1[1], best[2] * e1[0] - best[0] * e1[2], best[0] * e1[1] - best[1] * e1[0]];
    return [e1, e2];
  };
  for (let step = 0.5; step > 1e-6 && bestErr >= TOL.rk4Rel; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      const [e1, e2] = basis();
      for (const d of [e1, e2, scl(e1, -1), scl(e2, -1)]) {
        const u = unit(add(best, scl(d, step)));
        const e = err(u);
        if (e < bestErr) { best = u; bestErr = e; improved = true; break; }
      }
    }
  }
  return bestErr;
}

/** Minimum of |r| over one propagated segment whose radial velocity changes sign. */
function sailSegmentMinimum(rowA, rowB) {
  const N = 64;
  const h = (rowB.epoch_s - rowA.epoch_s) / N;
  const u0 = unit(C(rowA)), u1 = unit(C(rowB));
  const ctrl = s => { const u = add(scl(u0, 1 - s), scl(u1, s)); return norm(u) > 1e-9 ? unit(u) : u0; };
  let r = R(rowA), v = V(rowA);
  let best = { t: rowA.epoch_s, r: norm(r) };
  for (let k = 0; k < N; k++) {
    const x = rk4(r, v, h, ctrl(k / N), ctrl((k + 0.5) / N), ctrl((k + 1) / N));
    r = x.r; v = x.v;
    const rn = norm(r);
    if (rn < best.r) best = { t: rowA.epoch_s + (k + 1) * h, r: rn };
  }
  return best;
}

// ─── Sail "truth" stage (Sec. 7: higher-order check after RK4) ───────────────
// The organisers re-check every propagated step that passed the RK4 test
// against an accurate ("truth") solution of the same step, keeping the file's
// sail directions at both ends and choosing the interior sail direction
// themselves to minimise the error. Their collocation scheme is not published,
// so this proxy integrates the step accurately (RK4 sub-steps refined until
// the integration itself is good to 1e-7) under a continuous sail profile
//   u(s) = normalise( lerp(u0, u1, s) + sin(pi s) w1 + sin(2 pi s) w2 ),
// which equals the file's directions at s = 0 and s = 1, and searches w1, w2
// for the smallest end-state error. Same tolerance as the RK4 stage (1e-4).
function derivPhysical(r, v, u) {
  const rn = norm(r);
  const g = -MU / (rn * rn * rn);
  const cosA = Math.max(0, -dot(u, r) / rn);         // no thrust beyond 90 deg
  const k = -SAIL_ACC_1AU * (AU / rn) * (AU / rn) * cosA * cosA;
  return [v, [g * r[0] + k * u[0], g * r[1] + k * u[1], g * r[2] + k * u[2]]];
}
function sailProfile(u0, u1, w, s) {
  const b1 = Math.sin(Math.PI * s), b2 = Math.sin(2 * Math.PI * s);
  const u = [0, 1, 2].map(j => u0[j] * (1 - s) + u1[j] * s + b1 * w[j] + b2 * w[j + 3]);
  const n = norm(u);
  return n > 1e-9 ? scl(u, 1 / n) : u0;
}
function propagateSailProfile(r0, v0, h, u0, u1, w, N) {
  let r = r0, v = v0;
  const dt = h / N;
  for (let k = 0; k < N; k++) {
    const ua = sailProfile(u0, u1, w, k / N), um = sailProfile(u0, u1, w, (k + 0.5) / N), ub = sailProfile(u0, u1, w, (k + 1) / N);
    const [a1, b1] = derivPhysical(r, v, ua);
    const [a2, b2] = derivPhysical(add(r, scl(a1, dt / 2)), add(v, scl(b1, dt / 2)), um);
    const [a3, b3] = derivPhysical(add(r, scl(a2, dt / 2)), add(v, scl(b2, dt / 2)), um);
    const [a4, b4] = derivPhysical(add(r, scl(a3, dt)), add(v, scl(b3, dt)), ub);
    r = [0, 1, 2].map(j => r[j] + (a1[j] + 2 * a2[j] + 2 * a3[j] + a4[j]) * dt / 6);
    v = [0, 1, 2].map(j => v[j] + (b1[j] + 2 * b2[j] + 2 * b3[j] + b4[j]) * dt / 6);
  }
  return { r, v };
}
const TRUTH_MAX_EVALS = 600;
/** Smallest relative end-state error over the sail profiles above; shaped = needed w != 0. */
function truthSegmentError(rowA, rowB) {
  const r0 = R(rowA), v0 = V(rowA), r1 = R(rowB), v1 = V(rowB);
  const h = rowB.epoch_s - rowA.epoch_s;
  const u0 = unit(C(rowA)), u1 = unit(C(rowB));
  const dr = norm(sub(r1, r0)), dv = norm(sub(v1, v0));
  const rel = x => Math.max(norm(sub(x.r, r1)) / dr, norm(sub(x.v, v1)) / dv);
  const zero = [0, 0, 0, 0, 0, 0];
  let N = 8, x = propagateSailProfile(r0, v0, h, u0, u1, zero, N);
  for (;;) {                                         // refine until integration error < 1e-7
    const x2 = propagateSailProfile(r0, v0, h, u0, u1, zero, 2 * N);
    const diff = Math.max(norm(sub(x.r, x2.r)) / dr, norm(sub(x.v, x2.v)) / dv);
    N *= 2; x = x2;
    if (diff < 1e-7 || N >= 4096) break;
  }
  let best = rel(x), w = zero;
  if (best < TOL.rk4Rel) return { err: best, shaped: false };
  let evals = 0;                                     // pattern search on w1, w2
  for (let step = 0.5; step > 1e-5 && best >= TOL.rk4Rel && evals < TRUTH_MAX_EVALS; step /= 2) {
    let improved = true;
    while (improved && best >= TOL.rk4Rel && evals < TRUTH_MAX_EVALS) {
      improved = false;
      for (let k = 0; k < 6 && !improved; k++) {
        for (const sg of [1, -1]) {
          const w2 = [...w]; w2[k] += sg * step; evals++;
          const e = rel(propagateSailProfile(r0, v0, h, u0, u1, w2, N));
          if (e < best) { best = e; w = w2; improved = true; break; }
        }
      }
    }
  }
  return { err: best, shaped: true };
}

/**
 * Runs the truth stage on sail steps [[rowIndexA, rowIndexB], ...] that passed
 * the RK4 stage. Pure function: also used from the Web Worker.
 */
export function checkSailTruth(rows, segments, onProgress) {
  const messages = [];
  let count = 0, shaped = 0;
  segments.forEach(([i, j], k) => {
    const p = rows[i], q = rows[j];
    const { err, shaped: s } = truthSegmentError(p, q);
    if (s) shaped++;
    if (!(err < TOL.rk4Rel)) {
      count++;
      if (messages.length < MAX_MESSAGES_PER_CHECK) {
        messages.push(`line ${p.line}-${q.line}: no continuous sail profile between the two rows reproduces the second row (best relative error ${err.toExponential(2)} > 1e-4).`);
      }
    }
    if (onProgress && k % 200 === 0) onProgress(k, segments.length);
  });
  if (count > MAX_MESSAGES_PER_CHECK) messages.push(`... and ${count - MAX_MESSAGES_PER_CHECK} more.`);
  return {
    status: count ? 'fail' : 'pass',
    messages,
    summary: `${count ? `${count} of ${segments.length} sail steps fail` : `${segments.length} sail steps OK`} · ${shaped} needed a shaped sail profile`,
  };
}

/** Writes a checkSailTruth() result into a checks/errors pair (validation or mission object). */
export function mergeSailTruth(checks, errors, result) {
  const c = checks.find(x => x.id === 'sailTruth');
  if (!c) return;
  c.status = result.status;
  c.summary = result.summary;
  c.messages = result.messages;
  for (const m of result.messages) errors.push(`[${c.name}] ${m}`);
}

// ─── Close approaches to Altaira ─────────────────────────────────────────────
/** Periapsis passages of the conic (r0, v0) strictly after t0 and up to t1. */
function conicPeriapses(r0, v0, t0, t1) {
  const r0n = norm(r0);
  const alpha = 2 / r0n - dot(v0, v0) / MU;
  const rv = dot(r0, v0);
  const eVec = sub(scl(r0, dot(v0, v0) / MU - 1 / r0n), scl(v0, rv / MU));
  const e = norm(eVec);
  const out = [];
  if (alpha > 0) {
    if (e < 1e-12) return out;                       // circular: no periapsis
    const a = 1 / alpha;
    const n = Math.sqrt(MU * alpha * alpha * alpha);
    const E = Math.atan2(rv / Math.sqrt(MU * a), 1 - r0n / a);
    let M = E - e * Math.sin(E);
    if (M < 0) M += TWO_PI;
    const T = TWO_PI / n;
    let tp = t0 + (M > 0 ? (TWO_PI - M) / n : T);
    for (; tp <= t1; tp += T) out.push({ t: tp, r: a * (1 - e) });
  } else if (rv < 0 && e > 1) {
    const a = -1 / alpha;                           // |a|
    const n = Math.sqrt(MU / (a * a * a));
    const H = Math.asinh(rv / (e * Math.sqrt(MU * a)));
    const M = e * Math.sinh(H) - H;                  // < 0 before periapsis
    const tp = t0 - M / n;
    if (tp <= t1) out.push({ t: tp, r: a * (e - 1) });
  }
  return out;
}

// ─── Arc structure ───────────────────────────────────────────────────────────
function splitArcs(rows) {
  const arcs = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.bodyId > 0) {
      const two = i + 1 < rows.length && rows[i + 1].bodyId === r.bodyId;
      arcs.push({ type: 'flyby', idx: two ? [i, i + 1] : [i] });
      i += two ? 2 : 1;
    } else if (r.flag === 0) {
      const two = i + 1 < rows.length && rows[i + 1].bodyId === 0 && rows[i + 1].flag === 0;
      arcs.push({ type: 'conic', idx: two ? [i, i + 1] : [i] });
      i += two ? 2 : 1;
    } else {
      const idx = [];
      while (i < rows.length && rows[i].bodyId === 0 && rows[i].flag === r.flag) idx.push(i++);
      arcs.push({ type: 'propagated', idx });
    }
  }
  return arcs;
}

// ─── Main entry point ────────────────────────────────────────────────────────
/**
 * @param rows      parsed rows (see missionData.parseMission): bodyId, flag,
 *                  epoch_s, x_km.., vx_kms.., c1..c3, plus `line` (file line)
 *                  and `units` (printed precision of the 12 fields)
 * @param badLines  [{line, reason}] lines rejected by the parser
 * @param options   { sailTruth: 'sync' (default) | 'defer' }. With 'defer' the
 *                  truth stage is not run here: its check is left 'running' and
 *                  `sailTruthJob.segments` is returned for checkSailTruth().
 * @returns {checks, errors, firstPerihelion_s, closeApproaches, sailTruthJob}
 */
export function validateMission(rows, badLines = [], options = {}) {
  const checks = [
    { id: 'format', name: 'File Structure', desc: 'Rows have 12 numeric fields; arcs follow the solution-file structure (2-row flybys and conics, >=2-row propagated arcs, heliocentric start, flybys between heliocentric arcs).' },
    { id: 'launch', name: 'Initial State', desc: 'First row at x = -200 AU with Vy = Vz = 0 (100 m, 0.1 mm/s), 0 <= t0 <= 200 yr.' },
    { id: 'time', name: 'Time & Duration', desc: 'Epochs non-decreasing inside [0, 200 yr]; heliocentric arcs advance in time; propagated steps >= 60 s.' },
    { id: 'continuity', name: 'Patch Continuity', desc: 'No jump in time, position or velocity where arcs meet, inside flybys (position) or at control switches (to all reported digits, never above 100 m / 0.1 mm/s).' },
    { id: 'conic', name: 'Conic Arcs', desc: 'Each conic arc end state equals the Keplerian propagation of its start state (100 m, 0.1 mm/s).' },
    { id: 'sail', name: 'Solar Sail Arcs', desc: 'Sail normal is a unit vector pointing towards Altaira (cone angle 0-90 deg) and each step matches one RK4 step of the sail dynamics (relative 1e-4).' },
    { id: 'sailTruth', name: 'Sail Arcs · Truth', desc: 'Second stage of the sail check (Sec. 7): each step that passed RK4 must also match an accurate propagation of the sail dynamics to 1e-4, with the file\'s sail directions at both ends and a continuous sail profile in between.' },
    { id: 'flyby', name: 'Flyby Parameters', desc: 'Spacecraft is at the body (100 m); planets: |v_inf| conserved (0.1 mm/s) and altitude in [0.1, 100] radii; massless bodies: velocity continuous; reported v_inf = v - v_body.' },
    { id: 'spacing', name: 'Flyby Spacing', desc: 'Two successive flybys of the same body are at least 1/3 of its orbital period apart.' },
    { id: 'perihelion', name: 'Heliocentric Perihelion', desc: 'Every close approach to Altaira is >= 0.05 AU except at most one, which is >= 0.01 AU (1 km tolerance).' },
    { id: 'science', name: 'First Perihelion Science', desc: 'Asteroid/comet flybys before the first perihelion do not score (scoring rule, not a validity constraint).' },
  ].map(c => ({ ...c, status: 'pass', count: 0, messages: [], summary: '' }));
  const errors = [];

  const report = (id, status, msg) => {
    const c = checks.find(x => x.id === id);
    if (!c) return;
    if (status === 'fail') c.status = 'fail';
    else if (status === 'warning' && c.status !== 'fail') c.status = 'warning';
    c.count++;
    if (c.count <= MAX_MESSAGES_PER_CHECK) { errors.push(`[${c.name}] ${msg}`); c.messages.push(msg); }
  };
  const finish = (extra = {}) => {
    for (const c of checks) {
      if (c.count > MAX_MESSAGES_PER_CHECK) {
        errors.push(`[${c.name}] ... and ${c.count - MAX_MESSAGES_PER_CHECK} more.`);
        c.messages.push(`... and ${c.count - MAX_MESSAGES_PER_CHECK} more.`);
      }
    }
    return { checks, errors, sailTruthJob: null, ...extra };
  };

  // ── 0. Parsing / identifiers ──
  for (const b of badLines) report('format', 'fail', `line ${b.line}: ${b.reason}`);
  if (rows.length === 0) { report('format', 'fail', 'No data rows.'); return finish(); }
  for (const row of rows) {
    if (row.bodyId < 0 || (row.bodyId > 0 && !GTOC13_BODIES[row.bodyId])) {
      report('format', 'fail', `${where(row)}: unknown body_id ${row.bodyId}.`);
    }
    if (row.flag !== 0 && row.flag !== 1) report('format', 'fail', `${where(row)}: flag must be 0 or 1 (got ${row.flag}).`);
  }

  // ── 1. Arc structure (format Sec. 3 and 4.1) ──
  const arcs = splitArcs(rows);
  if (arcs[0].type === 'flyby') report('format', 'fail', `${where(rows[0])}: the first arc must be heliocentric (body_id = 0).`);
  arcs.forEach((arc, k) => {
    const first = rows[arc.idx[0]];
    const last = k === arcs.length - 1;
    if (arc.type === 'flyby') {
      if (arc.idx.length === 1 && !last) report('format', 'fail', `${where(first)}: flyby of body ${first.bodyId} has only one row (allowed only as the final row).`);
      if (arc.idx.length === 2 && rows[arc.idx[1]].flag !== first.flag) report('format', 'fail', `${where(first)}: the two rows of a flyby must have the same flag.`);
      if (k > 0 && arcs[k - 1].type === 'flyby') report('format', 'fail', `${where(first)}: flyby of body ${first.bodyId} is not preceded by a heliocentric arc.`);
      if (!last && arcs[k + 1].type === 'flyby') report('format', 'fail', `${where(first)}: flyby of body ${first.bodyId} is not followed by a heliocentric arc.`);
    } else if (arc.type === 'conic') {
      if (arc.idx.length !== 2) report('format', 'fail', `${where(first)}: conic arc must have exactly 2 rows.`);
      for (const i of arc.idx) {
        if (norm(C(rows[i])) > 1e-12) report('format', 'fail', `${where(rows[i])}: conic arc control must be [0, 0, 0].`);
      }
    } else if (arc.idx.length < 2) {
      report('format', 'fail', `${where(first)}: propagated arc must have at least 2 rows.`);
    }
  });

  // ── 2. Initial state (Sec. 4, Table 2; Sec. 7) ──
  const r0 = rows[0];
  if (r0.epoch_s < 0 || r0.epoch_s > T_MAX) report('launch', 'fail', `t0 = ${fmtT(r0.epoch_s)} is outside [0, 200 yr].`);
  const dx0 = Math.abs(r0.x_km + 200 * AU);
  if (dx0 > TOL.pos) report('launch', 'fail', `x0 = ${r0.x_km.toFixed(4)} km is ${(dx0 * 1000).toFixed(1)} m from -200 AU (tolerance 100 m).`);
  const vyz = Math.hypot(r0.vy_kms, r0.vz_kms);
  if (vyz > TOL.vel) report('launch', 'fail', `(Vy, Vz) = (${r0.vy_kms.toExponential(3)}, ${r0.vz_kms.toExponential(3)}) km/s must be 0 (tolerance 0.1 mm/s).`);
  if (!(r0.vx_kms > 0)) report('launch', 'warning', `Vx = ${r0.vx_kms} km/s; a positive Vx is recommended (not mandatory).`);

  // ── 3. Time (Sec. 7 rule 1; format 3.2.2, 3.3.2, 4.1) ──
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].epoch_s;
    const tol = rows[i].units ? 0.5 * rows[i].units[2] + FP_REL * Math.abs(t) : 0;
    if (t < -tol || t > T_MAX + tol) report('time', 'fail', `${where(rows[i])}: epoch ${fmtT(t)} is outside the 200-year window.`);
    if (i > 0 && t < rows[i - 1].epoch_s - timeTol(rows[i - 1], rows[i])) {
      report('time', 'fail', `${where(rows[i])}: time goes backwards (${fmtT(rows[i - 1].epoch_s)} -> ${fmtT(t)}).`);
    }
  }
  for (const arc of arcs) {
    if (arc.type === 'flyby' || arc.idx.length < 2) continue;
    const a = rows[arc.idx[0]], b = rows[arc.idx[arc.idx.length - 1]];
    if (b.epoch_s - a.epoch_s <= timeTol(a, b)) report('time', 'fail', `${where(a)}: ${arc.type} arc has zero duration.`);
    if (arc.type === 'propagated') {
      for (let j = 1; j < arc.idx.length; j++) {
        const p = rows[arc.idx[j - 1]], q = rows[arc.idx[j]];
        const dt = q.epoch_s - p.epoch_s;
        if (Math.abs(dt) <= timeTol(p, q)) continue;     // control discontinuity (same epoch)
        if (dt < TOL.minStep - 1e-6) report('time', 'fail', `${where(q)}: propagated step of ${dt.toFixed(3)} s is below 60 s.`);
      }
    }
  }

  // ── 4. Continuity between patches (format 3.1.2, 3.3.3, 4.1) ──
  const sameState = (p, q, what, checkVel) => {
    const dt = Math.abs(q.epoch_s - p.epoch_s), tt = timeTol(p, q);
    if (dt > tt) report('continuity', 'fail', `${where(q)}: ${what}: time jump of ${dt.toExponential(3)} s (tolerance ${tt.toExponential(1)} s).`);
    const dr = norm(sub(R(q), R(p))), tr = vecTol(p, q, R(p), R(q), 3, TOL.pos);
    if (dr > tr) report('continuity', 'fail', `${where(q)}: ${what}: position jump of ${dr.toExponential(3)} km (tolerance ${tr.toExponential(1)} km).`);
    if (checkVel) {
      const dv = norm(sub(V(q), V(p))), tv = vecTol(p, q, V(p), V(q), 6, TOL.vel);
      if (dv > tv) report('continuity', 'fail', `${where(q)}: ${what}: velocity jump of ${dv.toExponential(3)} km/s (tolerance ${tv.toExponential(1)} km/s).`);
    }
  };
  for (let k = 1; k < arcs.length; k++) {
    const p = rows[arcs[k - 1].idx[arcs[k - 1].idx.length - 1]];
    const q = rows[arcs[k].idx[0]];
    sameState(p, q, `transition ${arcs[k - 1].type} -> ${arcs[k].type}`, true);
  }
  for (const arc of arcs) {
    if (arc.type === 'flyby' && arc.idx.length === 2) {
      sameState(rows[arc.idx[0]], rows[arc.idx[1]], `flyby of body ${rows[arc.idx[0]].bodyId} (incoming/outgoing rows)`, false);
    } else if (arc.type === 'propagated') {
      for (let j = 1; j < arc.idx.length; j++) {
        const p = rows[arc.idx[j - 1]], q = rows[arc.idx[j]];
        if (Math.abs(q.epoch_s - p.epoch_s) <= timeTol(p, q)) sameState(p, q, 'control discontinuity', true);
      }
    }
  }

  // ── 5. Conic arcs are Keplerian (Appendix 1; Sec. 7 conic tolerance) ──
  for (const arc of arcs) {
    if (arc.type !== 'conic' || arc.idx.length !== 2) continue;
    const a = rows[arc.idx[0]], b = rows[arc.idx[1]];
    const dt = b.epoch_s - a.epoch_s;
    if (!(dt > 0)) continue;
    const x = keplerPropagate(R(a), V(a), dt);
    const er = norm(sub(x.r, R(b))), ev = norm(sub(x.v, V(b)));
    if (er > TOL.pos || ev > TOL.vel) {
      report('conic', 'fail', `${where(a)}-${b.line}: conic end state differs from Keplerian propagation by ${er.toExponential(3)} km / ${ev.toExponential(3)} km/s (tolerance 0.1 km / 1e-7 km/s).`);
    }
  }

  // ── 6. Sail arcs (Sec. 5, Sec. 7 rule 8 and RK4 tolerance) ──
  let sailSteps = 0;
  const truthSegments = [];
  for (const arc of arcs) {
    if (arc.type !== 'propagated') continue;
    for (const i of arc.idx) {
      const row = rows[i];
      const u = C(row);
      const uu = row.units ? Math.max(row.units[9], row.units[10], row.units[11]) : 0;
      const un = norm(u);
      if (Math.abs(un - 1) > Math.max(1e-6, 2 * uu)) report('sail', 'fail', `${where(row)}: sail normal has |u| = ${un.toFixed(9)} (must be a unit vector).`);
      const cosA = un > 0 ? -dot(u, R(row)) / (un * norm(R(row))) : 0;
      if (cosA < -Math.max(1e-9, 2 * uu)) report('sail', 'fail', `${where(row)}: cone angle ${(Math.acos(Math.max(-1, Math.min(1, cosA))) / DEG).toFixed(4)} deg > 90 deg (sail normal must point towards Altaira).`);
    }
    for (let j = 1; j < arc.idx.length; j++) {
      const p = rows[arc.idx[j - 1]], q = rows[arc.idx[j]];
      if (q.epoch_s - p.epoch_s < TOL.minStep - 1e-6) continue;   // discontinuity or already reported
      sailSteps++;
      const e = rk4SegmentError(p, q);
      if (!(e < TOL.rk4Rel)) report('sail', 'fail', `${where(p)}-${q.line}: segment does not match one RK4 step of the sail dynamics (relative error ${e.toExponential(2)} > 1e-4).`);
      else truthSegments.push([arc.idx[j - 1], arc.idx[j]]);     // goes on to the truth stage
    }
  }

  // ── 7. Flybys (Sec. 7 rules 4-6, Appendix 1) ──
  const flybyArcs = arcs.filter(a => a.type === 'flyby');
  for (const arc of flybyArcs) {
    const inc = rows[arc.idx[0]], out = arc.idx.length === 2 ? rows[arc.idx[1]] : null;
    const id = inc.bodyId;
    const body = GTOC13_BODIES[id];
    if (!body) continue;
    const bs = bodyState(id, inc.epoch_s);
    const label = `${where(inc)}: flyby of ${body.name} (${id}) at ${fmtT(inc.epoch_s)}`;
    for (const row of out ? [inc, out] : [inc]) {
      const d = norm(sub(R(row), bs.r));
      if (d > TOL.pos) { report('flyby', 'fail', `${label}: spacecraft is ${d.toExponential(3)} km from the body (tolerance 0.1 km).`); break; }
    }
    // Reported v_inf columns must be v - v_body (format Sec. 2.3, 3.1).
    for (const row of out ? [inc, out] : [inc]) {
      const d = norm(sub(C(row), sub(V(row), bs.v)));
      if (d > TOL.vinf) { report('flyby', 'fail', `${label}: reported v_inf differs from v - v_body by ${d.toExponential(3)} km/s.`); break; }
    }
    if (!out) continue;
    const vinIn = sub(V(inc), bs.v), vinOut = sub(V(out), bs.v);
    const nIn = norm(vinIn), nOut = norm(vinOut);
    if (isPlanet(id)) {
      if (Math.abs(nOut - nIn) > TOL.vinf) {
        report('flyby', 'fail', `${label}: |v_inf| not conserved (${nIn.toFixed(9)} -> ${nOut.toFixed(9)} km/s, tolerance 1e-7).`);
      }
      const vinf = 0.5 * (nIn + nOut);
      const cosD = Math.max(-1, Math.min(1, dot(vinIn, vinOut) / (nIn * nOut)));
      const s = Math.sqrt(Math.max(0, (1 - cosD) / 2));            // sin(turn/2)
      const h = s > 0 ? body.gm / (vinf * vinf) * (1 / s - 1) - body.radius : Infinity;
      if (h < 0.1 * body.radius - TOL.alt || h > 100 * body.radius + TOL.alt) {
        report('flyby', 'fail', `${label}: flyby altitude ${Number.isFinite(h) ? h.toFixed(3) + ' km' : 'infinite (no turn)'} outside [${(0.1 * body.radius).toFixed(1)}, ${(100 * body.radius).toFixed(1)}] km.`);
      }
    } else {
      const dv = norm(sub(V(out), V(inc)));
      if (dv > TOL.vinf) report('flyby', 'fail', `${label}: massless body, but velocity changes by ${dv.toExponential(3)} km/s (tolerance 1e-7).`);
    }
  }

  // ── 8. Spacing of successive flybys of the same body (Sec. 7 rule 3) ──
  for (let k = 1; k < flybyArcs.length; k++) {
    const p = rows[flybyArcs[k - 1].idx[0]], q = rows[flybyArcs[k].idx[0]];
    if (p.bodyId !== q.bodyId || !GTOC13_BODIES[q.bodyId]) continue;
    const T = bodyPeriod(q.bodyId);
    const dt = q.epoch_s - p.epoch_s;
    if (dt < T / 3 - timeTol(p, q)) {
      report('spacing', 'fail', `${where(q)}: successive flybys of ${GTOC13_BODIES[q.bodyId].name} only ${(dt / DAY).toFixed(3)} days apart (minimum T/3 = ${(T / 3 / DAY).toFixed(3)} days).`);
    }
  }

  // ── 9. Close approaches to Altaira (Sec. 7 rule 2) ──
  // A close approach is a local minimum of |r(t)| along the trajectory: a
  // periapsis passage inside a heliocentric arc, or a point where a flyby turns
  // the radial velocity from inbound to outbound.
  const events = [];
  const pieces = [];                                  // heliocentric pieces in time order
  for (const arc of arcs) {
    if (arc.type === 'conic' && arc.idx.length === 2) pieces.push({ kind: 'conic', a: rows[arc.idx[0]], b: rows[arc.idx[1]] });
    if (arc.type === 'propagated') {
      for (let j = 1; j < arc.idx.length; j++) {
        const a = rows[arc.idx[j - 1]], b = rows[arc.idx[j]];
        if (b.epoch_s - a.epoch_s >= TOL.minStep - 1e-6) pieces.push({ kind: 'sail', a, b });
      }
    }
  }
  const rdot = row => dot(R(row), V(row));
  for (let k = 0; k < pieces.length; k++) {
    const { kind, a, b } = pieces[k];
    if (kind === 'conic') {
      for (const ev of conicPeriapses(R(a), V(a), a.epoch_s, b.epoch_s)) events.push({ ...ev, line: a.line });
    } else if (rdot(a) < 0 && rdot(b) >= 0) {
      events.push({ ...sailSegmentMinimum(a, b), line: a.line });
    }
    const next = pieces[k + 1];
    if (next && rdot(b) < 0 && rdot(next.a) > 0) events.push({ t: b.epoch_s, r: norm(R(b)), line: b.line });
    if (!next && rdot(b) < 0) events.push({ t: b.epoch_s, r: norm(R(b)), line: b.line, end: true });
  }
  events.sort((x, y) => x.t - y.t);
  const approaches = [];                              // merge duplicates (< 1 h apart)
  for (const ev of events) {
    const prev = approaches[approaches.length - 1];
    if (prev && ev.t - prev.t < 3600) { if (ev.r < prev.r) Object.assign(prev, ev); }
    else approaches.push({ ...ev });
  }
  const low = approaches.filter(ev => ev.r < R_LOW - TOL.peri);
  for (const ev of approaches) {
    if (ev.r < R_MIN - TOL.peri) report('perihelion', 'fail', `line ${ev.line}: close approach of ${(ev.r / AU).toFixed(6)} AU at ${fmtT(ev.t)} is below 0.01 AU.`);
  }
  if (low.length > 1) {
    report('perihelion', 'fail', `${low.length} close approaches below 0.05 AU (only one allowed): ${low.map(ev => `${(ev.r / AU).toFixed(5)} AU at ${(ev.t / YEAR).toFixed(3)} yr`).join(', ')}.`);
  }
  const firstPerihelion_s = approaches.length ? approaches[0].t : null;

  // ── 10. Science before the first perihelion (Sec. 7 rule 7; scoring only) ──
  for (const arc of flybyArcs) {
    const row = rows[arc.idx[0]];
    if (!isSmallBody(row.bodyId) || row.flag !== 1) continue;
    if (firstPerihelion_s === null || row.epoch_s < firstPerihelion_s) {
      report('science', 'warning', `${where(row)}: science flyby of ${GTOC13_BODIES[row.bodyId]?.name ?? row.bodyId} at ${(row.epoch_s / YEAR).toFixed(3)} yr is before the first perihelion${firstPerihelion_s === null ? ' (none found)' : ` (${(firstPerihelion_s / YEAR).toFixed(3)} yr)`}; it will not score.`);
    }
  }

  // ── 11. Sail truth stage (Sec. 7), only on steps that passed RK4 ──
  let sailTruthJob = null;
  const truth = checks.find(c => c.id === 'sailTruth');
  if (sailSteps === 0) {
    truth.summary = 'No sail steps (ballistic trajectory)';
  } else if (truthSegments.length === 0) {
    truth.status = 'skipped';
    truth.summary = 'Not run: no sail step passed the RK4 stage';
  } else if (options.sailTruth === 'defer') {
    truth.status = 'running';
    truth.summary = `Queued: ${truthSegments.length} sail steps`;
    sailTruthJob = { segments: truthSegments };
  } else {
    mergeSailTruth(checks, errors, checkSailTruth(rows, truthSegments));
  }

  return finish({ firstPerihelion_s, closeApproaches: approaches, sailTruthJob });
}
