/**
 * One generic "folder registry": a package keeps a folder of files (`daemon/features/*.feature.ts`, later port slices,
 * manifest fragments, CLI verbs), and the generator writes ONE git-ignored file that lists them, so a feature is added by
 * adding a file and no list is edited. A registry differs from another only by its folder, its glob, its output path and
 * what the output says (`emit`): an import list, an `extends` list, a spread, a barrel.
 *
 * Order is the file names sorted as plain strings (not by locale), so the output is the same on every OS.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** One file of the folder, with the pieces an `emit` needs to name it. */
export interface FolderEntry {
  /** File name inside the folder (`alpha.feature.ts`). */
  readonly file: string;
  /** A valid identifier derived from the name, unique inside the registry (`feature_alpha`). */
  readonly name: string;
  /** Relative import path from the generated file to this file (`../features/alpha.feature.ts`). */
  readonly importPath: string;
}

/** What `emit` is given: the entries in sorted order, and the folder and output it is writing for. */
export interface FolderEmitInput {
  readonly entries: readonly FolderEntry[];
  /** Folder relative to its package (`daemon/features`). */
  readonly dir: string;
  /** The generated file, relative to the package. */
  readonly out: string;
  /** The text of one entry's file, for an `emit` that lists what a file declares (`read(entry.file)`). */
  readonly read: (file: string) => string;
}

export interface FolderRegistrySpec {
  /** Folder relative to the package root. */
  readonly dir: string;
  /** File-name glob inside that folder, not recursive (`*.feature.ts`). */
  readonly glob: string;
  /** The generated file, relative to the package root. */
  readonly out: string;
  /** Prefix of each entry's identifier (`feature`); the rest is the file name without what the glob's `*` left out. */
  readonly prefix: string;
  /** What the generated file says; return the whole text, header included. */
  readonly emit: (input: FolderEmitInput) => string;
}

/** The part of a workspace package a registry needs. */
export interface FolderPackage {
  /** Absolute folder. */
  readonly dir: string;
  /** Folder relative to the root, `/`-separated. */
  readonly rel: string;
}

/** `/`-separated relative import path from one file to another, always starting with `.`. */
export function importPath(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** A valid identifier from a prefix and an id: anything outside `[a-zA-Z0-9]` becomes `_`. */
export const ident = (prefix: string, id: string): string => `${prefix}_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;

/** Code-unit order, so no locale changes it. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The text a glob like `*.feature.ts` leaves after `*`, so `alpha.feature.ts` is named `alpha`. */
const suffixOf = (glob: string): string => {
  const star = glob.indexOf('*');
  return star === -1 ? '' : glob.slice(star + 1);
};

/**
 * The registry files of one spec: `<package>/<out>` (root-relative, `/`-separated) → text, for every package whose
 * folder holds at least one matching file. A package without the folder, or with no match, gets no file.
 */
export function folderRegistries(
  packages: readonly FolderPackage[],
  spec: FolderRegistrySpec,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const suffix = suffixOf(spec.glob);
  for (const pkg of packages) {
    const dir = join(pkg.dir, spec.dir);
    if (!existsSync(dir)) continue;
    const files = [...new Bun.Glob(spec.glob).scanSync({ cwd: dir, onlyFiles: true })].sort(byName);
    if (files.length === 0) continue;
    const target = join(pkg.dir, spec.out);
    const entries = files.map(file => ({
      file,
      name: ident(spec.prefix, suffix !== '' && file.endsWith(suffix) ? file.slice(0, -suffix.length) : file),
      importPath: importPath(target, join(dir, file)),
    }));
    out.set(
      `${pkg.rel}/${spec.out}`,
      spec.emit({ entries, dir: spec.dir, out: spec.out, read: file => readFileSync(join(dir, file), 'utf8') }),
    );
  }
  return out;
}
