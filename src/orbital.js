/**
 * Keplerian Orbital Mechanics
 * Full implementation matching the GTOC13 specification.
 *
 * All angles in radians internally, degrees at API boundary.
 * Positions returned in AU.
 */

import { MU, DEG } from './systemData.js';

/**
 * Solve Kepler's equation E - e*sin(E) = M via Newton–Raphson.
 * @param {number} M - Mean anomaly [rad]
 * @param {number} e - Eccentricity
 * @returns {number} Eccentric anomaly E [rad]
 */
export function solveKepler(M, e) {
  // Normalize M to [0, 2π]
  M = M % (2 * Math.PI);
  if (M < 0) M += 2 * Math.PI;

  let E = M; // initial guess
  for (let iter = 0; iter < 50; iter++) {
    const dE = (M - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/**
 * Solve Kepler's equation for hyperbolic orbit: e*sinh(H) - H = M.
 * @param {number} M - Mean anomaly [rad]
 * @param {number} e - Eccentricity (>1)
 * @returns {number} Hyperbolic eccentric anomaly H [rad]
 */
export function solveKeplerHyperbolic(M, e) {
  let H = M; // initial guess
  if (e > 1) {
    // Better starting guess for hyperbolic Kepler solver
    H = Math.log(M + Math.sqrt(M * M + 1));
  }
  for (let iter = 0; iter < 50; iter++) {
    const sinhH = Math.sinh(H);
    const coshH = Math.cosh(H);
    const f = e * sinhH - H - M;
    const df = e * coshH - 1;
    const dH = f / df;
    H -= dH;
    if (Math.abs(dH) < 1e-12) break;
  }
  return H;
}

/**
 * Convert Keplerian elements to Cartesian state in the ecliptic frame.
 * @param {object} el - Orbital elements {a,e,i,raan,omega,M0} (angles in degrees)
 * @param {number} t  - Time [years] since epoch
 * @returns {{x,y,z}} Position in AU
 */
export function keplerToCartesian(el, t) {
  const { a, e } = el;
  const i     = el.i     * DEG;
  const raan  = el.raan  * DEG;
  const omega = el.omega * DEG;
  const M0    = el.M0    * DEG;

  let M, nu, r;

  if (e < 1) {
    // Mean motion [rad/yr]
    const n = Math.sqrt(MU / (a * a * a));
    M = M0 + n * t;
    const E = solveKepler(M, e);

    // True anomaly
    nu = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2)
    );
    // Scalar distance
    r = a * (1 - e * Math.cos(E));
  } else {
    // Hyperbolic
    const n = Math.sqrt(MU / Math.abs(a * a * a));
    M = M0 + n * t;
    const H = solveKeplerHyperbolic(M, e);

    // True anomaly
    nu = 2 * Math.atan2(
      Math.sqrt(e + 1) * Math.sinh(H / 2),
      Math.sqrt(e - 1) * Math.cosh(H / 2)
    );
    // Scalar distance
    r = Math.abs(a) * (e * Math.cosh(H) - 1);
  }

  // Perifocal coordinates
  const x_pf = r * Math.cos(nu);
  const y_pf = r * Math.sin(nu);

  // Rotation matrices: Rz(-raan) · Rx(-i) · Rz(-omega)
  const co = Math.cos(omega), so = Math.sin(omega);
  const ci = Math.cos(i),     si = Math.sin(i);
  const cR = Math.cos(raan),  sR = Math.sin(raan);

  // Row vectors of the rotation matrix (3D)
  const Rx = cR * co - sR * so * ci;
  const Ry = sR * co + cR * so * ci;
  const Rz = so * si;

  const Qx = -cR * so - sR * co * ci;
  const Qy = -sR * so + cR * co * ci;
  const Qz = co * si;

  return {
    x: x_pf * Rx + y_pf * Qx,
    y: x_pf * Ry + y_pf * Qy,
    z: x_pf * Rz + y_pf * Qz,
  };
}

/**
 * Compute both Position and Velocity in the ecliptic frame from Keplerian elements.
 * @param {object} el - Orbital elements (angles in degrees)
 * @param {number} t  - Time [years] since epoch
 * @returns {{pos: {x,y,z}, vel: {x,y,z}}} Position in AU, Velocity in AU/yr
 */
export function keplerState(el, t) {
  const { a, e } = el;
  const i     = el.i     * DEG;
  const raan  = el.raan  * DEG;
  const omega = el.omega * DEG;
  const M0    = el.M0    * DEG;

  let M, nu, r;

  if (e < 1) {
    const n = Math.sqrt(MU / (a * a * a));
    M = M0 + n * t;
    const E = solveKepler(M, e);
    nu = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2)
    );
    r = a * (1 - e * Math.cos(E));
  } else {
    const n = Math.sqrt(MU / Math.abs(a * a * a));
    M = M0 + n * t;
    const H = solveKeplerHyperbolic(M, e);
    nu = 2 * Math.atan2(
      Math.sqrt(e + 1) * Math.sinh(H / 2),
      Math.sqrt(e - 1) * Math.cosh(H / 2)
    );
    r = Math.abs(a) * (e * Math.cosh(H) - 1);
  }

  const x_pf = r * Math.cos(nu);
  const y_pf = r * Math.sin(nu);

  let p;
  if (e < 1) {
    p = a * (1 - e * e);
  } else {
    p = Math.abs(a) * (e * e - 1);
  }

  const sqrtMuOverP = Math.sqrt(MU / p);
  const vx_pf = -sqrtMuOverP * Math.sin(nu);
  const vy_pf = sqrtMuOverP * (e + Math.cos(nu));

  const co = Math.cos(omega), so = Math.sin(omega);
  const ci = Math.cos(i),     si = Math.sin(i);
  const cR = Math.cos(raan),  sR = Math.sin(raan);

  const Rx = cR * co - sR * so * ci;
  const Ry = sR * co + cR * so * ci;
  const Rz = so * si;

  const Qx = -cR * so - sR * co * ci;
  const Qy = -sR * so + cR * co * ci;
  const Qz = co * si;

  return {
    pos: {
      x: x_pf * Rx + y_pf * Qx,
      y: x_pf * Ry + y_pf * Qy,
      z: x_pf * Rz + y_pf * Qz,
    },
    vel: {
      x: vx_pf * Rx + vy_pf * Qx,
      y: vx_pf * Ry + vy_pf * Qy,
      z: vx_pf * Rz + vy_pf * Qz,
    }
  };
}

