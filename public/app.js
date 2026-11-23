// Entry point: signs in, loads the config, then starts each UI feature in order.
// A new feature lives in public/features/<feature>.js and is added to FEATURES.
import { $, api, applyStaticText, el, richText, setLanguage, setWorkspaces, signIn, state, t } from '/core.js';
import { injectSprite } from '/icons.js';
import { brandOf } from '/mode-model.js';
import { initTerminals } from '/terminals.js';
import * as summary from '/features/summary.js';
import * as workspaces from '/features/workspaces.js';
// Wave 2: each unit adds its import on the line under its own marker (docs/extending.md).
// W3 overview
import * as overview from '/features/overview.js';

// W4 inbox
import * as inbox from '/features/inbox.js';

// W5 editor
import * as files from '/features/files.js';

// Tracking
import * as tracking from '/features/tracking.js';

// Columns
import * as columns from '/columns.js';

// Resources
import * as resources from '/features/resources.js';

// Launches
import * as launchProgress from '/features/launch-progress.js';

// Sleeping agents
import * as sleeping from '/features/sleeping.js';

// MCP per project
import * as mcp from '/features/mcp.js';

// Settings sheet
import * as settings from '/features/settings.js';

// Responsive drawers
import * as drawers from '/features/drawers.js';

// Help guide
import * as help from '/features/help.js';

// Credits
import * as credits from '/features/credits.js';

// Phone layout
import * as phone from '/features/phone.js';


/** Started in this order after sign-in, once config and workspaces are loaded. */
const FEATURES = [
  workspaces,
  summary,
  // W3 overview
  overview,

  // W4 inbox
  inbox,

  // W5 editor
  files,

  // Tracking
  tracking,

  // Columns
  columns,

  // Resources: polls GET /api/resources and badges the terminals; Seguimiento shows the same figures.
  resources,

  // Launches: the loading bar while agents open, Pausar, and the actions that wait meanwhile.
  launchProgress,

  // Sleeping agents: "Dormidos (N)" in each workspace group and in Seguimiento's dock, Despertar and Olvidar.
  sleeping,

  // MCP per project: "MCP" on folder rows ("Servidores MCP" in a workspace's "Más"), registered on import.
  mcp,

  // Settings sheet: the topbar's "Ajustes" (night shift, terminals, theme, language) and the night chip.
  settings,

  // Responsive drawers: after columns and summary have wired both sides, narrow windows fold them into drawers.
  drawers,

  // Help guide: the "?" key opens it outside text fields and terminals; Ajustes' "Ayuda" row opens it too.
  help,

  // Credits: the topbar brand opens who made Mirador, with the intro the first time.
  credits,

  // Phone layout: under 600px wide the page opens on the inbox, full-screen; after the drawers it folds.
  phone,

];

/** The static copy and the session text, which names the app (brandOf(), Mirador in every mode), before the config is read too. */
function applyShellText() {
  applyStaticText();
  const creditsLabel = t('credits.open', { brand: brandOf(state.config) });
  $('#credits-open').setAttribute('aria-label', creditsLabel);
  $('#credits-open').title = creditsLabel;
  $('#auth-body').replaceChildren(...richText('auth.body', { brand: brandOf(state.config), command: el('code', {}, 'mirador') }));
}

/** The app's name in the page title, the topbar brand and the session text: Mirador, from brandOf() (public/mode-model.js). */
function applyBrand() {
  document.title = brandOf(state.config);
  $('#credits-open').lastChild.textContent = brandOf(state.config);
  applyShellText();
}

async function start() {
  // Before anything draws an icon: index.html and every feature use its symbols.
  injectSprite();
  // The settings sheet holds the data-lang and data-layout buttons wired below and in initTerminals().
  settings.mountSettings();
  applyShellText();
  document.querySelectorAll('button[data-lang]').forEach((button) =>
    button.addEventListener('click', () => {
      setLanguage(button.dataset.lang);
      applyShellText();
    }),
  );
  await signIn();
  // One request for the start-up state: GET /api/config's and GET /api/workspaces's bodies (src/http/routes/bootstrap.ts).
  const boot = await api('GET', '/api/bootstrap');
  state.config = boot.config;
  applyBrand();
  setWorkspaces(boot.workspaces);
  await initTerminals();
  for (const feature of FEATURES) await feature.init();
}

start().catch((error) => {
  if (error.message !== 'unauthorized') console.error(error);
});
