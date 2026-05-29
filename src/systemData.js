/**
 * Altaira System — GTOC13 Trajectory Visualizer
 * Orbital data from the GTOC13 problem statement.
 *
 * Coordinate system: right-handed, star-centered Cartesian.
 * Ecliptic plane defined by Vulcan's orbital plane.
 * Units: AU for display, internal propagation in AU/yr.
 *
 * Gravitational parameter: μ = 1.32712440018e11 km³/s²
 * AU = 1.495978707e8 km
 * Year = 365.25 days = 31557600 s
 */

// ─── System Constants ────────────────────────────────────────────────────────
export const MU_KM3_S2 = 139348062043.343;   // km³/s²  (Altaira star gravity, G1v)
export const AU_KM      = 149597870.691;      // km / AU
export const YEAR_S     = 31557600;           // seconds / Julian year
export const DEG        = Math.PI / 180;

// μ in AU³/yr²
export const MU = MU_KM3_S2 * (YEAR_S * YEAR_S) / (AU_KM * AU_KM * AU_KM);

const kmToAu = (km) => km / AU_KM;

// ─── Planet Data ─────────────────────────────────────────────────────────────
// Keplerian elements at epoch J2000 (t0 = 0)
// a [AU], e [-], i [deg], RAAN [deg], omega [deg], M0 [deg]
// Physical: radius [km], mu_planet [km³/s²]
// Visual: color [hex], size scale, scientific weight
//
// Source: GTOC13 problem statement / public data files.
// Values from documentation/gtoc13_planets.csv; semi-major axes are converted
// from km to AU at module load.
//
// Size is proportional to physical radius, normalized to Vulcan.
// Vulcan (133020.7 km) is the reference body with VULCAN_BASE_SIZE.
const VULCAN_RADIUS_KM = 133020.7;
const VULCAN_BASE_SIZE = 0.030;
const MIN_PLANET_SIZE  = 0.0012;  // minimum for visibility/interactivity
const sizeFromRadius = (radiusKm) =>
  radiusKm > 0
    ? Math.max((radiusKm / VULCAN_RADIUS_KM) * VULCAN_BASE_SIZE, MIN_PLANET_SIZE)
    : MIN_PLANET_SIZE;

