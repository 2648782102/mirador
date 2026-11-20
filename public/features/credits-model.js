// The credits (.credits-dialog): what they list and the intro's
// phases. Pure module: public/features/credits.js and the tests import it.
// - The first open plays the crawl, then the rose, then the flash of its sparkle, which reveals
//   the still credits ('done'); they stay. Once seen, or with reduced motion, they open still.
// - "Saltar" jumps to the still credits; "Repetir la animación" plays the crawl again.
// - The still credits also name the agent logos the ▾ menu shows (public/icons/agents.js), with
//   their source and licence.
import { AGENT_LOGOS, SIMPLE_ICONS } from '../icons/agents.js';

/** How long each intro phase lasts. The crawl is the CSS animation's length; the rose grows in
    900 ms and its sparkle opens at 1 s; the flash covers the window before it ends at 1100 ms. */
export const INTRO_MS = { crawl: 20000, rose: 1000, flash: 900 };

const INTRO = ['crawl', 'rose', 'flash'];
const NEXT = { crawl: 'rose', rose: 'flash', flash: 'done' };

/** The `prefs` key (public/core.js) that remembers the intro was seen. */
export const CREDITS_SEEN_PREF = 'creditsSeen';

function target(phase, event, { seen = false, reducedMotion = false }) {
  if (event === 'open') return seen || reducedMotion ? 'done' : 'crawl';
  if (event === 'replay') return reducedMotion ? 'done' : 'crawl';
  if (event === 'elapsed') return NEXT[phase] ?? 'done';
  // 'skip' and 'close'.
  return 'done';
}

/**
 * The phase after `event` ('open', 'elapsed', 'skip', 'replay' or 'close') from `phase` (null
 * before the first open): `ms` until the next 'elapsed' (null when still), `reveal` when the
 * still credits appear at the end of the intro, and `markSeen` when that ends the intro for good.
 * Closing mid-intro stops it without marking it seen.
 */
export function creditsStep(phase, event, options = {}) {
  const next = target(phase, event, options);
  const still = next === 'done';
  return {
    phase: next,
    ms: INTRO_MS[next] ?? null,
    reveal: still && INTRO.includes(phase) && event !== 'close',
    markSeen: still && event !== 'close',
  };
}

/** "Con qué está hecho", in the design order. */
export const CREDITS_TOOLS = ['node', 'xterm', 'pty', 'ws', 'engram', 'gentle', 'chromium'].map((id) => ({
  nameKey: `credits.tool.${id}.name`,
  roleKey: `credits.tool.${id}.role`,
}));

/** "Agradecimientos y menciones especiales": Alan Buscaglia first and highlighted. */
export const CREDITS_THANKS = [
  { id: 'alan', featured: true },
  { id: 'mario' },
  { id: 'xterm' },
  { id: 'lazygit' },
].map(({ id, featured }) => ({
  nameKey: `credits.thanks.${id}.name`,
  orgKey: `credits.thanks.${id}.org`,
  textKey: `credits.thanks.${id}.text`,
  ...(featured ? { featured } : {}),
}));

/** "Logos de los agentes": each agent logo the app shows, its Simple Icons source and licence. */
export const CREDITS_LOGOS = Object.entries(AGENT_LOGOS).map(([id, logo]) => ({
  id,
  name: logo.title,
  source: `${SIMPLE_ICONS.icons}/${logo.slug}.svg`,
  licence: SIMPLE_ICONS.licence,
}));

/** ZURAI's site, the link in "Fundador de ZURAI — zurai.cl". */
export const ZURAI_SITE = { href: 'https://zurai.cl', text: 'zurai.cl' };

/** ZURAI's official contact, under its pitch below the founder line. */
export const CREDITS_CONTACTS = [{ href: 'mailto:contacto@zurai.cl', text: 'contacto@zurai.cl' }];

/** The official ZURAI core logo from file, small beside the founder line: principal on light,
    negativo on dark and in the crawl. */
export const ZURAI_LOGOS = [
  { src: '/brand/zurai-logo-principal.svg', tone: 'on-light' },
  { src: '/brand/zurai-logo-negativo.svg', tone: 'on-dark' },
];
