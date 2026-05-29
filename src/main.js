/**
 * Altaira System — Main Visualizer Entry Point
 * Three.js scene setup, rendering loop, interaction, and UI.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { PLANETS, generateAsteroidBelt, generateComets } from './systemData.js';
import { keplerToCartesian, generateOrbitPath, orbitalPeriod } from './orbital.js';

import { parseMission, generateTrailPoints, getPositionAtTime, getTrailIndex } from './missionData.js';
import { computeMissionScoring, getScoreAtTime, F_vinf } from './scoring.js';

// ─── Scale factor: 1 AU → N scene units ──────────────────────────────────────
const AU_SCALE = 1.0;  // 1 scene unit = 1 AU
const STAR_VISUAL_RADIUS = 0.18; // Visual star radius (not physical)
const MAX_OUTER_AU = 200;
const ASTEROID_LIGHT_LAYER = 1;

// ─── Scene Setup ─────────────────────────────────────────────────────────────
const container = document.getElementById('canvas-container');
const W = window.innerWidth, H = window.innerHeight;

// Renderer
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,  // essential for huge scale range
});
renderer.setSize(W, H);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000008);

// Camera
const camera = new THREE.PerspectiveCamera(50, W / H, 0.001, 5000);
camera.position.set(0, 95, 185);
camera.lookAt(0, 0, 0);
camera.layers.enable(ASTEROID_LIGHT_LAYER);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.04;
controls.minDistance = 0.08;
controls.maxDistance = 500;
controls.zoomSpeed = 1.2;
controls.minPolarAngle = 0.15; // avoid gimbal lock look-at singularity at the top pole
controls.maxPolarAngle = Math.PI - 0.15; // avoid gimbal lock look-at singularity at the bottom pole

// ─── Post-Processing ─────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(W, H),
  0.9,   // strength
  0.5,   // radius
  0.75   // threshold
);
composer.addPass(bloomPass);

// ─── Lighting ─────────────────────────────────────────────────────────────────
// Central star point light (Altaira)
const starLight = new THREE.PointLight(0xfff2e0, 5.2, 1400, 0.9);
starLight.position.set(0, 0, 0);
scene.add(starLight);

// Ambient for deep space visibility
const ambientLight = new THREE.AmbientLight(0x111830, 0.34);
scene.add(ambientLight);

const eclipticFillLight = new THREE.HemisphereLight(0xbfd8ff, 0x090713, 0.18);
eclipticFillLight.position.set(0, 1, 0);
scene.add(eclipticFillLight);

const asteroidKeyLight = new THREE.PointLight(0xffedd2, 1.6, 0, 0.55);
asteroidKeyLight.position.set(0, 0, 0);
asteroidKeyLight.layers.set(ASTEROID_LIGHT_LAYER);
scene.add(asteroidKeyLight);

// ─── Starfield ────────────────────────────────────────────────────────────────
function createStarfield(count = 6000) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 350 + Math.random() * 150;
    pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i*3+2] = r * Math.cos(phi);

    // Slightly varied star colors
    const t = Math.random();
    colors[i*3]   = 0.8 + t * 0.2;
    colors[i*3+1] = 0.85 + t * 0.15;
    colors[i*3+2] = 0.9 + t * 0.1;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.4,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  scene.add(new THREE.Points(geo, mat));
}
createStarfield();

// ─── Central Star (Altaira) ───────────────────────────────────────────────────
function createStar() {
  const group = new THREE.Group();

  // Core sphere
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff0cc });
  const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(STAR_VISUAL_RADIUS, 32, 32), coreMat);
  group.add(coreMesh);

  // Corona (additive glow sphere)
  const coronaMat = new THREE.MeshBasicMaterial({
    color: 0xffd580,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const corona = new THREE.Mesh(new THREE.SphereGeometry(STAR_VISUAL_RADIUS * 2.2, 32, 32), coronaMat);
  group.add(corona);

  const corona2 = corona.clone();
  corona2.scale.setScalar(1.8);
  corona2.material.opacity = 0.08;
  group.add(corona2);

  // Lens flare cross sprite (canvas texture)
  const flareCanvas = document.createElement('canvas');
  flareCanvas.width = flareCanvas.height = 128;
  const ctx = flareCanvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,240,200,0.9)');
  grad.addColorStop(0.3, 'rgba(255,200,100,0.5)');
  grad.addColorStop(1,   'rgba(255,150,50,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  const flareTex = new THREE.CanvasTexture(flareCanvas);
  const flareSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flareTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.7,
  }));
  flareSprite.scale.set(2.5, 2.5, 1);
  group.add(flareSprite);

  scene.add(group);
  return group;
}
const starGroup = createStar();

// ─── Ecliptic Grid ────────────────────────────────────────────────────────────
function createEclipticGrid() {
  const group = new THREE.Group();

  // Concentric rings at AU distances
  const auMarks = [1, 5, 10, 20, 50, 100, 150, MAX_OUTER_AU];
  auMarks.forEach(au => {
    const curve = new THREE.EllipseCurve(0, 0, au, au, 0, Math.PI * 2, false, 0);
    const pts = curve.getPoints(128);
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, 0, p.y)));
    const mat = new THREE.LineBasicMaterial({
      color: 0x1a2a4a,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    group.add(new THREE.LineLoop(geo, mat));
  });

  // Radial spokes
  for (let k = 0; k < 12; k++) {
    const angle = (k / 12) * Math.PI * 2;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(Math.cos(angle) * MAX_OUTER_AU, 0, Math.sin(angle) * MAX_OUTER_AU),
    ]);
    group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x1a2a4a, transparent: true, opacity: 0.15, depthWrite: false
    })));
  }

  scene.add(group);
  return group;
}
const eclipticGrid = createEclipticGrid();

// ─── Orbit Paths ──────────────────────────────────────────────────────────────
const orbitLines = [];

function createOrbitLine(positions, color, opacity = 0.5, dashed = false) {
  const geo = new THREE.BufferGeometry();
  // Convert [x,y,z] from AU → Three.js: we use x=x, y=z, z=y to align ecliptic with XZ plane
  const pts = new Float32Array(positions.length);
  for (let i = 0; i < positions.length / 3; i++) {
    pts[i*3]   = positions[i*3];
    pts[i*3+1] = positions[i*3+2]; // ecliptic Z → Three.js Y
    pts[i*3+2] = positions[i*3+1]; // ecliptic Y → Three.js Z (right-hand)
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));

  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // Close the loop
  const indices = [];
  const n = positions.length / 3;
  for (let i = 0; i < n - 1; i++) indices.push(i, i + 1);
  indices.push(n - 1, 0);
  geo.setIndex(indices);

  const line = new THREE.LineSegments(geo, mat);
  scene.add(line);
  return line;
}

// ─── Planet Spheres ───────────────────────────────────────────────────────────
const planetMeshes = [];
const planetRootMeshes = [];
const planetLabels = [];

// Convert ecliptic [x,y,z] → Three.js position
function toThreeJS(x, y, z) {
  return new THREE.Vector3(x, z, y);
}

// Canvas texture for planet label
function makeLabelSprite(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 384; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(3, 8, 24, 0.64)';
  roundRect(ctx, 4, 18, canvas.width - 8, 52, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(125, 190, 255, 0.26)';
  ctx.lineWidth = 2;
  roundRect(ctx, 4, 18, canvas.width - 8, 52, 14);
  ctx.stroke();
  ctx.font = 'bold 30px Inter, sans-serif';
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 8;
  ctx.fillText(name, 20, 54, canvas.width - 40);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: false,
  }));
  sprite.scale.set(0.082, 0.0205, 1);
  sprite.userData.baseScale = sprite.scale.clone();
  sprite.center.set(0.5, 0);
  return sprite;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Glow sprite for planets
function makePlanetGlow(color, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');

  const r = (color >> 16) & 0xff;
  const g = (color >> 8)  & 0xff;
  const b =  color        & 0xff;

  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0,   `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(0.3, `rgba(${r},${g},${b},0.3)`);
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  }));
  sprite.scale.set(scale * 8, scale * 8, 1);
  return sprite;
}

// Saturn-style ring geometry
function createRings(innerR, outerR, color) {
  const geo = new THREE.RingGeometry(innerR, outerR, 64);
  // Fix UV for ring
  const pos = geo.attributes.position;
  const uv  = geo.attributes.uv;
  const v3  = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v3.fromBufferAttribute(pos, i);
    uv.setXY(i, v3.length() / outerR, 0.5);
  }
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: makeRingTexture(color),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2.4;
  return mesh;
}

function cssHex(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function textureFromCanvas(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function drawBands(ctx, width, height, palette, rand, options = {}) {
  const minBand = options.minBand ?? 10;
  const maxBand = options.maxBand ?? 32;
  const wave = options.wave ?? 8;
  let y = -maxBand;

  while (y < height + maxBand) {
    const bandH = minBand + rand() * (maxBand - minBand);
    const color = palette[Math.floor(rand() * palette.length)];
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.75 + rand() * 0.25;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= width; x += 18) {
      const offset = Math.sin(x * 0.025 + rand() * Math.PI * 2) * wave;
      ctx.lineTo(x, y + offset);
    }
    ctx.lineTo(width, y + bandH);
    ctx.lineTo(0, y + bandH);
    ctx.closePath();
    ctx.fill();
    y += bandH * (0.75 + rand() * 0.65);
  }
  ctx.globalAlpha = 1;
}

function drawSpeckles(ctx, width, height, rand, count, colors, maxRadius = 2.5) {
  for (let i = 0; i < count; i++) {
    const r = rand() * maxRadius + 0.3;
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    ctx.globalAlpha = 0.22 + rand() * 0.38;
    ctx.beginPath();
    ctx.arc(rand() * width, rand() * height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawContinents(ctx, width, height, rand, count, color) {
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.82;
  for (let n = 0; n < count; n++) {
    const cx = rand() * width;
    const cy = height * (0.25 + rand() * 0.5);
    const rx = 18 + rand() * 58;
    const ry = 8 + rand() * 28;
    ctx.beginPath();
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      const jitter = 0.55 + rand() * 0.65;
      const x = cx + Math.cos(a) * rx * jitter;
      const y = cy + Math.sin(a) * ry * jitter;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawStorm(ctx, x, y, rx, ry, color) {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, rx);
  grad.addColorStop(0, color);
  grad.addColorStop(0.45, 'rgba(255,255,255,0.32)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, -0.18, 0, Math.PI * 2);
  ctx.fill();
}

function makeSurfaceTexture(pd) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const rand = seededRandom(pd.id * 973 + 17);
  const w = canvas.width;
  const h = canvas.height;

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  if (pd.id === 3) {
    bg.addColorStop(0, '#1a4f8f');
    bg.addColorStop(0.5, '#1c78b7');
    bg.addColorStop(1, '#0d2d66');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    drawContinents(ctx, w, h, rand, 8, '#2f7a42');
    drawSpeckles(ctx, w, h, rand, 220, ['#f4f7ff', '#d6f3ff'], 1.8);
  } else if (pd.id === 2) {
    bg.addColorStop(0, '#a95f2d');
    bg.addColorStop(0.55, '#d69c57');
    bg.addColorStop(1, '#6c3924');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    drawContinents(ctx, w, h, rand, 7, '#4d8a6a');
    drawSpeckles(ctx, w, h, rand, 180, ['#f3d59b', '#5a392b', '#c47f42'], 2.2);
  } else if (pd.id === 4) {
    bg.addColorStop(0, '#e8f2ff');
    bg.addColorStop(0.5, '#b7c9df');
    bg.addColorStop(1, '#788da8');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    drawBands(ctx, w, h, ['#f5f9ff', '#c9d8e8', '#97acc6'], rand, { minBand: 9, maxBand: 22, wave: 5 });
  } else if (pd.id === 1000) {
    ctx.fillStyle = '#6f5841';
    ctx.fillRect(0, 0, w, h);
    drawSpeckles(ctx, w, h, rand, 430, ['#c4a06f', '#3f342a', '#8a7357'], 3.8);
  } else if (pd.id === 8) {
    ctx.fillStyle = '#6a6270';
    ctx.fillRect(0, 0, w, h);
    drawSpeckles(ctx, w, h, rand, 360, ['#c4b6ce', '#3c3445', '#998aa4'], 3.0);
    drawBands(ctx, w, h, ['rgba(210,190,230,0.24)', 'rgba(80,70,96,0.26)'], rand, { minBand: 4, maxBand: 11, wave: 12 });
  } else if (pd.id === 10) {
    bg.addColorStop(0, '#24123b');
    bg.addColorStop(0.5, '#7653ae');
    bg.addColorStop(1, '#15091f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    drawSpeckles(ctx, w, h, rand, 260, ['#d8c8ff', '#8a6acc', '#2c184a'], 2.5);
    drawBands(ctx, w, h, ['rgba(215,180,255,0.26)', 'rgba(77,43,123,0.34)'], rand, { minBand: 8, maxBand: 18, wave: 10 });
  } else {
    const palettes = {
      1: ['#4a1207', '#a42d12', '#f36f21', '#ffd07a'],
      5: ['#6f5528', '#b89445', '#f4d06f', '#fff1a8'],
      6: ['#5b3420', '#a36e45', '#dca878', '#f5dfbf'],
      7: ['#206b8a', '#55b6d4', '#8adff0', '#d9fbff'],
      9: ['#2b0b25', '#7c1d64', '#ff4da6', '#ffaad8'],
    };
    const palette = palettes[pd.id] ?? [cssHex(pd.color), cssHex(pd.glowColor)];
    ctx.fillStyle = palette[0];
    ctx.fillRect(0, 0, w, h);
    drawBands(ctx, w, h, palette, rand, { minBand: 8, maxBand: 28, wave: pd.id === 7 ? 3 : 11 });
    if (pd.id === 1) drawStorm(ctx, w * 0.66, h * 0.57, 58, 18, 'rgba(255,210,150,0.82)');
    if (pd.id === 6) drawStorm(ctx, w * 0.58, h * 0.46, 72, 22, 'rgba(140,54,36,0.78)');
    if (pd.id === 9) drawStorm(ctx, w * 0.36, h * 0.53, 64, 18, 'rgba(255,170,220,0.72)');
  }

  return textureFromCanvas(canvas);
}

function makeCloudTexture(pd) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const rand = seededRandom(pd.id * 1733 + 91);
  const colors = pd.id === 4
    ? ['rgba(255,255,255,0.38)', 'rgba(210,228,255,0.25)']
    : ['rgba(255,255,255,0.34)', 'rgba(220,245,255,0.22)'];

  drawBands(ctx, canvas.width, canvas.height, colors, rand, { minBand: 7, maxBand: 20, wave: 18 });
  drawSpeckles(ctx, canvas.width, canvas.height, rand, 150, colors, 5.5);
  return textureFromCanvas(canvas);
}

function createPlanetMaterial(pd) {
  const gasGiant = [1, 5, 6, 7, 9].includes(pd.id);
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: makeSurfaceTexture(pd),
    emissive: pd.color,
    emissiveIntensity: gasGiant ? 0.12 : 0.07,
    roughness: gasGiant ? 0.72 : 0.88,
    metalness: 0.02,
  });
}

function createAtmosphere(pd, radius) {
  if (pd.id === 1000) return null;

  const atmosphereIds = new Set([2, 3, 4, 7, 8, 10]);
  const opacity = atmosphereIds.has(pd.id) ? 0.14 : 0.075;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.12, 32, 24),
    new THREE.MeshBasicMaterial({
      color: pd.glowColor,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  mesh.userData.baseOpacity = opacity;
  return mesh;
}

function createCloudLayer(pd, radius) {
  if (![2, 3, 4].includes(pd.id)) return null;

  const opacity = pd.id === 3 ? 0.36 : 0.24;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.035, 32, 20),
    new THREE.MeshBasicMaterial({
      map: makeCloudTexture(pd),
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
  mesh.userData.baseOpacity = opacity;
  return mesh;
}

function makeRingTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  const base = new THREE.Color(color);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let x = 0; x < canvas.width; x++) {
    const u = x / canvas.width;
    const band = 0.35 + 0.65 * Math.sin(u * Math.PI * 18) ** 2;
    const gap = Math.sin(u * Math.PI * 7) > 0.82 ? 0.18 : 1;
    ctx.fillStyle = `rgba(${Math.round(base.r * 255)},${Math.round(base.g * 255)},${Math.round(base.b * 255)},${0.18 + band * gap * 0.55})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }

  return textureFromCanvas(canvas);
}

// ─── Build All Planets ────────────────────────────────────────────────────────
PLANETS.forEach((pd, idx) => {
  // Orbit path
  const nPts = pd.e > 0.25 ? 512 : 256;
  const orbitPts = generateOrbitPath(pd, 0, nPts);
  const orbitColor = pd.retrograde ? 0xff4488 : pd.color;
  const orbitLine = createOrbitLine(orbitPts, orbitColor, pd.retrograde ? 0.45 : 0.35);
  orbitLines.push({ line: orbitLine, planet: pd });

  // Planet sphere
  const size = pd.size * AU_SCALE * 2.5;
  const geo = new THREE.SphereGeometry(size, 48, 32);

  const mat = createPlanetMaterial(pd);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.baseEmissiveIntensity = mat.emissiveIntensity;
  const visualExtras = [];

  // Glow sprite
  const glow = makePlanetGlow(pd.glowColor, pd.size * 2.5);
  mesh.add(glow);
  visualExtras.push(glow);

  const atmosphere = createAtmosphere(pd, size);
  if (atmosphere) {
    mesh.add(atmosphere);
    visualExtras.push(atmosphere);
  }

  const cloudLayer = createCloudLayer(pd, size);
  if (cloudLayer) {
    mesh.add(cloudLayer);
    visualExtras.push(cloudLayer);
  }

  // Rings for Beyoncé
  if (pd.hasRings) {
    const rings = createRings(size * 1.35, size * 2.55, pd.color);
    mesh.add(rings);
    visualExtras.push(rings);
  }

  scene.add(mesh);

  // Label sprite
  const label = makeLabelSprite(pd.name, pd.glowColor);
  label.userData.baseOffset = new THREE.Vector3(0, size * 2.5, 0);
  label.userData.smoothedPosition = new THREE.Vector3();
  scene.add(label);
  planetLabels.push(label);

  planetRootMeshes.push(mesh);
  planetMeshes.push({ mesh, planet: pd, label, visualRadius: size, visualExtras, cloudLayer });
});

// ─── Asteroid Belt ────────────────────────────────────────────────────────────
const asteroidData = generateAsteroidBelt(257);
const asteroidRand = seededRandom(9042);
const asteroidVisuals = asteroidData.map(() => ({
  phase: asteroidRand() * Math.PI * 2,
  spinX: 0.25 + asteroidRand() * 0.9,
  spinY: 0.25 + asteroidRand() * 1.1,
  spinZ: 0.15 + asteroidRand() * 0.8,
  sx: 0.55 + asteroidRand() * 0.85,
  sy: 0.45 + asteroidRand() * 0.7,
  sz: 0.60 + asteroidRand() * 0.95,
  scale: 0.55 + asteroidRand() * 1.15,
  color: new THREE.Color().setHSL(0.58 + asteroidRand() * 0.035, 0.045, 0.42 + asteroidRand() * 0.16),
}));
const asteroidDummy = new THREE.Object3D();
const asteroidMesh = createAsteroidField();

function createAsteroidField() {
  const geo = new THREE.DodecahedronGeometry(0.035, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.74,
    metalness: 0.0,
    emissive: 0x151a20,
    emissiveIntensity: 0.22,
    flatShading: true,
    vertexColors: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, asteroidData.length);
  mesh.layers.enable(ASTEROID_LIGHT_LAYER);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  asteroidVisuals.forEach((visual, i) => mesh.setColorAt(i, visual.color));
  mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

function updateAsteroidBelt(t = 0) {
  asteroidData.forEach((ast, i) => {
    const visual = asteroidVisuals[i];
    const pos = keplerToCartesian(ast, t);
    asteroidDummy.position.set(pos.x, pos.z, pos.y);
    asteroidDummy.rotation.set(
      visual.phase + t * visual.spinX,
      visual.phase * 0.7 + t * visual.spinY,
      visual.phase * 1.3 + t * visual.spinZ,
    );
    asteroidDummy.scale.set(
      visual.scale * visual.sx,
      visual.scale * visual.sy,
      visual.scale * visual.sz,
    );
    asteroidDummy.updateMatrix();
    asteroidMesh.setMatrixAt(i, asteroidDummy.matrix);
  });
  asteroidMesh.instanceMatrix.needsUpdate = true;
}
updateAsteroidBelt(0);

// ─── Comets ───────────────────────────────────────────────────────────────────
const cometData = generateComets(42);
const cometGroup = new THREE.Group();
scene.add(cometGroup);

function createCometOrbitLine(comet, index) {
  const samples = generateOrbitPath(comet, 0, 768);
  const points = [];
  for (let i = 0; i < samples.length / 3; i++) {
    points.push(new THREE.Vector3(
      samples[i * 3],
      samples[i * 3 + 2],
      samples[i * 3 + 1],
    ));
  }
  points.push(points[0].clone());

  const hue = 0.56 + (index % 7) * 0.012;
  const color = new THREE.Color().setHSL(hue, 0.9, 0.64);
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineDashedMaterial({
    color,
    dashSize: 2.6,
    gapSize: 1.7,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  cometGroup.add(line);
  return line;
}

const cometOrbitLines = cometData.map((comet, index) => createCometOrbitLine(comet, index));

function makeCometComaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(235, 252, 255, 0.95)');
  grad.addColorStop(0.25, 'rgba(140, 220, 255, 0.48)');
  grad.addColorStop(0.72, 'rgba(75, 160, 230, 0.12)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return textureFromCanvas(canvas);
}

function createCometVisual(index) {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.035 + (index % 4) * 0.006, 0),
    new THREE.MeshStandardMaterial({
      color: 0xd8f6ff,
      emissive: 0x72cfff,
      emissiveIntensity: 0.45,
      roughness: 0.8,
      flatShading: true,
    }),
  );
  const coma = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeCometComaTexture(),
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  coma.scale.setScalar(0.34 + (index % 5) * 0.035);
  group.add(core, coma);
  group.userData.core = core;
  group.userData.phase = index * 0.61;
  cometGroup.add(group);
  return group;
}

// Comet nuclei plus anti-star tails. The orbit lines stay faint and dashed so the
// highly eccentric comet population reads as trajectories rather than a solid box.
const cometVisuals = cometData.map((_, index) => createCometVisual(index));

const cometTailGeo = new THREE.BufferGeometry();
const cometTailPositions = new Float32Array(cometData.length * 2 * 3);
cometTailGeo.setAttribute('position', new THREE.BufferAttribute(cometTailPositions, 3));
const cometTailLines = new THREE.LineSegments(cometTailGeo, new THREE.LineBasicMaterial({
  color: 0xb8e8ff,
  transparent: true,
  opacity: 0.42,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}));
cometGroup.add(cometTailLines);

const cometHead = new THREE.Vector3();
const cometTail = new THREE.Vector3();

function updateComets(t) {
  cometData.forEach((c, i) => {
    const pos = keplerToCartesian(c, t);
    cometHead.set(pos.x, pos.z, pos.y);
    const visual = cometVisuals[i];
    visual.position.copy(cometHead);
    visual.userData.core.rotation.set(
      visual.userData.phase + t * 1.1,
      visual.userData.phase * 0.5 + t * 0.8,
      visual.userData.phase * 1.7 + t * 0.6,
    );

    const distance = Math.max(cometHead.length(), 0.35);
    const tailLength = THREE.MathUtils.clamp(2.4 / Math.sqrt(distance), 0.28, 1.8);
    cometTail.copy(cometHead).normalize().multiplyScalar(tailLength).add(cometHead);

    const j = i * 6;
    cometTailPositions[j] = cometHead.x;
    cometTailPositions[j + 1] = cometHead.y;
    cometTailPositions[j + 2] = cometHead.z;
    cometTailPositions[j + 3] = cometTail.x;
    cometTailPositions[j + 4] = cometTail.y;
    cometTailPositions[j + 5] = cometTail.z;
  });
  cometTailGeo.attributes.position.needsUpdate = true;
}
updateComets(0);

// ─── Boundary Plane (200 AU arrival boundary) ─────────────────────────────────
const boundaryGeo = new THREE.PlaneGeometry(40, 40);
const boundaryMat = new THREE.MeshBasicMaterial({
  color: 0x223355,
  transparent: true,
  opacity: 0.07,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const boundaryPlane = new THREE.Mesh(boundaryGeo, boundaryMat);
boundaryPlane.rotation.y = Math.PI / 2;
boundaryPlane.position.x = -200 * AU_SCALE;
scene.add(boundaryPlane);

// Boundary frame outline
const bfPts = [
  new THREE.Vector3(-200, -20, -20), new THREE.Vector3(-200, -20, 20),
  new THREE.Vector3(-200, 20, 20),   new THREE.Vector3(-200, 20, -20),
];
const bfGeo = new THREE.BufferGeometry().setFromPoints([...bfPts, bfPts[0]]);
scene.add(new THREE.Line(bfGeo, new THREE.LineBasicMaterial({ color: 0x3355aa, transparent: true, opacity: 0.3 })));

const boundaryLabel = makeLabelSprite('200 AU MISSION BOUNDARY', 0x8bbcff);
boundaryLabel.scale.set(0.15, 0.0375, 1);
boundaryLabel.userData.baseScale = boundaryLabel.scale.clone();
boundaryLabel.center.set(0, 0.5);
boundaryLabel.material.depthTest = false;
boundaryLabel.position.set(-172 * AU_SCALE, 0, 20);
boundaryLabel.renderOrder = 10;
scene.add(boundaryLabel);

// Exclusion spheres around Altaira
[{ r: 0.05, c: 0xffff00, o: 0.06 }, { r: 0.01, c: 0xff2200, o: 0.08 }].forEach(({ r, c, o }) => {
  const geo = new THREE.SphereGeometry(r, 32, 32);
  const mat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, side: THREE.FrontSide });
  scene.add(new THREE.Mesh(geo, mat));
});

// ─── Raycasting / Hover ───────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoveredPlanet = null;
let selectedPlanet = null;
let trackedPlanet = null;
let focusedPlanet = null;
let focusTimeLock = null;
let cameraFlight = null;
let pointerActive = false;

const flightEndPosition = new THREE.Vector3();
const flightTarget = new THREE.Vector3();
const flightDirection = new THREE.Vector3();
const focusOffset = new THREE.Vector3();
const labelTargetPosition = new THREE.Vector3();

const tooltip = document.getElementById('tooltip');
const infoPanel = document.getElementById('info-panel');
const infoPlanetName = document.getElementById('info-planet-name');
const infoRows = document.getElementById('info-rows');
const infoDesc = document.getElementById('info-desc');
const focusBanner = document.getElementById('focus-banner');

/**
 * Walk up the object hierarchy to find the root planet mesh.
 * Returns the index into planetMeshes[], or -1 if not found.
 */
