/**
 * GTOC13 Mission Submission Parser & Validator
 *
 * Parses a GTOC13 submission file into a structured mission object
 * and validates the trajectory against constraints from validator.py.
 */

import { AU_KM, YEAR_S, PLANETS, MU, MU_KM3_S2 } from './systemData.js';
import { cartesianToOrbitalElements, keplerToCartesian, keplerState, keplerPropagate } from './orbital.js';

const KM_TO_AU = 1 / AU_KM;
const S_TO_YR  = 1 / YEAR_S;
const KMS_TO_AUYR = YEAR_S / AU_KM;

// ─── Row parsing ──────────────────────────────────────────────────────────────

function parseRow(line) {
  const parts = line.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 12 || parts.some(isNaN)) return null;
  return {
    bodyId: Math.round(parts[0]),
    flag:   Math.round(parts[1]),
    epoch_s: parts[2],
    x_km: parts[3], y_km: parts[4], z_km: parts[5],
    vx_kms: parts[6], vy_kms: parts[7], vz_kms: parts[8],
    c1: parts[9], c2: parts[10], c3: parts[11],
  };
}

function rowToAU(row) {
  return {
    ...row,
    time_yr: row.epoch_s * S_TO_YR,
    x_au:  row.x_km * KM_TO_AU,
    y_au:  row.y_km * KM_TO_AU,
    z_au:  row.z_km * KM_TO_AU,
    vx_auyr: row.vx_kms * KMS_TO_AUYR,
    vy_auyr: row.vy_kms * KMS_TO_AUYR,
    vz_auyr: row.vz_kms * KMS_TO_AUYR,
  };
}

// ─── Mission Parser ───────────────────────────────────────────────────────────

export function parseMission(text) {
  const lines = text.split('\n');
  const rows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const row = parseRow(trimmed);
    if (row) rows.push(rowToAU(row));
  }

  if (rows.length === 0) {
    throw new Error('No valid data rows found in submission file.');
  }

  // Group rows into segments
  const segments = [];
  const flybys   = [];
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];

    if (row.bodyId > 0) {
      // ── Flyby arc: exactly 2 rows with same bodyId ──
      const incoming = row;
      const outgoing = (i + 1 < rows.length && rows[i + 1].bodyId === row.bodyId)
        ? rows[i + 1] : null;

      const flyby = {
        type: 'flyby',
        bodyId: row.bodyId,
        scienceFlyby: row.flag === 1,
        time_yr: row.time_yr,
        position: { x: row.x_au, y: row.y_au, z: row.z_au },
        vinf_in:  outgoing ? { x: incoming.c1, y: incoming.c2, z: incoming.c3 } : null,
        vinf_out: outgoing ? { x: outgoing.c1, y: outgoing.c2, z: outgoing.c3 } : null,
        v_in_auyr: { x: incoming.vx_auyr, y: incoming.vy_auyr, z: incoming.vz_auyr },
        v_out_auyr: outgoing ? { x: outgoing.vx_auyr, y: outgoing.vy_auyr, z: outgoing.vz_auyr } : null,
        incomingRowIndex: i,
        outgoingRowIndex: outgoing ? i + 1 : i,
      };
      flybys.push(flyby);
      segments.push(flyby);
      i += outgoing ? 2 : 1;

    } else if (row.flag === 0) {
      // ── Conic arc: exactly 2 rows ──
      const startRow = row;
      const endRow = (i + 1 < rows.length && rows[i + 1].bodyId === 0 && rows[i + 1].flag === 0)
        ? rows[i + 1] : null;

      if (endRow) {
        segments.push({
          type: 'conic',
          startTime_yr: startRow.time_yr,
          endTime_yr:   endRow.time_yr,
          startPos: { x: startRow.x_au, y: startRow.y_au, z: startRow.z_au },
          startVel: { x: startRow.vx_auyr, y: startRow.vy_auyr, z: startRow.vz_auyr },
          endPos:   { x: endRow.x_au, y: endRow.y_au, z: endRow.z_au },
          endVel:   { x: endRow.vx_auyr, y: endRow.vy_auyr, z: endRow.vz_auyr },
          startRowIndex: i,
          endRowIndex: i + 1,
        });
        i += 2;
      } else {
        // Single conic row (shouldn't happen, but handle gracefully)
        segments.push({
          type: 'conic',
          startTime_yr: startRow.time_yr,
          endTime_yr:   startRow.time_yr,
          startPos: { x: startRow.x_au, y: startRow.y_au, z: startRow.z_au },
          startVel: { x: startRow.vx_auyr, y: startRow.vy_auyr, z: startRow.vz_auyr },
          endPos:   { x: startRow.x_au, y: startRow.y_au, z: startRow.z_au },
          endVel:   { x: startRow.vx_auyr, y: startRow.vy_auyr, z: startRow.vz_auyr },
          startRowIndex: i,
          endRowIndex: i,
        });
        i += 1;
      }

    } else {
      // ── Propagated arc (flag=1, bodyId=0): collect all consecutive rows ──
      const points = [];
      const startIdx = i;
      while (i < rows.length && rows[i].bodyId === 0 && rows[i].flag === 1) {
        const r = rows[i];
        points.push({
          time_yr: r.time_yr,
          x: r.x_au, y: r.y_au, z: r.z_au,
          vx: r.vx_auyr, vy: r.vy_auyr, vz: r.vz_auyr,
          // Sail control normal vector
          ux: r.c1, uy: r.c2, uz: r.c3,
        });
        i++;
      }
      if (points.length > 0) {
        segments.push({
          type: 'propagated',
          startTime_yr: points[0].time_yr,
          endTime_yr:   points[points.length - 1].time_yr,
          points,
          startRowIndex: startIdx,
          endRowIndex: i - 1,
        });
      }
    }
  }

  const timeRange = {
    start_yr: rows[0].time_yr,
    end_yr:   rows[rows.length - 1].time_yr,
  };

  // Run flight constraints validation
  const validation = validateMission(rows, segments);

  return {
    segments,
    flybys,
    timeRange,
    rowCount: rows.length,
    validationChecks: validation.checks,
    validationErrors: validation.errors,
    rows: rows
  };
}


