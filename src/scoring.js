/**
 * GTOC13 Trajectory Scoring Module
 *
 * Implements the exact mathematical scoring formulas from documentation/scoring.py
 * to calculate the mission score J dynamically.
 */

export const PLANET_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const YANDI_ID = 1000;
export const ASTEROID_MIN = 1001, ASTEROID_MAX = 1257;
export const COMET_MIN = 2001, COMET_MAX = 2042;

// Body scientific weights (Problem Statement Table 1 / Table 2 in Spec)
export const WEIGHTS = {
  1: 0.1,   // Vulcan
  2: 1.0,   // Yavin
  3: 2.0,   // Eden
  4: 3.0,   // Hoth
  1000: 5.0, // Yandi
  5: 7.0,   // Beyonce
  6: 10.0,  // Bespin
  7: 15.0,  // Jotunn
  8: 20.0,  // Wakonyingo
  9: 35.0,  // Rogue1
  10: 50.0  // PlanetX
};

/**
 * Returns the scientific weight of a body based on its ID.
 */
export function getBodyWeight(k) {
  if (k in WEIGHTS) {
    return WEIGHTS[k];
  }
  if (k >= ASTEROID_MIN && k <= ASTEROID_MAX) {
    return 1.0;
  }
  if (k >= COMET_MIN && k <= COMET_MAX) {
    return 3.0;
  }
  return 0.0;
}

/**
 * Calculates the flyby-velocity penalty term F_vinf.
 * V is the hyperbolic excess velocity magnitude in km/s.
 */
export function F_vinf(V) {
  return 0.2 + Math.exp(-V / 13.0) / (1.0 + Math.exp(-5.0 * (V - 1.5)));
}

/**
 * Calculates the time bonus c.
 * t_days is the days since the competition start.
 */
export function timeBonusC(t_days) {
  if (t_days <= 7.0) {
    return 1.13;
  }
  return -0.005 * t_days + 1.165;
}

/**
 * Estimates the first perihelion epoch (in seconds) from the sequence of rows.
 */
