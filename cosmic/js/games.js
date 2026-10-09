/* ============================================================
   Cosmic — lista de juegos
   Para agregar uno nuevo:
     1. creá  game/mi-juego.html
     2. subí  img/mi-juego.png   (128x128)
     3. copiá una línea de acá abajo y cambia name / icon / page
   ============================================================ */

const GAMES = [
  { name: "Rocket Soccer Derby",              icon: "img/rocket.png",              page: "game/rocket.html" },
  { name: "Geometry Dash",                    icon: "img/gd.png",                  page: "game/gd.html" },
  { name: "Geometry Dash Lite",               icon: "img/gdlite.png",              page: "game/gdlite.html" },
  { name: "DELTARUNE",                        icon: "img/dr.png",                  page: "game/deltarune.html" },
  { name: "Friday Night Funkin",              icon: "img/fnf.png",                 page: "game/fnf.html" },
  { name: "FNF vs Sky",                       icon: "img/fnfsky.png",              page: "game/fnf-sky.html" },
  { name: "Baldi's Basics",                   icon: "img/baldi.png",               page: "game/baldi.html" },
  { name: "Eaglercraft (OFFLINE)",            icon: "img/eagler.png",              page: "game/eaglercraft.html" },
  { name: "Eaglercraft (Online)",             icon: "img/eagler.png",              page: "game/eaglercraftOnline.html" },
  { name: "Subway Surfers",                   icon: "img/subway.png",              page: "game/subway-surfers.html" },
  { name: "Level Devil",                      icon: "img/leveldevil.png",          page: "game/level-devil.html" },
  { name: "Papa's Pizzeria",                  icon: "img/papas-pizzeria.png",       page: "game/papas-pizzeria.html" },
  { name: "Papa's Freezeria",                 icon: "img/papas-freezeria.png",      page: "game/papas-freezeria.html" },
  { name: "Papa's Pastaria",                  icon: "img/papas-pastaria.png",       page: "game/papas-pastaria.html" },
  { name: "Papa's Cheeseria",                 icon: "img/papas-cheeseria.png",      page: "game/papas-cheeseria.html" },
  { name: "Papa's Cupcakeria",                icon: "img/papas-cupcakeria.png",     page: "game/papas-cupcakeria.html" },
  { name: "Papa's Burgeria",                  icon: "img/papas-burgeria.png",       page: "game/papas-burgeria.html" },
  { name: "Papa's Donuteria",                 icon: "img/papas-donuteria.png",      page: "game/papas-donuteria.html" },
  { name: "Papa's Scooperia",                 icon: "img/papas-scooperia.png",      page: "game/papas-scooperia.html" },
  { name: "Papa's Wingeria",                  icon: "img/papas-wingeria.png",       page: "game/papas-wingeria.html" },
  { name: "Papa's Hot Doggeria",              icon: "img/papas-hot-doggeria.png",   page: "game/papas-hot-doggeria.html" },
  { name: "Papa's Taco Mia",                  icon: "img/papas-taco-mia.png",       page: "game/papas-taco-mia.html" },
  { name: "Fireboy and Watergirl - The Forest Temple", icon: "img/fireboywatergirl1.png", page: "game/fireboy-watergirl-forest.html" },
  { name: "My Perfect Hotel",                 icon: "img/hotelgame.png",           page: "game/my-perfect-hotel.html" },
  { name: "UNDERTALE Yellow",                 icon: "img/utyellow.png",            page: "game/utyellow.html" },
  { name: "Bottle Hop",                       icon: "img/bottle-hop.png",          page: "game/bottle-hop.html" },
  { name: "Slope 2",                          icon: "img/slope-2.png",             page: "game/slope2.html" },
  { name: "Pou",                              icon: "img/pou.png",                 page: "game/pou.html" },
  { name: "Block Blast",                      icon: "img/blockblast.png",          page: "game/block-blast.html" },
  { name: "Cookie Clicker",                   icon: "img/cookie-clicker.png",      page: "game/cookie-clicker.html" },
  { name: "A Dance of Fire and Ice",          icon: "img/adofai.png",              page: "game/adofai.html" },
  { name: "Slice Master",                     icon: "img/slice-duo.png",           page: "game/slice-duo.html" },
  { name: "Words of Wonders",                 icon: "img/w-o-w.png",               page: "game/words-of-wonders.html" },
  { name: "Smash Karts",                      icon: "img/smash-karts.png",         page: "game/smash-karts.html" },
  { name: "Five Nights At Freddys",           icon: "img/fnaf.png",                page: "game/fnaf.html" },
  { name: "Basketball Stars",                 icon: "img/basketball-stars.png",    page: "game/basketball-stars.html" },
  { name: "Las basicas del momo",             icon: "img/momos-basics.png",        page: "game/momos-basics.html" }
  /* { name: "Otro", icon: "img/otro.png", page: "game/otro.html" }, */
];

/* ── subtítulo random (portada) ── */
const SUBS = [
  "hehe unblocked go brr",
  "if you read this you just lost the game",
  "hello",
  "niko oneshot best character trust",
  "question mark",
  "gd colon wouldnt be so happy about geometry lite being here",
  "skidding to death"
];

const sub = document.getElementById('sub');
if (sub) sub.textContent = SUBS[Math.floor(Math.random() * SUBS.length)];

/* ── contador de juegos ── */
const count = document.getElementById('count');
if (count) count.textContent = GAMES.length + ' juegos';

/* ── botón "juega uno al azar" ── */
const surprise = document.getElementById('surprise');
if (surprise) {
  surprise.addEventListener('click', () => {
    const g = GAMES[Math.floor(Math.random() * GAMES.length)];
    location.href = g.page;
  });
}

/* ── base de rutas: '' en la portada, '../' dentro de game/ ── */
const BASE = /\/game\//.test(location.pathname) ? '../' : '';

/* ── render de tarjetas ── */
function createCard(g) {
  const a = document.createElement('a');
  a.className = 'game-card';
  a.href = BASE + g.page;

  const thumb = document.createElement('span');
  thumb.className = 'thumb';

  const img = document.createElement('img');
  img.src = BASE + g.icon;
  img.alt = g.name;
  img.loading = 'lazy';
  img.onerror = function () {
    const fb = document.createElement('span');
    fb.className = 'img-fallback';
    fb.textContent = '?';
    this.replaceWith(fb);
  };
  thumb.appendChild(img);

  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = g.name;

  a.append(thumb, span);
  return a;
}

const grid  = document.getElementById('grid');
const nores = document.getElementById('nores');

function renderCards(list) {
  if (!grid) return;
  grid.textContent = '';
  if (nores) nores.style.display = list.length ? 'none' : 'block';
  list.forEach(g => grid.appendChild(createCard(g)));
}

if (grid) {
  renderCards(GAMES);

  /* ── buscador ── */
  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', function () {
      const q = this.value.toLowerCase().trim();
      renderCards(q ? GAMES.filter(g => g.name.toLowerCase().includes(q)) : GAMES);
    });
  }
}

/* ── fila "más juegos" (páginas de juego) ── */
const moreRow = document.getElementById('moreRow');
if (moreRow) {
  const here  = location.pathname.split('/').pop();
  const others = GAMES.filter(g => !g.page.endsWith('/' + here) && g.page !== here);

  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }

  others.slice(0, 12).forEach(g => moreRow.appendChild(createCard(g)));
}