function findPlanetIndex(object) {
  let obj = object;
  while (obj) {
    const idx = planetRootMeshes.indexOf(obj);
    if (idx >= 0) return idx;
    obj = obj.parent;
  }
  return -1;
}

function getPlanetEntry(pd) {
  return planetMeshes.find(p => p.planet === pd);
}

function isVulcan(pd) {
  return pd?.name === 'Vulcan';
}

function syncLabelVisibility() {
  planetMeshes.forEach(({ planet, label }) => {
    label.visible = showLabels && planet !== focusedPlanet;
  });
}

function showFocusBanner(pd) {
  focusBanner.textContent = pd.name;
  focusBanner.style.borderColor = `#${pd.glowColor.toString(16).padStart(6, '0')}`;
  focusBanner.classList.add('visible');
  updateFocusBannerScale();
}

function clearCameraFocus() {
  trackedPlanet = null;
  focusedPlanet = null;
  focusTimeLock = null;
  cameraFlight = null;
  focusOffset.set(0, 0, 0);
  controls.enabled = true;
  controls.enableDamping = true;
  focusBanner.style.setProperty('--focus-scale', '1');
  focusBanner.classList.remove('visible');
  syncLabelVisibility();
}

function updateFocusBannerScale() {
  if (!focusedPlanet) return;

  const entry = getPlanetEntry(focusedPlanet);
  if (!entry) return;

  const distance = Math.max(camera.position.distanceTo(entry.mesh.position), 0.001);
  const nominalFocusDistance = Math.max(entry.visualRadius * 16, 0.24);
  const scale = THREE.MathUtils.clamp((nominalFocusDistance / distance) * 1.22, 1.08, 2.1);
  focusBanner.style.setProperty('--focus-scale', scale.toFixed(3));
}

