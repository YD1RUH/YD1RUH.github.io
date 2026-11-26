import * as THREE from 'three';

const canvas = document.getElementById('scene');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (err) {
  document.body.classList.add('no-webgl');
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));

const BG = 0x010a18;
const GREEN = 0x00c8ff;
const CYAN = 0x4df3ff;
const PINK = 0x2f7bff;
const AMBER = 0x7dffe0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 600);

const line = (points, color, opacity = 1) => new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(points),
  new THREE.LineBasicMaterial({ color, transparent: true, opacity })
);
const circle = (radius, color, opacity, segments = 96) => {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return line(points, color, opacity);
};

/* ---------- scrolling wireframe terrain ---------- */
const terrainUniforms = { uTime: { value: 0 } };
const terrain = new THREE.Mesh(
  new THREE.PlaneGeometry(240, 240, 120, 120).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    uniforms: terrainUniforms,
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec2 vGrid;
      varying float vHeight;
      varying float vDist;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }

      void main() {
        vec3 p = position;
        vec2 world = vec2(p.x, p.z - uTime * 7.0);
        float valley = smoothstep(8.0, 45.0, abs(p.x));
        float h = (noise(world * 0.07) * 14.0 + noise(world * 0.19) * 4.0) * valley;
        p.y += h;
        vGrid = world / 4.0;
        vHeight = h;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec2 vGrid;
      varying float vHeight;
      varying float vDist;

      void main() {
        vec2 g = abs(fract(vGrid - 0.5) - 0.5) / fwidth(vGrid);
        float lineMask = 1.0 - min(min(g.x, g.y), 1.0);
        vec3 base = vec3(0.004, 0.039, 0.094);
        vec3 neon = mix(vec3(0.0, 0.36, 1.0), vec3(0.3, 0.95, 1.0), clamp(vHeight / 12.0, 0.0, 1.0));
        float fog = smoothstep(40.0, 130.0, vDist);
        gl_FragColor = vec4(mix(mix(base, neon, lineMask), base, fog), 1.0);
      }
    `
  })
);
terrain.position.set(0, -14, -70);
scene.add(terrain);

/* ---------- striped 80's sun ---------- */
const sun = new THREE.Mesh(
  new THREE.CircleGeometry(38, 96),
  new THREE.ShaderMaterial({
    transparent: true,
    uniforms: terrainUniforms,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vec3 color = mix(vec3(0.02, 0.25, 0.9), vec3(0.45, 1.0, 0.95), vUv.y);
        float band = fract(vUv.y * 18.0 + uTime * 0.25);
        float gap = step(band, (0.62 - vUv.y) * 1.1);
        gl_FragColor = vec4(color * 0.8, 1.0 - gap);
      }
    `
  })
);
sun.position.set(0, 4, -190);
scene.add(sun);

/* ---------- stars ---------- */
const starPositions = [];
for (let i = 0; i < 1400; i++) {
  starPositions.push((Math.random() - 0.5) * 500, Math.random() * 180 - 20, -200 - Math.random() * 60);
}
const stars = new THREE.Points(
  new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3)),
  new THREE.PointsMaterial({ color: 0xbfe9ff, size: 0.8 })
);
scene.add(stars);

/* ---------- globe with ground station and satellites ---------- */
const station = new THREE.Group();
scene.add(station);

const R = 5;
const globe = new THREE.Group();
station.add(globe);
// Opaque core hides the far side of the wireframe.
globe.add(new THREE.Mesh(
  new THREE.SphereGeometry(R * 0.98, 48, 32),
  new THREE.MeshBasicMaterial({ color: 0x021a33 })
));
for (let lat = -75; lat <= 75; lat += 15) {
  const ring = circle(R * Math.cos(THREE.MathUtils.degToRad(lat)), GREEN, lat === 0 ? 0.9 : 0.35);
  ring.position.y = R * Math.sin(THREE.MathUtils.degToRad(lat));
  globe.add(ring);
}
for (let lon = 0; lon < 180; lon += 15) {
  const ring = circle(R, GREEN, 0.35);
  ring.rotation.set(Math.PI / 2, 0, THREE.MathUtils.degToRad(lon));
  globe.add(ring);
}

// Grid OI33it, western Java.
const toSphere = (lat, lon, radius) => new THREE.Vector3().setFromSphericalCoords(
  radius,
  THREE.MathUtils.degToRad(90 - lat),
  THREE.MathUtils.degToRad(lon + 90)
);
const qth = toSphere(-6.2, 106.7, R * 1.01);
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshBasicMaterial({ color: AMBER }));
marker.position.copy(qth);
globe.add(marker);

const pulse = circle(0.5, AMBER, 1, 40);
pulse.position.copy(qth);
pulse.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), qth.clone().normalize());
globe.add(pulse);

// Turn the globe so that Indonesia faces the camera at start.
const startYaw = -Math.atan2(qth.x, qth.z);

const label = (text, color) => {
  const c = document.createElement('canvas');
  c.width = 384;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '36px "Share Tech Mono", monospace';
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, 192, 32);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(7.2, 1.2, 1);
  // Offset on Y only, so the label stays put while the satellite body yaws.
  sprite.position.set(0, 0.9, 0);
  return sprite;
};

const edges = (geometry, color) => new THREE.LineSegments(
  new THREE.EdgesGeometry(geometry),
  new THREE.LineBasicMaterial({ color })
);

