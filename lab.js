import {
  ToneGen, CwDemod, makeRttyDemod, makeAsciiDemod,
  baudotEncode, cwSegments, fskSegments, fftMagnitude
} from './dsp.js';

const $ = (id) => document.getElementById(id);

const PRESETS = {
  cw: { type: 'cw', center: 700, wpm: 18 },
  rtty45: { type: 'rtty', center: 2210, shift: 170, baud: 45.45, bits: 5, stopBits: 1.5 },
  rtty75: { type: 'rtty', center: 2210, shift: 170, baud: 75, bits: 5, stopBits: 1.5 },
  fsk300: { type: 'fsk', center: 1700, shift: 200, baud: 300, bits: 8, stopBits: 1 },
  fsk1200: { type: 'fsk', center: 1700, shift: 1000, baud: 1200, bits: 8, stopBits: 1 }
};

const BLOCK = 1024;
const FFT = 2048;
const SPAN = 3000; // Hz shown on spectrum and waterfall

let ctx = null;
let gain = null;
let gen = null;
let demod = null;
let mic = null;
let timer = 0;
let nextTime = 0;
let preset = PRESETS.cw;
let rxCenter = preset.center;
let txText = '';
let lastDb = null;
let rms = 1e-9;
let peakHold = -90;
const recent = new Float32Array(FFT);
let recentPos = 0;
let rows = 0; // spectrum frames not yet painted on the waterfall

const wpm = () => Number($('wpm').value);
const txCenter = () => Number($('txfreq').value);
const tones = (center) => (preset.type === 'cw'
  ? [center]
  // Mark is the lower tone for amateur AFSK/RTTY audio here; space = mark + shift.
  : [center - preset.shift / 2, center + preset.shift / 2]);

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function print(ch) {
  const log = $('rxlog');
  log.textContent = (log.textContent + ch).slice(-1500);
  log.scrollTop = log.scrollHeight;
}

function buildDemod() {
  if (!ctx) return;
  if (preset.type === 'cw') {
    demod = new CwDemod(ctx.sampleRate, { wpm: wpm(), center: rxCenter }, print);
  } else {
    const [mark, space] = tones(rxCenter);
    const make = preset.type === 'rtty' ? makeRttyDemod : makeAsciiDemod;
    demod = make(ctx.sampleRate, { baud: preset.baud, mark, space }, print);
  }
}

function send() {
  const text = txText;
  if (preset.type === 'cw') {
    gen.queue.push(...cwSegments(text, { wpm: wpm(), center: txCenter() }));
    return;
  }
  const [mark, space] = tones(txCenter());
  const codes = preset.type === 'rtty'
    ? baudotEncode(`\n${text}`)
    : [...`\n${text}`].map((c) => c.charCodeAt(0)).filter((c) => c < 128);
  gen.queue.push(...fskSegments(codes, { ...preset, mark, space }));
}

// Everything the receiver sees goes through here: loopback blocks or microphone blocks.
function receive(block) {
  let sum = 0;
  for (const x of block) {
    sum += x * x;
    recent[recentPos] = x;
    recentPos = (recentPos + 1) % FFT;
  }
  rms = Math.sqrt(sum / block.length);
  demod.process(block);

  const ordered = new Float32Array(FFT);
  ordered.set(recent.subarray(recentPos));
  ordered.set(recent.subarray(0, recentPos), FFT - recentPos);
  lastDb = fftMagnitude(ordered);
  rows = Math.min(rows + 1, 8);
}

function pump() {
  if (ctx.state !== 'running') return;
  // A throttled background tab falls behind; skip ahead instead of bursting.
  if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.02;
  while (nextTime < ctx.currentTime + 0.15) {
    const wasBusy = gen.busy;
    const tx = new Float32Array(BLOCK);
    gen.fill(tx);

    const buffer = ctx.createBuffer(1, BLOCK, ctx.sampleRate);
    const out = buffer.getChannelData(0);
    if (mic) {
      out.set(tx); // speaker carries the clean signal for another device to receive
    } else {
      const sigma = (0.5 / Math.SQRT2) * 10 ** (-Number($('snr').value) / 20);
      for (let i = 0; i < BLOCK; i++) out[i] = Math.max(-1, Math.min(1, tx[i] + sigma * gaussian()));
      receive(out);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(nextTime);
    nextTime += BLOCK / ctx.sampleRate;

    if (wasBusy && !gen.busy && $('repeat').checked && txText) send();
  }
}

async function power(on) {
  if (on) {
    if (!ctx) {
      ctx = new AudioContext();
      gain = ctx.createGain();
      gain.connect(ctx.destination);
      gen = new ToneGen(ctx.sampleRate);
      buildDemod();
    }
    gain.gain.value = Number($('vol').value) / 100;
    await ctx.resume();
    nextTime = 0;
    clearInterval(timer);
    timer = setInterval(pump, 25);
    requestAnimationFrame(draw);
  } else if (ctx) {
    clearInterval(timer);
    stopMic();
    gen.clear();
    gen.keyFreq = 0;
    await ctx.suspend();
  }
  $('power').textContent = on ? '■ Power off' : '▶ Power on';
  $('power').setAttribute('aria-pressed', String(on));
  $('lab-state').textContent = on ? 'RX ACTIVE · LOOPBACK' : 'STANDBY';
}

const isOn = () => ctx !== null && ctx.state === 'running';

function stopMic() {
  if (!mic) return;
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.source.disconnect();
  mic.node.disconnect();
  mic = null;
  $('mic').checked = false;
}

async function startMic() {
  await power(true);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  const code = `
    registerProcessor('tap', class extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(${BLOCK}); this.n = 0; }
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) for (const x of ch) {
          this.buf[this.n++] = x;
          if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
        }
        return true;
      }
    });`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  if (!ctx.tapLoaded) {
    await ctx.audioWorklet.addModule(url);
    ctx.tapLoaded = true;
  }
  URL.revokeObjectURL(url);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'tap');
  node.port.onmessage = (e) => { if (mic) receive(e.data); };
  source.connect(node);
  // The node outputs silence; connecting it keeps it processing.
  node.connect(ctx.destination);
  mic = { stream, source, node };
  buildDemod();
  $('lab-state').textContent = 'RX ACTIVE · MICROPHONE';
}

