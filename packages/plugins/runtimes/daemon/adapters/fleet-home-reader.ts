/**
 * The homes half of `RuntimesApi` over the kernel's `fleet` root: which harness homes the fleet published
 * ({@link fleetHomes}) and a bounded reader of one ({@link FleetHomeReader}).
 *
 * THE READER IS A FIXED MENU, NEVER A PATH. It opens three files of a home by name (`RUNTIME_HOME_DOCUMENTS`), lists the
 * folders directly in `<home>/skills`, and reads inside a skill folder it has just listed. Every step decides on what a
 * name IS (`RootHandle.entries` reports a link as a link and a file's hard-link count), so a link, a hard-linked file, a
 * non-regular file or an over-bound file is refused before a byte is read, and no link is ever followed out of a folder.
 * The one link it follows is a skill folder's own entry in `<home>/skills`, and only when it resolves to a folder inside
 * the fleet's `assets/` (a Ferretry-managed skill); any other link is skipped. `home` and `wrapper` on a {@link RuntimeHome}
 * are display text: nothing here opens a path from them.
 *
 * It holds no handle. Every method opens the `fleet` root scoped to `homes/<id>` and first asks the published manifest
 * whether that home is still published, so a home that disappears between two calls is refused.
 */
import type { FencedPath, RootEntry, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import {
  RUNTIME_HOME_DOCUMENTS,
  type RuntimeHome,
  type RuntimeHomeDocument,
  type RuntimeHomeFileRead,
  type RuntimeHomeReader,
  type RuntimeHomesApi,
  type RuntimeHomeSkillEntry,
  type RuntimeHomeSkillTree,
  RuntimeHomeUnreadable,
} from '../../contract/index.ts';
import { homesOf } from '../lib/service/runtime-homes.ts';
import type { FleetPublication } from '../lib/service/publication.ts';
import { fleetMounts, rootHostFiles } from './root-host-files.ts';
import { readFleetManifest } from './manifest-file.ts';

const MANIFEST_FILE = 'manifest.json';
const SKILL_MANIFEST = 'SKILL.md';

/** A skill folder's name: one plain segment, never a dot-entry. */
const SKILL_NAME = /^[^./\\\0][^/\\\0]*$/u;

const unreadable = (message: string): RuntimeHomeUnreadable => new RuntimeHomeUnreadable(message);

/** The kernel's root error, reduced to its code word (it names no path and no value); anything else is unreadable too. */
const refusal = (error: unknown): string => (error as { refusal?: string }).refusal ?? 'unreadable';

/** `path` of the folder, fenced, or a refusal. */
function fenced(root: RootHandle, relative: string): FencedPath {
  const resolved = root.resolve(relative);
  if (!resolved.ok) throw unreadable(`That runtime home could not be opened (${resolved.error}).`);
  return resolved.value;
}

/** A listed skill folder: the root it is read through and its path inside that root. */
interface Folder {
  readonly root: RootHandle;
  readonly path: string;
}

/** One skill folder entry a link resolved to, or `undefined` when the link is not a folder inside the fleet's assets. */
interface ManagedFolder {
  readonly path: string;
}

class FleetHomeReader implements RuntimeHomeReader {
  readonly #id: string;
  readonly #roots: Pick<RootsPort, 'root'>;
  readonly #directory: string;
  readonly #published: () => Promise<readonly RuntimeHome[]>;

  constructor(
    id: string,
    roots: Pick<RootsPort, 'root'>,
    directory: string,
    published: () => Promise<readonly RuntimeHome[]>,
  ) {
    this.#id = id;
    this.#roots = roots;
    this.#directory = directory;
    this.#published = published;
  }

  /** The `fleet` root scoped to this home, once the manifest still names the home. */
  async #open(): Promise<RootHandle> {
    if (!(await this.#published()).some(home => home.id === this.#id))
      throw unreadable('That runtime home is not published any more.');
    return this.#roots.root('fleet', { subfolder: `homes/${this.#id}` });
  }

  async #listing(root: RootHandle, relative: string): Promise<readonly RootEntry[]> {
    return (await root.entries(fenced(root, relative))).toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  }

  /** A link in `<home>/skills`: its folder when it resolves to a folder inside the fleet's `assets/`, else nothing. */
  async #managed(name: string): Promise<ManagedFolder | undefined> {
    const fleet = this.#roots.root('fleet');
    const named = fleet.resolve(`homes/${this.#id}/skills/${name}`);
    if (!named.ok) return undefined;
    // `realPath` follows the link and is refused when the target leaves the fleet folder (a dangling link has none).
    const real = await fleet.realPath(named.value).catch(() => undefined);
    if (real === undefined || !real.startsWith(`${this.#directory}/assets/`)) return undefined;
    const found = await fleet.stat(real);
    return found?.kind === 'directory' ? { path: real.slice(this.#directory.length + 1) } : undefined;
  }

  async document(file: RuntimeHomeDocument, limitBytes: number): Promise<string | null> {
    if (!(RUNTIME_HOME_DOCUMENTS as readonly string[]).includes(file))
      throw unreadable('That is not one of the files of a runtime home that can be read.');
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1)
      throw unreadable(`${file} needs a size bound of at least one byte.`);
    const root = await this.#open();
    try {
      const entry = (await this.#listing(root, '.')).find(candidate => candidate.name === file);
      if (entry === undefined) return null;
      if (entry.kind === 'symlink') throw unreadable(`${file} is a link, which is never read.`);
      if (entry.kind !== 'file') throw unreadable(`${file} is not a regular file.`);
      if (entry.links > 1) throw unreadable(`${file} has another name on this machine, so it is not read.`);
      if (entry.size > limitBytes) throw unreadable(`${file} is larger than the ${limitBytes} bytes that may be read.`);
      return await root.readText(fenced(root, file), limitBytes);
    } catch (error) {
      if (error instanceof RuntimeHomeUnreadable) throw error;
      throw unreadable(`${file} could not be read (${refusal(error)}).`);
    }
  }

  async skills(limit: number): Promise<readonly RuntimeHomeSkillEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw unreadable('The skills list needs a bound of zero or more.');
    const root = await this.#open();
    try {
      if ((await this.#listing(root, '.')).find(entry => entry.name === 'skills')?.kind !== 'directory') return [];
      const found: RuntimeHomeSkillEntry[] = [];
      for (const entry of await this.#listing(root, 'skills')) {
        if (found.length > limit) break;
        if (entry.name.startsWith('.')) continue;
        const managed = entry.kind === 'symlink';
        if (entry.kind !== 'directory' && !(managed && (await this.#managed(entry.name)) !== undefined)) continue;
        found.push({
          name: entry.name,
          manifest: `${this.#directory}/homes/${this.#id}/skills/${entry.name}/${SKILL_MANIFEST}`,
          managed,
        });
      }
      return found;
    } catch (error) {
      throw unreadable(`The skills of that runtime home could not be listed (${refusal(error)}).`);
    }
  }

  /** The folder of a skill `skills()` lists right now, or `undefined`. */
  async #folder(name: string): Promise<Folder | undefined> {
    if (!SKILL_NAME.test(name)) return undefined;
    const root = await this.#open();
    const top = (await this.#listing(root, '.')).find(entry => entry.name === 'skills');
    if (top?.kind !== 'directory') return undefined;
    const entry = (await this.#listing(root, 'skills')).find(candidate => candidate.name === name);
    if (entry?.kind === 'directory') return { root, path: `skills/${name}` };
    if (entry?.kind !== 'symlink') return undefined;
    const managed = await this.#managed(name);
    return managed === undefined ? undefined : { root: this.#roots.root('fleet'), path: managed.path };
  }

  /** What is at `segments` below a folder, each hop a real folder (never a link), or `undefined`. */
  async #lookup(folder: Folder, segments: readonly string[]): Promise<{ entry: RootEntry; path: string } | undefined> {
    let path = folder.path;
    let entry: RootEntry | undefined;
    for (const [index, segment] of segments.entries()) {
      entry = (await this.#listing(folder.root, path)).find(candidate => candidate.name === segment);
      if (entry === undefined || (index < segments.length - 1 && entry.kind !== 'directory')) return undefined;
      path = `${path}/${segment}`;
    }
    return entry === undefined ? undefined : { entry, path };
  }

  async skillManifest(name: string, maxBytes: number): Promise<string | undefined> {
    const read = await this.skillFile(name, SKILL_MANIFEST, maxBytes);
    return read.ok ? new TextDecoder().decode(read.bytes) : undefined;
  }

  async skillTree(
    name: string,
    limits: { readonly entries: number; readonly depth: number },
  ): Promise<RuntimeHomeSkillTree | undefined> {
    if (
      !Number.isSafeInteger(limits.entries) ||
      limits.entries < 1 ||
      !Number.isSafeInteger(limits.depth) ||
      limits.depth < 1
    )
      return undefined;
    const folder = await this.#folder(name);
    if (folder === undefined) return undefined;
    const entries: RuntimeHomeSkillTree['entries'][number][] = [];
    let seen = 0;
    let truncated = false;
    const pending: { readonly path: string; readonly prefix: readonly string[] }[] = [
      { path: folder.path, prefix: [] },
    ];
    for (const next of pending) {
      if (truncated) break;
      let listing: readonly RootEntry[];
      try {
        listing = await this.#listing(folder.root, next.path);
      } catch {
        if (next.prefix.length === 0) return undefined;
        entries.push({ path: next.prefix.join('/'), type: 'other', size: 0 });
        continue;
      }
      for (const entry of listing) {
        // A folder counts as much as a file: a tree of empty folders is as long a walk as a tree of files.
        if (seen >= limits.entries) {
          truncated = true;
          break;
        }
        seen += 1;
        const segments = [...next.prefix, entry.name];
        const path = segments.join('/');
        if (entry.kind === 'symlink') entries.push({ path, type: 'symlink', size: 0 });
        else if (entry.kind === 'directory') {
          if (segments.length >= limits.depth) entries.push({ path, type: 'deep', size: 0 });
          else pending.push({ path: `${next.path}/${entry.name}`, prefix: segments });
        } else if (entry.kind === 'file')
          entries.push(
            entry.links > 1 ? { path, type: 'hardlink', size: 0 } : { path, type: 'file', size: entry.size },
          );
        else entries.push({ path, type: 'other', size: 0 });
      }
    }
    return { entries, truncated };
  }

  async skillFile(name: string, relativePath: string, maxBytes: number): Promise<RuntimeHomeFileRead> {
    const segments = relativePath.split('/');
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[\\\0]/u.test(segment))
    )
      return { ok: false, reason: 'unreadable' };
    try {
      const folder = await this.#folder(name);
      const found = folder === undefined ? undefined : await this.#lookup(folder, segments);
      if (folder === undefined || found === undefined || found.entry.kind !== 'file' || found.entry.links > 1)
        return { ok: false, reason: 'unreadable' };
      if (found.entry.size > maxBytes) return { ok: false, reason: 'too_big' };
      const bytes = await folder.root.readBytes(fenced(folder.root, found.path), maxBytes);
      return bytes.length > maxBytes ? { ok: false, reason: 'too_big' } : { ok: true, bytes };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }
}

/** The fleet folder's absolute path, as the `fleet` root names it. */
function fleetDirectory(fleet: RootHandle): string {
  const base = fleet.resolve('.');
  if (!base.ok) throw new Error(`the fleet folder could not be opened (${base.error})`);
  return base.value.endsWith('/.') ? base.value.slice(0, -2) : base.value;
}

/**
 * The homes the published manifest names (none when no apply has published one) and a reader for one of them.
 *
 * `home(id)` is synchronous, so it answers from the last reading of the manifest (`homes()` or any reader call), and it
 * answers `undefined` for an id that reading did not list. That is only the first check: every reader method asks the
 * manifest again before it opens anything.
 */
export function fleetHomes(
  roots: Pick<RootsPort, 'root'>,
  publication: Pick<FleetPublication, 'reading'>,
): RuntimeHomesApi {
  const fleet = roots.root('fleet');
  const directory = fleetDirectory(fleet);
  let known: ReadonlySet<string> = new Set();
  const published = async (): Promise<readonly RuntimeHome[]> => {
    const files = rootHostFiles(fleetMounts(roots, fleet, directory));
    const manifest = await publication.reading(
      async () => await readFleetManifest(files, `${directory}/${MANIFEST_FILE}`),
    );
    const homes = homesOf(manifest, directory);
    known = new Set(homes.map(home => home.id));
    return homes;
  };
  return {
    homes: published,
    home: id => (known.has(id) ? new FleetHomeReader(id, roots, directory, published) : undefined),
  };
}
