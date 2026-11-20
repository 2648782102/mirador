// Choosing the agent that opens in a folder: the pure rules behind
// the ▾ beside a row's agent button and its menu (agent-picker.js, workspaces.js), tested in
// test/agent-picker-model.test.ts.

/**
 * The agents a row's ▾ menu offers besides its main agent button: the offered agents
 * (GET /api/agents) other than the configured one, in order, each by its catalog id and label.
 * None while one agent or fewer is offered: then there is no ▾ and the row stays exactly as before.
 */
export function agentChoices(agents) {
  if (!Array.isArray(agents) || agents.length < 2) return [];
  return agents
    .filter((agent) => agent && !agent.configured && typeof agent.id === 'string' && agent.id && typeof agent.label === 'string')
    .map(({ id, label }) => ({ id, label }));
}

/**
 * The POST /api/terminals body for `folder` ({ ws, rel }): its kind and size, and for an agent
 * terminal the chosen agent by its id only, never a command (the server checks it is offered).
 */
export function terminalBody(folder, kind, size, agent = null) {
  return { ws: folder.ws, rel: folder.rel, kind, ...size, ...(kind === 'agent' && typeof agent === 'string' && agent ? { agent } : {}) };
}