/* ---------- drawing ---------- */
const view = (id) => {
  const canvas = $(id);
  return { canvas, g: canvas.getContext('2d'), w: canvas.width, h: canvas.height };
};
const spec = view('spectrum');
const fall = view('waterfall');
const eye = view('eye');
const meter = view('meter');
fall.g.fillStyle = '#000';
fall.g.fillRect(0, 0, fall.w, fall.h);

function heat(v) {
  // deep navy, blue, azure, cyan, white
  const stops = [[0, 6, 20], [0, 40, 120], [0, 130, 255], [77, 243, 255], [255, 255, 255]];
  const t = Math.max(0, Math.min(0.999, v)) * (stops.length - 1);
  const i = Math.floor(t);
  const f = t - i;
  return stops[i].map((c, k) => c + (stops[i + 1][k] - c) * f);
}

function drawSpectrum() {
  const { g, w, h } = spec;
  g.fillStyle = '#020c1a';
  g.fillRect(0, 0, w, h);
  g.font = '12px "Share Tech Mono", monospace';
  const y = (db) => h - ((db + 90) / 90) * h;
  g.strokeStyle = 'rgba(0,200,255,0.18)';
  g.fillStyle = '#8cd';
  g.beginPath();
  for (let db = -20; db > -90; db -= 20) {
    g.moveTo(0, y(db));
    g.lineTo(w, y(db));
    g.fillText(`${db} dB`, 4, y(db) - 3);
  }
  for (let f = 500; f < SPAN; f += 500) {
    const x = (f / SPAN) * w;
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.fillText(`${f}`, x + 3, h - 4);
  }
  g.stroke();

  tones(rxCenter).forEach((f, i) => {
    g.fillStyle = i ? 'rgba(47,123,255,0.8)' : 'rgba(125,255,224,0.85)';
    const x = (f / SPAN) * w;
    g.fillRect(x - 1, 0, 2, h);
    g.fillText(preset.type === 'cw' ? 'TONE' : i ? 'S' : 'M', x + 4, 13 + i * 13);
  });

  if (!lastDb) return;
  const hzPerBin = ctx.sampleRate / FFT;
  g.strokeStyle = '#00c8ff';
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const v = y(lastDb[Math.round(((x / w) * SPAN) / hzPerBin)]);
    if (x) g.lineTo(x, v); else g.moveTo(x, v);
  }
  g.stroke();
}

function drawWaterfall() {
  if (!rows || !lastDb) return;
  const { canvas, g, w, h } = fall;
  const step = Math.min(rows, 4);
  rows = 0;
  g.drawImage(canvas, 0, 0, w, h - step, 0, step, w, h - step);
  const line = g.createImageData(w, step);
  const hzPerBin = ctx.sampleRate / FFT;
  for (let x = 0; x < w; x++) {
    const [r, gr, b] = heat((lastDb[Math.round(((x / w) * SPAN) / hzPerBin)] + 80) / 70);
    for (let row = 0; row < step; row++) line.data.set([r, gr, b, 255], (row * w + x) * 4);
  }
  g.putImageData(line, 0, 0);
}

