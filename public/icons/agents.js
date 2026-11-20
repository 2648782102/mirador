// Each agent's icon in the ▾ menu beside a row's agent button, in the credits and before the title
// of an agent's terminal tab (tabAgent). Pi (gentle-shell)
// keeps the rose. The others show their official logo where an openly licensed one exists: Simple
// Icons' path data (CC0 1.0; the trademarks belong to their owners), one shape filled in
// currentColor like the "more" dots. An agent without one gets a neutral monogram, its initial in a rounded frame, drawn in the icon
// set's stroke. They live in a sprite of their own, added on first use, because the app sprite
// (public/icons.js) is the design's, symbol for symbol. DOM-free until called, so the tests
// import it in Node.
import { icon, shape, symbolIcon } from '../icons.js';

/** Where the logos come from: Simple Icons at a fixed release, and its licence. */
export const SIMPLE_ICONS = { icons: 'https://github.com/simple-icons/simple-icons/blob/16.37.0/icons', licence: 'CC0 1.0' };

/** The logos by catalog id: the Simple Icons title and slug, and the path copied from its icons/<slug>.svg. */
export const AGENT_LOGOS = {
  'claude-code': { title: 'Claude Code', slug: 'claudecode', d: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z' },
  opencode: { title: 'OpenCode', slug: 'opencode', d: 'M22 24H2V0h20zM17 4.8H7v14.4h10z' },
  'gemini-cli': { title: 'Google Gemini', slug: 'googlegemini', d: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81' },
  kimi: { title: 'Kimi', slug: 'kimi', d: 'M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441' },
};

/** The agents with no openly licensed logo (Simple Icons has none): their initial, as strokes inside the frame. */
export const AGENT_MONOGRAMS = {
  antigravity: { letter: 'A', d: 'M8.5 16.5L12 7.5l3.5 9M9.86 13h4.28' },
  codex: { letter: 'C', d: 'M14.8 9.2a4 4 0 1 0 0 5.6' },
};

const SPRITE_ID = 'agent-icon-sprite';
// A Simple Icons shape fills its whole 24px box; the margin makes it as big as the stroked icons.
const LOGO_BOX = '-2 -2 28 28';
const FRAME = ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '4' }];

/**
 * How the agent `id` is drawn: { kind: 'rose' } for pi, { kind: 'logo' | 'monogram', symbol,
 * viewBox, shapes } for the agents above, and { kind: 'generic' } (the terminal icon) for any
 * other id.
 */
export function agentGlyph(id) {
  if (id === 'pi') return { kind: 'rose' };
  if (Object.hasOwn(AGENT_LOGOS, id)) {
    return { kind: 'logo', symbol: `agent-${id}`, viewBox: LOGO_BOX, shapes: [['path', { d: AGENT_LOGOS[id].d, fill: 'currentColor', stroke: 'none' }]] };
  }
  if (Object.hasOwn(AGENT_MONOGRAMS, id)) {
    return { kind: 'monogram', symbol: `agent-${id}`, viewBox: '0 0 24 24', shapes: [FRAME, ['path', { d: AGENT_MONOGRAMS[id].d }]] };
  }
  return { kind: 'generic' };
}

/** Adds the hidden sprite of the agents' logos and monograms at the start of the body; a second call does nothing. */
export function injectAgentSprite(doc = document) {
  if (doc.getElementById(SPRITE_ID)) return;
  const sprite = shape(doc, 'svg', { id: SPRITE_ID, width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false' });
  sprite.setAttribute('style', 'position: absolute');
  for (const id of [...Object.keys(AGENT_LOGOS), ...Object.keys(AGENT_MONOGRAMS)]) {
    const { symbol: name, viewBox, shapes } = agentGlyph(id);
    const symbol = shape(doc, 'symbol', { id: `i-${name}`, viewBox });
    symbol.append(...shapes.map(([tag, attrs]) => shape(doc, tag, attrs)));
    sprite.append(symbol);
  }
  doc.body.prepend(sprite);
}

/**
 * The agent a terminal tab shows, { id, label }, or null for a bash or git terminal. A chosen agent
 * (`info.agent`) by its id and its label among `agents` (GET /api/agents); the configured one by
 * its catalog id there, else pi's rose as the tree's agent button, and by `configuredLabel`, the
 * name that button shows (mode-model.js agentLabel).
 */
export function tabAgent(info, agents, configuredLabel) {
  if (info?.kind !== 'agent') return null;
  const offered = Array.isArray(agents) ? agents : [];
  if (typeof info.agent === 'string' && info.agent) {
    return { id: info.agent, label: offered.find((agent) => agent?.id === info.agent)?.label ?? info.agent };
  }
  return { id: offered.find((agent) => agent?.configured)?.id ?? 'pi', label: configuredLabel };
}

/** The decorative <svg class="icon"> of the agent `id`: the rose in --rose for pi (gs-rose), else its logo or monogram. */
export function agentIcon(id) {
  const glyph = agentGlyph(id);
  if (glyph.kind === 'rose') {
    const rose = icon('rose');
    rose.classList.add('gs-rose');
    return rose;
  }
  if (glyph.kind === 'generic') return icon('terminal');
  injectAgentSprite(document);
  return symbolIcon(`i-${glyph.symbol}`);
}
