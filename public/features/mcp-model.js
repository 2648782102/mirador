// Pure rules of the "Servidores MCP" dialog: the
// selection, its estimated saving per agent, the git and trust notes and the save payload. Servers
// come from GET /api/mcp ({ name, source, enabled, locked, description, estimatedMb }). No DOM and
// no imports: public/features/mcp.js and test/mcp-model.test.ts use it.

/** The servers off in this project when the dialog opens; servers off for every project are left out. */
export function offNames(servers) {
  return new Set(servers.filter((server) => !server.enabled && !server.locked).map((server) => server.name));
}

/**
 * What turning `off` saves in each agent of the folder: the estimates added up (`mb`), how many
 * servers have none (`unknown`) and how many count (`count`). Servers off for every project save
 * nothing here.
 */
export function savingEstimate(servers, off) {
  const counted = servers.filter((server) => !server.locked && off.has(server.name));
  return {
    mb: counted.reduce((sum, server) => sum + (server.estimatedMb ?? 0), 0),
    unknown: counted.filter((server) => server.estimatedMb === null).length,
    count: counted.length,
  };
}

/** "~110 MB", or null without an estimate. */
export function memoryLabel(mb) {
  return typeof mb === 'number' ? `~${mb} MB` : null;
}

/** Body of PUT /api/mcp: the folder and the servers off, in list order. */
export function savePayload(folder, servers, off) {
  return { ws: folder.ws, rel: folder.rel, disabled: servers.filter((server) => !server.locked && off.has(server.name)).map((server) => server.name) };
}

/** Whether `off` differs from what the folder has now. */
export function isDirty(servers, off) {
  const now = offNames(servers);
  return servers.some((server) => !server.locked && now.has(server.name) !== off.has(server.name));
}

/** The i18n key of the note on the project file in git (tracked, ignored, untracked, none, unknown). */
export function gitNoteKey(git) {
  return `mcp.git.${['tracked', 'ignored', 'untracked', 'none'].includes(git) ? git : 'unknown'}`;
}

/** The i18n key of the trust note, or null when pi trusts the project (it reads .pi/mcp.json). */
export function trustNoteKey(trust) {
  if (trust === 'trusted') return null;
  return trust === 'untrusted' ? 'mcp.trust.untrusted' : 'mcp.trust.unknown';
}

/**
 * The dialog's notes as i18n keys: `warnings`, which stay on screen
 * because they may stop the save from working, and `howItWorks`, folded in "Cómo funciona": the git
 * note (first, shown after the file's path), the estimate and when the change applies.
 */
export function noteKeys(view) {
  const trustKey = trustNoteKey(view.trust);
  const warnings = [view.userConfig === 'invalid' ? 'mcp.userConfig.invalid' : null, trustKey].filter(Boolean);
  return { warnings, howItWorks: [gitNoteKey(view.git), 'mcp.estimateHint', 'mcp.applies'] };
}
