// Original synthwave loop, synthesised with Web Audio (no audio file, no licence to worry about).
(() => {
  const button = document.getElementById('music');
  const BPM = 96;
  const STEP = 60 / BPM / 4; // sixteenth note
  const LEVEL = 0.22;

  // Am - F - C - G, one bar each (MIDI notes).
  const CHORDS = [
    { root: 33, notes: [57, 60, 64] },
    { root: 29, notes: [53, 57, 60] },
    { root: 36, notes: [55, 60, 64] },
    { root: 31, notes: [55, 59, 62] }
  ];
  const ARP = [0, 1, 2, 1, 3, 2, 1, 2];

  let ctx = null;
  let master = null;
  let echo = null;
  let noise = null;
  let timer = 0;
  let step = 0;
  let next = 0;
  const slider = document.getElementById('music-vol');
  const load = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };
  let playing = load('music') !== 'off'; // on unless the visitor switched it off
  slider.value = load('music-vol') ?? slider.value;

  const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

  function build() {
    ctx = new AudioContext();
    master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);

    echo = ctx.createDelay(1);
    echo.delayTime.value = STEP * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    echo.connect(feedback).connect(echo);
    echo.connect(master);

    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  function envelope(t, peak, attack, length) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    return g;
  }

  function synth(t, midi, { type, peak, attack = 0.005, length, cutoff, detune = 0, send = false }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz(midi);
    osc.detune.value = detune;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const amp = envelope(t, peak, attack, length);
    osc.connect(filter).connect(amp).connect(master);
    if (send) amp.connect(echo);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  function kick(t) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.14);
    const amp = envelope(t, 0.9, 0.003, 0.28);
    osc.connect(amp).connect(master);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  function hit(t, frequency, peak, length) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = frequency;
    src.connect(filter).connect(envelope(t, peak, 0.002, length)).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + length + 0.05);
  }

  function play(s, t) {
    const bar = Math.floor(s / 16);
    const beat = s % 16;
    const chord = CHORDS[bar % CHORDS.length];
    const section = Math.floor(bar / 8) % 4; // arrangement changes every 8 bars

    if (beat === 0) {
      for (const note of chord.notes) {
        for (const detune of [-9, 9]) {
          synth(t, note, { type: 'sawtooth', peak: 0.045, attack: 0.5, length: STEP * 16, cutoff: 1300, detune });
        }
      }
    }
    if (beat % 2 === 0) {
      const octave = beat % 4 === 2 ? 12 : 0;
      synth(t, chord.root + octave, { type: 'sawtooth', peak: 0.28, length: STEP * 1.8, cutoff: 480 });
    }
    if (section > 0) {
      if (beat % 4 === 0) kick(t);
      if (beat === 4 || beat === 12) hit(t, 1500, 0.35, 0.2);
      if (beat % 2 === 1) hit(t, 8000, 0.12, 0.05);
    }
    if (section !== 1) {
      const i = ARP[s % ARP.length];
      const note = i < 3 ? chord.notes[i] + 12 : chord.notes[0] + 24;
      synth(t, note, { type: 'square', peak: 0.05, length: STEP * 1.4, cutoff: 2600, send: true });
    }
  }

  function pump() {
    // Hidden tabs throttle timers to about 1 s, so schedule further ahead there.
    const ahead = document.hidden ? 1.5 : 0.15;
    if (next < ctx.currentTime) next = ctx.currentTime + 0.05;
    while (next < ctx.currentTime + ahead) {
      play(step++, next);
      next += STEP;
    }
  }

  // Quieten the music while the Signal Lab is on, so the signals stay audible.
  const lab = document.getElementById('power');
  // The slider is squared so that its lower half is not too loud. 100 % is twice LEVEL.
  const level = () => LEVEL * 2 * (slider.value / 100) ** 2
    * (lab.getAttribute('aria-pressed') === 'true' ? 0.12 : 1);
  const fade = () => { if (ctx) master.gain.setTargetAtTime(level(), ctx.currentTime, 0.08); };
  new MutationObserver(fade).observe(lab, { attributes: true, attributeFilter: ['aria-pressed'] });

  const blocked = () => playing && ctx !== null && ctx.state !== 'running';
  function label() {
    button.setAttribute('aria-pressed', String(playing));
    // "TAP" means the browser is still waiting for a first interaction.
    button.textContent = !playing ? '♫ OFF' : blocked() ? '♫ TAP' : '♫ ON';
  }

  function start() {
    if (!ctx) {
      build();
      master.gain.value = level();
      ctx.onstatechange = label;
    }
    // Not awaited: without a user gesture this promise stays pending.
    ctx.resume().then(label);
    clearInterval(timer);
    timer = setInterval(pump, 40);
    label();
  }

  function stop() {
    clearInterval(timer);
    ctx?.suspend();
    label();
  }

  button.addEventListener('click', () => {
    // A click while autoplay is blocked starts the music instead of switching it off.
    if (blocked()) { start(); return; }
    playing = !playing;
    save('music', playing ? 'on' : 'off');
    if (playing) start(); else stop();
  });

  slider.addEventListener('input', () => {
    save('music-vol', slider.value);
    fade();
  });

  // Browsers only allow sound after an interaction, so retry on the first ones.
  const unlock = (e) => {
    if (e.target === button) return; // the button handles itself
    if (blocked()) start();
  };
  for (const type of ['pointerdown', 'pointerup', 'keydown', 'touchend']) {
    addEventListener(type, unlock, { capture: true, passive: true });
  }

  if (playing) start(); else label();
})();