function updatePlanetLabelScales(dt = 0) {
  planetMeshes.forEach(({ mesh, planet, label, visualRadius }) => {
    const baseScale = label.userData.baseScale;
    if (!baseScale) return;

    const distance = Math.max(camera.position.distanceTo(mesh.position), 0.001);
    const nominalReadableDistance = Math.max(visualRadius * 18, 0.32);
    const scale = THREE.MathUtils.clamp(nominalReadableDistance / distance, 1, 1.85);
    label.scale.set(baseScale.x * scale, baseScale.y * scale, 1);

    const baseOffset = label.userData.baseOffset ?? new THREE.Vector3(0, visualRadius * 2.5, 0);
    const lift = visualRadius * (scale - 1) * 0.55;
    labelTargetPosition
      .copy(mesh.position)
      .add(baseOffset);
    labelTargetPosition.y += lift;

    const smoothedPosition = label.userData.smoothedPosition;
    if (!smoothedPosition || smoothedPosition.lengthSq() === 0 || dt <= 0) {
      label.position.copy(labelTargetPosition);
      if (smoothedPosition) smoothedPosition.copy(labelTargetPosition);
      return;
    }

    const smoothingRate = isVulcan(planet) ? 5.5 : 16;
    const alpha = 1 - Math.exp(-dt * smoothingRate);
    smoothedPosition.lerp(labelTargetPosition, alpha);
    label.position.copy(smoothedPosition);
  });
}

function setPointerFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  pointerActive = true;
}

function pickPlanetFromPointer() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(planetRootMeshes, true);
  if (hits.length === 0) return null;

  const idx = findPlanetIndex(hits[0].object);
  return idx >= 0 ? planetMeshes[idx] : null;
}

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function focusCameraOnPlanet(pd) {
  const entry = getPlanetEntry(pd);
  if (!entry) return;

  const lockFocus = isVulcan(pd);
  focusTimeLock = lockFocus ? simTime : null;
  flightDirection.copy(camera.position).sub(controls.target);
  if (flightDirection.lengthSq() < 0.0001) {
    flightDirection.set(1, 0.45, 1);
  }
  flightDirection.normalize();

  const focusDistance = Math.max(entry.visualRadius * 16, 0.24);
  focusOffset.copy(flightDirection).multiplyScalar(focusDistance);
  cameraFlight = {
    planet: pd,
    startTime: performance.now(),
    duration: 1100,
    fromPosition: camera.position.clone(),
    fromTarget: controls.target.clone(),
    offset: focusOffset.clone(),
  };
  trackedPlanet = pd;
  focusedPlanet = pd;
  showFocusBanner(pd);
  syncLabelVisibility();
  controls.enabled = false;
  controls.enableDamping = !lockFocus;
}

function updateCameraFocus(now) {
  if (cameraFlight) {
    const entry = getPlanetEntry(cameraFlight.planet);
    if (!entry) {
      cameraFlight = null;
      controls.enabled = true;
      return;
    }

    const t = Math.min((now - cameraFlight.startTime) / cameraFlight.duration, 1);
    const eased = easeInOutCubic(t);
    flightTarget.copy(entry.mesh.position);
    flightEndPosition.copy(flightTarget).add(cameraFlight.offset);

    camera.position.lerpVectors(cameraFlight.fromPosition, flightEndPosition, eased);
    controls.target.lerpVectors(cameraFlight.fromTarget, flightTarget, eased);

    if (t >= 1) {
      camera.position.copy(flightEndPosition);
      controls.target.copy(flightTarget);
      focusOffset.copy(cameraFlight.offset);
      cameraFlight = null;
      controls.enabled = true;
    }
    return;
  }

  if (trackedPlanet) {
    const entry = getPlanetEntry(trackedPlanet);
    if (entry) {
      controls.target.copy(entry.mesh.position);
      camera.position.copy(entry.mesh.position).add(focusOffset);
    }
  }
}

renderer.domElement.addEventListener('pointermove', (e) => {
  setPointerFromEvent(e);
  tooltip.style.left = (e.clientX + 14) + 'px';
  tooltip.style.top  = (e.clientY + 14) + 'px';
});

renderer.domElement.addEventListener('click', (e) => {
  setPointerFromEvent(e);
  const picked = pickPlanetFromPointer();
  if (picked) {
    selectPlanet(picked.planet);
  } else {
    deselectPlanet();
  }
});

renderer.domElement.addEventListener('dblclick', (e) => {
  setPointerFromEvent(e);
  const picked = pickPlanetFromPointer();
  if (!picked) return;

  selectPlanet(picked.planet);
  focusCameraOnPlanet(picked.planet);
});

// ─── Highlight / dim helpers ──────────────────────────────────────────────────
const DIM_HEX   = 0x2a3a55;   // dark slate gray for dimmed orbits & planets
const DIM_EMISSIVE = 0x0a0f1a; // near-black emissive for dimmed bodies

function setEntryExtraOpacity(entry, factor) {
  entry.visualExtras.forEach((object) => {
    const material = object.material;
    if (!material) return;
    if (material.userData.baseOpacity === undefined) {
      material.userData.baseOpacity = material.opacity ?? 1;
    }
    material.opacity = material.userData.baseOpacity * factor;
    material.transparent = true;
    material.needsUpdate = true;
  });
}

function applySelectionHighlight(pd) {
  // Orbits
  orbitLines.forEach(({ line, planet }) => {
    if (planet === pd) {
      const orbitColor = planet.retrograde ? 0xff4488 : planet.color;
      line.material.color.setHex(orbitColor);
      line.material.opacity = 0.85;
    } else {
      line.material.color.setHex(DIM_HEX);
      line.material.opacity = 0.10;
    }
    line.material.needsUpdate = true;
  });

  // Planet meshes
  planetMeshes.forEach((entry) => {
    const { mesh, planet } = entry;
    if (planet === pd) {
      mesh.material.color.setHex(0xffffff);
      mesh.material.emissive.setHex(planet.color);
      mesh.material.emissiveIntensity = 0.28;
      mesh.material.opacity = 1;
      mesh.material.transparent = false;
      setEntryExtraOpacity(entry, 1.1);
    } else {
      mesh.material.color.setHex(DIM_HEX);
      mesh.material.emissive.setHex(DIM_EMISSIVE);
      mesh.material.emissiveIntensity = 0.025;
      mesh.material.opacity = 0.35;
      mesh.material.transparent = true;
      setEntryExtraOpacity(entry, 0.28);
    }
    mesh.material.needsUpdate = true;
  });
}

function resetSelectionHighlight() {
  orbitLines.forEach(({ line, planet }) => {
    const orbitColor = planet.retrograde ? 0xff4488 : planet.color;
    line.material.color.setHex(orbitColor);
    line.material.opacity = planet.retrograde ? 0.45 : 0.35;
    line.material.needsUpdate = true;
  });

  planetMeshes.forEach((entry) => {
    const { mesh, planet } = entry;
    mesh.material.color.setHex(0xffffff);
    mesh.material.emissive.setHex(planet.color);
    mesh.material.emissiveIntensity = mesh.userData.baseEmissiveIntensity ?? 0.08;
    mesh.material.opacity = 1;
    mesh.material.transparent = false;
    mesh.material.needsUpdate = true;
    setEntryExtraOpacity(entry, 1);
  });
}

function selectPlanet(pd) {
  selectedPlanet = pd;
  clearCameraFocus();
  
  isFollowingSpacecraft = false;
  const btnGlobal = document.getElementById('btn-view-global');
  const btnFollow = document.getElementById('btn-view-follow');
  if (btnGlobal) btnGlobal.classList.remove('active');
  if (btnFollow) btnFollow.classList.remove('active');
  
  applySelectionHighlight(pd);

  infoPlanetName.textContent = pd.name;
  infoPlanetName.style.color = `#${pd.glowColor.toString(16).padStart(6,'0')}`;
  const per = orbitalPeriod(pd.a).toFixed(2);
  const radius = pd.radius > 0
    ? `${pd.radius.toLocaleString(undefined, { maximumFractionDigits: 0 })} km`
    : 'Massless';
  infoRows.innerHTML = `
    <div class="info-row"><span class="info-label">Classification</span><span class="info-value">${pd.classification}</span></div>
    <div class="info-row"><span class="info-label">Sci. Weight</span><span class="info-value">${pd.weight}</span></div>
    <div class="info-row"><span class="info-label">Semi-major axis</span><span class="info-value">${pd.a.toFixed(3)} AU</span></div>
    <div class="info-row"><span class="info-label">Eccentricity</span><span class="info-value">${pd.e.toFixed(4)}</span></div>
    <div class="info-row"><span class="info-label">Inclination</span><span class="info-value">${Math.abs(pd.i).toFixed(2)}°${pd.retrograde ? ' (retrograde)' : ''}</span></div>
    <div class="info-row"><span class="info-label">Orbital Period</span><span class="info-value">${per} yr</span></div>
    <div class="info-row"><span class="info-label">Radius</span><span class="info-value">${radius}</span></div>
    <div class="info-row"><span class="info-label">GM</span><span class="info-value">${pd.mu.toExponential(3)} km³/s²</span></div>
    <div class="info-row"><span class="info-label">Body ID</span><span class="info-value">${pd.id}</span></div>
  `;
  infoDesc.textContent = pd.desc;
  infoPanel.classList.add('visible');
}