function drawEye() {
  const { g, w, h } = eye;
  g.fillStyle = '#020c1a';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(0,200,255,0.2)';
  g.beginPath();
  for (const x of [0.25, 0.5, 0.75]) { g.moveTo(w * x, 0); g.lineTo(w * x, h); }
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  if (!demod) return;
  g.strokeStyle = 'rgba(77,243,255,0.35)';
  for (const trace of demod.history.traces()) {
    g.beginPath();
    trace.forEach((v, i) => {
      const x = (i / (trace.length - 1)) * w;
      const y = h / 2 - v * h * 0.44;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.stroke();
  }
}

function drawMeter() {
  const { g, w, h } = meter;
  const db = Math.max(-60, 20 * Math.log10(rms + 1e-9));
  peakHold = Math.max(db, peakHold - 0.4);
  const quality = Math.max(0, Math.min(1, demod ? demod.quality : 0));
  g.clearRect(0, 0, w, h);
  g.font = '13px "Share Tech Mono", monospace';
  const bar = (y, label, value, text) => {
    const segments = 40;
    const left = 62;
    const width = w - left - 82;
    g.fillStyle = '#7dffe0';
    g.fillText(label, 0, y + 13);
    for (let i = 0; i < segments; i++) {
      const lit = i / segments < value;
      const color = i > 33 ? '255,255,255' : i > 26 ? '125,255,224' : '0,200,255';
      g.fillStyle = `rgba(${color},${lit ? 1 : 0.13})`;
      g.fillRect(left + (i * width) / segments, y, width / segments - 2, 16);
    }
    g.fillStyle = '#cfeaff';
    g.fillText(text, w - 74, y + 13);
    return { left, width };
  };
  const power_ = bar(4, 'POWER', (db + 60) / 60, `${db.toFixed(0)} dBFS`);
  g.fillStyle = '#fff';
  g.fillRect(power_.left + ((peakHold + 60) / 60) * power_.width, 4, 2, 16);
  bar(30, 'SIGNAL', quality, `${Math.round(quality * 100)} %`);
}

let visible = false;
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  if (visible && isOn()) requestAnimationFrame(draw);
}).observe($('lab'));

let drawing = false;
function draw() {
  if (drawing) return;
  drawing = true;
  const frame = () => {
    drawSpectrum();
    drawWaterfall();
    drawEye();
    drawMeter();
    $('txstate').textContent = gen && gen.busy ? '● TX' : '○ IDLE';
    if (visible && isOn()) requestAnimationFrame(frame);
    else drawing = false;
  };
  frame();
}

/* ---------- controls ---------- */
function setMode(name) {
  preset = PRESETS[name];
  rxCenter = preset.center;
  $('txfreq').value = preset.center;
  $('txfreq-out').textContent = `${preset.center} Hz`;
  $('rxfreq-out').textContent = `${preset.center} Hz`;
  $('wpm').disabled = preset.type !== 'cw';
  $('key').disabled = preset.type !== 'cw';
  if (gen) { gen.clear(); gen.keyFreq = 0; }
  $('rxlog').textContent = '';
  buildDemod();
}

$('power').addEventListener('click', () => power(!isOn()));
$('mode').addEventListener('change', (e) => setMode(e.target.value));
$('tx').addEventListener('click', async () => {
  await power(true);
  txText = $('txtext').value.trim();
  if (txText) send();
});
$('stop').addEventListener('click', () => {
  $('repeat').checked = false;
  gen?.clear();
});
$('clear').addEventListener('click', () => { $('rxlog').textContent = ''; });
$('snr').addEventListener('input', (e) => { $('snr-out').textContent = `${e.target.value} dB`; });
$('vol').addEventListener('input', (e) => { if (gain) gain.gain.value = e.target.value / 100; });
$('wpm').addEventListener('input', (e) => { $('wpm-out').textContent = `${e.target.value}`; });
$('wpm').addEventListener('change', buildDemod);
$('txfreq').addEventListener('input', (e) => { $('txfreq-out').textContent = `${e.target.value} Hz`; });

// Tune the receiver by clicking the spectrum or the waterfall.
for (const { canvas } of [spec, fall]) {
  canvas.addEventListener('click', (e) => {
    const box = canvas.getBoundingClientRect();
    rxCenter = Math.round(Math.max(200, Math.min(SPAN - 200, ((e.clientX - box.left) / box.width) * SPAN)));
    $('rxfreq-out').textContent = `${rxCenter} Hz`;
    buildDemod();
    if (!isOn()) drawSpectrum();
  });
}
$('retune').addEventListener('click', () => {
  rxCenter = txCenter();
  $('rxfreq-out').textContent = `${rxCenter} Hz`;
  buildDemod();
});

$('mic').addEventListener('change', async (e) => {
  if (e.target.checked) {
    try {
      await startMic();
    } catch (err) {
      e.target.checked = false;
      $('lab-state').textContent = `MIC ERROR: ${err.message}`;
    }
  } else {
    stopMic();
    $('lab-state').textContent = 'RX ACTIVE · LOOPBACK';
  }
});

// Straight key: hold the button (pointer, Space or Enter).
const key = $('key');
const keyDown = async () => {
  if (!isOn()) await power(true);
  gen.keyFreq = txCenter();
  key.classList.add('down');
};
const keyUp = () => {
  if (gen) gen.keyFreq = 0;
  key.classList.remove('down');
};
key.addEventListener('pointerdown', (e) => { key.setPointerCapture(e.pointerId); keyDown(); });
key.addEventListener('pointerup', keyUp);
key.addEventListener('pointercancel', keyUp);
key.addEventListener('blur', keyUp);
key.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  e.preventDefault();
  if (!e.repeat) keyDown();
});
key.addEventListener('keyup', (e) => { if (e.code === 'Space' || e.code === 'Enter') keyUp(); });
key.addEventListener('contextmenu', (e) => e.preventDefault());

setMode('cw');
drawSpectrum();
drawEye();
drawMeter();
