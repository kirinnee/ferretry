/**
 * Where a v4 component's `file:` is read from, and only ever from INSIDE the v4 home snapshot.
 *
 * How v4 resolved it (`packages/fleet/src/lib/paths.ts` `expandAssetPath`): a relative value is relative to the asset
 * tree (`fleet/assets/`); `~/…`, `$HOME/…` and an absolute path are real filesystem paths. This tool reads a SNAPSHOT of
 * the home, so a path is mapped into it:
 *
 * 1. relative: `fleet/assets/<file>` (v4's own rule); when that is no plain file, the folder of the component's own
 *    YAML (`config/components/<kind>/<file>`), where a home that keeps its documents beside the component has them;
 * 2. `~/…`, `$HOME/…` or absolute: only when it lands inside the REAL v4 home, and then the same path inside the snapshot.
 *
 * Whatever resolves is checked with `lstat` on EVERY folder from the home root down and the file itself: a link anywhere
 * on the way, or a file that is not a regular file, is never read. A path outside the home is never opened.
 */
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { StepContext } from './index.ts';

/** A settings or hooks file is read only up to this size; a bigger one is held by name. */
export const MAX_COMPONENT_BYTES = 1024 * 1024;

/** `home/<parts…>` when every folder on the way is a real folder (no link) and the last part is a regular file. */
async function plainFileInHome(home: string, parts: readonly string[]): Promise<string | undefined> {
  if (parts.length === 0) return undefined;
  let walked = home;
  for (const [index, part] of parts.entries()) {
    walked = join(walked, part);
    const facts = await lstat(walked).catch(() => undefined);
    if (facts === undefined) return undefined;
    if (index === parts.length - 1 ? !facts.isFile() : !facts.isDirectory()) return undefined;
  }
  return walked;
}

const outsideOf = (inside: string): boolean =>
  inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);

/** The asset document an instructions (or lessons) component points at, when it is a plain file inside `fleet/assets/`. */
export async function instructionsSource(home: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || isAbsolute(value) || value.startsWith('~')) return undefined;
  const inside = relative('assets', normalize(join('assets', value)));
  if (outsideOf(inside)) return undefined;
  return plainFileInHome(home, ['fleet', 'assets', ...inside.split(sep)]);
}

/** The home-relative parts of `path` when it is inside `root`, else undefined. */
const partsInside = (root: string, path: string): readonly string[] | undefined => {
  const inside = relative(root, path);
  return outsideOf(inside) ? undefined : inside.split(sep);
};

/** The snapshot file a settings or hooks component's `file:` names, or undefined when it is outside or no plain file. */
export async function componentFileSource(
  ctx: StepContext,
  kind: 'settings' | 'hooks',
  value: string,
): Promise<string | undefined> {
  const home = ctx.v4.home;
  const isHomeRelative = value === '~' || value.startsWith('~/') || value === '$HOME' || value.startsWith('$HOME/');
  if (!isAbsolute(value) && !isHomeRelative) {
    const asset = await instructionsSource(home, value);
    if (asset !== undefined) return asset;
    const beside = partsInside(home, normalize(join(home, 'config', 'components', kind, value)));
    return beside === undefined ? undefined : plainFileInHome(home, beside);
  }
  // A path on the real filesystem: only one inside the real v4 home is reachable, as its copy in the snapshot.
  const realHome = ctx.previewV4Home ?? home;
  const userHome = ctx.previewUserHome ?? ctx.host?.homeDirectory;
  let absolute: string;
  if (isHomeRelative) {
    if (userHome === undefined) return undefined;
    absolute = join(userHome, value.replace(/^(~|\$HOME)\/?/u, ''));
  } else absolute = value;
  const parts = partsInside(normalize(realHome), normalize(absolute));
  return parts === undefined ? undefined : plainFileInHome(home, parts);
}
