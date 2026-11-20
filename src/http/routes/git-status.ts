import { folderGitStatus } from '../../folders/git-status.ts';
import { readNotes } from '../../folders/notes.ts';
import type { RouteModule } from '../context.ts';
import { sendJson } from '../respond.ts';

/**
 * GET /api/folder/git?ws=&rel= → { cwd, git: FolderGit, notes: FolderNotes | null }: the folder's
 * read-only git state (src/folders/git-status.ts) and its NOTES.md (src/folders/notes.ts), for
 * plain mode's "Where it left off". Local only: no Engram, no
 * network. The folder comes from ctx.resolveFolder (unknown workspace 404, outside the root 400),
 * and both readers check it against the root again. A folder that is no repo, or a machine
 * without git, answers 200 with `git.available: false` and its reason.
 */
export const gitStatusRoutes: RouteModule = (ctx) => [
  {
    method: 'GET',
    path: '/api/folder/git',
    handler: async ({ res, url }) => {
      const { workspace, path, rel } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel'));
      const [git, notes] = await Promise.all([folderGitStatus(workspace.root, rel), readNotes(workspace.root, rel)]);
      sendJson(res, 200, { cwd: path, git, notes });
    },
  },
];
