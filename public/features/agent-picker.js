// The agents a folder can open, from GET /api/agents: read at the
// start and again whenever a row's ▾ menu opens, so its next opening lists what is offered now.
// With one offered agent nothing changes on the rows (agentChoices).
import { api } from '/core.js';
import { agentChoices } from '/features/agent-picker-model.js';

let offered = [];

/** Reads the offered agents again; a failed read keeps the last list. */
export async function loadAgents() {
  try {
    const { agents } = await api('GET', '/api/agents');
    offered = Array.isArray(agents) ? agents : [];
  } catch (error) {
    console.warn('could not read the offered agents:', error);
  }
}

/** The agents a row's ▾ menu offers besides its main agent button ({ id, label }[]). */
export const pickerAgents = () => agentChoices(offered);
