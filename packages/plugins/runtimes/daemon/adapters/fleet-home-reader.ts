/**
 * The homes half of `RuntimesApi`: which harness homes the fleet published ({@link fleetHomes}) and a bounded reader of
 * one ({@link FleetHomeReader}).
 *
 * THE READER IS A FIXED MENU, NEVER A PATH. It opens three files of a home by name (`RUNTIME_HOME_DOCUMENTS`), lists the
 * folders directly in `<home>/skills`, and reads inside a skill folder it has just listed. Every step decides on what a
 * name IS (`RootHandle.entries` reports a link as a link and a file's hard-link count), so a link, a hard-linked file, a
 * non-regular file or an over-bound file is refused before a byte is read.
 *
 * EVERY READ GOES THROUGH A HANDLE SCOPED TO THE FOLDER IT READS, so the kernel's own fence is the second line behind the
 * reader's listing: a home's documents through the home's folder, a plain skill through `<home>/skills/<name>`, a managed
 * skill through the asset folder its link resolved to. A name swapped for a link between the listing and the read is
 * refused by the kernel (`link_escape`) and no byte leaves. The one handle that is NOT scoped to a folder it reads is the
 * `fleet` root opened to resolve a skill link (`realPath` only; nothing is read through it): that is the only handle that
 * can name both `homes/<id>/skills/<name>` and `assets/`. A swap there can only change which asset folder is read, and that
 * folder is then read through its own scoped handle.
 *
 * Declared residuals: a document swapped for a link between its listing and its read can reach another file of the
 * SAME home (the three-name menu and the home's own folder bound it, and no link out of the home is ever followed);
 * a file inside a skill folder swapped for a link can reach another file of the same skill folder.
 *
 * A home the manifest places outside `fleet/homes` (an operator's own folder, a home-manager home) is served read-only
 * through `following-handle.ts` with the same menu and bounds, and its links are FOLLOWED: such a home is made of links
 * (`skills/`, `settings.json` into `/nix/store`) and its catalogs read the same through them as through plain files. The
 * follow is bounded (at most `MAX_LINK_HOPS` links on the way down, a link back to a folder above it is a loop, a dangling
 * link or a link the kernel refuses is left as a link and named as one), it never reaches the daemon's own home or a
 * sign-in file, and nothing here writes. A fleet home is unchanged: a link there is read only when it resolves into the
 * fleet's own `assets/`.
 *
 * A link in a skill's own tree (`skillTree`) is followed the same way, so a skill folder made of links into a store lists
 * and reads as the same folder made of files.
 *
 * Each method runs whole inside ONE `publication.reading(...)` (the manifest is read inside it, ungated, never nested),
 * so an apply that moves a home's documents aside is never observed half-done (S67).
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
import { followingHandle, type ReadHandle } from './following-handle.ts';
import { readFleetManifest } from './manifest-file.ts';

const MANIFEST_FILE = 'manifest.json';
const SKILL_MANIFEST = 'SKILL.md';

/** The most of `manifest.json` that is read: a manifest of a thousand accounts is far under it. */
const MANIFEST_LIMIT = 4 * 1024 * 1024;

/** A skill folder's name: one plain segment, never a dot-entry. */
const SKILL_NAME = /^[^./\\\0][^/\\\0]*$/u;

const unreadable = (message: string): RuntimeHomeUnreadable => new RuntimeHomeUnreadable(message);

/** The kernel's root error, reduced to its code word (it names no path and no value); anything else is unreadable too. */
const refusal = (error: unknown): string => (error as { refusal?: string }).refusal ?? 'unreadable';

/** `path` below a folder, fenced, or a refusal. */
function fenced(root: ReadHandle, relative: string): FencedPath {
  const resolved = root.resolve(relative);
  if (!resolved.ok) throw unreadable(`That runtime home could not be opened (${resolved.error}).`);
  return resolved.value;
}

/** `name` below the folder `path` names (`.` is the folder the handle is scoped to). */
const below = (path: string, name: string): string => (path === '.' ? name : `${path}/${name}`);

/** What the reader needs of the world: the roots, the fleet folder's lexical path, the gate and the ungated manifest read. */
interface Deps {
  readonly roots: Pick<RootsPort, 'root'>;
  readonly directory: string;
  readonly publication: Pick<FleetPublication, 'reading'>;
  readonly published: () => Promise<readonly RuntimeHome[]>;
}

/** A handle scoped to `home` (or to `inside`, a folder below it): the `fleet` root for a fleet home, `harness-home` for any other. */
function scoped(deps: Deps, home: RuntimeHome, inside?: string): ReadHandle {
  const folder = inside === undefined ? home.home : `${home.home}/${inside}`;
  return home.home.startsWith(`${deps.directory}/homes/`)
    ? deps.roots.root('fleet', { subfolder: folder.slice(deps.directory.length + 1) })
    : followingHandle(deps.roots, home.home, folder);
}