function deselectPlanet() {
  selectedPlanet = null;
  clearCameraFocus();
  resetSelectionHighlight();
  infoPanel.classList.remove('visible');
  
  const btnGlobal = document.getElementById('btn-view-global');
  const btnFollow = document.getElementById('btn-view-follow');
  if (btnGlobal) btnGlobal.classList.add('active');
  if (btnFollow) btnFollow.classList.remove('active');
}

// ─── Legend UI ────────────────────────────────────────────────────────────────
const legendList = document.getElementById('legend-list');
PLANETS.forEach(pd => {
  const item = document.createElement('div');
  item.className = 'legend-item';
  item.innerHTML = `
    <div class="legend-dot" style="background:#${pd.color.toString(16).padStart(6,'0')}"></div>
    <span class="legend-name">${pd.name}</span>
    <span class="legend-weight">w=${pd.weight}</span>
  `;
  item.addEventListener('click', () => selectPlanet(pd));
  item.addEventListener('dblclick', () => {
    selectPlanet(pd);
    focusCameraOnPlanet(pd);
  });
  legendList.appendChild(item);

  // Separator before outer planets
  if (pd.id === 1000) {
    const hr = document.createElement('hr');
    hr.className = 'legend-divider';
    legendList.appendChild(hr);
  }
});

// ─── UI Controls ─────────────────────────────────────────────────────────────
const MIN_SIM_SPEED = 7 / 365.25; // 1 week per second, in years per second
const MAX_SIM_SPEED = 1000;
let simTime = 0;       // years
let simPaused = false;
let simSpeed = MIN_SIM_SPEED;
let showOrbits = true;
let showAsteroids = true;
let showComets = true;
let showLabels = true;
let lastFrame = performance.now();

// Mission-specific state
let activeMission = null;
let scoringData = null;
let trailPoints = null;
let spacecraftMesh = null;
let trajectoryLine = null;
let isFollowingSpacecraft = false;
let showTrajectoryTrail = true;
let delayDays = 0;
let lastUpdateScore = 0;
let lastUpdateTime = 0;
let isTimelineMode = false;
let activeMissionFilename = '';
let activeDashTab = 'linear';

const timeValue = document.getElementById('time-value');
const speedVal  = document.getElementById('speed-val');
const speedSlider = document.getElementById('speed-slider');

function speedFromSlider(value) {
  const t = Number(value);
  return MIN_SIM_SPEED * Math.pow(MAX_SIM_SPEED / MIN_SIM_SPEED, t);
}

function sliderFromSpeed(speed) {
  return Math.log(speed / MIN_SIM_SPEED) / Math.log(MAX_SIM_SPEED / MIN_SIM_SPEED);
}

function formatSimSpeed(speed) {
  if (speed <= MIN_SIM_SPEED * 1.02) return '1 wk/s';
  if (speed < 1) return `${(speed * 365.25 / 7).toFixed(1)} wk/s`;
  if (speed < 10) return `${speed.toFixed(2)} yr/s`;
  return `${Math.round(speed)} yr/s`;
}

speedSlider.value = sliderFromSpeed(simSpeed).toFixed(3);
speedVal.textContent = formatSimSpeed(simSpeed);

document.getElementById('btn-pause').addEventListener('click', function() {
  simPaused = !simPaused;
  this.textContent = simPaused ? '▶ Resume' : '⏸ Pause';
  this.classList.toggle('active', !simPaused);
});

document.getElementById('btn-reset').addEventListener('click', () => {
  simTime = 0;
  clearCameraFocus();
  controls.target.set(0, 0, 0);
  camera.position.set(0, 95, 185);
  deselectPlanet();
});

speedSlider.addEventListener('input', function() {
  simSpeed = speedFromSlider(this.value);
  speedVal.textContent = formatSimSpeed(simSpeed);
});

function toggleBtn(id) {
  const btn = document.getElementById(id);
  const isActive = btn.classList.toggle('active');
  return isActive;
}

document.getElementById('btn-orbits').addEventListener('click', function() {
  showOrbits = this.classList.toggle('active');
  orbitLines.forEach(({ line }) => { line.visible = showOrbits; });
  eclipticGrid.visible = showOrbits;
});

document.getElementById('btn-asteroids').addEventListener('click', function() {
  showAsteroids = this.classList.toggle('active');
  if (asteroidMesh) asteroidMesh.visible = showAsteroids;
});

document.getElementById('btn-comets').addEventListener('click', function() {
  showComets = this.classList.toggle('active');
  cometGroup.visible = showComets;
});

document.getElementById('btn-labels').addEventListener('click', function() {
  showLabels = this.classList.toggle('active');
  syncLabelVisibility();
});

// View presets
document.getElementById('btn-view-free').addEventListener('click', function() {
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  this.classList.add('active');
  clearCameraFocus();
  controls.enableRotate = true;
});
document.getElementById('btn-view-top').addEventListener('click', function() {
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  this.classList.add('active');
  clearCameraFocus();
  const dist = controls.getDistance();
  camera.position.set(0, Math.max(dist, 160), 0.001);
  controls.target.set(0, 0, 0);
});
document.getElementById('btn-view-ecliptic').addEventListener('click', function() {
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  this.classList.add('active');
  clearCameraFocus();
  camera.position.set(190, 7, 0);
  controls.target.set(0, 0, 0);
});
// ─── GTOC13 Score & Mission Logic ──────────────────────────────────────────

const PLANET_NAMES = {
  1: 'Vulcan',
  2: 'Yavin',
  3: 'Eden',
  4: 'Hoth',
  1000: 'Yandi',
  5: 'Beyonce',
  6: 'Bespin',
  7: 'Jotunn',
  8: 'Wakonyingo',
  9: 'Rogue1',
  10: 'PlanetX'
};

function getBodyName(id) {
  if (id in PLANET_NAMES) {
    return PLANET_NAMES[id];
  }
  if (id >= 1001 && id <= 1257) {
    return `Asteroid ${id}`;
  }
  if (id >= 2001 && id <= 2042) {
    return `Comet ${id}`;
  }
  return `Body ${id}`;
}

function triggerFloatingScoreDiff(diffText) {
  // Spawn in HUD score value wrapper
  const hudWrapper = document.getElementById('score-value-wrapper');
  if (hudWrapper) {
    const el = document.createElement('div');
    el.className = 'score-diff-float';
    el.textContent = diffText;
    hudWrapper.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }
  
  // Spawn in Dashboard score value wrapper
  const dashWrapper = document.getElementById('dash-score-value-wrapper');
  if (dashWrapper) {
    const el = document.createElement('div');
    el.className = 'score-diff-float';
    el.textContent = diffText;
    dashWrapper.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }
}

function updateGrandTourChecklist(visitedChecklist) {
  const grid = document.getElementById('checklist-planets-grid');
  if (!grid) return;
  
  grid.innerHTML = '';
  
  // Major Planets ID 1-10
  let planetVisitedCount = 0;
  const majorPlanetIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  majorPlanetIds.forEach(bid => {
    const isVisited = visitedChecklist[bid];
    if (isVisited) planetVisitedCount++;
    
    const cell = document.createElement('div');
    cell.style.display = 'flex';
    cell.style.alignItems = 'center';
    cell.style.justify = 'center';
    cell.style.fontSize = '9px';
    cell.style.fontWeight = 'bold';
    cell.style.padding = '3px 0';
    cell.style.borderRadius = '4px';
    cell.style.fontFamily = 'monospace';
    cell.style.transition = 'all 0.2s';
    
    const nameShort = getPlanetNameShort(bid);
    cell.textContent = nameShort;
    
    if (isVisited) {
      cell.style.background = `rgba(74, 222, 128, 0.15)`;
      cell.style.color = '#4ade80';
      cell.style.border = `1px solid #4ade80`;
      cell.style.boxShadow = `0 0 6px rgba(74,222,128,0.2)`;
    } else {
      cell.style.background = 'rgba(255,255,255,0.02)';
      cell.style.color = 'rgba(255,255,255,0.2)';
      cell.style.border = '1px solid rgba(255,255,255,0.06)';
    }
    grid.appendChild(cell);
  });
  
  // Update counts and status
  document.getElementById('checklist-planets-count').textContent = `${planetVisitedCount}/10`;
  
  const yandiVisited = visitedChecklist[1000];
  const yandiStatus = document.getElementById('checklist-yandi-status');
  if (yandiStatus) {
    if (yandiVisited) {
      yandiStatus.textContent = 'VISITED';
      yandiStatus.style.color = '#4ade80';
      yandiStatus.style.borderColor = '#4ade80';
      yandiStatus.style.background = 'rgba(74, 222, 128, 0.1)';
      yandiStatus.style.boxShadow = '0 0 6px rgba(74,222,128,0.2)';
    } else {
      yandiStatus.textContent = 'PENDING';
      yandiStatus.style.color = 'rgba(255,255,255,0.3)';
      yandiStatus.style.borderColor = 'rgba(255,255,255,0.1)';
      yandiStatus.style.background = 'rgba(255,255,255,0.02)';
      yandiStatus.style.boxShadow = 'none';
    }
  }
  
  const minorCount = visitedChecklist.minorCount || 0;
  const minorCountEl = document.getElementById('checklist-minor-count');
  if (minorCountEl) minorCountEl.textContent = `${minorCount}/13`;
  
  const minorBar = document.getElementById('checklist-minor-progress');
  if (minorBar) {
    const pct = Math.min(100, (minorCount / 13) * 100);
    minorBar.style.width = `${pct}%`;
  }
  
  // Show / hide multiplier banner
  const multiplierBanner = document.getElementById('grand-tour-multiplier-banner');
  if (multiplierBanner) {
    const hasMultiplier = planetVisitedCount === 10 && yandiVisited && minorCount >= 13;
    multiplierBanner.style.display = hasMultiplier ? 'block' : 'none';
  }
}

function getPlanetNameShort(id) {
  const shorts = {
    1: 'VU', 2: 'YA', 3: 'ED', 4: 'HO', 5: 'BY',
    6: 'BE', 7: 'JO', 8: 'WA', 9: 'RO', 10: 'PX'
  };
  return shorts[id] || '??';
}

