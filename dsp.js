// Pure DSP for the signal lab: CW, RTTY (ITA2) and 2-FSK. No DOM, no Web Audio.

export const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '@': '.--.-.'
};
const MORSE_REVERSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

// ITA2 with US-TTY figures. Code 27 = FIGS, 31 = LTRS.
const LTRS = ['\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K',
  'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', null, 'M', 'X', 'V', null];
const FIGS = ['\0', '3', '\n', '-', ' ', '\x07', '8', '7', '\r', '$', '4', "'", ',', '!', ':', '(',
  '5', '"', ')', '2', '#', '6', '0', '1', '9', '?', '&', null, '.', '/', ';', null];

export function baudotEncode(text) {
  const codes = [31];
  let figures = false;
  for (const ch of text.toUpperCase()) {
    const table = figures ? FIGS : LTRS;
    let code = table.indexOf(ch);
    if (code < 0) {
      code = (figures ? LTRS : FIGS).indexOf(ch);
      if (code < 0) continue; // not representable in ITA2
      figures = !figures;
      codes.push(figures ? 27 : 31);
    }
    codes.push(code);
  }
  return codes;
}

/* ---------- modulator: a queue of {freq, dur} segments, phase continuous ---------- */
export class ToneGen {
  constructor(fs) {
    this.fs = fs;
    this.queue = [];
    this.phase = 0;
    this.gain = 0;
    this.left = 0;
    this.freq = 0;
    this.carry = 0; // fraction of a sample owed to the next segment
    this.keyFreq = 0; // non-zero while the straight key is held
  }

  get busy() { return this.left > 0 || this.queue.length > 0; }

  clear() { this.queue = []; this.left = 0; this.carry = 0; }

  fill(out, amplitude = 0.5) {
    const slew = 1 / (0.004 * this.fs); // 4 ms ramp avoids key clicks
    for (let i = 0; i < out.length; i++) {
      while (this.left <= 0 && this.queue.length) {
        const seg = this.queue.shift();
        const exact = seg.dur * this.fs + this.carry;
        this.left = Math.round(exact);
        this.carry = exact - this.left;
        this.freq = seg.freq;
      }
      let target = 0;
      let freq = this.freq;
      if (this.left > 0) {
        this.left--;
        if (freq) target = 1;
      }
      if (this.keyFreq) { target = 1; freq = this.keyFreq; }
      if (freq) this.lastFreq = freq;
      this.gain += Math.max(-slew, Math.min(slew, target - this.gain));
      this.phase += (2 * Math.PI * (freq || this.lastFreq || 0)) / this.fs;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      out[i] = amplitude * this.gain * Math.sin(this.phase);
    }
  }
}

export function cwSegments(text, { wpm, center }) {
  const unit = 1.2 / wpm;
  const out = [{ freq: 0, dur: unit * 3 }];
  for (const word of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    for (const ch of word) {
      const code = MORSE[ch];
      if (!code) continue;
      for (const mark of code) {
        out.push({ freq: center, dur: mark === '.' ? unit : unit * 3 });
        out.push({ freq: 0, dur: unit });
      }
      out.push({ freq: 0, dur: unit * 2 });
    }
    out.push({ freq: 0, dur: unit * 4 });
  }
  out.push({ freq: 0, dur: unit * 4 });
  return out;
}

// Asynchronous framing: start (space), data LSB first, stop (mark). Mark = 1.
export function fskSegments(codes, { baud, mark, space, bits, stopBits }) {
  const bit = 1 / baud;
  const preamble = Math.max(0.25, bit * 12);
  const out = [{ freq: mark, dur: preamble }];
  for (const code of codes) {
    out.push({ freq: space, dur: bit });
    for (let i = 0; i < bits; i++) out.push({ freq: (code >> i) & 1 ? mark : space, dur: bit });
    out.push({ freq: mark, dur: bit * stopBits });
  }
  out.push({ freq: mark, dur: bit * 8 });
  return out;
}

/* ---------- demodulators ---------- */