// ─── Trail Point Generation ──────────────────────────────────────────────────
// Pre-compute a dense array of {time_yr, x, y, z} points for trail rendering.

export function generateTrailPoints(mission, conicSamples = 300) {
  const trail = [];

  for (const seg of mission.segments) {
    if (seg.type === 'flyby') {
      trail.push({
        time_yr: seg.time_yr,
        x: seg.position.x, y: seg.position.y, z: seg.position.z,
        segType: 'flyby',
        bodyId: seg.bodyId,
        scienceFlyby: seg.scienceFlyby,
      });

    } else if (seg.type === 'conic') {
      const dt = seg.endTime_yr - seg.startTime_yr;
      if (dt <= 0) {
        trail.push({
          time_yr: seg.startTime_yr,
          x: seg.startPos.x, y: seg.startPos.y, z: seg.startPos.z,
          segType: 'conic',
        });
        continue;
      }

      // Propagate using stable universal variables
      let hasError = false;
      let propagatedEnd = null;
      let errX = 0, errY = 0, errZ = 0;

      try {
        const resultEnd = keplerPropagate(seg.startPos, seg.startVel, dt, MU);
        propagatedEnd = resultEnd.pos;
        if (isNaN(propagatedEnd.x) || isNaN(propagatedEnd.y) || isNaN(propagatedEnd.z)) {
          hasError = true;
        } else {
          errX = seg.endPos.x - propagatedEnd.x;
          errY = seg.endPos.y - propagatedEnd.y;
          errZ = seg.endPos.z - propagatedEnd.z;
        }
      } catch (e) {
        hasError = true;
      }

      for (let k = 0; k <= conicSamples; k++) {
        const frac = k / conicSamples;
        const t = seg.startTime_yr + frac * dt;
        let x, y, z;

        if (hasError) {
          // Linear interpolation fallback
          x = seg.startPos.x + frac * (seg.endPos.x - seg.startPos.x);
          y = seg.startPos.y + frac * (seg.endPos.y - seg.startPos.y);
          z = seg.startPos.z + frac * (seg.endPos.z - seg.startPos.z);
        } else {
          // Propagate with stable universal variables
          const result = keplerPropagate(seg.startPos, seg.startVel, frac * dt, MU);
          // Apply linear residual correction to match the endpoints exactly
          x = result.pos.x + frac * errX;
          y = result.pos.y + frac * errY;
          z = result.pos.z + frac * errZ;
        }

        trail.push({
          time_yr: t,
          x, y, z,
          segType: 'conic',
        });
      }

    } else if (seg.type === 'propagated') {
      for (const pt of seg.points) {
        trail.push({
          time_yr: pt.time_yr,
          x: pt.x, y: pt.y, z: pt.z,
          segType: 'propagated',
          ux: pt.ux, uy: pt.uy, uz: pt.uz,
          vx: pt.vx, vy: pt.vy, vz: pt.vz,
        });
      }
    }
  }

  // Sort by time just in case
  trail.sort((a, b) => a.time_yr - b.time_yr);
  return trail;
}