function updateScienceFeed(currentTime_yr) {
  const feed = document.getElementById('dash-science-feed');
  if (!feed || !scoringData) return;
  
  feed.innerHTML = '';
  
  const events = scoringData.scorableEvents;
  const b = scoringData.b;
  const c = scoringData.c;
  
  let lastFeedItem = null;
  
  events.forEach((ev) => {
    const isCompleted = ev.time_yr <= currentTime_yr;
    const bodyName = getBodyName(ev.bodyId);
    const timeStr = ev.time_yr.toFixed(3);
    const contrib = (b * c * ev.contribution).toFixed(4);
    
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.justify = 'space-between';
    div.style.padding = '4px 6px';
    div.style.borderRadius = '4px';
    div.style.marginBottom = '2px';
    
    if (isCompleted) {
      div.style.background = 'rgba(74, 222, 128, 0.08)';
      div.style.color = '#4ade80';
      div.style.borderLeft = '2px solid #4ade80';
      div.style.textShadow = '0 0 4px rgba(74,222,128,0.2)';
      div.innerHTML = `<span>★ Year ${timeStr}: ${bodyName} flyby</span><span style="font-family: monospace;">+${contrib}</span>`;
      lastFeedItem = div;
    } else {
      div.style.color = 'rgba(200, 220, 255, 0.35)';
      div.style.borderLeft = '2px solid rgba(255,255,255,0.08)';
      div.innerHTML = `<span>Year ${timeStr}: ${bodyName} flyby</span><span style="font-family: monospace;">+${contrib}</span>`;
    }
    feed.appendChild(div);
  });
  
  if (lastFeedItem) {
    lastFeedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function drawScoreDashboardChart(currentTime_yr) {
  const canvas = document.getElementById('dash-score-chart');
  if (!canvas || !scoringData) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  
  ctx.clearRect(0, 0, W, H);
  
  const padL = 45;
  const padR = 15;
  const padT = 15;
  const padB = 25;
  
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  
  const t_start = activeMission.timeRange.start_yr;
  const t_end = activeMission.timeRange.end_yr;
  const t_span = t_end - t_start;
  
  const maxJ = Math.max(scoringData.J, 1.0);
  
  ctx.strokeStyle = 'rgba(110, 231, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(150, 180, 255, 0.4)';
  ctx.font = '8px monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const val = (maxJ * i) / yTicks;
    const y = padT + plotH * (1 - i / yTicks);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(val.toFixed(1), padL - 6, y);
  }
  
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const val = t_start + (t_span * i) / xTicks;
    const x = padL + plotW * (i / xTicks);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, H - padB);
    ctx.stroke();
    ctx.fillText(val.toFixed(1) + 'y', x, H - padB + 5);
  }
  
  const getX = (t) => padL + plotW * ((t - t_start) / t_span);
  const getY = (j) => padT + plotH * (1 - j / maxJ);
  
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(110, 231, 255, 0.7)';
  ctx.lineWidth = 2;
  
  let currentX = getX(t_start);
  let currentY = getY(0);
  ctx.moveTo(currentX, currentY);
  
  const events = scoringData.scorableEvents;
  const b = scoringData.b;
  const c = scoringData.c;
  
  for (const ev of events) {
    const evX = getX(ev.time_yr);
    ctx.lineTo(evX, currentY);
    const nextJ = b * c * ev.accumulatedScore;
    currentY = getY(nextJ);
    ctx.lineTo(evX, currentY);
  }
  ctx.lineTo(getX(t_end), currentY);
  ctx.stroke();
  
  ctx.lineTo(getX(t_end), getY(0));
  ctx.lineTo(getX(t_start), getY(0));
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, 'rgba(110, 231, 255, 0.15)');
  grad.addColorStop(1, 'rgba(110, 231, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fill();
  
  const playheadX = getX(currentTime_yr);
  if (playheadX >= padL && playheadX <= W - padR) {
    ctx.beginPath();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(playheadX, padT);
    ctx.lineTo(playheadX, H - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const scoreState = getScoreAtTime(scoringData, currentTime_yr);
    const playheadY = getY(scoreState.J_t);
    
    ctx.beginPath();
    ctx.arc(playheadX, playheadY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    ctx.beginPath();
    ctx.arc(playheadX, playheadY, 8, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
    ctx.stroke();
  }
}

function mapAUToRadius(r_au) {
  const R_min = 35;
  const numRings = 12;
  const w_ring = (170 - R_min) / numRings; // 11.25px per ring
  
  const levels = [
    0.0,      // Sun (R_min)
    0.092,    // Vulcan (Ring 0 center)
    0.859,    // Yavin (Ring 1 center)
    1.200,    // Eden (Ring 2 center)
    2.939,    // Hoth (Ring 3 center)
    7.481,    // Beyonce (Ring 4 center)
    14.295,   // Bespin (Ring 5 center)
    17.529,   // Jotunn (Ring 6 center)
    34.195,   // Wakonyingo (Ring 7 center)
    67.173,   // Rogue1 (Ring 8 center)
    106.653,  // PlanetX (Ring 9 center)
    130.0,    // Asteroids center (Ring 10 center)
    200.0     // Comets center (Ring 11 center)
  ];
  
  const radii = [
    R_min,
    R_min + 0.5 * w_ring,
    R_min + 1.5 * w_ring,
    R_min + 2.5 * w_ring,
    R_min + 3.5 * w_ring,
    R_min + 4.5 * w_ring,
    R_min + 5.5 * w_ring,
    R_min + 6.5 * w_ring,
    R_min + 7.5 * w_ring,
    R_min + 8.5 * w_ring,
    R_min + 9.5 * w_ring,
    R_min + 10.5 * w_ring,
    R_min + 11.5 * w_ring
  ];
  
  if (r_au <= 0) return radii[0];
  if (r_au >= levels[levels.length - 1]) return radii[radii.length - 1];
  
  for (let i = 0; i < levels.length - 1; i++) {
    if (r_au >= levels[i] && r_au <= levels[i+1]) {
      const frac = (r_au - levels[i]) / (levels[i+1] - levels[i]);
      return radii[i] + frac * (radii[i+1] - radii[i]);
    }
  }
  return radii[radii.length - 1];
}

function drawScoreDashboardWheel(currentTime_yr) {
  const canvas = document.getElementById('dash-wheel-chart');
  if (!canvas || !scoringData || !activeMission) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  
  ctx.clearRect(0, 0, W, H);
  
  const cx = W / 2;
  const cy = H / 2;
  
  // Layout radii
  const R_max = 170;
  const R_min = 35;
  const numRings = 12;
  const w_ring = (R_max - R_min) / numRings;
  const R_center = R_min - 6; // center circle boundary (29px)
  
  // 1. Draw solar sail thrust profile wedges in the center circle (radius 0 to 29px)
  ctx.save();
  for (let i = 0; i < trailPoints.length - 1; i++) {
    const pt1 = trailPoints[i];
    if (pt1.time_yr > currentTime_yr) break;
    const pt2 = trailPoints[i + 1];
    
    let color = 'rgba(255, 255, 255, 0.02)'; // default coasting
    if (pt1.segType === 'propagated' && pt1.vx !== undefined) {
      const dot = pt1.ux * pt1.vx + pt1.uy * pt1.vy + pt1.uz * pt1.vz;
      color = dot > 0 ? 'rgba(74, 222, 128, 0.35)' : 'rgba(239, 68, 68, 0.35)'; // Accelerating green vs braking red
    }
    
    const ang1 = -Math.atan2(pt1.y, pt1.x);
    const ang2 = -Math.atan2(pt2.y, pt2.x);
    
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R_center, ang1, ang2, ang2 < ang1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  
  // 2. Draw historical spacecraft orbital trajectory spiral in the center circle
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 0.75;
  
  let first = true;
  for (let i = 0; i < trailPoints.length; i++) {
    const pt = trailPoints[i];
    if (pt.time_yr > currentTime_yr) break;
    
    const ang = -Math.atan2(pt.y, pt.x);
    const r_sc = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
    const maxAU = 200.0;
    const mappedR = (Math.min(r_sc, maxAU) / maxAU) * R_center;
    
    const px = cx + mappedR * Math.cos(ang);
    const py = cy + mappedR * Math.sin(ang);
    
    if (first) {
      ctx.moveTo(px, py);
      first = false;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.restore();
  
  // 3. Draw the glowing exoplanetary Sun in the center
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffb347'; // golden sun glow
  ctx.shadowColor = '#ffb347';
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.restore();
  
  // 4. Draw radar/instrument background grid (radial lines every 30 deg)
  ctx.strokeStyle = 'rgba(110, 231, 255, 0.03)';
  ctx.lineWidth = 1;
  for (let d = 0; d < 360; d += 30) {
    const rad = d * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx + R_min * Math.cos(rad), cy + R_min * Math.sin(rad));
    ctx.lineTo(cx + R_max * Math.cos(rad), cy + R_max * Math.sin(rad));
    ctx.stroke();
  }
  
  // 5. Draw Concentric Ring Boundaries
  ctx.strokeStyle = 'rgba(110, 231, 255, 0.08)';
  for (let i = 0; i <= numRings; i++) {
    const r = R_min + i * w_ring;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  }
  
  // 6. Draw flybys
  const flybys = activeMission.flybys || [];
  
  // Map of planet colors
  const planetColors = {};
  PLANETS.forEach(p => {
    planetColors[p.id] = p.color;
  });
  
  // Compute visit counts for labeling
  const visitCounts = {};
  
  // Width of science block (14.8 degrees)
  const blockWidthRad = 14.8 * Math.PI / 180;
  const halfWidth = blockWidthRad / 2;
  
  // Sort flybys chronologically
  const sortedFlybys = [...flybys].sort((a, b) => a.time_yr - b.time_yr);
  
  sortedFlybys.forEach(fb => {
    let ringIdx = -1;
    let colorHex = 0x94a3b8; // default gray
    
    if (fb.bodyId >= 1 && fb.bodyId <= 10) {
      ringIdx = fb.bodyId - 1;
      colorHex = planetColors[fb.bodyId] || 0xcccccc;
    } else if (fb.bodyId === 1000) {
      ringIdx = 10; // Asteroids ring (Yandi)
      colorHex = 0x4ade80; // bright green for Yandi
    } else if (fb.bodyId >= 1001 && fb.bodyId <= 1257) {
      ringIdx = 10; // Asteroids ring
      colorHex = 0x94a3b8; // slate gray
    } else if (fb.bodyId >= 2001 && fb.bodyId <= 2042) {
      ringIdx = 11; // Comets ring
      colorHex = 0x22d3ee; // cyan
    }
    
    if (ringIdx === -1) return;
    
    // Increment visit index
    if (!visitCounts[fb.bodyId]) visitCounts[fb.bodyId] = 0;
    visitCounts[fb.bodyId]++;
    const visitIndex = visitCounts[fb.bodyId];
    
    // Check if flyby is completed or in the future
    const isCompleted = fb.time_yr <= currentTime_yr;
    
    // Compute angle from position
    const rnorm = Math.sqrt(fb.position.x * fb.position.x + fb.position.y * fb.position.y + fb.position.z * fb.position.z);
    if (rnorm === 0) return;
    
    const angle = Math.atan2(fb.position.y, fb.position.x);
    // Invert angle for standard counter-clockwise coordinates in canvas
    const screenAngle = -angle;
    
    // Radii bounds for this ring
    let R_in = R_min + ringIdx * w_ring;
    let R_out = R_min + (ringIdx + 1) * w_ring;
    
    // Determine opacity and heights based on whether it is science or non-science
    let blockOpacity = 0.25;
    let isHalfHeight = !fb.scienceFlyby;
    
    if (fb.scienceFlyby) {
      // Science flyby: opacity depends on V-infinity penalty F
      let vinf = 0;
      if (fb.vinf_in) {
        vinf = Math.sqrt(fb.vinf_in.x * fb.vinf_in.x + fb.vinf_in.y * fb.vinf_in.y + fb.vinf_in.z * fb.vinf_in.z);
      } else {
        const v = fb.vinf_out || { x: 0, y: 0, z: 0 };
        vinf = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      }
      const F = F_vinf(vinf);
      // Map F (0.2 to 1.2) to opacity (0.35 to 1.0)
      blockOpacity = 0.35 + 0.65 * (F - 0.2) / 1.0;
      blockOpacity = Math.max(0.35, Math.min(1.0, blockOpacity));
    }
    
    if (isHalfHeight) {
      // Non-science flyby: half height (draw in inner half of ring)
      R_out = R_in + w_ring / 2;
    }
    
    const th1 = screenAngle - (isHalfHeight ? halfWidth / 2 : halfWidth);
    const th2 = screenAngle + (isHalfHeight ? halfWidth / 2 : halfWidth);
    
    const rRed = (colorHex >> 16) & 0xff;
    const rGreen = (colorHex >> 8) & 0xff;
    const rBlue = colorHex & 0xff;
    
    ctx.save();
    
    // Draw block
    ctx.beginPath();
    ctx.arc(cx, cy, R_out, th1, th2, false);
    ctx.lineTo(cx + R_in * Math.cos(th2), cy + R_in * Math.sin(th2));
    ctx.arc(cx, cy, R_in, th2, th1, true);
    ctx.closePath();
    
    if (isCompleted) {
      ctx.fillStyle = `rgba(${rRed}, ${rGreen}, ${rBlue}, ${blockOpacity})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255, 255, 255, 0.35)`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    } else {
      ctx.strokeStyle = `rgba(${rRed}, ${rGreen}, ${rBlue}, 0.25)`;
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 0.75;
      ctx.stroke();
      ctx.fillStyle = `rgba(${rRed}, ${rGreen}, ${rBlue}, 0.05)`;
      ctx.fill();
    }
    
    // Draw visit number if science flyby and visitIndex > 1
    if (fb.scienceFlyby && visitIndex > 1 && isCompleted) {
      const midR = R_in + (R_out - R_in) / 2;
      const textX = cx + midR * Math.cos(screenAngle);
      const textY = cy + midR * Math.sin(screenAngle);
      
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(visitIndex.toString(), textX, textY);
    }
    
    ctx.restore();
  });
  
  // 7. Draw Radial Labels along the axes
  ctx.save();
  ctx.shadowColor = '#000000';
  ctx.shadowBlur = 4;
  ctx.font = 'bold 8.5px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  // Planet labels vertically upwards (12 o'clock)
  PLANETS.forEach((p, idx) => {
    const r_mid = R_min + idx * w_ring + w_ring / 2;
    const labelX = cx;
    const labelY = cy - r_mid;
    
    ctx.fillStyle = '#ffffff';
    ctx.fillText(p.name, labelX, labelY);
  });
  
  // Asteroids and Comets labels at 6 o'clock
  const r_mid_ast = R_min + 10 * w_ring + w_ring / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Asteroids', cx, cy + r_mid_ast);
  
  const r_mid_com = R_min + 11 * w_ring + w_ring / 2;
  ctx.fillText('Comets', cx, cy + r_mid_com);
  
  ctx.restore();
  
  // 8. Draw Header Metadata (Team Name & Final Score)
  ctx.save();
  ctx.fillStyle = '#6ee7ff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  
  const missionNameText = activeMissionFilename || 'Active Trajectory';
  ctx.fillText(missionNameText.toUpperCase(), cx, 8);
  
  ctx.fillStyle = 'rgba(200, 220, 255, 0.7)';
  ctx.font = '9.5px monospace';
  const scoreValText = `J = ${scoringData.J.toFixed(3)}`;
  ctx.fillText(scoreValText, cx, 22);
  ctx.restore();
  
  // 9. Draw Spacecraft Position Indicator (Playhead)
  const pos = getPositionAtTime(trailPoints, currentTime_yr);
  if (pos) {
    const scAngle = Math.atan2(pos.y, pos.x);
    const scScreenAngle = -scAngle;
    
    ctx.save();
    
    // Radial dashed playhead line
    ctx.beginPath();
    ctx.moveTo(cx + R_min * Math.cos(scScreenAngle), cy + R_min * Math.sin(scScreenAngle));
    ctx.lineTo(cx + R_max * Math.cos(scScreenAngle), cy + R_max * Math.sin(scScreenAngle));
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    
    // Spacecraft dot mapped radially based on non-linear planet ring radii
    const r_sc = Math.sqrt(pos.x * pos.x + pos.y * pos.y);
    const mappedScR = mapAUToRadius(r_sc);
    
    const scX = cx + mappedScR * Math.cos(scScreenAngle);
    const scY = cy + mappedScR * Math.sin(scScreenAngle);
    
    ctx.beginPath();
    ctx.arc(scX, scY, 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = '#f59e0b';
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = 8;
    ctx.fill();
    
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    ctx.restore();
  }
}

function drawSidebarScoreChart(currentTime_yr) {
  const canvas = document.getElementById('score-evolution-chart');
  if (!canvas || !scoringData) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  
  ctx.clearRect(0, 0, W, H);
  
  const padL = 25;
  const padR = 8;
  const padT = 5;
  const padB = 15;
  
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  
  const t_start = activeMission.timeRange.start_yr;
  const t_end = activeMission.timeRange.end_yr;
  const t_span = t_end - t_start;
  
  const maxJ = Math.max(scoringData.J, 1.0);
  
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(150, 180, 255, 0.3)';
  ctx.font = '7px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  
  ctx.fillText(maxJ.toFixed(0), padL - 4, padT);
  ctx.fillText('0', padL - 4, H - padB);
  
  const getX = (t) => padL + plotW * ((t - t_start) / t_span);
  const getY = (j) => padT + plotH * (1 - j / maxJ);
  
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(110, 231, 255, 0.6)';
  ctx.lineWidth = 1.5;
  
  let currentX = getX(t_start);
  let currentY = getY(0);
  ctx.moveTo(currentX, currentY);
  
  const events = scoringData.scorableEvents;
  const b = scoringData.b;
  const c = scoringData.c;
  
  for (const ev of events) {
    const evX = getX(ev.time_yr);
    ctx.lineTo(evX, currentY);
    const nextJ = b * c * ev.accumulatedScore;
    currentY = getY(nextJ);
    ctx.lineTo(evX, currentY);
  }
  ctx.lineTo(getX(t_end), currentY);
  ctx.stroke();
  
  ctx.lineTo(getX(t_end), getY(0));
  ctx.lineTo(getX(t_start), getY(0));
  ctx.closePath();
  ctx.fillStyle = 'rgba(110, 231, 255, 0.06)';
  ctx.fill();
  
  const playheadX = getX(currentTime_yr);
  if (playheadX >= padL && playheadX <= W - padR) {
    ctx.beginPath();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.moveTo(playheadX, padT);
    ctx.lineTo(playheadX, H - padB);
    ctx.stroke();
  }
}

function updateScoreBreakdownSidebar() {
  const breakdownList = document.getElementById('score-stats-list');
  if (!breakdownList || !scoringData) return;
  
  const b = scoringData.b;
  const c = scoringData.c;
  const raw = scoringData.totalRawScore;
  const J = scoringData.J;
  
  breakdownList.innerHTML = `
    <div class="mission-stat"><span class="mission-stat-label">Total Raw Score</span><span class="mission-stat-value" style="color:#a0c4ff;">${raw.toFixed(6)}</span></div>
    <div class="mission-stat"><span class="mission-stat-label">Grand Tour Bonus (b)</span><span class="mission-stat-value" style="color:#${b > 1 ? '4ade80' : 'a0d4ff'};">${b.toFixed(1)}x</span></div>
    <div class="mission-stat"><span class="mission-stat-label">Delay Clock Decay (c)</span><span class="mission-stat-value" style="color:#a0c4ff;">${c.toFixed(4)}</span></div>
    <div class="mission-stat" style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 6px; margin-top: 4px;"><span class="mission-stat-label" style="font-weight: bold; color: #6ee7ff;">Final Score J</span><span class="mission-stat-value" style="color:#6ee7ff; font-weight: bold; text-shadow: 0 0 8px rgba(110,231,255,0.4);">${J.toFixed(6)}</span></div>
  `;
}

function updateValidationSidebar() {
  const valList = document.getElementById('mission-validation-list');
  if (!valList || !activeMission) return;
  
  valList.innerHTML = '';
  
  const checks = activeMission.validationChecks || [];
  checks.forEach(c => {
    const item = document.createElement('div');
    item.className = 'validation-item';
    
    let statusClass = 'validation-pass';
    let statusIcon = '✓';
    if (c.status === 'fail') {
      statusClass = 'validation-fail';
      statusIcon = '✗';
    } else if (c.status === 'warning') {
      statusClass = 'validation-warning';
      statusIcon = '⚠';
    }
    
    item.innerHTML = `
      <span class="validation-name" title="${c.desc}">${c.name}</span>
      <span class="validation-status ${statusClass}">${statusIcon} ${c.status.toUpperCase()}</span>
    `;
    valList.appendChild(item);
  });
}

function updateEncounterLogSidebar() {
  const flybyList = document.getElementById('mission-flyby-list');
  if (!flybyList || !activeMission) return;
  
  flybyList.innerHTML = '';
  
  const flybys = activeMission.flybys || [];
  if (flybys.length === 0) {
    flybyList.innerHTML = '<div style="color: rgba(255,255,255,0.25); font-style: italic;">No flybys logged.</div>';
    return;
  }
  
  flybys.forEach(fb => {
    const isScience = fb.scienceFlyby;
    const bodyName = getBodyName(fb.bodyId);
    const typeStr = isScience ? 'Science Assist' : 'Navigation Assist';
    const typeClass = isScience ? 'flyby-science' : 'flyby-nav';
    const bullet = isScience ? '★' : '◇';
    
    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    div.innerHTML = `<span class="${typeClass}">${bullet} Year ${fb.time_yr.toFixed(3)}: ${bodyName}</span> <span style="color:rgba(255,255,255,0.3); font-size: 8.5px;">(${typeStr})</span>`;
    flybyList.appendChild(div);
  });
}

function createTrajectoryLine(points, color = 0x6ee7ff) {
  if (trajectoryLine) scene.remove(trajectoryLine);
  
  const geo = new THREE.BufferGeometry();
  const pts = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    pts[i*3]   = p.x;
    pts[i*3+1] = p.z;
    pts[i*3+2] = p.y;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.75,
    linewidth: 1.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  
  trajectoryLine = new THREE.Line(geo, mat);
  scene.add(trajectoryLine);
}

function createSpacecraftMesh() {
  if (spacecraftMesh) scene.remove(spacecraftMesh);
  
  const group = new THREE.Group();
  
  // 1. Detailed 3D Model Group (shown in follow mode / zoomed in)
  const modelGroup = new THREE.Group();
  modelGroup.name = 'modelGroup';
  modelGroup.scale.setScalar(0.08); // Scale down the spacecraft detailed model to be smaller than the planets
  
  // Add external illumination to the satellite so it is visible from all angles without overexposure
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(1, 1, 1);
  modelGroup.add(keyLight);
  modelGroup.add(keyLight.target);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
  fillLight.position.set(-1, -1, -1);
  modelGroup.add(fillLight);
  modelGroup.add(fillLight.target);

  const bounceLight = new THREE.DirectionalLight(0xffffff, 0.4);
  bounceLight.position.set(-1, 1, -1);
  modelGroup.add(bounceLight);
  modelGroup.add(bounceLight.target);
  
  // Gold Bus (Spacecraft Body)
  const busGeo = new THREE.BoxGeometry(0.04, 0.04, 0.04);
  const busMat = new THREE.MeshStandardMaterial({
    color: 0xd4af37, // gold
    metalness: 0.9,
    roughness: 0.15
  });
  const bus = new THREE.Mesh(busGeo, busMat);
  bus.name = 'bus';
  modelGroup.add(bus);
  
  // Solar Sail Group
  const sailGroup = new THREE.Group();
  sailGroup.name = 'sailGroup';
  
  // The flat sail panel (facing along Z axis by default)
  const sailGeo = new THREE.BoxGeometry(0.24, 0.24, 0.002);
  const sailMat = new THREE.MeshStandardMaterial({
    color: 0xcccccc, // silver
    metalness: 0.8,
    roughness: 0.2,
    side: THREE.DoubleSide
  });
  const sail = new THREE.Mesh(sailGeo, sailMat);
  sail.position.set(0, 0, -0.02); // slightly behind the bus
  sailGroup.add(sail);
  
  // Sail struts/booms
  const strutGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.34, 8);
  const strutMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.5 });
  const strut1 = new THREE.Mesh(strutGeo, strutMat);
  strut1.rotation.z = Math.PI / 4;
  strut1.position.set(0, 0, -0.02);
  const strut2 = strut1.clone();
  strut2.rotation.z = -Math.PI / 4;
  sailGroup.add(strut1, strut2);
  
  modelGroup.add(sailGroup);
  
  // Thrust Vector Arrow (pointing along Z axis, matching control vector u orientation)
  const arrowGroup = new THREE.Group();
  arrowGroup.name = 'arrowGroup';
  
  const shaftGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.12, 8);
  const arrowMat = new THREE.MeshBasicMaterial({
    color: 0x00ffff, // cyan
    transparent: true,
    opacity: 0.85
  });
  const shaft = new THREE.Mesh(shaftGeo, arrowMat);
  shaft.rotation.x = Math.PI / 2; // align cylinder to point along Z axis
  shaft.position.set(0, 0, 0.06);
  
  const headGeo = new THREE.ConeGeometry(0.015, 0.04, 8);
  const head = new THREE.Mesh(headGeo, arrowMat);
  head.rotation.x = Math.PI / 2;
  head.position.set(0, 0, 0.14); // tip of shaft
  
  arrowGroup.add(shaft, head);
  modelGroup.add(arrowGroup);
  
  // Sunward Hemisphere Limit Cone
  const limitConeMat = new THREE.MeshBasicMaterial({
    color: 0xffaa00,
    transparent: true,
    opacity: 0.15,
    wireframe: true,
    side: THREE.DoubleSide
  });
  const limitConeGeo = new THREE.ConeGeometry(0.18, 0.18, 16, 1, true); // open-ended cone
  const limitCone = new THREE.Mesh(limitConeGeo, limitConeMat);
  limitCone.name = 'limitCone';
  limitCone.rotation.x = Math.PI / 2; // point along Z axis
  modelGroup.add(limitCone);
  
  group.add(modelGroup);
  
  // 2. Global View Sphere Indicator (simple bright cyan sphere)
  const globalSphereGeo = new THREE.SphereGeometry(0.08, 16, 16);
  const globalSphereMat = new THREE.MeshBasicMaterial({
    color: 0x6ee7ff,
    transparent: true,
    opacity: 0.9
  });
  const globalSphere = new THREE.Mesh(globalSphereGeo, globalSphereMat);
  globalSphere.name = 'globalSphere';
  
  // Glow effect on global sphere
  const glow = makePlanetGlow(0x6ee7ff, 0.06);
  glow.name = 'glow';
  globalSphere.add(glow);
  
  group.add(globalSphere);

  // 3. Arrow above the satellite to locate it easily
  // This is a 3D locator arrow pointing straight down at the satellite (along Y axis)
  const locatorArrow = new THREE.Group();
  locatorArrow.name = 'locatorArrow';
  
  const locatorShaftGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.20, 8);
  const locatorMat = new THREE.MeshBasicMaterial({
    color: 0x4ade80, // bright green
    transparent: true,
    opacity: 0.85
  });
  const locatorShaft = new THREE.Mesh(locatorShaftGeo, locatorMat);
  locatorShaft.position.set(0, 0.18, 0); // raised above the center
  
  const locatorHeadGeo = new THREE.ConeGeometry(0.024, 0.06, 8);
  const locatorHead = new THREE.Mesh(locatorHeadGeo, locatorMat);
  locatorHead.rotation.x = Math.PI; // point head down (-Y)
  locatorHead.position.set(0, 0.08, 0);
  
  locatorArrow.add(locatorShaft, locatorHead);
  group.add(locatorArrow);
  
  spacecraftMesh = group;
  scene.add(spacecraftMesh);
}

