// design/, the approved artboards, stays in this repository and is left out of the public export
// (.gitattributes, public release T1). A test that pins the app to an artboard reads it through here
// and, where design/ is absent, skips with NO_DESIGN as its reason; the rest of its file still runs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The skip reason where design/ is absent (the public export), false where it is here. */
export const NO_DESIGN: string | false = existsSync(join(ROOT, 'design'))
  ? false
  : 'design/ is not in this checkout (the public export leaves it out): this artboard pin runs where design/ is';

/** The artboard at `path` (from the repository root); '' where design/ is absent, and a missing file still throws where it is. */
export function readArtboard(path: string): string {
  return NO_DESIGN ? '' : readFileSync(join(ROOT, path), 'utf8');
}
