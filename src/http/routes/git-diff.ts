import { folderGitDiff } from '../../folders/git-diff.ts';
import type { RouteModule } from '../context.ts';
import { sendJson } from '../respond.ts';

/**
 * GET /api/folder/diff?ws=&rel= → { cwd, diff: FolderDiff }: the folder's read-only changes against
 * HEAD (src/folders/git-diff.ts) for the "Changes" panel, in both modes.
 * Same shape and guards as GET /api/folder/git: the folder comes from ctx.resolveFolder
 * (unknown workspace 404, outside the root 400) and the helper checks it against the root again.
 * No repo, no commit or no git answers 200 with `diff.available: false` and its reason.
 */
export const gitDiffRoutes: RouteModule = (ctx) => [
  {
    method: 'GET',
    path: '/api/folder/diff',
    handler: async ({ res, url }) => {
      const { workspace, path, rel } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel'));
      sendJson(res, 200, { cwd: path, diff: await folderGitDiff(workspace.root, rel) });
    },
  },
];