function updateScoreUI(renderTime) {
  if (!scoringData) return;
  
  const scoreState = getScoreAtTime(scoringData, renderTime);
  const J_curr = scoreState.J_t;
  
  // Check if score has increased and we are moving forward in time
  if (J_curr > lastUpdateScore && renderTime > lastUpdateTime) {
    const eventsInInterval = scoringData.scorableEvents.filter(
      ev => ev.time_yr > lastUpdateTime && ev.time_yr <= renderTime
    );
    
    if (eventsInInterval.length > 0) {
      const b = scoringData.b;
      const c = scoringData.c;
      const totalContrib = eventsInInterval.reduce((sum, ev) => sum + ev.contribution, 0) * b * c;
      
      let diffText = '';
      if (eventsInInterval.length === 1) {
        const ev = eventsInInterval[0];
        const bodyName = getBodyName(ev.bodyId);
        diffText = `+${totalContrib.toFixed(6)} (${bodyName} flyby)`;
      } else {
        diffText = `+${totalContrib.toFixed(6)} (${eventsInInterval.length} flybys)`;
      }
      
      triggerFloatingScoreDiff(diffText);
    }
  }
  
  lastUpdateScore = J_curr;
  lastUpdateTime = renderTime;
  
  const scoreVal = document.getElementById('score-value');
  if (scoreVal) scoreVal.textContent = J_curr.toFixed(6);
  
  const dashScoreVal = document.getElementById('dash-score-value');
  if (dashScoreVal) dashScoreVal.textContent = J_curr.toFixed(6);
  
  updateGrandTourChecklist(scoreState.visitedChecklist);
  updateScienceFeed(renderTime);
  if (activeDashTab === 'linear') {
    drawScoreDashboardChart(renderTime);
  } else {
    drawScoreDashboardWheel(renderTime);
  }
  drawSidebarScoreChart(renderTime);
}

