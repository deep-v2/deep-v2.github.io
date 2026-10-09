/* ============================================================
   Cosmic — script compartido
   · fondo de estrellas (portada + páginas de juego)
   · botón "fullscreen" (solo páginas de juego)
   ============================================================ */

(function () {
  'use strict';

  /* ── estrellas ── */
  const canvas = document.getElementById('stars');

  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    let W, H, stars = [];

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }

    function initStars(n) {
      stars = [];
      for (let i = 0; i < n; i++) {
        stars.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: Math.random() * 1.5 + 0.3,
          speed: Math.random() * 0.18 + 0.04,
          base: Math.random() * 0.6 + 0.2,
          phase: Math.random() * Math.PI * 2
        });
      }
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      const t = Date.now() / 1000;
      stars.forEach(s => {
        s.y += s.speed;
        if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
        const a = s.base * (0.5 + 0.5 * Math.sin(t * 1.1 + s.phase));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,200,205,${a})`;
        ctx.fill();
      });
      requestAnimationFrame(draw);
    }

    resize();
    initStars(220);
    draw();
    window.addEventListener('resize', () => { resize(); initStars(220); });
  }

  /* ── fullscreen ── */
  const fsBtn = document.getElementById('fsBtn');
  const frame = document.getElementById('gameFrame');

  if (fsBtn && frame) {
    fsBtn.addEventListener('click', () => {
      if (frame.requestFullscreen) frame.requestFullscreen();
      else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
      else if (frame.mozRequestFullScreen) frame.mozRequestFullScreen();
    });
  }
})();
