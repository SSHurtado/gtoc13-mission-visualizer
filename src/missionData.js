/**
 * GTOC13 Mission Submission Parser
 *
 * Parses a GTOC13 submission file into a structured mission object and runs
 * the solution checker (validator.js), which follows the GTOC13 Problem
 * Statement and the Solution File Format Specification.
 */

import { AU_KM, YEAR_S, MU } from './systemData.js';
import { keplerPropagate } from './orbital.js';
import { validateMission, printUnit } from './validator.js';

const KM_TO_AU = 1 / AU_KM;
const S_TO_YR  = 1 / YEAR_S;
const KMS_TO_AUYR = YEAR_S / AU_KM;

// ─── Row parsing ──────────────────────────────────────────────────────────────

// Returns { row } or { error }. Fields may be separated by commas and/or
// whitespace (format Sec. 2.1); body_id and flag are cast to integers.
function parseRow(line) {
  const tokens = line.trim().split(/[\s,]+/).filter(s => s.length > 0);
  if (tokens.length < 12) return { error: `expected 12 fields, found ${tokens.length}` };
  const parts = tokens.slice(0, 12).map(Number);
  const bad = parts.findIndex(x => !Number.isFinite(x));
  if (bad >= 0) return { error: `field ${bad + 1} ("${tokens[bad]}") is not a finite number` };
  return {
    row: {
      bodyId: Math.trunc(parts[0]),
      flag:   Math.trunc(parts[1]),
      epoch_s: parts[2],
      x_km: parts[3], y_km: parts[4], z_km: parts[5],
      vx_kms: parts[6], vy_kms: parts[7], vz_kms: parts[8],
      c1: parts[9], c2: parts[10], c3: parts[11],
      units: tokens.slice(0, 12).map(printUnit),   // printed precision, for continuity checks
    },
    error: tokens.length > 12 ? `expected 12 fields, found ${tokens.length}` : null,
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

// options.sailTruth: 'sync' (default) runs every check here; 'defer' leaves the
// sail truth stage to the caller (see mission.sailTruthJob and sailTruthWorker.js).
export function parseMission(text, options = {}) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const badLines = [];

  lines.forEach((line, k) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return;
    const { row, error } = parseRow(trimmed);
    if (error) badLines.push({ line: k + 1, reason: error });
    if (row) rows.push(rowToAU({ ...row, line: k + 1 }));
  });

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

  // Check the trajectory against the GTOC13 rules (validator.js)
  const validation = validateMission(rows, badLines, options);

  return {
    segments,
    flybys,
    timeRange,
    rowCount: rows.length,
    validationChecks: validation.checks,
    validationErrors: validation.errors,
    firstPerihelion_s: validation.firstPerihelion_s,
    closeApproaches: validation.closeApproaches,
    sailTruthJob: validation.sailTruthJob,
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
