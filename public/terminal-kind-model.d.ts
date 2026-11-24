// Types for public/terminal-kind-model.js, for the TypeScript that imports it (its tests). The
// browser never loads this file.

/** Whether a terminal shows as a tab and grid pane: a 'git' terminal never does. */
export function showsAsTab(info: { kind?: string }): boolean;

/** The terminal ids the inbox `items` name that `known` lacks, each once, in order. */
export function unknownTerminalIds(items: unknown, known: Set<string>): string[];
