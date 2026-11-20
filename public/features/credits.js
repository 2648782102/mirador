// The credits (.credits-dialog): who made Mirador, with which
// tools, and the thanks. The topbar brand opens them.
// - Who made it: the authorship on top,
//   "Creado por" the author and then the agents; below it the ZURAI block, "Fundador de ZURAI —
//   zurai.cl" with the ZURAI logo on its own line above it, ZURAI's pitch and mail. ZURAI is his company,
//   not the maker.
// - The modal is the shared one (public/dialog.js): the page behind is inert, Escape closes it and
//   the focus goes back to the brand. "Saltar" sits over the stage while the intro plays.
// - The first open plays the intro on a stage over the whole dialog: the crawl, the rose and the
//   flash of its sparkle, which reveals the still credits. The phases come from credits-model.js;
//   later opens are still (the `creditsSeen` pref) and reduced motion always opens them still.
// - The title names the app: Mirador in every mode (brandOf() in public/mode-model.js).
import { $, el, prefs, richText, state, t } from '/core.js';
import { openDialog } from '/dialog.js';
import { icon } from '/icons.js';
import { agentIcon } from '/icons/agents.js';
import { brandOf } from '/mode-model.js';
import { CREDITS_CONTACTS, CREDITS_LOGOS, CREDITS_SEEN_PREF, CREDITS_THANKS, CREDITS_TOOLS, INTRO_MS, ZURAI_LOGOS, ZURAI_SITE, creditsStep } from '/features/credits-model.js';

/** gentle-shell's rose (the `rose` symbol in --rose) with a class for its size. */
function rose(className) {
  const mark = icon('rose');
  mark.classList.add(className);
  return mark;
}

/** An agent logo's credit: the logo, its agent and its source with the licence. */
function logoLine(logo) {
  return el(
    'li',
    {},
    agentIcon(logo.id),
    el('b', {}, logo.name),
    el('a', { href: logo.source, target: '_blank', rel: 'noopener' }, t('credits.logos.source', { licence: logo.licence })),
  );
}

function thanksCard(entry) {
  return el(
    'li',
    { class: entry.featured ? 'featured' : null },
    el('p', { class: 'who' }, el('b', {}, t(entry.nameKey)), el('span', { class: 'org' }, t(entry.orgKey))),
    el('p', {}, t(entry.textKey)),
  );
}

/** "Quién lo hizo", in two groups: the authorship (the author, then the agents) on top; below it
    the ZURAI block, the official ZURAI logo for each theme on its own line, small and decorative
    (the founder line under it names ZURAI), then its pitch and mail. Links open outside the app
    window. */
function by() {
  return el(
    'div',
    { class: 'credits-who' },
    el(
      'div',
      { class: 'credits-authorship' },
      el('p', { class: 'credits-by' }, richText('credits.by.created', { name: el('b', {}, t('credits.by.name')) })),
      el('p', { class: 'credits-agents' }, t('credits.by.agents')),
    ),
    el(
      'div',
      { class: 'credits-zurai' },
      el(
        'p',
        { class: 'credits-founder' },
        ZURAI_LOGOS.map((logo) => el('img', { class: `zurai-logo ${logo.tone}`, src: logo.src, alt: '', width: '100', height: '34' })),
        el('span', {}, richText('credits.by.founder', { site: el('a', { href: ZURAI_SITE.href, target: '_blank', rel: 'noopener' }, ZURAI_SITE.text) })),
      ),
      el('p', { class: 'maker-pitch' }, t('credits.maker.pitch')),
      el(
        'p',
        { class: 'maker-links' },
        CREDITS_CONTACTS.flatMap((contact, i) => [
          i ? el('span', { 'aria-hidden': 'true' }, '·') : null,
          el('a', { href: contact.href, target: '_blank', rel: 'noopener' }, contact.text),
        ]),
      ),
    ),
  );
}

