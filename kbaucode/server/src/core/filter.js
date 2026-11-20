// Word filter for everything people can type into KbauBlocks (usernames, names, bios, project text, comments,
// collections, reports). AGPL-3.0-or-later.
//
// It normalises text before matching: lower case, accents removed, common look-alikes (0→o, 1→i, 3→e, 4→a,
// 5→s, 7→t, @→a, $→s, …), stretched letters ("fuuuck"), and letters spaced or dotted apart ("f u c k",
// "f.u.c.k"). Words are matched as whole words (with common endings like -s, -ed, -ing) so that ordinary
// words that merely contain a bad one ("class", "Scunthorpe", "assassin") are not blocked. A short list of
// slurs is also matched inside other words and inside usernames, because those have no innocent uses.
//
// Admins can add more words from the admin page (stored in the blocked_words table).

// Matched as whole words in normal text, and inside usernames (except where an allowed word explains it).
const SWEARS = [
    'fuck', 'fucker', 'fuckin', 'fucking', 'motherfucker', 'fck', 'fuk', 'fuq', 'fux', 'phuck', 'stfu', 'gtfo', 'wtf',
    'shit', 'shite', 'shitty', 'bullshit', 'horseshit', 'sht',
    'bitch', 'biatch', 'bich', 'cunt', 'twat', 'wanker', 'wank', 'prick', 'dick', 'dickhead', 'cock', 'cocksucker',
    'pussy', 'ass', 'asshole', 'arsehole', 'arse', 'jackass', 'dumbass', 'smartass', 'badass', 'bastard', 'bollocks',
    'bugger', 'slut', 'whore', 'hoe', 'skank', 'thot', 'douche', 'douchebag', 'damn', 'goddamn', 'piss', 'pissed',
    'crap', 'tits', 'titty', 'boobs', 'boob', 'penis', 'vagina', 'dildo', 'porn', 'porno', 'sex', 'sexy', 'nude',
    'nudes', 'naked', 'horny', 'cum', 'jizz', 'blowjob', 'handjob', 'rimjob', 'milf', 'hentai', 'rape', 'rapist',
    'pedo', 'pedophile', 'paedo', 'nazi', 'hitler', 'kys', 'killyourself'
];

// Slurs: matched anywhere, including inside other words and usernames.
const SLURS = [
    'nigger', 'nigga', 'niggah', 'nigg', 'faggot', 'fagot', 'faggy', 'fagg', 'retard', 'retarded', 'tranny',
    'kike', 'chink', 'gook', 'wetback', 'beaner', 'spic', 'coon', 'raghead', 'towelhead', 'dyke', 'sandnigger',
    'porchmonkey', 'jigaboo', 'shemale'
];
// Slurs short enough to appear inside ordinary words are only matched as whole words.
const WORD_ONLY_SLURS = new Set(['spic', 'coon', 'gook', 'dyke', 'kike', 'chink']);

// Ordinary words containing a blocked word; removed before looking inside usernames.
const ALLOWED_INSIDE = [
    'assassin', 'assault', 'assemble', 'assembly', 'assert', 'assess', 'asset', 'assign', 'assist', 'associate',
    'assume', 'assure', 'class', 'classic', 'glass', 'grass', 'brass', 'bass', 'mass', 'pass', 'sass', 'lass',
    'compass', 'embarrass', 'harass', 'molasses', 'ambassador', 'cassette', 'passion', 'massive', 'chassis',
    'scunthorpe', 'cockpit', 'cocktail', 'peacock', 'hancock', 'hitchcock', 'cockatoo', 'cockroach', 'shuttlecock',
    'dickens', 'dickinson', 'benedick', 'therapist', 'grape', 'drape', 'scrape', 'rapeseed', 'cumulus', 'cumbersome',
    'cucumber', 'circumstance', 'document', 'scumble', 'accumulate', 'shitake', 'shiitake', 'pissarro',
    'sextant', 'sextet', 'sussex', 'essex', 'middlesex', 'hoedown', 'shoe', 'hoes', 'whoever', 'crapaud', 'dampen',
    'damnation', 'hello', 'shell', 'pushit', 'cocoon', 'raccoon', 'tycoon', 'scoon', 'pussycat', 'spice', 'spicy',
    'despicable', 'conspicuous', 'skankhunt', 'mississippi', 'titan', 'title', 'titus', 'constitution', 'petition',
    'boobook', 'analysis', 'canal', 'analog', 'sexton', 'pen', 'penistone', 'arsenal', 'arsenic', 'parse', 'sparse',
    'tarsier', 'nazir', 'hitlist', 'scrap', 'prickly', 'swank', 'thoth', 'thorny', 'torpedo', 'pedometer',
    'cassandra', 'cassie', 'hassan', 'vassal', 'tassel', 'jessica'
];