// Quadrature correlator for one tone, integrated over a sliding window.
class Correlator {
  constructor(fs, freq, length) {
    this.step = (2 * Math.PI * freq) / fs;
    this.phase = 0;
    this.i = new Float64Array(length);
    this.q = new Float64Array(length);
    this.sumI = 0;
    this.sumQ = 0;
    this.pos = 0;
  }

  push(x) {
    const i = x * Math.cos(this.phase);
    const q = x * Math.sin(this.phase);
    this.phase += this.step;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    this.sumI += i - this.i[this.pos];
    this.sumQ += q - this.q[this.pos];
    this.i[this.pos] = i;
    this.q[this.pos] = q;
    this.pos = (this.pos + 1) % this.i.length;
    return Math.hypot(this.sumI, this.sumQ) / this.i.length;
  }
}

class MovingPower {
  constructor(length) {
    this.buf = new Float64Array(length);
    this.sum = 0;
    this.pos = 0;
  }

  push(x) {
    const v = x * x;
    this.sum += v - this.buf[this.pos];
    this.buf[this.pos] = v;
    this.pos = (this.pos + 1) % this.buf.length;
    return Math.max(this.sum / this.buf.length, 1e-12);
  }
}

// History of the soft decision plus transition times, used to draw the eye diagram.
class SoftHistory {
  constructor(symbol) {
    this.symbol = symbol;
    this.buf = new Float32Array(Math.max(1 << 17, symbol * 48));
    this.n = 0;
    this.edges = [];
  }

  push(v) { this.buf[this.n % this.buf.length] = v; this.n++; }

  edge() {
    this.edges.push(this.n);
    if (this.edges.length > 64) this.edges.shift();
  }

  // Segments of two symbols: -0.5 to +1.5 symbols around each transition.
  traces(max = 40, points = 96) {
    const N = this.symbol;
    return this.edges
      .filter((e) => e + 1.5 * N < this.n && e - 0.5 * N > Math.max(0, this.n - this.buf.length))
      .slice(-max)
      .map((e) => {
        const start = e - Math.floor(N / 2);
        const trace = new Float32Array(points);
        for (let k = 0; k < points; k++) {
          trace[k] = this.buf[(start + Math.floor((k * 2 * N) / points)) % this.buf.length];
        }
        return trace;
      });
  }
}

export class FskDemod {
  constructor(fs, { baud, mark, space, bits }, onCode) {
    this.N = Math.max(8, Math.round(fs / baud));
    this.exact = fs / baud;
    this.bits = bits;
    this.onCode = onCode;
    this.mark = new Correlator(fs, mark, this.N);
    this.space = new Correlator(fs, space, this.N);
    this.power = new MovingPower(this.N);
    this.history = new SoftHistory(this.N);
    this.quality = 0;
    this.alpha = 1 / (this.N * 2);
    this.prev = 0;
    this.frame = null;
  }

  process(samples) {
    for (const x of samples) {
      const m = this.mark.push(x);
      const s = this.space.push(x);
      const p = this.power.push(x);
      const soft = (m - s) / (m + s + 1e-9);
      // Share of the input power that sits on the two tones: about 1 for a clean signal.
      const fraction = Math.min(1, (2 * (m * m + s * s)) / p);
      this.quality += this.alpha * (fraction - this.quality);
      this.history.push(soft);
      const open = this.quality > 0.14;
      if ((this.prev > 0) !== (soft > 0) && open) this.history.edge();

      const f = this.frame;
      if (!f) {
        // The filter delays the zero crossing by half a symbol.
        if (this.prev > 0 && soft <= 0 && open) this.frame = { t: 0, k: 0, code: 0, q: 0 };
      } else {
        f.t++;
        if (f.t >= this.exact / 2 + f.k * this.exact) {
          const one = soft > 0;
          f.q += this.quality;
          if (f.k === 0) {
            if (one) this.frame = null; // false start
          } else if (f.k <= this.bits) {
            if (one) f.code |= 1 << (f.k - 1);
          } else {
            // The stop bit must still carry signal, or the carrier just dropped.
            const last = (2 * (m * m + s * s)) / p;
            if (one && last > 0.3 && f.q / (f.k + 1) > 0.26) this.onCode(f.code);
            this.frame = null;
          }
          f.k++;
        }
      }
      this.prev = soft;
    }
  }
}