/** The credits' content; `ids` labels the sections of the still copy, never the crawl's. */
function sections(ids) {
  const section = (id, heading, ...content) =>
    el(
      'section',
      { class: 'credits-sec', 'aria-labelledby': ids ? `credits-${id}` : null },
      el('h3', { id: ids ? `credits-${id}` : null }, heading),
      content,
    );
  return [
    section('by', t('credits.by.heading'), by()),
    section(
      'tools',
      t('credits.tools.heading'),
      el('ul', { class: 'credits-tools' }, CREDITS_TOOLS.map((tool) => el('li', {}, el('b', {}, t(tool.nameKey)), el('span', {}, t(tool.roleKey))))),
    ),
    section('thanks', t('credits.thanks.heading'), el('ul', { class: 'credits-thanks' }, CREDITS_THANKS.map(thanksCard))),
    // Fine print, so only the still credits list it; the crawl stays the design's.
    // Left out of the crawl, never null: replaceChildren() would print a null as "null".
    ...(ids
      ? [
          section(
            'logos',
            t('credits.logos.heading'),
            el('ul', { class: 'credits-logos' }, CREDITS_LOGOS.map(logoLine)),
            el('p', { class: 'credits-logos-note' }, t('credits.logos.note')),
          ),
        ]
      : []),
    el('p', { class: 'credits-foot' }, t('credits.foot')),
  ];
}

/** Opens the credits: the intro the first time, the still credits once seen. */
export function openCredits() {
  const crawlText = el('div', { class: 'crawl-text' });
  const stage = el(
    'div',
    { class: 'credits-stage', 'aria-hidden': 'true', inert: true },
    el('div', { class: 'crawl' }, crawlText),
    el('div', { class: 'rose-intro' }, rose('rose-big'), el('span', { class: 'flash' })),
  );
  const replay = el('button', { type: 'button', class: 'btn sm ghost', onclick: () => go('replay') }, rose('gs-rose'), t('credits.replay'));
  const still = el(
    'div',
    { class: 'credits-static' },
    el('p', { class: 'credits-tagline' }, t('credits.tagline')),
    sections(true),
    el('p', { class: 'credits-replay' }, replay),
  );
  const skip = el('button', { type: 'button', class: 'btn secondary credits-skip', hidden: true, onclick: () => go('skip') }, t('credits.skip'));

  let phase = null;
  let timer = null;
  let dialog = null;
  const go = (event) => {
    clearTimeout(timer);
    const skipHadFocus = document.activeElement === skip;
    const step = creditsStep(phase, event, {
      seen: prefs.read(CREDITS_SEEN_PREF, false) === true,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    phase = step.phase;
    if (step.markSeen) prefs.write(CREDITS_SEEN_PREF, true);
    // Closing removes the dialog, and its animations with it; only the timer needed stopping.
    if (event === 'close') return;
    dialog.dataset.phase = phase;
    dialog.classList.toggle('revealed', step.reveal);
    skip.hidden = phase === 'done';
    const body = still.parentElement;
    if (phase === 'crawl') {
      crawlText.replaceChildren(
        el('div', { class: 'credits-hero' }, el('p', { class: 'crawl-title' }, t('credits.title', { brand: brandOf(state.config) })), el('p', { class: 'crawl-tagline' }, t('credits.tagline'))),
        ...sections(false),
      );
      // The text starts under the stage's bottom edge, whatever the window's height.
      crawlText.style.setProperty('--crawl-from', `${stage.clientHeight}px`);
      body.scrollTop = 0;
      skip.focus();
    } else if (phase === 'done') {
      if (step.reveal) body.scrollTop = 0;
      if (skipHadFocus) replay.focus({ preventScroll: true });
    }
    if (step.ms !== null) timer = setTimeout(() => go('elapsed'), step.ms);
  };

  const closed = openDialog({
    title: [rose('credits-mark'), t('credits.title', { brand: brandOf(state.config) })],
    body: [stage, still],
    actions: [],
    close: t('credits.close'),
    initialFocus: 'cancel',
    className: 'credits-dialog',
  });
  dialog = still.closest('dialog');
  dialog.append(skip);
  dialog.style.setProperty('--crawl-ms', `${INTRO_MS.crawl}ms`);
  go('open');
  return closed.then((value) => {
    go('close');
    return value;
  });
}

export async function init() {
  $('#credits-open').addEventListener('click', () => openCredits());
}