/**
 * The asset folder (below the fleet folder) a link in `<home>/skills` resolves to, or `undefined` when it does not resolve
 * to a folder inside the fleet's `assets/`. Resolved once per call; a home outside the fleet has none (its root cannot
 * follow a link out of the folder).
 */
type ManagedResolver = (name: string) => Promise<string | undefined>;

function managedResolver(deps: Deps, home: RuntimeHome): ManagedResolver {
  if (!home.home.startsWith(`${deps.directory}/homes/`)) return async () => undefined;
  // `fleet` is opened only to resolve a link (`realPath`); nothing is read through it.
  const fleet = deps.roots.root('fleet');
  let realFleet: Promise<string> | undefined;
  return async name => {
    // Compared with the RESOLVED fleet folder: a FY_HOME reached through a link still resolves its managed skills.
    realFleet ??= fleet.realPath(fenced(fleet, '.'));
    const prefix = `${await realFleet}/assets/`;
    const real = await fleet.realPath(fenced(fleet, `homes/${home.id}/skills/${name}`)).catch(() => undefined);
    if (real === undefined || !real.startsWith(prefix)) return undefined;
    const inAssets = real.slice(prefix.length);
    const assets = deps.roots.root('fleet', { subfolder: 'assets' });
    const found = await assets.stat(fenced(assets, inAssets));
    return found?.kind === 'directory' ? `assets/${inAssets}` : undefined;
  };
}