function handleMissionFile(fileText) {
  try {
    const mission = parseMission(fileText);
    activeMission = mission;
    
    delayDays = 0;
    const delaySlider = document.getElementById('delay-slider');
    if (delaySlider) delaySlider.value = 0;
    const delayVal = document.getElementById('delay-val');
    if (delayVal) delayVal.textContent = '0 days';
    
    scoringData = computeMissionScoring(activeMission, delayDays);
    trailPoints = generateTrailPoints(activeMission);
    
    createTrajectoryLine(trailPoints);
    createSpacecraftMesh();
    if (spacecraftMesh) {
      spacecraftMesh.userData.lastPosition = spacecraftMesh.position.clone();
    }
    
    if (trajectoryLine) trajectoryLine.visible = showTrajectoryTrail;
    if (spacecraftMesh) spacecraftMesh.visible = true;
    
    isFollowingSpacecraft = false;
    const btnGlobal = document.getElementById('btn-view-global');
    const btnFollow = document.getElementById('btn-view-follow');
    if (btnGlobal) btnGlobal.classList.add('active');
    if (btnFollow) btnFollow.classList.remove('active');
    
    document.getElementById('btn-score-dashboard').style.display = 'inline-block';
    if (btnGlobal) btnGlobal.style.display = 'inline-block';
    if (btnFollow) btnFollow.style.display = 'inline-block';
    document.getElementById('btn-trail').style.display = 'inline-block';
    document.getElementById('btn-goto-mission').style.display = 'inline-block';
    document.getElementById('mission-timeline-panel').style.display = 'block';
    
    const missionPanel = document.getElementById('mission-panel');
    if (missionPanel) missionPanel.classList.add('visible');
    
    const statsList = document.getElementById('mission-stats');
    if (statsList) {
      statsList.innerHTML = `
        <div class="mission-stat"><span class="mission-stat-label">Data Rows</span><span class="mission-stat-value">${activeMission.rowCount}</span></div>
        <div class="mission-stat"><span class="mission-stat-label">Start Year</span><span class="mission-stat-value">${activeMission.timeRange.start_yr.toFixed(3)} yr</span></div>
        <div class="mission-stat"><span class="mission-stat-label">End Year</span><span class="mission-stat-value">${activeMission.timeRange.end_yr.toFixed(3)} yr</span></div>
        <div class="mission-stat"><span class="mission-stat-label">Duration</span><span class="mission-stat-value">${(activeMission.timeRange.end_yr - activeMission.timeRange.start_yr).toFixed(2)} yr</span></div>
      `;
    }
    
    const scoreBreakdownSect = document.getElementById('mission-score-breakdown-section');
    if (scoreBreakdownSect) scoreBreakdownSect.style.display = 'block';
    
    updateScoreBreakdownSidebar();
    updateValidationSidebar();
    updateEncounterLogSidebar();
    
    const checklistPanel = document.getElementById('grand-tour-checklist-panel');
    if (checklistPanel) checklistPanel.style.display = 'block';
    
    lastUpdateScore = 0;
    lastUpdateTime = 0;
    
    document.getElementById('hud-score-divider').style.display = 'block';
    document.getElementById('hud-score-container').style.display = 'block';
    
    simTime = activeMission.timeRange.start_yr;
    const renderTime = focusTimeLock ?? simTime;
    updateScoreUI(renderTime);
    
    isTimelineMode = true;
    const btnPlayMode = document.getElementById('btn-timeline-play-mode');
    if (btnPlayMode) {
      btnPlayMode.textContent = '🛰️ Playback Mode';
      btnPlayMode.classList.add('active');
    }
    
    simPaused = false;
    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) {
      pauseBtn.textContent = '⏸ Pause';
      pauseBtn.classList.add('active');
    }
    
  } catch (err) {
    console.error(err);
    alert('Failed to load mission: ' + err.message);
  }
}

// ─── Score Dashboard Dragging & Setup ────────────────────────────────────────

const dashWindow = document.getElementById('score-dashboard-window');
const dashHeader = document.getElementById('score-dashboard-header');

let isDragging = false;
let dragStartX = 0, dragStartY = 0;
let dashStartX = 0, dashStartY = 0;

if (dashHeader && dashWindow) {
  dashHeader.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dashStartX = dashWindow.offsetLeft;
    dashStartY = dashWindow.offsetTop;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    
    let newLeft = dashStartX + dx;
    let newTop = dashStartY + dy;
    
    const maxLeft = window.innerWidth - dashWindow.offsetWidth;
    const maxTop = window.innerHeight - dashWindow.offsetHeight;
    
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    newTop = Math.max(0, Math.min(newTop, maxTop));
    
    dashWindow.style.left = `${newLeft}px`;
    dashWindow.style.top = `${newTop}px`;
    dashWindow.style.right = 'auto';
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  dashHeader.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      dashStartX = dashWindow.offsetLeft;
      dashStartY = dashWindow.offsetTop;
    }
  });

  window.addEventListener('touchmove', (e) => {
    if (!isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - dragStartX;
    const dy = e.touches[0].clientY - dragStartY;
    
    let newLeft = dashStartX + dx;
    let newTop = dashStartY + dy;
    
    const maxLeft = window.innerWidth - dashWindow.offsetWidth;
    const maxTop = window.innerHeight - dashWindow.offsetHeight;
    
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    newTop = Math.max(0, Math.min(newTop, maxTop));
    
    dashWindow.style.left = `${newLeft}px`;
    dashWindow.style.top = `${newTop}px`;
    dashWindow.style.right = 'auto';
  });

  window.addEventListener('touchend', () => {
    isDragging = false;
  });
}

// Collapsible Checklist Setup
const checklistHeader = document.getElementById('checklist-header');
const checklistContent = document.getElementById('checklist-content');
const checklistToggleIcon = document.getElementById('checklist-toggle-icon');

if (checklistHeader && checklistContent) {
  checklistHeader.addEventListener('click', () => {
    const isCollapsed = checklistContent.style.maxHeight === '0px';
    if (isCollapsed) {
      checklistContent.style.maxHeight = '280px';
      if (checklistToggleIcon) checklistToggleIcon.textContent = '▼';
    } else {
      checklistContent.style.maxHeight = '0px';
      if (checklistToggleIcon) checklistToggleIcon.textContent = '▲';
    }
  });
}

// Controls hookups
document.getElementById('btn-load-mission').addEventListener('click', () => {
  document.getElementById('mission-file-input').click();
});

document.getElementById('mission-file-input').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  activeMissionFilename = file.name.replace(/\.[^/.]+$/, "");
  
  const reader = new FileReader();
  reader.onload = function(evt) {
    handleMissionFile(evt.target.result);
  };
  reader.readAsText(file);
});

document.getElementById('btn-score-dashboard').addEventListener('click', function() {
  const dash = document.getElementById('score-dashboard-window');
  if (!dash) return;
  const isVisible = dash.style.display !== 'none';
  if (isVisible) {
    dash.style.display = 'none';
    this.classList.remove('active');
  } else {
    dash.style.display = 'block';
    this.classList.add('active');
    if (activeMission) {
      const renderTime = focusTimeLock ?? simTime;
      updateScoreUI(renderTime);
    }
  }
});

// Dashboard tab event listeners
document.getElementById('dash-tab-linear').addEventListener('click', function() {
  activeDashTab = 'linear';
  this.classList.add('active');
  document.getElementById('dash-tab-wheel').classList.remove('active');
  
  document.getElementById('dash-score-chart').style.display = 'block';
  document.getElementById('dash-wheel-chart').style.display = 'none';
  
  if (activeMission) {
    const renderTime = focusTimeLock ?? simTime;
    updateScoreUI(renderTime);
  }
});

document.getElementById('dash-tab-wheel').addEventListener('click', function() {
  activeDashTab = 'wheel';
  this.classList.add('active');
  document.getElementById('dash-tab-linear').classList.remove('active');
  
  document.getElementById('dash-score-chart').style.display = 'none';
  document.getElementById('dash-wheel-chart').style.display = 'block';
  
  if (activeMission) {
    const renderTime = focusTimeLock ?? simTime;
    updateScoreUI(renderTime);
  }
});

document.getElementById('btn-close-score-dashboard').addEventListener('click', () => {
  const dash = document.getElementById('score-dashboard-window');
  if (dash) dash.style.display = 'none';
  const scoreDashBtn = document.getElementById('btn-score-dashboard');
  if (scoreDashBtn) scoreDashBtn.classList.remove('active');
});

document.getElementById('btn-view-global').addEventListener('click', function() {
  isFollowingSpacecraft = false;
  document.getElementById('btn-view-global').classList.add('active');
  document.getElementById('btn-view-follow').classList.remove('active');
  
  clearCameraFocus();
  
  // Transition camera back to a global view (centered at system origin)
  controls.target.set(0, 0, 0);
  camera.position.set(0, 95, 185);
  controls.update();
});

