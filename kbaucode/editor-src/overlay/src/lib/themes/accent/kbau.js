// KbauBlocks default accent: white on near-black. Part of the KbauBlocks patch set, GPL-3.0.
// Wherever TurboWarp fills something with the accent colour, kbau-on-accent / kbau-accent-icon-filter
// switch its text and icons to black so they stay readable (see apply-kbau.mjs, "white accent").
const guiColors = {
    'motion-primary': '#ffffff',
    'motion-primary-transparent': '#ffffffe6',
    'motion-tertiary': '#d4d4d4',

    'looks-secondary': '#ffffff',
    'looks-transparent': '#ffffff40',
    'looks-light-transparent': '#ffffff1f',
    'looks-secondary-dark': '#cfcfcf',

    'extensions-primary': '#e0e0e0',
    'extensions-tertiary': '#bdbdbd',
    'extensions-transparent': '#ffffff59',
    'extensions-light': '#f2f2f2',

    'drop-highlight': '#ffffff',

    'kbau-on-accent': '#000000',
    'kbau-accent-icon-filter': 'brightness(0)',
    'kbau-checkbox-fill': '#6b6b6b',

    // KbauBlocks: the top bar is always solid black, regardless of accent.
    'menu-bar-background': '#000000',
    'menu-bar-background-image': 'none',
    'menu-bar-foreground': '#ffffff'
};

const blockColors = {
    checkboxActiveBackground: '#6b6b6b',
    checkboxActiveBorder: '#4d4d4d'
};

export {
    guiColors,
    blockColors
};
