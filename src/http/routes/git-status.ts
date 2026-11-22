import { LEFT_OFF_DAYS, stateDir } from '../../config.ts';
import { folderGitStatus } from '../../folders/git-status.ts';
import { readNotes } from '../../folders/notes.ts';
import { leftOffDir, readLeftOff } from '../../memory/left-off.ts';
import { plainLeftOff } from '../../memory/overview.ts';
import type { RouteModule } from '../context.ts';
import { sendJson } from '../respond.ts';

/**
 * GET /api/folder/git?ws=&rel= → { cwd, git: FolderGit, notes: FolderNotes | null, leftOff?: PlainLeftOff }:
 * the folder's read-only git state (src/folders/git-status.ts), its NOTES.md (src/folders/notes.ts) and
 * its local record of Claude Code's hooks (src/memory/left-off.ts; left out when none, expired or `leftOff: false`),
 * for plain mode's "Where it left off". Local only: no Engram, no
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
      const [git, notes, record] = await Promise.all([
        folderGitStatus(workspace.root, rel),
        readNotes(workspace.root, rel),
        ctx.config.leftOff === false ? null : readLeftOff(leftOffDir(stateDir()), workspace.id, rel, { days: ctx.config.leftOffDays ?? LEFT_OFF_DAYS }),
      ]);
      sendJson(res, 200, { cwd: path, git, notes, ...(record ? { leftOff: plainLeftOff(record) } : {}) });
    },
  },
];
