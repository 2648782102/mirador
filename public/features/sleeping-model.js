// Pure rules of the sleeping agents: agents that had
// finished their turn before a restart, left without a process until the user wakes them. Their list
// is GET /api/terminals/sleeping ({ id, workspaceId, rel, createdAt, resumable }). No DOM and no
// imports: the browser (public/features/sleeping.js, terminals.js) and test/sleeping-model.test.ts use it.

/** Sleeping agents per workspace id, in the order the list first names each workspace. */
export function sleepingCounts(agents) {
  const counts = new Map();
  for (const agent of agents) counts.set(agent.workspaceId, (counts.get(agent.workspaceId) ?? 0) + 1);
  return counts;
}

/**
 * The sleeping agents by workspace: sidebar order (`workspaces`), then workspaces that no longer
 * exist, named after their id; folders sorted inside each. Returns [{ workspaceId, name, known, agents }].
 */
export function sleepingGroups(agents, workspaces) {
  const byWorkspace = new Map();
  for (const agent of agents) byWorkspace.set(agent.workspaceId, [...(byWorkspace.get(agent.workspaceId) ?? []), agent]);
  const sorted = (list) => [...list].sort((a, b) => a.rel.localeCompare(b.rel) || a.id.localeCompare(b.id));
  const groups = [];
  for (const workspace of workspaces) {
    const list = byWorkspace.get(workspace.id);
    if (!list) continue;
    groups.push({ workspaceId: workspace.id, name: workspace.name, known: true, agents: sorted(list) });
    byWorkspace.delete(workspace.id);
  }
  for (const [workspaceId, list] of byWorkspace) groups.push({ workspaceId, name: workspaceId, known: false, agents: sorted(list) });
  return groups;
}

/**
 * Desarrollo's terminal groups (terminal-groups.js groupTerminals) with each one's `sleeping`
 * count, plus an empty group for a workspace whose agents all sleep: in sidebar order among the
 * known groups, after the unknown ones otherwise.
 */
export function withSleepingGroups(groups, counts, workspaces) {
  const byId = new Map(groups.map((group) => [group.workspaceId, group]));
  const merged = [];
  for (const workspace of workspaces) {
    const group = byId.get(workspace.id);
    if (group) merged.push(group);
    else if (counts.get(workspace.id)) merged.push({ workspaceId: workspace.id, name: workspace.name, known: true, terminals: [] });
  }
  const known = new Set(workspaces.map((workspace) => workspace.id));
  merged.push(...groups.filter((group) => !known.has(group.workspaceId)));
  for (const workspaceId of counts.keys()) {
    if (!known.has(workspaceId) && !byId.has(workspaceId)) merged.push({ workspaceId, name: workspaceId, known: false, terminals: [] });
  }
  return merged.map((group) => ({ ...group, sleeping: counts.get(group.workspaceId) ?? 0 }));
}
