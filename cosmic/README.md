# Cosmic — unblocked games

Juegos jugables directo en el navegador. Puro HTML/CSS/JS, sin dependencias ni build.
Tema oscuro, sin cuentas ni registros.

Se publica en **kbau.lol/cosmic/** — esta carpeta es la carpeta `cosmic/` del repo.

## Estructura

```
cosmic/
├── index.html        → kbau.lol/cosmic/          portada (buscador + rejilla + footer)
├── css/style.css     → hoja de estilos única (portada + juegos)
├── js/games.js       → lista de juegos (name / icon / page) + subtítulos random
├── js/i18n.js        → idiomas (es/en) + link de Discord
├── js/main.js        → script compartido (estrellas + botón fullscreen)
├── img/*.png         → iconos, 128×128 (se ven a 64px)
│   └── logo.png      → LOGO del sitio
├── game/*.html       → kbau.lol/cosmic/game/<juego>.html
└── README.md
```

## Cosas que se cambian seguido

| Qué                        | Dónde                          |
| -------------------------- | ------------------------------ |
| Subtítulos random del hero | `js/games.js` → array `SUBS`   |
| Lista de juegos            | `js/games.js` → array `GAMES`  |
| Textos es/en               | `js/i18n.js` → objeto `I18N`   |
| Link del Discord           | `js/i18n.js` → `DISCORD_INVITE` |

### Idiomas

Botón **EN/ES** en la barra superior de todas las páginas. Cambia todo el texto
de la interfaz (buscador, botones, secciones, footer). La elección se guarda en
`localStorage` y la primera vez se detecta por el idioma del navegador.
Para agregar otro idioma: agregar una entrada nueva en `I18N` y ampliar la lógica
de `applyLang`.

### Discord

Hay tres botones/link con atributo `data-discord` (hero, footer de la portada y
footer de cada juego). Todos toman su URL de `DISCORD_INVITE` en `js/i18n.js`,
así que el invite se cambia en un solo lugar.

### Logo

Todas las páginas referencian `img/logo.png` (portada) / `../img/logo.png`
(juegos). Si el archivo no existe, se muestra el texto **Cosmic** como fallback.

## Páginas

**Portada** — barra sticky con logo + buscador + botón de idioma, hero con
subtítulo aleatorio y botones "Juega uno al azar" + "Únete al Discord", rejilla
de juegos con contador, footer con link al Discord.

**Juego** — barra con logo + "Todos los juegos" + botón de idioma, iframe en
tarjeta redondeada con barra de título + botón fullscreen, fila "Más juegos"
(12 al azar, sin repetir el actual), footer con link al Discord.

## Agregar un juego

1. Creá `game/mi-juego.html` copiando cualquier otra página de `game/` y cambiando
   `<title>`, `<h1>`, el `src` del `<iframe>` y el icono de la barra.
2. Subí el icono a `img/mi-juego.png` (128×128).
3. Agregá una línea en `js/games.js`:

```js
{ name: "Mi Juego", icon: "img/mi-juego.png", page: "game/mi-juego.html" },
```

## Desarrollo local

Abrí `index.html` en el navegador, o serví la carpeta:

```sh
npx serve .
```

## Publicar

Subir esta carpeta como `cosmic/` en la raíz del repo del sitio:

```
repo/                  → kbau.lol/
├── cosmic/            → kbau.lol/cosmic/        (esta carpeta)
│   ├── index.html
│   └── game/*.html
└── ...
```

GitHub Pages sirve `index.html` automáticamente al entrar a `/cosmic/`.
Todas las rutas son relativas, así que funciona igual en local y en producción.