// ─── Position Lookup ──────────────────────────────────────────────────────────

export function getPositionAtTime(trail, t) {
  if (!trail || trail.length === 0) return null;
  if (t <= trail[0].time_yr) return null; // not yet departed
  if (t >= trail[trail.length - 1].time_yr) {
    const last = trail[trail.length - 1];
    return { x: last.x, y: last.y, z: last.z, ux: last.ux, uy: last.uy, uz: last.uz, segType: last.segType };
  }

  // Binary search for the segment
  let lo = 0, hi = trail.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (trail[mid].time_yr <= t) lo = mid;
    else hi = mid;
  }

  const a = trail[lo];
  const b = trail[hi];
  const dt = b.time_yr - a.time_yr;
  if (dt <= 0) return { x: a.x, y: a.y, z: a.z, ux: a.ux, uy: a.uy, uz: a.uz, segType: a.segType };

  const frac = (t - a.time_yr) / dt;
  return {
    x: a.x + (b.x - a.x) * frac,
    y: a.y + (b.y - a.y) * frac,
    z: a.z + (b.z - a.z) * frac,
    ux: a.ux,
    uy: a.uy,
    uz: a.uz,
    segType: a.segType,
  };
}

export function getTrailIndex(trail, t) {
  if (!trail || trail.length === 0) return 0;
  if (t <= trail[0].time_yr) return 0;
  if (t >= trail[trail.length - 1].time_yr) return trail.length;

  // Binary search
  let lo = 0, hi = trail.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (trail[mid].time_yr <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ─── Flight Constraints Validator ─────────────────────────────────────────────

const ASTEROID_ID_MIN = 1001;
const ASTEROID_ID_MAX = 1257;
const COMET_ID_MIN = 2001;
const COMET_ID_MAX = 2042;

function isAsteroidOrComet(bodyId) {
  return (bodyId >= ASTEROID_ID_MIN && bodyId <= ASTEROID_ID_MAX) ||
         (bodyId >= COMET_ID_MIN && bodyId <= COMET_ID_MAX);
}

// perihelion distance helper
function perihelionDistance(r, v, mu) {
  const hx = r.y * v.z - r.z * v.y;
  const hy = r.z * v.x - r.x * v.z;
  const hz = r.x * v.y - r.y * v.x;
  const h2 = hx*hx + hy*hy + hz*hz;
  if (h2 <= 1e-24) return 0;
  const rmag = Math.sqrt(r.x*r.x + r.y*r.y + r.z*r.z);
  const vmag2 = v.x*v.x + v.y*v.y + v.z*v.z;
  const rv = r.x*v.x + r.y*v.y + r.z*v.z;
  const p = h2 / mu;
  const factor = vmag2 - mu / rmag;
  const ex = (factor * r.x - rv * v.x) / mu;
  const ey = (factor * r.y - rv * v.y) / mu;
  const ez = (factor * r.z - rv * v.z) / mu;
  const e = Math.sqrt(ex*ex + ey*ey + ez*ez);
  if (e < 1e-12) return p;
  return p / (1.0 + e);
}

function estimateFirstPerihelionEpoch(rows) {
  if (!rows || rows.length === 0) return null;
  const rByT = {};
  for (const row of rows) {
    const rmag = Math.sqrt(row.x_km*row.x_km + row.y_km*row.y_km + row.z_km*row.z_km);
    if (rByT[row.epoch_s] === undefined || rmag < rByT[row.epoch_s]) {
      rByT[row.epoch_s] = rmag;
    }
  }
  const times = Object.keys(rByT).map(Number).sort((a, b) => a - b);
  const radii = times.map(t => rByT[t]);
  for (let idx = 1; idx < times.length - 1; idx++) {
    if (radii[idx] <= radii[idx - 1] && radii[idx] <= radii[idx + 1]) {
      return times[idx];
    }
  }
  if (times.length === 0) return null;
  let minIdx = 0;
  for (let i = 1; i < times.length; i++) {
    if (radii[i] < radii[minIdx]) minIdx = i;
  }
  return times[minIdx];
}

export function validateMission(rows, segments) {
  const errors = [];
  const checks = [
    { id: 'launch', name: 'Launch State', status: 'pass', desc: 'Spacecraft departs at -200 AU with Vy=Vz=0 within limits.' },
    { id: 'time', name: 'Time & Duration', status: 'pass', desc: 'Monotonic progression under the maximum 200-year window.' },
    { id: 'continuity', name: 'Trajectory Continuity', status: 'pass', desc: 'Zero position and velocity jumps between segments.' },
    { id: 'sail', name: 'Solar Sail Control', status: 'pass', desc: 'Thrust vectors are unit length and point in the sunward hemisphere.' },
    { id: 'flyby', name: 'Flyby Parameters', status: 'pass', desc: 'Assists satisfy altitude bounds, planet asymptote equality, and massless continuity.' },
    { id: 'spacing', name: 'Flyby Spacing', status: 'pass', desc: 'Encounters at the same planet are separated by at least T/3.' },
    { id: 'perihelion', name: 'Heliocentric Perihelion', status: 'pass', desc: 'Orbit perihelion stays >= 0.01 AU; at most one is below 0.05 AU.' },
    { id: 'science', name: 'First Perihelion Science', status: 'pass', desc: 'Asteroid/comet science flybys only occur after the first perihelion.' }
  ];

  const updateCheck = (id, status, msg) => {
    const c = checks.find(x => x.id === id);
    if (c) {
      if (status === 'fail') c.status = 'fail';
      else if (status === 'warning' && c.status !== 'fail') c.status = 'warning';
      if (msg) errors.push(`[${c.name}] ${msg}`);
    }
  };

  // Setup databases from systemData.js
  const planetDB = {};
  const planetPeriodMap = {};
  PLANETS.forEach(p => {
    planetDB[p.id] = {
      radius: p.radius, // km
      mu: p.mu,         // km^3/s^2
      el: p             // elements for velocity calculation
    };
    // T = 2 * pi * sqrt(a^3 / MU) in years
    const a = p.a;
    const t_yr = Math.sqrt(a * a * a / MU) * 2 * Math.PI;
    planetPeriodMap[p.id] = t_yr * YEAR_S; // period in seconds
  });

  // 1. Launch Conditions
  const r0 = rows[0];
  const x_target = -200 * AU_KM;
  if (r0.epoch_s < 0 || r0.epoch_s > 200 * YEAR_S) {
    updateCheck('launch', 'fail', `Depart epoch ${r0.epoch_s.toFixed(1)}s (yr: ${(r0.epoch_s / YEAR_S).toFixed(3)}) is out of [0, 200 years] window.`);
  }
  if (Math.abs(r0.x_km - x_target) > 0.1) {
    updateCheck('launch', 'fail', `Launch position error: X = ${r0.x_km.toFixed(1)} km (expected ${x_target.toFixed(1)} km; diff exceeds 100m).`);
  }
  if (Math.abs(r0.vy_kms) > 1e-7 || Math.abs(r0.vz_kms) > 1e-7) {
    updateCheck('launch', 'fail', `Launch velocity error: Vy = ${r0.vy_kms.toExponential(3)} km/s, Vz = ${r0.vz_kms.toExponential(3)} km/s (must be 0 within 10^-7 km/s).`);
  }

  // 2. Time & Duration
  const r_last = rows[rows.length - 1];
  if (r_last.epoch_s > 200 * YEAR_S + 1e-6) {
    updateCheck('time', 'fail', `Global duration exceeds 200-year window (last epoch: ${(r_last.epoch_s / YEAR_S).toFixed(2)} yr).`);
  }
  for (let idx = 1; idx < rows.length; idx++) {
    if (rows[idx].epoch_s + 1e-7 < rows[idx - 1].epoch_s) {
      updateCheck('time', 'fail', `Time non-monotonic at row ${idx + 1}: t(i-1) = ${rows[idx - 1].epoch_s.toFixed(1)}s, t(i) = ${rows[idx].epoch_s.toFixed(1)}s.`);
    }
  }

  // 3. Continuity checks between successive segments
  for (let a_idx = 1; a_idx < segments.length; a_idx++) {
    const prev = segments[a_idx - 1];
    const curr = segments[a_idx];

    let endPos, endVel, endT;
    if (prev.type === 'conic') {
      endPos = prev.endPos;
      endVel = prev.endVel;
      endT = prev.endTime_yr * YEAR_S;
    } else if (prev.type === 'flyby') {
      endPos = { x: prev.position.x, y: prev.position.y, z: prev.position.z };
      endVel = prev.v_out_auyr ? prev.v_out_auyr : prev.v_in_auyr;
      endT = prev.time_yr * YEAR_S;
    } else if (prev.type === 'propagated') {
      const lastPt = prev.points[prev.points.length - 1];
      endPos = { x: lastPt.x, y: lastPt.y, z: lastPt.z };
      endVel = { x: lastPt.vx, y: lastPt.vy, z: lastPt.vz };
      endT = lastPt.time_yr * YEAR_S;
    }

    let startPos, startVel, startT;
    if (curr.type === 'conic') {
      startPos = curr.startPos;
      startVel = curr.startVel;
      startT = curr.startTime_yr * YEAR_S;
    } else if (curr.type === 'flyby') {
      startPos = { x: curr.position.x, y: curr.position.y, z: curr.position.z };
      startVel = curr.v_in_auyr;
      startT = curr.time_yr * YEAR_S;
    } else if (curr.type === 'propagated') {
      const firstPt = curr.points[0];
      startPos = { x: firstPt.x, y: firstPt.y, z: firstPt.z };
      startVel = { x: firstPt.vx, y: firstPt.vy, z: firstPt.vz };
      startT = firstPt.time_yr * YEAR_S;
    }

    if (endPos && startPos) {
      const dt = startT - endT;
      if (Math.abs(dt) > 1e-7) {
        updateCheck('continuity', 'fail', `Segment ${a_idx} -> ${a_idx+1} time gap: dt = ${dt.toFixed(3)}s.`);
      }

      const pos_tol = Math.abs(dt) <= 1e-7 ? 1e-6 : 0.1; // km (1mm vs 100m)
      const vel_tol = Math.abs(dt) <= 1e-7 ? 1e-9 : 1e-7; // km/s (1 micron/s vs 0.1 mm/s)

      const dx_km = (startPos.x - endPos.x) * AU_KM;
      const dy_km = (startPos.y - endPos.y) * AU_KM;
      const dz_km = (startPos.z - endPos.z) * AU_KM;
      const pos_diff = Math.sqrt(dx_km*dx_km + dy_km*dy_km + dz_km*dz_km);

      const dvx_kms = (startVel.x - endVel.x) / KMS_TO_AUYR;
      const dvy_kms = (startVel.y - endVel.y) / KMS_TO_AUYR;
      const dvz_kms = (startVel.z - endVel.z) / KMS_TO_AUYR;
      const vel_diff = Math.sqrt(dvx_kms*dvx_kms + dvy_kms*dvy_kms + dvz_kms*dvz_kms);

      if (pos_diff > pos_tol) {
        updateCheck('continuity', 'fail', `Position jump between segments ${a_idx} & ${a_idx+1}: ||dr|| = ${pos_diff.toFixed(4)} km (allowed tol = ${pos_tol.toExponential(1)} km).`);
      }
      if (vel_diff > vel_tol) {
        updateCheck('continuity', 'fail', `Velocity jump between segments ${a_idx} & ${a_idx+1}: ||dv|| = ${vel_diff.toExponential(3)} km/s (allowed tol = ${vel_tol.toExponential(1)} km/s).`);
      }
    }
  }

  // 4. Solar Sail Control
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    if (r.bodyId === 0 && r.flag === 1) {
      const c_len = Math.sqrt(r.c1*r.c1 + r.c2*r.c2 + r.c3*r.c3);
      if (Math.abs(c_len - 1.0) > 1e-6) {
        updateCheck('sail', 'fail', `Row ${idx+1}: Sail control vector magnitude is |u| = ${c_len.toFixed(6)} (must be 1.0 within 1e-6).`);
      }
      const rmag = Math.sqrt(r.x_km*r.x_km + r.y_km*r.y_km + r.z_km*r.z_km);
      if (rmag > 0) {
        const sunward_x = -r.x_km / rmag;
        const sunward_y = -r.y_km / rmag;
        const sunward_z = -r.z_km / rmag;
        const cos_alpha = r.c1*sunward_x + r.c2*sunward_y + r.c3*sunward_z;
        if (cos_alpha < -1e-9) {
          updateCheck('sail', 'fail', `Row ${idx+1}: Sail orientation points away from exosun (cos(alpha) = ${cos_alpha.toFixed(6)}; must be >= 0).`);
        }
      }
    }
  }
  // Step sizes for solar sail arcs
  segments.forEach((seg, sIdx) => {
    if (seg.type === 'propagated') {
      for (let k = 1; k < seg.points.length; k++) {
        const dt = (seg.points[k].time_yr - seg.points[k-1].time_yr) * YEAR_S;
        if (dt > 1e-7 && dt < 60.0 - 1e-9) {
          updateCheck('sail', 'fail', `Propagated arc step size too small: dt = ${dt.toFixed(3)}s (must be >= 60 seconds).`);
        }
      }
    }
  });

  // 5 & 6. Flyby Checks & Spacing
  const lastFlybyTime = {}; // tracks last flyby time per bodyId

  segments.forEach((seg, sIdx) => {
    if (seg.type !== 'flyby') return;

    const k = seg.bodyId;
    const t = seg.time_yr * YEAR_S;

    // A. Check Spacing Constraint (T/3 separation)
    if (lastFlybyTime[k] !== undefined) {
      const prev_t = lastFlybyTime[k];
      const T = planetPeriodMap[k]; // will be undefined for asteroids/comets (which is fine)
      if (T !== undefined) {
        const dt = t - prev_t;
        if (dt + 1e-9 < T / 3) {
          updateCheck('spacing', 'fail', `Flybys of body ${k} are separated by too little time: dt = ${(dt / YEAR_S).toFixed(3)} yr (minimum separation T/3 = ${(T / 3 / YEAR_S).toFixed(3)} yr).`);
        }
      }
    }
    lastFlybyTime[k] = t;

    // B. Keplerian Ephemeris & Gravity checks (for major planets)
    const isPlanet = (k >= 1 && k <= 10);
    const planetData = planetDB[k];

    if (isPlanet && planetData) {
      if (seg.outgoingRowIndex > seg.incomingRowIndex) {
        try {
          // Compute planet state vector at flyby epoch
          const pState = keplerState(planetData.el, seg.time_yr);
          // Convert planet velocity from AU/yr to km/s
          const pVel_kms = {
            x: pState.vel.x / KMS_TO_AUYR,
            y: pState.vel.y / KMS_TO_AUYR,
            z: pState.vel.z / KMS_TO_AUYR
          };

          const incomingRow = rows[seg.incomingRowIndex];
          const outgoingRow = rows[seg.outgoingRowIndex];

          // V_inf = V_sc - V_planet
          const vinf_in = {
            x: incomingRow.vx_kms - pVel_kms.x,
            y: incomingRow.vy_kms - pVel_kms.y,
            z: incomingRow.vz_kms - pVel_kms.z
          };
          const vinf_out = {
            x: outgoingRow.vx_kms - pVel_kms.x,
            y: outgoingRow.vy_kms - pVel_kms.y,
            z: outgoingRow.vz_kms - pVel_kms.z
          };

          const v_in = Math.sqrt(vinf_in.x*vinf_in.x + vinf_in.y*vinf_in.y + vinf_in.z*vinf_in.z);
          const v_out = Math.sqrt(vinf_out.x*vinf_out.x + vinf_out.y*vinf_out.y + vinf_out.z*vinf_out.z);

          // Check asymptotes magnitude equality
          if (Math.abs(v_in - v_out) > 1e-7) {
            updateCheck('flyby', 'fail', `Planet ${k} flyby asymptote mismatch: |v_inf_in| = ${v_in.toFixed(6)} km/s, |v_out| = ${v_out.toFixed(6)} km/s (must match within 10^-7 km/s).`);
          }

          if (v_in > 0 && v_out > 0) {
            const dot = vinf_in.x*vinf_out.x + vinf_in.y*vinf_out.y + vinf_in.z*vinf_out.z;
            const cosd = Math.max(-1.0, Math.min(1.0, dot / (v_in * v_out)));
            const delta = Math.acos(cosd);
            const s = Math.sin(delta / 2.0);

            if (s <= 1e-9) {
              updateCheck('flyby', 'fail', `Planet ${k} flyby: hyperbolic turn angle is zero (flyby alt is infinity).`);
            } else {
              const muP = planetData.mu;
              const Rp = planetData.radius;
              const Rperi = (muP * (1 - s)) / (s * v_in * v_in);
              const h = Rperi - Rp; // altitude in km

              const min_alt = Math.max(0.0, 0.1 * Rp - 0.1);
              const max_alt = 100.0 * Rp + 0.1;

              if (h < min_alt || h > max_alt) {
                updateCheck('flyby', 'fail', `Planet ${k} flyby altitude out of bounds: h = ${h.toFixed(1)} km (allowed: ${min_alt.toFixed(1)} to ${max_alt.toFixed(1)} km, i.e., 0.1 to 100 Rp).`);
              }
            }
          }
        } catch (err) {
          updateCheck('flyby', 'warning', `Planet ${k} flyby math check failed: ${err.message}`);
        }
      }
    } else {
      if (seg.outgoingRowIndex > seg.incomingRowIndex) {
        // Massless body (asteroid/comet) flyby: check velocity continuity (V_inf_in = V_inf_out)
        // Since it's massless, V_sc is continuous, so V_sc_in = V_sc_out
        const incomingRow = rows[seg.incomingRowIndex];
        const outgoingRow = rows[seg.outgoingRowIndex];
        const dvx = outgoingRow.vx_kms - incomingRow.vx_kms;
        const dvy = outgoingRow.vy_kms - incomingRow.vy_kms;
        const dvz = outgoingRow.vz_kms - incomingRow.vz_kms;
        const dv = Math.sqrt(dvx*dvx + dvy*dvy + dvz*dvz);
        if (dv > 1e-7) {
          updateCheck('flyby', 'fail', `Massless body ${k} flyby velocity discontinuity: ||Δv|| = ${dv.toExponential(3)} km/s (must be continuous within 10^-7 km/s).`);
        }
      }
    }
  });

  // 7. Heliocentric Perihelion
  let low05Count = 0;
  const low05Details = [];

  segments.forEach((seg, sIdx) => {
    if (seg.type !== 'conic') return;

    // Convert start state to vector in km and km/s
    const r = { x: seg.startPos.x * AU_KM, y: seg.startPos.y * AU_KM, z: seg.startPos.z * AU_KM };
    const v = {
      x: seg.startVel.x / KMS_TO_AUYR,
      y: seg.startVel.y / KMS_TO_AUYR,
      z: seg.startVel.z / KMS_TO_AUYR
    };

    const rp = perihelionDistance(r, v, MU_KM3_S2);
    if (rp > 0) {
      const rp_AU = rp / AU_KM;
      if (rp_AU < 0.01 - 1e-9) {
        updateCheck('perihelion', 'fail', `Heliocentric perihelion in segment ${sIdx+1} goes too close: ${rp_AU.toFixed(5)} AU (must be >= 0.01 AU).`);
      } else if (rp_AU < 0.05 - 1e-9) {
        low05Count++;
        low05Details.push(`segment ${sIdx+1} (${rp_AU.toFixed(4)} AU)`);
      }
    }
  });

  if (low05Count > 1) {
    updateCheck('perihelion', 'fail', `More than one heliocentric perihelion passage below 0.05 AU: ${low05Details.join(', ')}.`);
  }

  // 8. Pre-Perihelion Science
  const t_peri_s = estimateFirstPerihelionEpoch(rows);
  if (t_peri_s !== null) {
    segments.forEach((seg, sIdx) => {
      if (seg.type !== 'flyby') return;
      if (!isAsteroidOrComet(seg.bodyId)) return;
      if (!seg.scienceFlyby) return; // not scoring science

      const t_fb_s = seg.time_yr * YEAR_S;
      if (t_fb_s + 1e-5 < t_peri_s) {
        updateCheck('science', 'fail', `Asteroid/comet science flyby of body ${seg.bodyId} occurs before first perihelion passage (t_fb = ${(t_fb_s / YEAR_S).toFixed(3)} yr, t_peri = ${(t_peri_s / YEAR_S).toFixed(3)} yr).`);
      }
    });
  }

  return { checks, errors };
}
