// Real-time satellite tracking: SGP4 (satellite.js) on a tactical 3D globe or flat map.
import * as THREE from 'three';
import * as satlib from 'satellite.js';

const $ = (id) => document.getElementById(id);
const RE = 6378.137;
const C = 299792.458; // km/s
const RAD = Math.PI / 180;

// Frequencies in MHz. Linear transponders list the passband centre.
const SATS = [
  { id: 40931, name: 'IO-86', down: 435.880, up: 145.880, mode: 'FM · tone 88.5', color: '#ff2bd6' },
  { id: 25544, name: 'ISS', down: 437.800, up: 145.990, mode: 'FM repeater · tone 67.0', color: '#ffffff' },
  { id: 27607, name: 'SO-50', down: 436.795, up: 145.850, mode: 'FM · tone 67.0 (arm 74.4)', color: '#00f0ff' },
  { id: 43678, name: 'PO-101', down: 145.900, up: 437.500, mode: 'FM · tone 141.3 (scheduled)', color: '#ff6a3d' },
  { id: 43017, name: 'AO-91', down: 145.960, up: 435.250, mode: 'FM · tone 67.0', color: '#b78bff' },
  { id: 7530, name: 'AO-7', down: 145.950, up: 432.150, mode: 'Linear mode B (inverting)', color: '#ffe14d' },
  { id: 43803, name: 'JO-97', down: 145.865, up: 435.110, mode: 'Linear (inverting)', color: '#39ff14' },
  { id: 44909, name: 'RS-44', down: 435.640, up: 145.965, mode: 'Linear (inverting)', color: '#5aa9ff' }
];

let observer = null; // {latitude, longitude, height} in radians / km
let selected = SATS[0];
let flat = false;
let follow = false;
const cam = { lat: -6, lon: 110, zoom: 1 };