export function estimateFirstPerihelionEpoch(rows) {
  if (!rows || rows.length === 0) return null;
  const rByT = {};
  for (const row of rows) {
    const rmag = Math.sqrt(row.x_km * row.x_km + row.y_km * row.y_km + row.z_km * row.z_km);
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

/**
 * Computes seasonal S terms for each flyby of a given body chronologically.
 */
export function seasonalSForBody(flybysOfBody) {
  const Svals = [];
  const r_hats = flybysOfBody.map(fb => fb.rhat);
  for (let i = 0; i < r_hats.length; i++) {
    if (i === 0) {
      Svals.push(1.0);
      continue;
    }
    let sum_exp = 0.0;
    const ri = r_hats[i];
    for (let j = 0; j < i; j++) {
      const rj = r_hats[j];
      let dot = ri[0] * rj[0] + ri[1] * rj[1] + ri[2] * rj[2];
      dot = Math.max(-1.0, Math.min(1.0, dot));
      const theta_deg = Math.acos(dot) * 180.0 / Math.PI;
      sum_exp += Math.exp(- (theta_deg * theta_deg) / 50.0);
    }
    const S = 0.1 + 0.9 / (1.0 + 10.0 * sum_exp);
    Svals.push(S);
  }
  return Svals;
}

/**
 * Groups and extracts science flybys (flag=1) from parsed rows.
 */
export function extractScienceFlybys(rows, eps_t = 1e-3) {
  const flybysFlat = [];
  let i = 0;
  const n = rows.length;
  while (i < n) {
    const row = rows[i];
    if (row.bodyId <= 0) {
      i += 1;
      continue;
    }
    let rowOut = null;
    if (i + 1 < n) {
      const nxt = rows[i + 1];
      if (nxt.bodyId === row.bodyId && nxt.flag === row.flag && Math.abs(nxt.epoch_s - row.epoch_s) <= eps_t) {
        rowOut = nxt;
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
    if (row.flag !== 1) {
      continue;
    }
    
    const rx = row.x_km;
    const ry = row.y_km;
    const rz = row.z_km;
    const rnorm = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rnorm === 0.0) {
      continue;
    }
    const rhat = [rx / rnorm, ry / rnorm, rz / rnorm];
    const vinf = Math.sqrt(row.c1 * row.c1 + row.c2 * row.c2 + row.c3 * row.c3);
    
    flybysFlat.push({
      bodyId: row.bodyId,
      epoch_s: row.epoch_s,
      time_yr: row.time_yr,
      rhat: rhat,
      vinf: vinf
    });
  }
  
  // Group per body id, keep chronological and cap at 13
  flybysFlat.sort((a, b) => {
    if (a.bodyId !== b.bodyId) return a.bodyId - b.bodyId;
    return a.epoch_s - b.epoch_s;
  });
  
  const flybysByBody = {};
  for (const fb of flybysFlat) {
    if (!flybysByBody[fb.bodyId]) {
      flybysByBody[fb.bodyId] = [];
    }
    if (flybysByBody[fb.bodyId].length < 13) {
      flybysByBody[fb.bodyId].push(fb);
    }
  }
  return flybysByBody;
}

/**
 * Filter asteroid/comet flybys that happen before the first perihelion passage.
 */
export function filterForPerihelion(fb_dict, t_peri) {
  if (t_peri === null || t_peri === undefined) {
    return fb_dict;
  }
  const out = {};
  for (const k in fb_dict) {
    const id = Number(k);
    const lst = fb_dict[k];
    let filt;
    if ((id >= ASTEROID_MIN && id <= ASTEROID_MAX) || (id >= COMET_MIN && id <= COMET_MAX)) {
      filt = lst.filter(fb => fb.epoch_s >= t_peri);
    } else {
      filt = [...lst];
    }
    if (filt.length > 0) {
      out[k] = filt.slice(0, 13);
    }
  }
  return out;
}

/**
 * Computes the grand tour bonus multiplier (1.2 if criteria met, else 1.0).
 */
export function getGrandTourBonus(countedFlybys) {
  const planetsOk = PLANET_IDS.every(bid => countedFlybys[bid] && countedFlybys[bid].length > 0);
  const yandiOk = countedFlybys[YANDI_ID] && countedFlybys[YANDI_ID].length > 0;
  
  let acCount = 0;
  for (const bid in countedFlybys) {
    const id = Number(bid);
    if ((id >= ASTEROID_MIN && id <= ASTEROID_MAX) || (id >= COMET_MIN && id <= COMET_MAX)) {
      if (countedFlybys[bid].length > 0) {
        acCount++;
      }
    }
  }
  return (planetsOk && yandiOk && acCount >= 13) ? 1.2 : 1.0;
}

/**
 * Pre-computes the entire scoring structure for the loaded mission.
 */
export function computeMissionScoring(mission, t_days = 0) {
  const rows = mission.rows || [];
  const rawFlybyDict = extractScienceFlybys(rows);
  const t_peri = estimateFirstPerihelionEpoch(rows);
  
  // Apply perihelion rule
  const fbDict = filterForPerihelion(rawFlybyDict, t_peri);
  
  // Extract and calculate details for all scorable flyby events
  const scorableEvents = [];
  for (const bid in fbDict) {
    const fbs = fbDict[bid];
    const Svals = seasonalSForBody(fbs);
    const w = getBodyWeight(Number(bid));
    
    for (let i = 0; i < fbs.length; i++) {
      const fb = fbs[i];
      const S = Svals[i];
      const F = F_vinf(fb.vinf);
      const contribution = w * S * F;
      
      scorableEvents.push({
        bodyId: fb.bodyId,
        epoch_s: fb.epoch_s,
        time_yr: fb.time_yr,
        rhat: fb.rhat,
        vinf: fb.vinf,
        weight: w,
        S: S,
        F: F,
        contribution: contribution
      });
    }
  }
  
  // Sort scorable events chronologically
  scorableEvents.sort((a, b) => a.epoch_s - b.epoch_s);
  
  // Accumulate raw score steps
  let acc = 0;
  for (const ev of scorableEvents) {
    acc += ev.contribution;
    ev.accumulatedScore = acc;
  }
  
  const totalRawScore = acc;
  const b = getGrandTourBonus(fbDict);
  const c = timeBonusC(t_days);
  const J = b * c * totalRawScore;
  
  return {
    t_peri,
    scorableEvents,
    totalRawScore,
    b,
    c,
    J
  };
}

/**
 * Computes the score and checklist details at a specific simulation time.
 */
export function getScoreAtTime(scoringData, t_yr) {
  if (!scoringData) {
    return { J_t: 0, raw_t: 0, b_t: 1.0, visitedCount: 0, visitedChecklist: {} };
  }
  
  const { scorableEvents, c } = scoringData;
  
  // Find all events that have occurred up to t_yr
  const occurredEvents = scorableEvents.filter(ev => ev.time_yr <= t_yr);
  
  // Calculate raw score at time t
  let raw_t = 0;
  if (occurredEvents.length > 0) {
    raw_t = occurredEvents[occurredEvents.length - 1].accumulatedScore;
  }
  
  // Group occurred events by bodyId to check Grand Tour eligibility
  const flybysByBody_t = {};
  for (const ev of occurredEvents) {
    if (!flybysByBody_t[ev.bodyId]) {
      flybysByBody_t[ev.bodyId] = [];
    }
    flybysByBody_t[ev.bodyId].push(ev);
  }
  
  // Check checklist details
  const visitedChecklist = {};
  PLANET_IDS.forEach(bid => {
    visitedChecklist[bid] = (flybysByBody_t[bid] && flybysByBody_t[bid].length > 0) || false;
  });
  visitedChecklist[YANDI_ID] = (flybysByBody_t[YANDI_ID] && flybysByBody_t[YANDI_ID].length > 0) || false;
  
  let minorCount = 0;
  for (const bid in flybysByBody_t) {
    const id = Number(bid);
    if ((id >= ASTEROID_MIN && id <= ASTEROID_MAX) || (id >= COMET_MIN && id <= COMET_MAX)) {
      minorCount++;
    }
  }
  visitedChecklist.minorCount = minorCount;
  
  const b_t = getGrandTourBonus(flybysByBody_t);
  const J_t = b_t * c * raw_t;
  
  return {
    J_t,
    raw_t,
    b_t,
    visitedChecklist
  };
}
