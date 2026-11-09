/**
 * Where a v4 component's `file:` is read from. v4's own rule, exactly, and nothing wider.
 *
 * How v4 resolved it (`packages/fleet/src/lib/paths.ts` `expandAssetPath`): a relative value is relative to the asset
 * tree (`fleet/assets/`); `~/…`, `$HOME/…` and an absolute path are real filesystem paths. v4 then FENCED every
 * component source (`componentSourceFence`): the only open folder inside the home is `fleet/assets/`; a `file:` that
 * resolved anywhere else was a config error and its body was never read. So this tool carries a `file:` only when the
 * resolved REAL path lies under `<v4 home>/fleet/assets/`, and then reads the same path inside the snapshot:
 *
 * 1. relative: `fleet/assets/<file>` (a `..` that climbs out of it is outside);
 * 2. `~/…`, `$HOME/…` or absolute: only when it lands under the REAL v4 home's `fleet/assets/`.
 *
 * There is NO "beside the YAML" fallback: v4 never read a document from `config/components/`. Whatever resolves is
 * checked with `lstat` on EVERY folder from the home root down and the file itself: a link anywhere on the way, or a
 * file that is not a regular file, is never read. A path anywhere else (the rest of the home, a credential file under
 * `state/`, another folder) is never opened.
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

/** What `componentFileSource` found: the snapshot file, or the KIND of refusal (never the path's contents). */
export type ComponentFile =
  | { readonly source: string }
  | { readonly refused: 'outside fleet/assets' | 'no plain file in fleet/assets' };

const OUTSIDE = { refused: 'outside fleet/assets' } as const;

/** The parts under `<root>/fleet/assets/` of `path`, or undefined when it is not under it. */
const assetParts = (root: string, path: string): readonly string[] | undefined => {
  const inside = relative(join(root, 'fleet', 'assets'), path);
  return outsideOf(inside) ? undefined : inside.split(sep);
};

/** The snapshot file a settings or hooks component's `file:` names, under v4's rule, or the kind of refusal. */
export async function componentFileSource(ctx: StepContext, value: string): Promise<ComponentFile> {
  const home = ctx.v4.home;
  const isHomeRelative = value === '~' || value.startsWith('~/') || value === '$HOME' || value.startsWith('$HOME/');
  let parts: readonly string[] | undefined;
  if (!isAbsolute(value) && !isHomeRelative) {
    const inside = relative('assets', normalize(join('assets', value)));
    parts = outsideOf(inside) ? undefined : inside.split(sep);
  } else {
    // A path on the real filesystem: only one under the real v4 home's fleet/assets is reachable, as its snapshot copy.
    const realHome = ctx.previewV4Home ?? home;
    const userHome = ctx.previewUserHome ?? ctx.host?.homeDirectory;
    let absolute: string;
    if (isHomeRelative) {
      if (userHome === undefined) return OUTSIDE;
      absolute = join(userHome, value.replace(/^(~|\$HOME)\/?/u, ''));
    } else absolute = value;
    parts = assetParts(normalize(realHome), normalize(absolute));
  }
  if (parts === undefined) return OUTSIDE;
  const source = await plainFileInHome(home, ['fleet', 'assets', ...parts]);
  return source === undefined ? { refused: 'no plain file in fleet/assets' } : { source };
}