/* ---------- locator ---------- */
function gridToLatLon(grid) {
  const m = /^([A-R]{2})(\d{2})([A-X]{2})?$/i.exec(grid.trim());
  if (!m) return null;
  const field = m[1].toUpperCase();
  let lon = (field.charCodeAt(0) - 65) * 20 - 180 + Number(m[2][0]) * 2;
  let lat = (field.charCodeAt(1) - 65) * 10 - 90 + Number(m[2][1]);
  if (m[3]) {
    const sub = m[3].toUpperCase();
    lon += (sub.charCodeAt(0) - 65) / 12 + 1 / 24;
    lat += (sub.charCodeAt(1) - 65) / 24 + 1 / 48;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

let qth = null;
function setGrid(grid) {
  const pos = gridToLatLon(grid);
  if (!pos) return false;
  qth = pos;
  observer = { latitude: pos.lat * RAD, longitude: pos.lon * RAD, height: 0.05 };
  for (const s of SATS) s.pass = undefined;
  return true;
}

/* ---------- orbital mechanics ---------- */
function state(sat, date) {
  const pv = satlib.propagate(sat.rec, date);
  if (!pv.position) return null;
  const gmst = satlib.gstime(date);
  const geo = satlib.eciToGeodetic(pv.position, gmst);
  const look = satlib.ecfToLookAngles(observer, satlib.eciToEcf(pv.position, gmst));
  const v = pv.velocity;
  return {
    lat: satlib.degreesLat(geo.latitude),
    lon: satlib.degreesLong(geo.longitude),
    alt: geo.height,
    speed: Math.hypot(v.x, v.y, v.z),
    az: look.azimuth / RAD,
    el: look.elevation / RAD,
    range: look.rangeSat
  };
}

const elevation = (sat, t) => state(sat, new Date(t))?.el ?? -90;

// Next (or current) pass within 48 hours.
function findPass(sat, from) {
  const STEP = 30000;
  const edge = (lo, hi, rising) => {
    while (hi - lo > 1000) {
      const mid = (lo + hi) / 2;
      if ((elevation(sat, mid) > 0) === rising) hi = mid; else lo = mid;
    }
    return hi;
  };
  let t = from;
  const live = elevation(sat, t) > 0;
  let aos = live ? from : null;
  let max = 0;
  while (t < from + 48 * 3600e3) {
    const el = elevation(sat, t);
    if (el > 0) {
      if (aos === null) aos = edge(t - STEP, t, true);
      max = Math.max(max, el);
    } else if (aos !== null) {
      return { aos, los: edge(t - STEP, t, false), max, live };
    }
    t += STEP;
  }
  return aos === null ? null : { aos, los: null, max, live };
}

function groundTrack(sat, from, to, step) {
  const points = [];
  for (let t = from; t <= to; t += step) {
    const s = state(sat, new Date(t));
    if (s) points.push(s);
  }
  return points;
}

function footprint(s) {
  const lam = Math.acos(RE / (RE + s.alt));
  const la = s.lat * RAD;
  const lo = s.lon * RAD;
  const points = [];
  for (let b = 0; b <= 360; b += 4) {
    const br = b * RAD;
    const lat = Math.asin(Math.sin(la) * Math.cos(lam) + Math.cos(la) * Math.sin(lam) * Math.cos(br));
    const lon = lo + Math.atan2(
      Math.sin(br) * Math.sin(lam) * Math.cos(la),
      Math.cos(lam) - Math.sin(la) * Math.sin(lat)
    );
    points.push({ lat: lat / RAD, lon: ((lon / RAD + 540) % 360) - 180, alt: 0 });
  }
  return points;
}

/* ---------- elements ---------- */
const epochOf = (l1) => {
  const year = 2000 + Number(l1.slice(18, 20));
  return Date.UTC(year, 0, 1) + (Number(l1.slice(20, 32)) - 1) * 86400e3;
};

function apply(elements) {
  for (const sat of SATS) {
    const pair = elements[sat.id];
    if (!pair) continue;
    const epoch = epochOf(pair[0]);
    if (sat.epoch && epoch <= sat.epoch) continue; // keep the newer set
    sat.rec = satlib.twoline2satrec(pair[0], pair[1]);
    sat.epoch = epoch;
    sat.pass = undefined;
    sat.orbitAt = 0;
  }
}

async function liveElements() {
  const KEY = 'tle-amateur';
  try {
    const cached = JSON.parse(localStorage.getItem(KEY));
    // Celestrak asks clients not to re-download often.
    if (cached && Date.now() - cached.at < 6 * 3600e3) return cached.data;
  } catch { /* storage unavailable or corrupt: fetch again */ }

  const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle');
  if (!res.ok) throw new Error(`Celestrak ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).map((l) => l.trimEnd());
  const data = {};
  lines.forEach((line, i) => {
    if (line.startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      data[Number(line.slice(2, 7))] = [line, lines[i + 1]];
    }
  });
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* optional */ }
  return data;
}

/* ---------- 3D globe ---------- */
const stage = $('stage');
const canvas3d = $('globe');
const canvas2d = $('flatmap');
const g2 = canvas2d.getContext('2d');
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
} catch {
  flat = true;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x010c1c);
const camera = new THREE.PerspectiveCamera(40, 2, 0.1, 50);
const earth = new THREE.Group();
scene.add(earth);

const vec = (lat, lon, r = 1) => new THREE.Vector3(
  r * Math.cos(lat * RAD) * Math.sin(lon * RAD),
  r * Math.sin(lat * RAD),
  r * Math.cos(lat * RAD) * Math.cos(lon * RAD)
);
// Altitude is compressed a little so that high orbits stay on screen.
const lift = (alt) => 1.004 + (alt / RE) * 0.8;

function lineObject(color, opacity, segments = false) {
  const Type = segments ? THREE.LineSegments : THREE.Line;
  const line = new Type(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  line.frustumCulled = false;
  return line;
}
const setPoints = (line, points) => {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(points);
};

earth.add(new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshBasicMaterial({ color: 0x021833 })));
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(1.035, 96, 64),
  new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.07, side: THREE.BackSide })
));

const graticule = lineObject(0x00b4ff, 0.12, true);
{
  const points = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += 5) points.push(vec(lat, lon, 1.001), vec(lat, lon + 5, 1.001));
  }
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -90; lat < 90; lat += 5) points.push(vec(lat, lon, 1.001), vec(lat + 5, lon, 1.001));
  }
  setPoints(graticule, points);
}
earth.add(graticule);

const borderLines = lineObject(0x00b4ff, 0.55, true);
earth.add(borderLines);
let borders = []; // rings as flat [lon, lat, lon, lat, ...]

const orbitLine = lineObject(0x7dffe0, 0.9);
const footLine = lineObject(0x7dffe0, 0.9);
const linkLine = lineObject(0xffffff, 0.9);
earth.add(orbitLine, footLine, linkLine);

const trails = new Map(SATS.map((s) => {
  const line = lineObject(s.color, 0.55);
  earth.add(line);
  return [s.id, line];
}));

/* ---------- HTML markers shared by both views ---------- */
const layer = $('markers');
function marker(className, html) {
  const el = document.createElement(className === 'qth' ? 'div' : 'button');
  el.className = `marker ${className}`;
  el.innerHTML = html;
  layer.appendChild(el);
  return el;
}
const qthMarker = marker('qth', '<i></i><span>QTH</span>');
const icon = '<svg viewBox="-9 -9 18 18" aria-hidden="true"><g transform="rotate(45)">'
  + '<path d="M-8-2h5v4h-5zM3-2h5v4H3z" opacity=".65"/><path d="M-2-2h4v4h-4zM-.5-5h1v3h-1z"/></g></svg>';
for (const sat of SATS) {
  sat.el = marker('sat', `${icon}<span>${sat.name}</span>`);
  sat.el.type = 'button';
  sat.el.style.color = sat.color;
  sat.el.addEventListener('click', () => select(sat));
}

function place(el, x, y, show) {
  el.style.display = show ? '' : 'none';
  if (show) el.style.transform = `translate(${x}px, ${y}px)`;
}

/* ---------- flat map ---------- */
let size = { w: 1, h: 1 };
function mapRect() {
  const w = Math.min(size.w, size.h * 2);
  return { w, h: w / 2, x: (size.w - w) / 2, y: (size.h - w / 2) / 2 };
}
const toXY = (lat, lon, r = mapRect()) => [r.x + ((lon + 180) / 360) * r.w, r.y + ((90 - lat) / 180) * r.h];

function path2d(points, color, width) {
  const r = mapRect();
  g2.strokeStyle = color;
  g2.lineWidth = width;
  g2.beginPath();
  let prev = null;
  for (const p of points) {
    const [x, y] = toXY(p.lat, p.lon, r);
    if (prev === null || Math.abs(p.lon - prev) > 180) g2.moveTo(x, y); else g2.lineTo(x, y);
    prev = p.lon;
  }
  g2.stroke();
}

function drawFlat() {
  const r = mapRect();
  g2.fillStyle = '#010c1c';
  g2.fillRect(0, 0, size.w, size.h);
  g2.strokeStyle = 'rgba(0,180,255,0.14)';
  g2.lineWidth = 1;
  g2.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = toXY(0, lon, r);
    g2.moveTo(x, r.y);
    g2.lineTo(x, r.y + r.h);
  }
  for (let lat = -90; lat <= 90; lat += 30) {
    const [, y] = toXY(lat, 0, r);
    g2.moveTo(r.x, y);
    g2.lineTo(r.x + r.w, y);
  }
  g2.stroke();
  g2.strokeStyle = 'rgba(0,180,255,0.55)';
  g2.beginPath();
  for (const ring of borders) {
    for (let i = 0; i < ring.length; i += 2) {
      const [x, y] = toXY(ring[i + 1], ring[i], r);
      if (i === 0 || Math.abs(ring[i] - ring[i - 2]) > 180) g2.moveTo(x, y); else g2.lineTo(x, y);
    }
  }
  g2.stroke();
  for (const sat of SATS) if (sat.trail) path2d(sat.trail, sat.color, sat === selected ? 2 : 1);
  if (selected.orbit) path2d(selected.orbit, 'rgba(125,255,224,0.6)', 1);
  if (selected.now) path2d(footprint(selected.now), '#7dffe0', 2);
}

/* ---------- update ---------- */
const fmtClock = (ms) => new Date(ms).toISOString().slice(11, 16);
const fmtSpan = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${h ? `${h}:` : ''}${m}:${String(s % 60).padStart(2, '0')}`;
};

const tbody = $('passes');
for (const sat of SATS) {
  const row = tbody.insertRow();
  const name = document.createElement('button');
  name.type = 'button';
  name.textContent = sat.name;
  name.style.color = sat.color;
  name.addEventListener('click', () => select(sat));
  row.insertCell().appendChild(name);
  sat.cells = [1, 2, 3, 4, 5].map(() => row.insertCell());
  sat.row = row;
}

function select(sat) {
  selected = sat;
  for (const s of SATS) {
    s.el.classList.toggle('sel', s === sat);
    s.row.classList.toggle('sel', s === sat);
  }
  update();
}

function telemetry() {
  const sat = selected;
  const now = Date.now();
  $('t-name').textContent = sat.name;
  $('t-mode').textContent = sat.mode;
  if (!sat.now) {
    $('t-body').textContent = 'No orbital elements.';
    return;
  }
  const s = sat.now;
  const later = state(sat, new Date(now + 1000));
  const rate = later ? later.range - s.range : 0; // km/s, positive when receding
  const down = sat.down * (1 - rate / C);
  const up = sat.up * (1 + rate / C);
  const age = (now - sat.epoch) / 86400e3;
  const rows = [
    ['Status', s.el > 0 ? 'IN VIEW' : 'below horizon'],
    ['Azimuth', `${s.az.toFixed(1)}°`],
    ['Elevation', `${s.el.toFixed(1)}°`],
    ['Range', `${Math.round(s.range)} km`],
    ['Altitude', `${Math.round(s.alt)} km`],
    ['Speed', `${s.speed.toFixed(2)} km/s`],
    ['Sub-point', `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`],
    ['RX (Doppler)', `${down.toFixed(4)} MHz`],
    ['TX (Doppler)', `${up.toFixed(4)} MHz`],
    ['TLE age', `${age.toFixed(1)} d${age > 14 ? ' (stale)' : ''}`]
  ];
  $('t-body').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

let passBudget = 0;
function update() {
  if (!observer) return;
  const now = Date.now();
  const date = new Date(now);
  passBudget = 1; // at most one 48 h pass search per tick keeps the page smooth

  for (const sat of SATS) {
    if (!sat.rec) continue;
    sat.now = state(sat, date);
    if (!sat.now) continue;

    if (!sat.orbitAt || now - sat.orbitAt > 20000) {
      const period = ((2 * Math.PI) / sat.rec.no) * 60000;
      sat.trail = groundTrack(sat, now - period * 0.16, now, period / 150);
      sat.orbit = groundTrack(sat, now, now + period, period / 180);
      sat.orbitAt = now;
    }

    const expired = sat.pass && sat.pass.los !== null && sat.pass.los < now;
    if ((sat.pass === undefined || expired) && passBudget) {
      passBudget--;
      sat.pass = findPass(sat, now);
    }

    const [az, el, aos, max, los] = sat.cells;
    az.textContent = `${sat.now.az.toFixed(0)}°`;
    el.textContent = `${sat.now.el.toFixed(0)}°`;
    sat.row.classList.toggle('up', sat.now.el > 0);
    const p = sat.pass;
    if (p === undefined) { aos.textContent = '…'; max.textContent = ''; los.textContent = ''; }
    else if (p === null) { aos.textContent = 'none in 48 h'; max.textContent = ''; los.textContent = ''; }
    else {
      aos.textContent = p.aos <= now ? 'IN VIEW' : `${fmtClock(p.aos)} (${fmtSpan(p.aos - now)})`;
      max.textContent = `${p.max.toFixed(0)}°`;
      los.textContent = p.los === null ? '—' : fmtClock(p.los);
    }
  }
  telemetry();
  updateScene();
}

function updateScene() {
  for (const sat of SATS) {
    const line = trails.get(sat.id);
    if (!sat.now || !sat.trail) continue;
    setPoints(line, [...sat.trail, sat.now].map((p) => vec(p.lat, p.lon, lift(p.alt))));
    line.material.opacity = sat === selected ? 1 : 0.45;
  }
  const s = selected.now;
  const here = vec(qth.lat, qth.lon, 1.004);
  setPoints(orbitLine, s ? selected.orbit.map((p) => vec(p.lat, p.lon, lift(p.alt))) : []);
  setPoints(footLine, s ? footprint(s).map((p) => vec(p.lat, p.lon, 1.006)) : []);
  setPoints(linkLine, s && s.el > 0 ? [here, vec(s.lat, s.lon, lift(s.alt))] : []);
  render();
}

const projected = new THREE.Vector3();
function placeGlobe(el, lat, lon, r) {
  projected.copy(vec(lat, lon, r)).applyMatrix4(earth.matrixWorld);
  // Hidden when behind the globe's silhouette.
  const hidden = projected.z < 0 && Math.hypot(projected.x, projected.y) < 1;
  projected.project(camera);
  place(el, ((projected.x + 1) / 2) * size.w, ((1 - projected.y) / 2) * size.h, !hidden);
}

function render() {
  if (!observer) return;
  if (follow && selected.now) {
    cam.lat = selected.now.lat;
    cam.lon = selected.now.lon;
  }
  if (flat) {
    drawFlat();
    place(qthMarker, ...toXY(qth.lat, qth.lon), true);
    for (const sat of SATS) {
      if (sat.now) place(sat.el, ...toXY(sat.now.lat, sat.now.lon), true);
      else place(sat.el, 0, 0, false);
    }
  } else {
    earth.rotation.set(cam.lat * RAD, -cam.lon * RAD, 0);
    earth.updateMatrixWorld();
    camera.position.z = 3.6 / cam.zoom;
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    placeGlobe(qthMarker, qth.lat, qth.lon, 1.004);
    for (const sat of SATS) {
      if (sat.now) placeGlobe(sat.el, sat.now.lat, sat.now.lon, lift(sat.now.alt));
      else place(sat.el, 0, 0, false);
    }
  }
}

function resize() {
  size = { w: stage.clientWidth, h: stage.clientHeight };
  if (!size.w || !size.h) return;
  const ratio = Math.min(devicePixelRatio, 2);
  canvas2d.width = size.w * ratio;
  canvas2d.height = size.h * ratio;
  g2.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (renderer) {
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    // Narrow stages need a wider vertical field to fit the globe.
    camera.fov = camera.aspect < 1 ? 40 / camera.aspect : 40;
    camera.updateProjectionMatrix();
  }
  render();
}

/* ---------- controls ---------- */
function setView(next) {
  flat = next || !renderer;
  canvas3d.hidden = flat;
  canvas2d.hidden = !flat;
  $('view').textContent = flat ? '3D globe' : '2D map';
  render();
}

let drag = null;
canvas3d.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas3d.setPointerCapture(e.pointerId);
});
canvas3d.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const speed = 0.3 / cam.zoom;
  cam.lon = ((cam.lon - (e.clientX - drag.x) * speed + 540) % 360) - 180;
  cam.lat = Math.max(-85, Math.min(85, cam.lat + (e.clientY - drag.y) * speed));
  drag = { x: e.clientX, y: e.clientY };
  follow = false;
  $('follow').setAttribute('aria-pressed', 'false');
  render();
});
for (const type of ['pointerup', 'pointercancel']) canvas3d.addEventListener(type, () => { drag = null; });