export function makeRttyDemod(fs, cfg, onText) {
  let figures = false;
  return new FskDemod(fs, { ...cfg, bits: 5 }, (code) => {
    if (code === 27) figures = true;
    else if (code === 31) figures = false;
    else {
      const ch = (figures ? FIGS : LTRS)[code];
      if (ch !== '\0' && ch !== '\r' && ch !== '\x07') onText(ch);
    }
  });
}

export function makeAsciiDemod(fs, cfg, onText) {
  return new FskDemod(fs, { ...cfg, bits: 8 }, (code) => {
    if (code === 10 || (code >= 32 && code < 127)) onText(String.fromCharCode(code));
  });
}

export class CwDemod {
  constructor(fs, { wpm, center }, onText) {
    this.fs = fs;
    this.onText = onText;
    this.unit = (1.2 / wpm) * fs;
    const window = Math.round(Math.min(0.4 * this.unit, 0.016 * fs));
    this.tone = new Correlator(fs, center, window);
    this.power = new MovingPower(window);
    this.history = new SoftHistory(Math.round(this.unit));
    this.peak = 0;
    this.decay = Math.exp(-1 / (3 * fs));
    this.on = false;
    this.pending = 0;
    this.run = 0;
    this.symbol = '';
    this.spaced = true;
    this.quality = 0;
  }

  process(samples) {
    for (const x of samples) {
      const m = this.tone.push(x);
      const p = this.power.push(x);
      const fraction = Math.min(1, (2 * m * m) / p);
      const tonal = fraction > 0.2;
      this.peak *= this.decay;
      if (tonal && m > this.peak) this.peak = m;
      const level = this.peak > 1e-4 ? m / this.peak : 0;
      this.quality += 0.001 * (fraction - this.quality);
      this.history.push(Math.max(-1, Math.min(1, level * 1.6 - 0.8)));

      const want = this.on ? level > 0.4 : level > 0.55 && tonal;
      this.run++;
      // A change must last a fifth of a dot before it counts.
      this.pending = want !== this.on ? this.pending + 1 : 0;
      if (this.pending > this.unit * 0.2) this.flip();

      if (!this.on) {
        if (this.symbol && this.run > this.unit * 2.2) {
          this.onText(MORSE_REVERSE[this.symbol] || '*');
          this.symbol = '';
          this.spaced = false;
        } else if (!this.spaced && this.run > this.unit * 5.5) {
          this.onText(' ');
          this.spaced = true;
        }
      }
    }
  }

  flip() {
    const duration = this.run - this.pending;
    if (this.on) {
      const dot = duration < this.unit * 2;
      this.symbol = (this.symbol + (dot ? '.' : '-')).slice(0, 8);
      // Follow the sender's speed, which matters for hand keying.
      const estimate = dot ? duration : duration / 3;
      this.unit = Math.max(this.fs * 0.025, Math.min(this.fs * 0.3, this.unit * 0.8 + estimate * 0.2));
    }
    this.history.edge();
    this.on = !this.on;
    this.run = this.pending;
    this.pending = 0;
  }
}

/* ---------- spectrum ---------- */
export function fftMagnitude(samples) {
  const n = samples.length; // power of two
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    re[j] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(angle * k);
      const wi = Math.sin(angle * k);
      for (let a = k; a < n; a += len) {
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  const db = new Float32Array(n / 2);
  // A full-scale sine reads 0 dB with the Hann window.
  for (let i = 0; i < n / 2; i++) db[i] = 20 * Math.log10((4 * Math.hypot(re[i], im[i])) / n + 1e-9);
  return db;
}