async function listing(root: ReadHandle, relative: string): Promise<readonly RootEntry[]> {
  return (await root.entries(fenced(root, relative))).toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

class FleetHomeReader implements RuntimeHomeReader {
  readonly #id: string;
  readonly #deps: Deps;

  constructor(id: string, deps: Deps) {
    this.#id = id;
    this.#deps = deps;
  }

  /** `body` inside ONE read of the published fleet, once the manifest (read inside it, ungated) still names the home. */
  async #gate<T>(body: (home: RuntimeHome) => Promise<T>): Promise<T> {
    return await this.#deps.publication.reading(async () => {
      const home = (await this.#deps.published()).find(candidate => candidate.id === this.#id);
      if (home === undefined) throw unreadable('That runtime home is not published any more.');
      return await body(home);
    });
  }

  async document(file: RuntimeHomeDocument, limitBytes: number): Promise<string | null> {
    if (!(RUNTIME_HOME_DOCUMENTS as readonly string[]).includes(file))
      throw unreadable('That is not one of the files of a runtime home that can be read.');
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1)
      throw unreadable(`${file} needs a size bound of at least one byte.`);
    try {
      return await this.#gate(async home => {
        const root = scoped(this.#deps, home);
        const entry = (await listing(root, '.')).find(candidate => candidate.name === file);
        if (entry === undefined) return null;
        if (entry.kind === 'symlink')
          throw unreadable(
            home.home.startsWith(`${this.#deps.directory}/homes/`)
              ? `${file} is a link, which is never read.`
              : `${file} is a link that is not followed (it leads nowhere, loops, is nested too deep, or leads to a place that is never read).`,
          );
        if (entry.kind !== 'file') throw unreadable(`${file} is not a regular file.`);
        if (entry.links > 1) throw unreadable(`${file} has another name on this machine, so it is not read.`);
        if (entry.size > limitBytes)
          throw unreadable(`${file} is larger than the ${limitBytes} bytes that may be read.`);
        return await root.readText(fenced(root, file), limitBytes);
      });
    } catch (error) {
      if (error instanceof RuntimeHomeUnreadable) throw error;
      throw unreadable(`${file} could not be read (${refusal(error)}).`);
    }
  }

  async skills(limit: number): Promise<readonly RuntimeHomeSkillEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw unreadable('The skills list needs a bound of zero or more.');
    try {
      return await this.#gate(async home => {
        const root = scoped(this.#deps, home);
        if ((await listing(root, '.')).find(entry => entry.name === 'skills')?.kind !== 'directory') return [];
        const managedOf = managedResolver(this.#deps, home);
        const found: RuntimeHomeSkillEntry[] = [];
        for (const entry of await listing(root, 'skills')) {
          if (found.length > limit) break;
          if (entry.name.startsWith('.')) continue;
          const managed = entry.kind === 'symlink';
          if (entry.kind !== 'directory' && !(managed && (await managedOf(entry.name)) !== undefined)) continue;
          found.push({ name: entry.name, manifest: `${home.home}/skills/${entry.name}/${SKILL_MANIFEST}`, managed });
        }
        return found;
      });
    } catch (error) {
      if (error instanceof RuntimeHomeUnreadable) throw error;
      throw unreadable(`The skills of that runtime home could not be listed (${refusal(error)}).`);
    }
  }

  /** A handle scoped to the folder of a skill `skills()` lists right now, or `undefined`. */
  async #folder(home: RuntimeHome, name: string): Promise<ReadHandle | undefined> {
    if (!SKILL_NAME.test(name)) return undefined;
    const root = scoped(this.#deps, home);
    if ((await listing(root, '.')).find(entry => entry.name === 'skills')?.kind !== 'directory') return undefined;
    const entry = (await listing(root, 'skills')).find(candidate => candidate.name === name);
    if (entry?.kind === 'directory') return scoped(this.#deps, home, `skills/${name}`);
    if (entry?.kind !== 'symlink') return undefined;
    const managed = await managedResolver(this.#deps, home)(name);
    return managed === undefined ? undefined : this.#deps.roots.root('fleet', { subfolder: managed });
  }

  /** What is at `segments` below a skill folder, each hop a real folder (never a link), or `undefined`. */
  async #lookup(
    folder: ReadHandle,
    segments: readonly string[],
  ): Promise<{ entry: RootEntry; path: string } | undefined> {
    let path = '.';
    let entry: RootEntry | undefined;
    for (const [index, segment] of segments.entries()) {
      entry = (await listing(folder, path)).find(candidate => candidate.name === segment);
      if (entry === undefined || (index < segments.length - 1 && entry.kind !== 'directory')) return undefined;
      path = below(path, segment);
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
    try {
      return await this.#gate(async home => {
        const folder = await this.#folder(home, name);
        return folder === undefined ? undefined : await this.#walk(folder, limits);
      });
    } catch (error) {
      if (error instanceof RuntimeHomeUnreadable) throw error;
      throw unreadable(`That skill folder could not be listed (${refusal(error)}).`);
    }
  }

  async #walk(
    folder: ReadHandle,
    limits: { readonly entries: number; readonly depth: number },
  ): Promise<RuntimeHomeSkillTree | undefined> {
    const entries: RuntimeHomeSkillTree['entries'][number][] = [];
    let seen = 0;
    let truncated = false;
    const pending: { readonly path: string; readonly prefix: readonly string[] }[] = [{ path: '.', prefix: [] }];
    for (const next of pending) {
      if (truncated) break;
      let found: readonly RootEntry[];
      try {
        found = await listing(folder, next.path);
      } catch {
        if (next.prefix.length === 0) return undefined;
        entries.push({ path: next.prefix.join('/'), type: 'other', size: 0 });
        continue;
      }
      for (const entry of found) {
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
          else pending.push({ path: below(next.path, entry.name), prefix: segments });
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
      return await this.#gate(async (home): Promise<RuntimeHomeFileRead> => {
        const folder = await this.#folder(home, name);
        const found = folder === undefined ? undefined : await this.#lookup(folder, segments);
        if (folder === undefined || found === undefined || found.entry.kind !== 'file' || found.entry.links > 1)
          return { ok: false, reason: 'unreadable' };
        if (found.entry.size > maxBytes) return { ok: false, reason: 'too_big' };
        const bytes = await folder.readBytes(fenced(folder, found.path), maxBytes);
        return bytes.length > maxBytes ? { ok: false, reason: 'too_big' } : { ok: true, bytes };
      });
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
  // The manifest through the fleet root itself, so the kernel bounds the read (`HostFiles.readText` takes no limit).
  const files = {
    readText: async (): Promise<string | undefined> => {
      const at = fleet.resolve(MANIFEST_FILE);
      if (!at.ok) throw unreadable(`The fleet manifest could not be opened (${at.error}).`);
      return (await fleet.lstat(at.value)) === undefined ? undefined : await fleet.readText(at.value, MANIFEST_LIMIT);
    },
  };
  let known: ReadonlySet<string> = new Set();
  /** The manifest's homes, read OUTSIDE the gate (the caller holds it); damage is a typed refusal naming the file. */
  const published = async (): Promise<readonly RuntimeHome[]> => {
    const path = `${directory}/${MANIFEST_FILE}`;
    let homes: readonly RuntimeHome[];
    try {
      homes = homesOf(await readFleetManifest(files, path), directory);
    } catch {
      throw unreadable(`The fleet manifest at ${path} could not be read.`);
    }
    known = new Set(homes.map(home => home.id));
    return homes;
  };
  const deps: Deps = { roots, directory, publication, published };
  return {
    homes: async () => await publication.reading(published),
    home: id => (known.has(id) ? new FleetHomeReader(id, deps) : undefined),
  };
}