const zoom = (factor) => { cam.zoom = Math.max(0.7, Math.min(2.6, cam.zoom * factor)); render(); };
// Ctrl + wheel (or pinch on a touchpad) zooms; a plain wheel keeps scrolling the page.
canvas3d.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });
$('zin').addEventListener('click', () => zoom(1.2));
$('zout').addEventListener('click', () => zoom(1 / 1.2));
$('view').addEventListener('click', () => setView(!flat));
$('follow').addEventListener('click', (e) => {
  follow = !follow;
  e.currentTarget.setAttribute('aria-pressed', String(follow));
  render();
});
$('home').addEventListener('click', () => {
  follow = false;
  $('follow').setAttribute('aria-pressed', 'false');
  Object.assign(cam, { lat: qth.lat, lon: qth.lon, zoom: 1 });
  render();
});
$('grid').addEventListener('change', (e) => {
  const ok = setGrid(e.target.value);
  e.target.setAttribute('aria-invalid', String(!ok));
  if (ok) { Object.assign(cam, { lat: qth.lat, lon: qth.lon }); update(); }
});

/* ---------- start ---------- */
setGrid('OI33it');
new ResizeObserver(resize).observe(stage);
setView(flat);
select(selected);

let onScreen = false;
let timer = 0;
new IntersectionObserver(([entry]) => {
  onScreen = entry.isIntersecting;
  clearInterval(timer);
  if (onScreen) {
    update();
    timer = setInterval(update, 1000);
  }
}, { rootMargin: '200px' }).observe($('track'));

fetch('data/borders.json').then((r) => r.json()).then((rings) => {
  borders = rings;
  const points = [];
  for (const ring of rings) {
    for (let i = 2; i < ring.length; i += 2) {
      points.push(vec(ring[i - 1], ring[i - 2], 1.002), vec(ring[i + 1], ring[i], 1.002));
    }
  }
  setPoints(borderLines, points);
  render();
}).catch(() => { $('t-status').textContent = 'Map data failed to load.'; });

(async () => {
  const status = $('t-status');
  try {
    apply(await (await fetch('data/tle.json', { cache: 'no-cache' })).json());
    status.textContent = 'TLE: stored snapshot';
  } catch {
    status.textContent = 'TLE snapshot missing';
  }
  update();
  try {
    apply(await liveElements());
    status.textContent = 'TLE: Celestrak live + snapshot (IO-86: SatNOGS)';
  } catch {
    status.textContent += ' · Celestrak unreachable';
  }
  update();
})();