/**
 * Generate an orbit path as a Float32Array of positions.
 * Uses adaptive sampling — denser near periapsis.
 * @param {object} el    - Orbital elements (angles in degrees)
 * @param {number} t0    - Reference time [years]
 * @param {number} nPts  - Number of sample points
 * @returns {Float32Array} Flat [x,y,z, x,y,z, ...] positions in AU
 */
export function generateOrbitPath(el, t0 = 0, nPts = 256) {
  const { a, e } = el;
  const i     = el.i     * DEG;
  const raan  = el.raan  * DEG;
  const omega = el.omega * DEG;

  // Rotation basis vectors
  const co = Math.cos(omega), so = Math.sin(omega);
  const ci = Math.cos(i),     si = Math.sin(i);
  const cR = Math.cos(raan),  sR = Math.sin(raan);

  const Rx = cR * co - sR * so * ci;
  const Ry = sR * co + cR * so * ci;
  const Rz = so * si;
  const Qx = -cR * so - sR * co * ci;
  const Qy = -sR * so + cR * co * ci;
  const Qz = co * si;

  const positions = new Float32Array(nPts * 3);

  for (let k = 0; k < nPts; k++) {
    let nu, r;
    if (e < 1) {
      // Sample uniformly in eccentric anomaly E for adaptive density
      const E = (2 * Math.PI * k) / nPts;
      nu = 2 * Math.atan2(
        Math.sqrt(1 + e) * Math.sin(E / 2),
        Math.sqrt(1 - e) * Math.cos(E / 2)
      );
      r = a * (1 - e * Math.cos(E));
    } else {
      // Hyperbolic orbit: sample true anomaly nu symmetrically from -nu_limit to +nu_limit
      const cos_nu_limit = -1 / e;
      const nu_limit = Math.acos(cos_nu_limit) - 0.05; // stay slightly inside asymptotes
      const frac = k / (nPts - 1);
      nu = -nu_limit + 2 * nu_limit * frac;
      r = Math.abs(a) * (e * e - 1) / (1 + e * Math.cos(nu));
    }

    const xp = r * Math.cos(nu);
    const yp = r * Math.sin(nu);

    positions[k * 3]     = xp * Rx + yp * Qx;
    positions[k * 3 + 1] = xp * Ry + yp * Qy;
    positions[k * 3 + 2] = xp * Rz + yp * Qz;
  }

  return positions;
}