const satellites = [
  { name: 'NOAA', radius: 6.6, tilt: [1.2, 0.3], speed: 0.5, phase: 0.5 },
  { name: 'FALCONSAT-3', radius: 7.4, tilt: [0.4, -0.5], speed: 0.38, phase: 2.4 },
  { name: 'ISS', radius: 8.1, tilt: [-0.55, 0.35], speed: 0.3, phase: 4.1 },
  { name: 'GK-2A', radius: 9.2, tilt: [0.12, 0.1], speed: 0.12, phase: 5.6 }
].map((cfg) => {
  const orbit = new THREE.Group();
  orbit.rotation.set(cfg.tilt[0], 0, cfg.tilt[1]);
  orbit.add(circle(cfg.radius, CYAN, 0.3, 128));

  const body = new THREE.Group();
  body.add(edges(new THREE.BoxGeometry(0.4, 0.4, 0.4), PINK));
  for (const side of [-1, 1]) {
    const panel = edges(new THREE.BoxGeometry(0.7, 0.04, 0.35), CYAN);
    panel.position.x = side * 0.6;
    body.add(panel);
  }
  body.add(label(cfg.name, '#4df3ff'));
  orbit.add(body);
  station.add(orbit);
  return { ...cfg, body };
});

// Downlink beam from the ground station to whichever satellite is nearest.
const beam = line([new THREE.Vector3(), new THREE.Vector3()], AMBER, 0.9);
beam.material.dispose();
beam.material = new THREE.LineDashedMaterial({ color: AMBER, dashSize: 0.3, gapSize: 0.2 });
station.add(beam);

/* ---------- radar scope under the globe ---------- */
const radar = new THREE.Group();
for (const r of [3, 6, 9]) radar.add(circle(r, GREEN, 0.5));
for (let i = 0; i < 4; i++) {
  const a = (i / 4) * Math.PI;
  const v = new THREE.Vector3(Math.cos(a) * 9, 0, Math.sin(a) * 9);
  radar.add(line([v, v.clone().negate()], GREEN, 0.3));
}
const sweep = new THREE.Mesh(
  new THREE.CircleGeometry(9, 32, 0, Math.PI / 5).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false })
);
radar.add(sweep);
radar.position.y = -7.5;
station.add(radar);

/* ---------- layout, input, loop ---------- */
let stationX = 0;
let stationY = 0;
let scroll = 0;
const pointer = new THREE.Vector2();

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  // Wide screens: globe beside the title. Narrow screens: globe above it.
  const wide = w > 760;
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 34;
  const halfWidth = halfHeight * camera.aspect;
  stationX = wide ? halfWidth * 0.45 : 0;
  stationY = wide ? 0 : halfHeight * 0.4;
  station.scale.setScalar(wide ? Math.min(1, halfWidth / 24) : Math.min(0.75, halfWidth / 11));
}

const onScroll = () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  scroll = max > 0 ? scrollY / max : 0;
};

addEventListener('resize', () => { resize(); onScroll(); if (reduced) draw(0); });
addEventListener('scroll', onScroll, { passive: true });
addEventListener('pointermove', (e) => {
  pointer.set(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5);
}, { passive: true });

const satPos = new THREE.Vector3();
const nearest = new THREE.Vector3();
const qthNow = new THREE.Vector3();

function draw(time) {
  terrainUniforms.uTime.value = time;

  globe.rotation.y = startYaw + time * 0.12;
  qthNow.copy(qth).applyEuler(globe.rotation);

  let best = Infinity;
  for (const sat of satellites) {
    const a = sat.phase + time * sat.speed;
    sat.body.position.set(Math.cos(a) * sat.radius, 0, Math.sin(a) * sat.radius);
    sat.body.rotation.y = -a;
    satPos.copy(sat.body.position).applyEuler(sat.body.parent.rotation);
    const d = satPos.distanceTo(qthNow);
    if (d < best) { best = d; nearest.copy(satPos); }
  }
  // Show the link only while the station can actually see the satellite.
  beam.visible = nearest.clone().sub(qthNow).dot(qthNow) > 0;
  const p = beam.geometry.attributes.position;
  p.setXYZ(0, qthNow.x, qthNow.y, qthNow.z);
  p.setXYZ(1, nearest.x, nearest.y, nearest.z);
  p.needsUpdate = true;
  beam.computeLineDistances();

  const wave = (time * 0.8) % 1;
  pulse.scale.setScalar(0.3 + wave * 2);
  pulse.material.opacity = 1 - wave;
  sweep.rotation.y = -time * 1.6;

  // The globe drifts up and away while the page scrolls past the hero.
  const leave = Math.min(scrollY / innerHeight, 1);
  station.position.set(stationX, stationY + leave * 16, -leave * 20);

  camera.position.x += (pointer.x * 3 - camera.position.x) * 0.05;
  camera.position.y += (2 - pointer.y * 2 - scroll * 5 - camera.position.y) * 0.05;
  camera.position.z = 34;
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
}

resize();
onScroll();
camera.position.set(0, 2, 34);

if (reduced) {
  draw(0);
  addEventListener('scroll', () => draw(0), { passive: true });
} else {
  const clock = new THREE.Clock();
  let time = 0;
  renderer.setAnimationLoop(() => {
    // Clamp the delta so a background tab does not make the scene jump.
    time += Math.min(clock.getDelta(), 0.05);
    draw(time);
  });
}
