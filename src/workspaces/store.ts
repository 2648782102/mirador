import { realpath } from 'node:fs/promises';
import { basename, normalize, relative, sep } from 'node:path';
import { isDirectory, type Workspace } from '../config.ts';
import { InvalidFolderError, resolveInsideRoot } from '../folders/tree.ts';

export class UnknownWorkspaceError extends Error {
  constructor(id: string) {
    super(`unknown workspace: ${id}`);
    this.name = 'UnknownWorkspaceError';
  }
}

/**
 * A rejected change or an unusable workspace. `code` is stable for the UI: workspace_name,
 * workspace_root, workspace_root_missing, workspace_folders, workspace_expanded,
 * workspace_mission, workspace_projects, workspace_limit, workspace_config, unknown_field.
 */
export class InvalidWorkspaceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InvalidWorkspaceError';
    this.code = code;
  }
}

export interface ResolvedFolder {
  workspace: Workspace;
  /** Real path of the folder, inside the workspace root. */
  path: string;
  /** Path relative to the workspace root, with forward slashes; '' for the root. */
  rel: string;
}

const MAX_WORKSPACES = 50;
const MAX_NAME = 60;
const MAX_FOLDERS = 500;
const MAX_EXPANDED = 1000;
const MAX_MISSION = 8000;
/** Also the most folders one batch opens (src/http/routes/terminals.ts). */
export const MAX_PROJECTS = 50;
const CONTROL = /\p{Cc}/u;
/** Control characters other than tab, line feed and carriage return, which Markdown uses. */
const MISSION_CONTROL = /[^\P{Cc}\t\n\r]/u;

const sortNames = (list: string[]) => [...new Set(list)].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }) || a.localeCompare(b));

function onlyFields(input: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length) throw new InvalidWorkspaceError('unknown_field', `unknown fields: ${extra.join(', ')}`);
}

function checkName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_NAME || CONTROL.test(name)) {
    throw new InvalidWorkspaceError('workspace_name', `name must be 1-${MAX_NAME} printable characters`);
  }
  return name;
}

async function checkRoot(value: unknown, home: string | undefined): Promise<string> {
  const raw = typeof value === 'string' ? value.trim().replace(/^~(?=\/|$)/, home ?? '~') : '';
  if (!raw.startsWith('/') || !(await isDirectory(raw))) {
    throw new InvalidWorkspaceError('workspace_root', 'root must be an existing absolute folder');
  }
  return normalize(raw).replace(/\/+$/, '') || '/';
}

function slug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

async function relInside(root: string, rel: string): Promise<{ path: string; rel: string }> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new InvalidWorkspaceError('workspace_root_missing', `the workspace folder no longer exists: ${root}`);
  }
  const path = await resolveInsideRoot(realRoot, rel);
  return { path, rel: relative(realRoot, path).split(sep).join('/') };
}

/**
 * At most `max` existing folders inside the root (never the root itself), normalized, sorted and once.
 * An entry already in `saved` that no longer resolves (deleted on disk) is kept as saved, so one
 * deleted folder does not block saving the rest; every other entry must resolve.
 */
async function checkFolderList(root: string, value: unknown, saved: string[], max: number, invalid: () => InvalidWorkspaceError): Promise<string[]> {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  const folders: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) throw invalid();
    let rel: string;
    try {
      ({ rel } = await relInside(root, entry.trim()));
    } catch (error) {
      if (!(error instanceof InvalidFolderError)) throw error;
      const kept = entry.trim().split('/').filter((s) => s && s !== '.').join('/');
      if (!saved.includes(kept)) throw invalid();
      rel = kept;
    }
    if (!rel) throw invalid();
    folders.push(rel);
  }
  return sortNames(folders);
}

const checkFolders = (root: string, value: unknown, saved: string[]) =>
  checkFolderList(root, value, saved, MAX_FOLDERS, () => new InvalidWorkspaceError('workspace_folders', 'folders must be existing folders inside the workspace root'));
const checkProjects = (root: string, value: unknown, saved: string[]) =>
  checkFolderList(root, value, saved, MAX_PROJECTS, () => new InvalidWorkspaceError('workspace_projects', `projects must be at most ${MAX_PROJECTS} existing folders inside the workspace root`));

function checkExpanded(value: unknown): string[] {
  const invalid = () => new InvalidWorkspaceError('workspace_expanded', 'expanded must list relative folder paths');
  if (!Array.isArray(value) || value.length > MAX_EXPANDED) throw invalid();
  return sortNames(
    value.map((entry) => {
      if (typeof entry !== 'string' || entry.length > 1024 || entry.startsWith('/') || CONTROL.test(entry)) throw invalid();
      const segments = entry.split('/').filter((s) => s && s !== '.');
      if (!segments.length || segments.includes('..')) throw invalid();
      return segments.join('/');
    }),
  );
}