/**
 * Convert Cartesian state vector to Keplerian orbital elements.
 * @param {{x,y,z}} pos  — Position in AU (ecliptic frame)
 * @param {{x,y,z}} vel  — Velocity in AU/yr (ecliptic frame)
 * @returns {object} {a, e, i, raan, omega, M0} — angles in DEGREES
 */
export function cartesianToOrbitalElements(pos, vel) {
  const rx = pos.x, ry = pos.y, rz = pos.z;
  const vx = vel.x, vy = vel.y, vz = vel.z;

  const r = Math.sqrt(rx*rx + ry*ry + rz*rz);
  const v2 = vx*vx + vy*vy + vz*vz;

  // Specific angular momentum h = r × v
  const hx = ry*vz - rz*vy;
  const hy = rz*vx - rx*vz;
  const hz = rx*vy - ry*vx;
  const h = Math.sqrt(hx*hx + hy*hy + hz*hz);

  // Node vector n = z_hat × h
  const nx = -hy;
  const ny =  hx;
  const nMag = Math.sqrt(nx*nx + ny*ny);

  // Semi-major axis
  const energy = v2 / 2 - MU / r;
  const a = -MU / (2 * energy);

  // Eccentricity vector e_vec = (v × h)/mu - r_hat
  const rdotv = rx*vx + ry*vy + rz*vz;
  const ex = (v2/MU - 1/r)*rx - (rdotv/MU)*vx;
  const ey = (v2/MU - 1/r)*ry - (rdotv/MU)*vy;
  const ez = (v2/MU - 1/r)*rz - (rdotv/MU)*vz;
  const e = Math.sqrt(ex*ex + ey*ey + ez*ez);

  // Inclination
  const i_rad = Math.acos(Math.max(-1, Math.min(1, hz/h)));

  // RAAN
  let raan_rad = 0;
  if (nMag > 1e-12) {
    raan_rad = Math.acos(Math.max(-1, Math.min(1, nx/nMag)));
    if (ny < 0) raan_rad = 2*Math.PI - raan_rad;
  }

  // Argument of periapsis
  let omega_rad = 0;
  if (nMag > 1e-12 && e > 1e-12) {
    const ndote = (nx*ex + ny*ey) / (nMag * e);
    omega_rad = Math.acos(Math.max(-1, Math.min(1, ndote)));
    if (ez < 0) omega_rad = 2*Math.PI - omega_rad;
  }

  // True anomaly
  let nu = 0;
  if (e > 1e-12) {
    const edotr = (ex*rx + ey*ry + ez*rz) / (e * r);
    nu = Math.acos(Math.max(-1, Math.min(1, edotr)));
    if (rdotv < 0) nu = 2*Math.PI - nu;
  }

  let M0_rad = 0;
  if (e < 1) {
    // Eccentric anomaly from true anomaly
    const E = 2 * Math.atan2(
      Math.sqrt(1 - e) * Math.sin(nu / 2),
      Math.sqrt(1 + e) * Math.cos(nu / 2)
    );
    // Mean anomaly
    M0_rad = E - e * Math.sin(E);
    if (M0_rad < 0) M0_rad += 2 * Math.PI;
  } else {
    // Hyperbolic anomaly from true anomaly
    const denom = 1 + e * Math.cos(nu);
    const coshH = (e + Math.cos(nu)) / denom;
    const sinhH = (Math.sqrt(e * e - 1) * Math.sin(nu)) / denom;
    const H = Math.log(coshH + sinhH);
    M0_rad = e * Math.sinh(H) - H;
  }

  return {
    a,
    e,
    i:     i_rad / DEG,
    raan:  raan_rad / DEG,
    omega: omega_rad / DEG,
    M0:    M0_rad / DEG,
  };
}