const ALLOWED_WORDS = new Set(ALLOWED_INSIDE);

const LOOKALIKE = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l', '¡': 'i', 'ß': 'ss', 'ø': 'o', 'æ': 'ae',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't'
};

const ENDINGS = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y', 'ies', 'z'];

const stripAccents = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
const mapLookalikes = s => [...s].map(c => LOOKALIKE[c] || c).join('');
// "fuuuuck" -> ["fuuck", "fuck"]; words with real double letters ("ass") still match the 2-letter form.
const squeezeVariants = w => [...new Set([w.replace(/(.)\1{2,}/g, '$1$1'), w.replace(/(.)\1+/g, '$1')])];

const prepare = text => mapLookalikes(stripAccents(String(text).toLowerCase()));

/** Tokens of a piece of text, including letters spaced/dotted apart ("f u c k", "f.u.c.k"). */
const tokens = text => {
    // Split camelCase too ("BigAss" -> "big ass") before lower-casing.
    const words = prepare(String(text).replace(/([a-z])([A-Z])/g, '$1 $2')).split(/[^a-z]+/).filter(Boolean);
    const out = [...words];
    let run = '';
    for (const w of words) {
        if (w.length === 1) {
            run += w;
        } else {
            if (run.length > 2) out.push(run);
            run = '';
        }
    }
    if (run.length > 2) out.push(run);
    return out;
};

export const createFilter = () => {
    const wordSet = new Set([...SWEARS, ...SLURS]);
    let custom = new Set();
    const isBadWord = token => squeezeVariants(token).some(v =>
        ENDINGS.some(end => v.endsWith(end) && v.length - end.length >= 2 &&
            (wordSet.has(v.slice(0, v.length - end.length)) || custom.has(v.slice(0, v.length - end.length)))));
    const insideSlur = squashed => squeezeVariants(squashed).find(v =>
        SLURS.find(s => !WORD_ONLY_SLURS.has(s) && v.includes(s)));

    /**
     * @param {string} text the text to check
     * @param {{username?: boolean}} [opts] usernames are also checked for blocked words hidden inside them
     * @returns {string|null} the blocked word that was found, or null if the text is fine
     */
    const check = (text, opts = {}) => {
        if (!text) return null;
        for (const t of tokens(text)) {
            if (!ALLOWED_WORDS.has(t) && isBadWord(t)) return t;
        }
        const squashed = prepare(text).replace(/[^a-z]/g, '');
        const slur = insideSlur(squashed);
        if (slur) return slur;
        if (opts.username) {
            let rest = squashed;
            for (const ok of ALLOWED_INSIDE) rest = rest.split(ok).join('_');
            for (const v of squeezeVariants(rest)) {
                // Inside a name only longer words count; short ones ("ass") must stand alone (big_ass, BigAss).
                for (const w of [...SWEARS, ...custom]) {
                    if (w.length >= 4 && v.includes(w)) return w;
                }
            }
        }
        return null;
    };
    const setCustom = words => {
        custom = new Set(words.map(w => prepare(w).replace(/[^a-z]/g, '')).filter(w => w.length >= 2));
    };
    return {check, setCustom};
};

export const BUILT_IN_WORD_COUNT = new Set([...SWEARS, ...SLURS]).size;