document.getElementById('btn-view-follow').addEventListener('click', function() {
  isFollowingSpacecraft = true;
  document.getElementById('btn-view-global').classList.remove('active');
  document.getElementById('btn-view-follow').classList.add('active');
  
  clearCameraFocus();
  
  if (spacecraftMesh && spacecraftMesh.visible) {
    controls.target.copy(spacecraftMesh.position);
    focusOffset.set(0.3, 0.15, 0.3);
    camera.position.copy(spacecraftMesh.position).add(focusOffset);
    spacecraftMesh.userData.lastPosition = spacecraftMesh.position.clone();
    controls.update();
  }
});

document.getElementById('btn-trail').addEventListener('click', function() {
  showTrajectoryTrail = !showTrajectoryTrail;
  this.classList.toggle('active', showTrajectoryTrail);
  if (trajectoryLine) {
    trajectoryLine.visible = showTrajectoryTrail;
  }
});

document.getElementById('btn-goto-mission').addEventListener('click', () => {
  if (activeMission) {
    simTime = activeMission.timeRange.start_yr;
    const renderTime = focusTimeLock ?? simTime;
    timeValue.textContent = renderTime.toFixed(2);
    updateScoreUI(renderTime);
  }
});

const timelineSlider = document.getElementById('timeline-slider');
const timelineProgressText = document.getElementById('timeline-progress-text');
const btnPlayMode = document.getElementById('btn-timeline-play-mode');

if (btnPlayMode) {
  btnPlayMode.addEventListener('click', () => {
    isTimelineMode = !isTimelineMode;
    if (isTimelineMode) {
      btnPlayMode.textContent = '🛰️ Playback Mode';
      btnPlayMode.classList.add('active');
      if (activeMission) {
        const t_start = activeMission.timeRange.start_yr;
        const t_end = activeMission.timeRange.end_yr;
        if (simTime < t_start || simTime > t_end) {
          simTime = t_start;
        }
      }
    } else {
      btnPlayMode.textContent = '🔄 Evolution Mode';
      btnPlayMode.classList.remove('active');
    }
  });
}

if (timelineSlider) {
  timelineSlider.addEventListener('input', function() {
    if (activeMission) {
      const t_start = activeMission.timeRange.start_yr;
      const t_end = activeMission.timeRange.end_yr;
      const pct = Number(this.value) / 100;
      simTime = t_start + pct * (t_end - t_start);
      
      const renderTime = focusTimeLock ?? simTime;
      timeValue.textContent = renderTime.toFixed(2);
      updateScoreUI(renderTime);
    }
  });
}

const delaySlider = document.getElementById('delay-slider');
if (delaySlider) {
  delaySlider.addEventListener('input', function() {
    delayDays = Number(this.value);
    const delayVal = document.getElementById('delay-val');
    if (delayVal) delayVal.textContent = `${delayDays} days`;
    if (activeMission) {
      scoringData = computeMissionScoring(activeMission, delayDays);
      updateScoreBreakdownSidebar();
      const renderTime = focusTimeLock ?? simTime;
      updateScoreUI(renderTime);
    }
  });
}

// ─── Animation Loop ───────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05); // cap at 50ms
  lastFrame = now;

  if (!simPaused && focusTimeLock === null) {
    if (activeMission && isTimelineMode) {
      const t_start = activeMission.timeRange.start_yr;
      const t_end = activeMission.timeRange.end_yr;
      simTime += dt * simSpeed;
      if (simTime > t_end) {
        simTime = t_end;
        simPaused = true;
        const pauseBtn = document.getElementById('btn-pause');
        if (pauseBtn) {
          pauseBtn.textContent = '▶ Resume';
          pauseBtn.classList.remove('active');
        }
      }
    } else {
      simTime += dt * simSpeed;
    }
  }
  const renderTime = focusTimeLock ?? simTime;

  // Update planet positions
  planetMeshes.forEach(({ mesh, planet, cloudLayer }) => {
    const pos = keplerToCartesian(planet, renderTime);
    mesh.position.set(pos.x, pos.z, pos.y); // ecliptic to Three.js

    // Slow rotation
    mesh.rotation.y += dt * (0.15 + planet.size * 4.5);
    if (cloudLayer) cloudLayer.rotation.y += dt * 0.18;

  });

  // Update spacecraft position, orientation and follow state
  if (activeMission && spacecraftMesh && trailPoints) {
    const posObj = getPositionAtTime(trailPoints, renderTime);
    if (posObj) {
      spacecraftMesh.position.set(posObj.x, posObj.z, posObj.y);
      spacecraftMesh.visible = true;
      
      const modelGroup = spacecraftMesh.getObjectByName('modelGroup');
      const globalSphere = spacecraftMesh.getObjectByName('globalSphere');
      const locatorArrow = spacecraftMesh.getObjectByName('locatorArrow');
      
      const camDist = camera.position.distanceTo(spacecraftMesh.position);
      
      // Determine Zoomed-in Follow vs. Global Mode
      const isZoomed = isFollowingSpacecraft || camDist < 1.5;
      
      if (isZoomed) {
        // Zoomed in (Follow / Close Mode)
        if (modelGroup) modelGroup.visible = true;
        if (globalSphere) globalSphere.visible = false;
        
        // Scale locator arrow down slightly and keep it close
        if (locatorArrow) {
          locatorArrow.visible = true;
          const locScale = THREE.MathUtils.clamp(camDist * 0.4, 0.1, 1.0);
          locatorArrow.scale.setScalar(locScale);
          locatorArrow.position.set(0, 0.15 * locScale, 0);
        }
        
        // Spin the body for visual feedback (child 0 of modelGroup is the bus)
        const bus = spacecraftMesh.getObjectByName('bus');
        if (bus) {
          bus.rotation.y += 0.015;
        }
        
        const sailGroup = spacecraftMesh.getObjectByName('sailGroup');
        const arrowGroup = spacecraftMesh.getObjectByName('arrowGroup');
        const limitCone = spacecraftMesh.getObjectByName('limitCone');
        
        // 1. Orient sailGroup and arrowGroup to face active control vector u, or face star in conic phase
        const hasControl = (posObj.ux !== undefined && posObj.uy !== undefined && posObj.uz !== undefined &&
                            !isNaN(posObj.ux) && !isNaN(posObj.uy) && !isNaN(posObj.uz) &&
                            (posObj.ux * posObj.ux + posObj.uy * posObj.uy + posObj.uz * posObj.uz) > 1e-6);
        if (hasControl) {
          if (arrowGroup) arrowGroup.visible = true;
          const targetDirection = new THREE.Vector3(posObj.ux, posObj.uz, posObj.uy).normalize();
          const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), targetDirection);
          if (sailGroup) sailGroup.quaternion.copy(quaternion);
          if (arrowGroup) arrowGroup.quaternion.copy(quaternion);
        } else {
          if (arrowGroup) arrowGroup.visible = false;
          // Face the star (origin)
          const targetDirection = new THREE.Vector3(-posObj.x, -posObj.z, -posObj.y).normalize();
          const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), targetDirection);
          if (sailGroup) sailGroup.quaternion.copy(quaternion);
        }
        
        // 2. Orient limitCone to face the inward vector towards the star
        if (limitCone) {
          limitCone.visible = (posObj.segType === 'propagated');
          if (limitCone.visible) {
            const sunDirection = new THREE.Vector3(-posObj.x, -posObj.z, -posObj.y).normalize();
            const coneQuaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), sunDirection);
            limitCone.quaternion.copy(coneQuaternion);
          }
        }
      } else {
        // Global Mode (Zoomed out)
        if (modelGroup) modelGroup.visible = false;
        if (globalSphere) {
          globalSphere.visible = true;
          // Scale sphere indicator so it is a little smaller and fits clean spacing
          const sphereScale = THREE.MathUtils.clamp(camDist * 0.02, 0.15, 2.5);
          globalSphere.scale.setScalar(sphereScale);
        }
        
        // Dynamic scaling of locator arrow in global mode
        if (locatorArrow) {
          const relativeScale = THREE.MathUtils.clamp(camDist * 0.05, 0.5, 10.0);
          locatorArrow.scale.setScalar(relativeScale);
          locatorArrow.position.set(0, 0.20 * relativeScale, 0);
        }
      }
      
      if (isFollowingSpacecraft) {
        if (!spacecraftMesh.userData.lastPosition) {
          spacecraftMesh.userData.lastPosition = spacecraftMesh.position.clone();
        }
        const delta = new THREE.Vector3().subVectors(spacecraftMesh.position, spacecraftMesh.userData.lastPosition);
        spacecraftMesh.userData.lastPosition.copy(spacecraftMesh.position);
        
        camera.position.add(delta);
        controls.target.add(delta);
      } else {
        spacecraftMesh.userData.lastPosition = null;
      }
    } else {
      spacecraftMesh.visible = false;
    }

    // Update trajectory line draw range to only show trail up to renderTime
    if (trajectoryLine) {
      const count = getTrailIndex(trailPoints, renderTime);
      if (count > 0 && showTrajectoryTrail) {
        trajectoryLine.geometry.setDrawRange(0, count);
        trajectoryLine.visible = true;
      } else {
        trajectoryLine.visible = false;
      }
    }
  }

  updateCameraFocus(now);

  // Hover detection
  const hits = pointerActive
    ? (raycaster.setFromCamera(pointer, camera), raycaster.intersectObjects(planetRootMeshes, true))
    : [];
  if (hits.length > 0) {
    const idx = findPlanetIndex(hits[0].object);
    if (idx >= 0) {
      hoveredPlanet = planetMeshes[idx].planet;
      tooltip.style.display = 'block';
      tooltip.textContent = `${hoveredPlanet.name}  ·  w=${hoveredPlanet.weight}`;
      renderer.domElement.style.cursor = 'pointer';
    } else {
      hoveredPlanet = null;
      tooltip.style.display = 'none';
      renderer.domElement.style.cursor = 'default';
    }
  } else {
    hoveredPlanet = null;
    tooltip.style.display = 'none';
    renderer.domElement.style.cursor = 'default';
  }

  if (showAsteroids) updateAsteroidBelt(renderTime);
  if (showComets) updateComets(renderTime);

  // Star corona pulse
  starGroup.children[1].scale.setScalar(1 + 0.014 * Math.sin(now * 0.00028));
  starGroup.children[2].scale.setScalar(1 + 0.02 * Math.sin(now * 0.00018 + 1));

  // Update time display
  timeValue.textContent = renderTime.toFixed(2);

  if (activeMission) {
    const t_start = activeMission.timeRange.start_yr;
    const t_end = activeMission.timeRange.end_yr;
    const t_span = t_end - t_start;
    const progress = t_span > 0 ? ((renderTime - t_start) / t_span) * 100 : 0;
    
    if (document.activeElement !== timelineSlider) {
      timelineSlider.value = progress.toFixed(2);
    }
    
    if (timelineProgressText) {
      timelineProgressText.textContent = `${Math.max(0, Math.min(100, progress)).toFixed(1)}% (${renderTime.toFixed(2)} yr)`;
    }
    
    updateScoreUI(renderTime);
  }

  controls.update();
  if ((trackedPlanet || isFollowingSpacecraft) && !cameraFlight) {
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    
    // Safety clamp to prevent OrbitControls NaN crashes from extreme zoom collapse
    const dist = offset.length();
    const minDist = isFollowingSpacecraft ? 0.08 : 0.05;
    const maxDist = isFollowingSpacecraft ? 1.45 : 500.0;
    
    if (dist < minDist) {
      if (dist > 0.0001) {
        offset.setLength(minDist);
      } else {
        // Safe fallback direction pointing along positive X axis
        offset.set(minDist, 0, 0);
      }
      camera.position.copy(controls.target).add(offset);
    } else if (dist > maxDist) {
      offset.setLength(maxDist);
      camera.position.copy(controls.target).add(offset);
    }
    
    focusOffset.copy(offset);
  }
  updateFocusBannerScale();
  updatePlanetLabelScales(dt);
  composer.render();
}

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

// ─── Start ────────────────────────────────────────────────────────────────────
// Fade out loading screen
setTimeout(() => {
  const loading = document.getElementById('loading');
  loading.classList.add('fade-out');
  setTimeout(() => loading.remove(), 900);
}, 1900);

animate();
