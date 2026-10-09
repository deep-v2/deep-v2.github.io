/* ============================================================
   Cosmic — idiomas (es / en) + link de Discord
   · textos de la interfaz → I18N más abajo
   · DISCORD_INVITE       → poné acá el link de tu server cuando exista
   · el botón #langBtn alterna es/en y se guarda en localStorage
   · detecta el idioma del navegador la primera vez
   ============================================================ */

const DISCORD_INVITE = 'https://discord.gg/N6V4vgrKQZ';

const I18N = {
  es: {
    searchPh:   '¿Qué vas a jugar hoy?',
    searchAria: 'buscar juego',
    cta:        'Juega uno al azar',
    joinDc:     'Únete al Discord',
    allGames:   'Todos los juegos',
    count:      'juegos',
    noResults:  'no hay resultados :(',
    gameBy:     'juega gratis en Cosmic',
    moreGames:  'Más juegos',
    tagline:    'Juegos unblocked para jugar en el navegador. Sin cuentas, sin instalar nada — abrí y jugá.',
    colGames:   'Juegos',
    colMore:    'Más',
    seeAll:     'Todos los juegos',
    seeGrid:    'Rejilla completa',
    bottom:     'Cosmic — juegos unblocked',
    discord:    'Discord',
    toEn:       'Switch to English',
    toEs:       'Cambiar a español'
  },
  en: {
    searchPh:   'What are you playing today?',
    searchAria: 'search games',
    cta:        'Play a random one',
    joinDc:     'Join the Discord',
    allGames:   'All games',
    count:      'games',
    noResults:  'no results :(',
    gameBy:     'play free on Cosmic',
    moreGames:  'More games',
    tagline:    'Unblocked games to play in your browser. No accounts, no installs — just open and play.',
    colGames:   'Games',
    colMore:    'More',
    seeAll:     'All games',
    seeGrid:    'See all games',
    bottom:     'Cosmic — unblocked games',
    discord:    'Discord',
    toEn:       'Switch to English',
    toEs:       'Cambiar a español'
  }
};

/* ── idioma inicial: guardado > navegador > español ── */
let LANG = 'es';
try {
  const saved = localStorage.getItem('cosmic-lang');
  if (saved === 'es' || saved === 'en') {
    LANG = saved;
  } else if (!(navigator.language || '').toLowerCase().startsWith('es')) {
    LANG = 'en';
  }
} catch (e) { /* sin localStorage: queda en español */ }

function applyLang(lang) {
  LANG = lang;
  document.documentElement.lang = lang;
  const T = I18N[lang];

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = T[el.dataset.i18n];
    if (v !== undefined) el.textContent = v;
  });

  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const v = T[el.dataset.i18nPh];
    if (v !== undefined) el.placeholder = v;
  });

  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const v = T[el.dataset.i18nAria];
    if (v !== undefined) el.setAttribute('aria-label', v);
  });

  const count = document.getElementById('count');
  if (count && typeof GAMES !== 'undefined') {
    count.textContent = GAMES.length + ' ' + T.count;
  }

  const langBtn = document.getElementById('langBtn');
  if (langBtn) {
    langBtn.textContent = lang === 'es' ? 'EN' : 'ES';
    const label = lang === 'es' ? T.toEn : T.toEs;
    langBtn.title = label;
    langBtn.setAttribute('aria-label', label);
  }

  try { localStorage.setItem('cosmic-lang', lang); } catch (e) {}
}

/* ── links de Discord ── */
document.querySelectorAll('[data-discord]').forEach(el => { el.href = DISCORD_INVITE; });

/* ── botón de idioma ── */
const langBtn = document.getElementById('langBtn');
if (langBtn) {
  langBtn.addEventListener('click', () => applyLang(LANG === 'es' ? 'en' : 'es'));
}

applyLang(LANG);
