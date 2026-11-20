import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * opencode's attention bridge. opencode 2 loads plugins from its config
 * (https://opencode.ai/docs/plugins/) into its server, so Mirador never touches `~/.config/opencode` or a
 * project's `.opencode`: it copies bin/opencode-plugin.js into `<dir>/opencode-plugin/` and names that folder
 * in OPENCODE_CONFIG_CONTENT, an extra config layer opencode merges with the user's own (plugin lists add
 * up). Only opencode agent terminals get it (bridgeEnvProvider), started with `--standalone`: the shared
 * background server would never see the variable, a private one inherits it with the herdr variables. The
 * plugin reports through the herdr socket as bin/claude-hook does: a root session's execution started is
 * working, a permission or a question form waiting, its execution ended finished, each with the session id
 * Mirador records to resume with `--session <id>`.
 */

/**
 * Writes the plugin folder `<dir>/opencode-plugin` (0700) holding `index.js`, a copy of `pluginPath`, and a
 * `package.json` that makes it an ES module (both 0600, in Mirador's 0700 herdr folder), and returns the
 * OPENCODE_CONFIG_CONTENT that loads it.
 */
export async function prepareOpencodePlugin(dir: string, pluginPath: string): Promise<string> {
  const folder = join(dir, 'opencode-plugin');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const files: Array<[string, string]> = [['package.json', '{ "type": "module" }\n'], ['index.js', await readFile(pluginPath, 'utf8')]];
  for (const [name, text] of files) {
    await writeFile(join(folder, name), text, { mode: 0o600 });
    await chmod(join(folder, name), 0o600);
  }
  return JSON.stringify({ plugins: [folder] });
}