/** Markdown text up to MAX_MISSION characters; blank means no mission (null). Nothing is stripped. */
function checkMission(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_MISSION || MISSION_CONTROL.test(value)) {
    throw new InvalidWorkspaceError('workspace_mission', `mission must be text of at most ${MAX_MISSION} characters without control characters`);
  }
  return value.trim() ? value : null;
}

/**
 * The workspaces Mirador shows. Every change is validated, saved through
 * `persist` and only then applied; changes run one at a time, in order.
 * `problems` (from loadConfig's workspaceProblems) lists what the config file
 * holds that Mirador could not read: saving the list would drop or overwrite it,
 * so while there is any, every change is refused (`workspace_config`).
 */
export class WorkspaceStore {
  private workspaces: Workspace[];
  private readonly persist: (workspaces: Workspace[]) => Promise<void>;
  private readonly problems: string[];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(workspaces: Workspace[], persist: (workspaces: Workspace[]) => Promise<void>, options: { problems?: string[] } = {}) {
    this.workspaces = structuredClone(workspaces);
    this.persist = persist;
    this.problems = [...(options.problems ?? [])];
  }

  list(): Workspace[] {
    return structuredClone(this.workspaces);
  }

  get(id: string): Workspace | undefined {
    const found = this.workspaces.find((w) => w.id === id);
    return found && structuredClone(found);
  }

  /** Adds a workspace from `{ root, name? }`; without a name it takes the folder's name. */
  add(input: Record<string, unknown>, env: { HOME?: string } = process.env): Promise<Workspace> {
    return this.change(async (list) => {
      onlyFields(input, ['name', 'root']);
      if (list.length >= MAX_WORKSPACES) throw new InvalidWorkspaceError('workspace_limit', `at most ${MAX_WORKSPACES} workspaces`);
      const root = await checkRoot(input.root, env.HOME);
      const blank = typeof input.name !== 'string' || !input.name.trim();
      const name = checkName(blank ? basename(root) || root : input.name);
      const taken = new Set(list.map((w) => w.id));
      const base = slug(name);
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      const workspace: Workspace = { id, name, root, folders: [], expanded: [] };
      return { list: [...list, workspace], result: workspace };
    });
  }

  /**
   * Changes `name`, `folders`, `expanded`, `mission` and/or `projects`; the root and id never
   * change. A blank mission or an empty project set removes it.
   */
  update(id: string, patch: Record<string, unknown>): Promise<Workspace> {
    return this.change(async (list) => {
      const current = list.find((w) => w.id === id);
      if (!current) throw new UnknownWorkspaceError(id);
      onlyFields(patch, ['name', 'folders', 'expanded', 'mission', 'projects']);
      const next: Workspace = { ...current };
      if ('name' in patch) next.name = checkName(patch.name);
      if ('folders' in patch) next.folders = await checkFolders(current.root, patch.folders, current.folders);
      if ('expanded' in patch) next.expanded = checkExpanded(patch.expanded);
      if ('mission' in patch) {
        const mission = checkMission(patch.mission);
        if (mission === null) delete next.mission;
        else next.mission = mission;
      }
      if ('projects' in patch) {
        const projects = await checkProjects(current.root, patch.projects, current.projects ?? []);
        if (projects.length) next.projects = projects;
        else delete next.projects;
      }
      return { list: list.map((w) => (w.id === id ? next : w)), result: next };
    });
  }

  /** Forgets a workspace. Its folder and files are never touched. */
  remove(id: string): Promise<void> {
    return this.change(async (list) => {
      if (!list.some((w) => w.id === id)) throw new UnknownWorkspaceError(id);
      return { list: list.filter((w) => w.id !== id), result: undefined };
    });
  }

  /** Resolves `rel` inside workspace `id`, following symlinks; the result never leaves its root. */
  async resolve(id: string, rel: string): Promise<ResolvedFolder> {
    const workspace = this.get(id);
    if (!workspace) throw new UnknownWorkspaceError(id);
    return { workspace, ...(await relInside(workspace.root, rel)) };
  }

  private change<T>(apply: (list: Workspace[]) => Promise<{ list: Workspace[]; result: T }>): Promise<T> {
    if (this.problems.length) {
      return Promise.reject(
        new InvalidWorkspaceError(
          'workspace_config',
          `workspace changes are not saved while config.json holds workspaces Mirador cannot read (${this.problems.join('; ')}); fix the file and restart Mirador`,
        ),
      );
    }
    const run = this.queue.then(async () => {
      const { list, result } = await apply(structuredClone(this.workspaces));
      await this.persist(structuredClone(list));
      this.workspaces = list;
      return structuredClone(result);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
