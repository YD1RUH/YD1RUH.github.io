// UI behaviour kept separate from the 3D scene, so it works even if three.js fails to load.
(() => {
  const hud = document.querySelector('.hud');
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--hud-h', `${hud.offsetHeight}px`);
  }).observe(hud);

  const utc = document.getElementById('utc');
  const tick = () => { utc.textContent = new Date().toISOString().slice(11, 19); };
  tick();
  setInterval(tick, 1000);

  const typed = document.getElementById('typed');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const lines = [
      'CQ CQ CQ DE YD1RUH YD1RUH K',
      '-.-- -.. .---- .-. ..- ....',
      'TRACKING NOAA / FALCONSAT-3 / GK-2A ...',
      '73 DE YD1RUH OI33it'
    ];
    let line = 0, pos = 0, step = 1;
    const type = () => {
      pos += step;
      typed.textContent = lines[line].slice(0, pos);
      let wait = step > 0 ? 70 : 30;
      if (pos >= lines[line].length) { step = -1; wait = 1800; }
      else if (pos <= 0) { step = 1; line = (line + 1) % lines.length; }
      setTimeout(type, wait);
    };
    typed.textContent = '';
    type();
  }

  const box = document.getElementById('lightbox');
  const full = box.querySelector('img');
  const open = (img) => {
    full.src = img.src;
    full.alt = img.alt;
    box.showModal();
  };
  document.querySelectorAll('[data-zoom]').forEach((img) => {
    img.tabIndex = 0;
    img.addEventListener('click', () => open(img));
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(img); });
  });
  box.addEventListener('click', (e) => { if (e.target === box) box.close(); });
})();