export const PLANETS = [
  {
    id: 1, name: 'Vulcan', classification: 'Hot Jupiter',
    desc: 'Very close orbit; its plane defines the system ecliptic. Key gravity assist for orbital energy reduction.',
    weight: 0.1,
    a: kmToAu(13811982.942), e: 0.000, i: 0.000, raan: 0.000, omega: 315.372, M0: 322.584,
    radius: 133020.700, mu: 658906373.320,
    color: 0xff6b35, glowColor: 0xff8c5a, size: sizeFromRadius(133020.700),
    retrograde: false,
  },
  {
    id: 2, name: 'Yavin', classification: 'Terrestrial',
    desc: 'Located near the inner edge of the habitable zone. Useful for gravity assists toward inner system.',
    weight: 1.0,
    a: kmToAu(128528229.968), e: 0.050, i: 3.000, raan: 110.499, omega: 148.135, M0: 155.310,
    radius: 18013.200, mu: 6363037.484,
    color: 0xffb347, glowColor: 0xffd080, size: sizeFromRadius(18013.200),
    retrograde: false,
  },
  {
    id: 3, name: 'Eden', classification: 'Earth-analog',
    desc: 'Earth-sized planet near the middle of the habitable zone. Prime scientific target.',
    weight: 2.0,
    a: kmToAu(179517444.840), e: 0.007, i: 1.000, raan: 107.472, omega: 356.208, M0: 51.897,
    radius: 6697.400, mu: 443853.559,
    color: 0x4fc3f7, glowColor: 0x7ee8fa, size: sizeFromRadius(6697.400),
    retrograde: false,
  },
  {
    id: 4, name: 'Hoth', classification: 'Venus-analog',
    desc: 'Highly inclined Venus-sized planet. Orbits below the main asteroid belt, enabling out-of-plane transfers.',
    weight: 3.0,
    a: kmToAu(439627001.911), e: 0.050, i: 12.000, raan: 95.497, omega: 18.923, M0: 121.720,
    radius: 5498.800, mu: 284441.708,
    color: 0xb0c4de, glowColor: 0xd0e8ff, size: sizeFromRadius(5498.800),
    retrograde: false,
  },
  {
    id: 1000, name: 'Yandi', classification: 'Dwarf Planet',
    desc: 'Dwarf planet embedded in the main asteroid belt. Massless — no gravitational influence on spacecraft.',
    weight: 5.0,
    a: kmToAu(596325410.852), e: 0.077, i: 10.591, raan: 80.301, omega: 73.809, M0: 154.607,
    radius: 0.000, mu: 0.000,
    color: 0xccaa77, glowColor: 0xddcc99, size: sizeFromRadius(0),
    retrograde: false,
  },
  {
    id: 5, name: 'Beyoncé', classification: 'Saturn-analog',
    desc: 'Ringed Saturn-sized planet. Its orbital resonances sculpt the main asteroid belt.',
    weight: 7.0,
    a: kmToAu(1119105767.218), e: 0.070, i: 0.000, raan: 220.319, omega: 116.863, M0: 64.820,
    radius: 63476.200, mu: 49322760.294,
    color: 0xf4d03f, glowColor: 0xf8e87f, size: sizeFromRadius(63476.200),
    retrograde: false, hasRings: true,
  },
  {
    id: 6, name: 'Bespin', classification: 'Super-Jovian',
    desc: 'A massive super-Jovian gas giant. The most powerful gravity-assist body in the system.',
    weight: 10.0,
    a: kmToAu(2138564173.385), e: 0.119, i: 0.400, raan: 173.526, omega: 333.322, M0: 310.972,
    radius: 63661.400, mu: 120377125.895,
    color: 0xe8c49c, glowColor: 0xf5dfc0, size: sizeFromRadius(63661.400),
    retrograde: false,
  },
  {
    id: 7, name: 'Jotunn', classification: 'Ice Giant',
    desc: 'Ice giant dynamically similar to Neptune/Uranus. Deep gravity wells enable massive velocity rotations.',
    weight: 15.0,
    a: kmToAu(2622318885.763), e: 0.150, i: 5.000, raan: 209.170, omega: 16.367, M0: 199.109,
    radius: 23865.300, mu: 6341816.256,
    color: 0x7fceeb, glowColor: 0xa0e4ff, size: sizeFromRadius(23865.300),
    retrograde: false,
  },
  {
    id: 8, name: 'Wakonyingo', classification: 'Super-Earth Core',
    desc: 'Ice giant stripped of its atmosphere, leaving a dense super-Earth core. Unusual gravity-assist geometry.',
    weight: 20.0,
    a: kmToAu(5115499188.587), e: 0.095, i: 15.000, raan: 33.723, omega: 107.462, M0: 158.153,
    radius: 13531.400, mu: 6598433.391,
    color: 0x9b8ea0, glowColor: 0xc0b0cc, size: sizeFromRadius(13531.400),
    retrograde: false,
  },
  {
    id: 9, name: 'Rogue1', classification: 'Retrograde Jovian',
    desc: 'Captured Jovian exoplanet in a retrograde orbit. In 2:1 mean-motion resonance with PlanetX. Very high scientific value.',
    weight: 35.0,
    a: kmToAu(10048973262.572), e: 0.100, i: 175.000, raan: 161.693, omega: 318.000, M0: 280.461,
    radius: 109471.200, mu: 66346648.135,
    color: 0xff4da6, glowColor: 0xff80c8, size: sizeFromRadius(109471.200),
    retrograde: true,
  },
  {
    id: 10, name: 'PlanetX', classification: 'Eccentric & Inclined',
    desc: 'Highly eccentric, highly inclined planet. In 1:2 resonance with Rogue1. The highest scientific value target.',
    weight: 50.0,
    a: kmToAu(15955016885.357), e: 0.345, i: 40.000, raan: 341.693, omega: 30.000, M0: 133.427,
    radius: 12993.800, mu: 3411912.397,
    color: 0xc084fc, glowColor: 0xd8a8ff, size: sizeFromRadius(12993.800),
    retrograde: false,
  },
];

// ─── Asteroid Belt ────────────────────────────────────────────────────────────
// 257 asteroids between Hoth and Beyoncé, centered around Yandi.
// We generate procedurally using a seeded distribution matching the belt.
export function generateAsteroidBelt(count = 257) {
  const belt = [];
  // Simple LCG for reproducible pseudo-random
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };

  for (let i = 0; i < count; i++) {
    // Kirkwood gap avoidance: skip prominent interior resonances with Beyoncé.
    let a;
    do {
      a = 3.1 + rand() * 3.4; // 3.1–6.5 AU
    } while (
      (a > 3.55 && a < 3.63) || // 3:1 resonance
      (a > 4.02 && a < 4.10) || // 5:2 resonance
      (a > 4.22 && a < 4.30) || // 7:3 resonance
      (a > 4.66 && a < 4.76)    // 2:1 resonance
    );

    belt.push({
      a,
      e: rand() * 0.25,
      i: (rand() - 0.5) * 20, // ±10° inclination
      raan: rand() * 360,
      omega: rand() * 360,
      M0: rand() * 360,
    });
  }
  return belt;
}

// ─── Comet Data ───────────────────────────────────────────────────────────────
// 42 comets with highly eccentric orbits traversing multiple planetary zones
export function generateComets(count = 42) {
  const comets = [];
  let seed = 137;
  const rand = () => { seed = (seed * 22695477 + 1) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };

  for (let i = 0; i < count; i++) {
    comets.push({
      a: 15 + rand() * 85,       // 15–100 AU semi-major axis
      e: 0.7 + rand() * 0.28,    // 0.70–0.98 eccentricity
      i: rand() * 160 - 20,      // random inclination
      raan: rand() * 360,
      omega: rand() * 360,
      M0: rand() * 360,
    });
  }
  return comets;
}