/**
 * Orbital period in years.
 */
export function orbitalPeriod(a) {
  if (a <= 0) return Infinity;
  return Math.sqrt(a * a * a / MU) * 2 * Math.PI;
}

/**
 * Propagate a state vector (elliptic, parabolic, hyperbolic) using universal variables.
 * Mathematically identical to kepler_propagate in mission_core.py.
 * @param {{x,y,z}} r0  - Initial position vector
 * @param {{x,y,z}} v0  - Initial velocity vector
 * @param {number} dt   - Propagation time duration
 * @param {number} mu   - Gravitational parameter
 * @returns {{pos: {x,y,z}, vel: {x,y,z}}} Propagated state vector
 */
export function keplerPropagate(r0, v0, dt, mu) {
  if (Math.abs(dt) < 1e-12) {
    return {
      pos: { x: r0.x, y: r0.y, z: r0.z },
      vel: { x: v0.x, y: v0.y, z: v0.z }
    };
  }

  const r0n = Math.sqrt(r0.x*r0.x + r0.y*r0.y + r0.z*r0.z);
  const v0n = Math.sqrt(v0.x*v0.x + v0.y*v0.y + v0.z*v0.z);
  const vr0 = (r0.x*v0.x + r0.y*v0.y + r0.z*v0.z) / r0n;
  
  let alpha = 2.0 / r0n - (v0n * v0n) / mu;
  if (Math.abs(alpha) < 1e-12) {
    alpha = 0.0;
  }

  function stumpffC(z) {
    if (z > 0) {
      const sz = Math.sqrt(z);
      return (1.0 - Math.cos(sz)) / z;
    }
    if (z < 0) {
      const sz = Math.sqrt(-z);
      if (sz > 700.0) {
        return Infinity;
      }
      return (Math.cosh(sz) - 1.0) / (-z);
    }
    return 0.5;
  }

  function stumpffS(z) {
    if (z > 0) {
      const sz = Math.sqrt(z);
      return (sz - Math.sin(sz)) / (sz * sz * sz);
    }
    if (z < 0) {
      const sz = Math.sqrt(-z);
      if (sz > 700.0) {
        return Infinity;
      }
      return (Math.sinh(sz) - sz) / (sz * sz * sz);
    }
    return 1.0 / 6.0;
  }

  const sqrt_mu = Math.sqrt(mu);
  let chi = 0.0;
  
  if (alpha > 0) {
    chi = Math.sign(dt) * (sqrt_mu * Math.abs(alpha) * Math.abs(dt));
  } else if (alpha < 0) {
    try {
      const term = vr0 + Math.sign(dt) * Math.sqrt(-mu / alpha) * (1.0 - alpha * r0n);
      chi = Math.sign(dt) * Math.sqrt(-1.0 / alpha) * Math.log((-2.0 * mu * alpha * Math.abs(dt)) / term);
      if (isNaN(chi) || !isFinite(chi)) {
        chi = Math.sign(dt) * sqrt_mu * Math.abs(dt) * Math.sqrt(-alpha);
      }
    } catch (e) {
      chi = Math.sign(dt) * sqrt_mu * Math.abs(dt) * Math.sqrt(-alpha);
    }
  } else {
    chi = Math.sign(dt) * (sqrt_mu * Math.abs(dt) / r0n);
  }
  
  if (chi === 0.0) {
    chi = 1e-12 * Math.sign(dt);
    if (chi === 0.0) chi = 1e-12;
  }

  // Bracket the root to guarantee convergence and prevent wild Newton steps
  let x_lower, x_upper;
  const chi_limit = alpha < 0 ? 700.0 / Math.sqrt(-alpha) : 1e12;

  function evaluateF(x) {
    const z = alpha * x * x;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F = (r0n * vr0 / sqrt_mu) * x * x * C +
              (1.0 - alpha * r0n) * x * x * x * S +
              r0n * x -
              sqrt_mu * dt;
    const dF = (r0n * vr0 / sqrt_mu) * x * (1.0 - z * S) +
               (1.0 - alpha * r0n) * x * x * C +
               r0n * (1.0 - z * C);
    return { F, dF };
  }

  if (dt > 0) {
    x_lower = 0.0;
    let guess = chi > 0 ? chi : 1.0;
    guess = Math.min(guess, chi_limit);
    let { F } = evaluateF(guess);
    while (F < 0 && guess < chi_limit) {
      x_lower = guess;
      guess = Math.min(guess * 2.0, chi_limit);
      F = evaluateF(guess).F;
    }
    x_upper = guess;
  } else {
    x_upper = 0.0;
    let guess = chi < 0 ? chi : -1.0;
    guess = Math.max(guess, -chi_limit);
    let { F } = evaluateF(guess);
    while (F > 0 && guess > -chi_limit) {
      x_upper = guess;
      guess = Math.max(guess * 2.0, -chi_limit);
      F = evaluateF(guess).F;
    }
    x_lower = guess;
  }

  // Perform safeguarded hybrid Newton-Raphson / Bisection
  let it = 0;
  const tol = 1e-13;
  const max_iter = 200;
  chi = 0.5 * (x_lower + x_upper);
  let prev_step = x_upper - x_lower;
  let step = prev_step;

  while (it < max_iter && (x_upper - x_lower) > tol) {
    it++;
    const { F, dF } = evaluateF(chi);
    
    if (Math.abs(F) < 1e-14) {
      break;
    }

    if (F < 0) {
      x_lower = chi;
    } else {
      x_upper = chi;
    }

    let next_chi = chi;
    let newton_ok = false;
    if (Math.abs(dF) > 1e-15) {
      const newton_step = F / dF;
      next_chi = chi - newton_step;
      if (next_chi > x_lower && next_chi < x_upper && Math.abs(newton_step) < 0.5 * Math.abs(prev_step)) {
        newton_ok = true;
        prev_step = step;
        step = newton_step;
      }
    }

    if (newton_ok) {
      chi = next_chi;
    } else {
      chi = 0.5 * (x_lower + x_upper);
      prev_step = x_upper - x_lower;
      step = prev_step;
    }

    if (chi === x_lower || chi === x_upper) {
      break;
    }
  }

  const z = alpha * chi * chi;
  const C = stumpffC(z);
  const S = stumpffS(z);
  
  const f = 1.0 - (chi * chi / r0n) * C;
  const g = dt - (chi * chi * chi / sqrt_mu) * S;
  
  const rx = f * r0.x + g * v0.x;
  const ry = f * r0.y + g * v0.y;
  const rz = f * r0.z + g * v0.z;
  
  const rmag = Math.sqrt(rx*rx + ry*ry + rz*rz);
  
  const fdot = (sqrt_mu / (rmag * r0n)) * (z * S - 1.0) * chi;
  const gdot = 1.0 - (chi * chi / rmag) * C;
  
  const vx = fdot * r0.x + gdot * v0.x;
  const vy = fdot * r0.y + gdot * v0.y;
  const vz = fdot * r0.z + gdot * v0.z;

  return {
    pos: { x: rx, y: ry, z: rz },
    vel: { x: vx, y: vy, z: vz }
  };
}
