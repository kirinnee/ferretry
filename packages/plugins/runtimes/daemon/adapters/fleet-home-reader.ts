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
 * Declared residuals: a name of a FLEET home swapped for a link between its listing and its read can reach another file of
 * the SAME folder it is scoped to. For a home outside the fleet every read is checked after it (the bytes are kept only
 * when the name still reaches the file that was judged), so a swap of the file itself is refused; a swap of a FOLDER above
 * it for a link to another folder is not, and can return a same-named file there (`following-handle.ts` states it for the
 * skills, `document-link.ts` for the three documents).
 *
 * A home the manifest places outside `fleet/homes` (an operator's own folder, a home-manager home) is served read-only
 * through `following-handle.ts` (the skills, scoped to the account home itself) and `document-link.ts` (the three
 * documents). WHAT EACH READER DOES WITH A LINK there, against what today's readers of the same home did (today's machine
 * skill inventory confined an outside home to `fleet/`; the session skill picker and the MCP document reader followed
 * every link):
 *
 *  - `skills()` lists a plain folder and a link that resolves INSIDE the home to a folder with a plain `SKILL.md`; it skips,
 *    with no line and no error, a link that leaves the home (a store, `~/.ssh`), leads nowhere, loops, or leads to a
 *    sign-in file. What it lists is a SUPERSET of today's machine skill inventory of such a home (a plain folder and an
 *    inside link are extra: the inventory listed neither), EXCEPT where that inventory followed a link into `fleet/`:
 *    a link into the fleet's `assets/` it listed as Ferretry's, and here it is skipped (waived, because no root can name both
 *    the home and `assets/`; Skills lists `fleet/assets/skills/<name>` itself as Ferretry's, so such a link is a duplicate
 *    path to the same skill and never needs following). It is also NARROWER than the session skill picker (that listed store links). A skill folder
 *    whose `SKILL.md` is a hard link is not listed: nothing could read it.
 *  - `skillManifest()` reads `SKILL.md` plain or through a link inside the home; a link out of the home is not read.
 *  - `document()` follows a link for the three documents ONLY, wherever it leads (a home-manager link into a store), as
 *    today's MCP document reader did, under the bounds of `document-link.ts` (a regular file, with a second name only in a
 *    proven-immutable store, at most 16 MiB, that parses as the document, never the daemon's home, never a target whose
 *    real name is a sign-in file's; a second name is read only by the kernel's hard-link rule (S49), in the root-owned,
 *    world-readable store, a sign-in file's second name under another basename included, and refused everywhere else)
 *    and with a refusal that names only the
 *    link. That is NARROWER than today's reader, which opened any file. A link to nothing answers absent, as there.
 *  - `skillTree()` and `skillFile()` never follow a link inside a skill folder: a link is a link (tree) or unreadable
 *    (file), as today's skill-folder reader does.
 *
 * The follow of the home and of its `skills/` folder is bounded by construction (`following-handle.ts`); nothing here
 * writes. A fleet home is unchanged: a link there is read only when it resolves into the fleet's own `assets/`.
 *
 * Each method runs whole inside ONE `publication.reading(...)` (the manifest is read inside it, ungated, never nested),
 * so an apply that moves a home's documents aside is never observed half-done (S67).
 */
import type { FencedPath, RootEntry, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import {
  RUNTIME_HOME_DOCUMENTS,
  type RuntimeAssetSkills,
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
import { readLinkedDocument } from './document-link.ts';
import { followingHandle, isPlainFileInside, type ReadHandle } from './following-handle.ts';
import { FleetManifestUnreadableError, readFleetManifest } from './manifest-file.ts';

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

const isFleetHome = (deps: Deps, home: RuntimeHome): boolean => home.home.startsWith(`${deps.directory}/homes/`);

/**
 * A handle scoped to `home` (or to `inside`, a folder below it): the `fleet` root for a fleet home, `harness-home` scoped to
 * the account home for any other. `follow` (a home outside the fleet only) says whether a link in a listing that resolves
 * inside the home is followed: the listing of the home, of its `skills/` and of the skill folder `skillManifest` reads follow;
 * a walk or file read INSIDE one skill folder does not.
 */
function scoped(deps: Deps, home: RuntimeHome, inside: string | undefined, follow: boolean): ReadHandle {
  const folder = inside === undefined ? home.home : `${home.home}/${inside}`;
  return isFleetHome(deps, home)
    ? deps.roots.root('fleet', { subfolder: folder.slice(deps.directory.length + 1) })
    : followingHandle(deps.roots, home.home, folder, follow);
}

/**
 * The asset folder (below the fleet folder) a link in `<home>/skills` resolves to, or `undefined` when it does not resolve
 * to a folder inside the fleet's `assets/`. Resolved once per call; a home outside the fleet has none (a link there is
 * followed by `following-handle.ts` only inside the home, and is never a Ferretry-managed skill).
 */
type ManagedResolver = (name: string) => Promise<string | undefined>;

function managedResolver(deps: Deps, home: RuntimeHome): ManagedResolver {
  if (!isFleetHome(deps, home)) return async () => undefined;
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
        const root = scoped(this.#deps, home, undefined, true);
        const entry = (await listing(root, '.')).find(candidate => candidate.name === file);
        if (entry === undefined) return null;
        if (entry.kind === 'symlink') {
          if (isFleetHome(this.#deps, home)) throw unreadable(`${file} is a link, which is never read.`);
          // The home-scoped handle did not follow it (outside the home, nowhere, a loop, a sign-in file): see `document-link.ts`.
          const linked = await readLinkedDocument(this.#deps.roots, home.home, file, limitBytes);
          if (linked.kind === 'text') return linked.text;
          if (linked.kind === 'absent') return null;
          if (linked.kind === 'too_big')
            throw unreadable(`${file} is larger than the ${linked.bound} bytes that may be read.`);
          throw unreadable(
            `${file} is a link whose target is not read (it is not a plain settings file this reader may open).`,
          );
        }
        if (entry.kind !== 'file') throw unreadable(`${file} is not a regular file.`);
        if (entry.links > 1) throw unreadable(`${file} has another name on this machine, so it is not read.`);
        if (entry.size > limitBytes)
          throw unreadable(`${file} is larger than the ${limitBytes} bytes that may be read.`);
        // One byte more than the bound: a file that grew after the listing comes back longer and is refused, not cut short.
        const bytes = await root.readBytes(fenced(root, file), limitBytes + 1);
        if (bytes.length > limitBytes)
          throw unreadable(`${file} is larger than the ${limitBytes} bytes that may be read.`);
        return new TextDecoder().decode(bytes);
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
        const root = scoped(this.#deps, home, undefined, true);
        if ((await listing(root, '.')).find(entry => entry.name === 'skills')?.kind !== 'directory') return [];
        const managedOf = managedResolver(this.#deps, home);
        const found: RuntimeHomeSkillEntry[] = [];
        for (const entry of await listing(root, 'skills')) {
          if (found.length > limit) break;
          if (entry.name.startsWith('.')) continue;
          const managed = entry.kind === 'symlink';
          // A link that was not followed (it leads outside the home, nowhere, or loops) is passed over with no line and no
          // error, as the inventory of today passed it over.
          if (entry.kind !== 'directory' && !(managed && (await managedOf(entry.name)) !== undefined)) continue;
          if (!isFleetHome(this.#deps, home) && !(await this.#manifestInside(home, entry.name))) continue;
          found.push({ name: entry.name, manifest: `${home.home}/skills/${entry.name}/${SKILL_MANIFEST}`, managed });
        }
        return found;
      });
    } catch (error) {
      if (error instanceof RuntimeHomeUnreadable) throw error;
      throw unreadable(`The skills of that runtime home could not be listed (${refusal(error)}).`);
    }
  }

  /**
   * Whether the skill folder `name` of a home outside the fleet has a `SKILL.md` that resolves to a file INSIDE the home (the
   * inventory of today passed a folder over whose `SKILL.md` did not).
   */
  async #manifestInside(home: RuntimeHome, name: string): Promise<boolean> {
    return await isPlainFileInside(this.#deps.roots, home.home, `${home.home}/skills/${name}/${SKILL_MANIFEST}`);
  }

  /**
   * A handle scoped to the folder of a skill `skills()` lists right now, or `undefined`. `follow`: a link in the folder
   * is followed when it resolves inside the home (for the one `SKILL.md` read the inventory of today made through a link),
   * and reported as a link otherwise (every walk and file read of a skill folder).
   */
  async #folder(home: RuntimeHome, name: string, follow: boolean): Promise<ReadHandle | undefined> {
    if (!SKILL_NAME.test(name)) return undefined;
    const root = scoped(this.#deps, home, undefined, true);
    if ((await listing(root, '.')).find(entry => entry.name === 'skills')?.kind !== 'directory') return undefined;
    const entry = (await listing(root, 'skills')).find(candidate => candidate.name === name);
    if (entry?.kind === 'directory') return scoped(this.#deps, home, `skills/${name}`, follow);
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
    // The one read of a skill folder that follows a link (inside the home): the inventory of today read `SKILL.md` through one.
    const read = await this.#read(name, SKILL_MANIFEST, maxBytes, true);
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
        const folder = await this.#folder(home, name, false);
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
    return await this.#read(name, relativePath, maxBytes, false);
  }

  async #read(name: string, relativePath: string, maxBytes: number, follow: boolean): Promise<RuntimeHomeFileRead> {
    const segments = relativePath.split('/');
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[\\\0]/u.test(segment))
    )
      return { ok: false, reason: 'unreadable' };
    try {
      return await this.#gate(async (home): Promise<RuntimeHomeFileRead> => {
        const folder = await this.#folder(home, name, follow);
        const found = folder === undefined ? undefined : await this.#lookup(folder, segments);
        if (folder === undefined || found === undefined || found.entry.kind !== 'file' || found.entry.links > 1)
          return { ok: false, reason: 'unreadable' };
        if (found.entry.size > maxBytes) return { ok: false, reason: 'too_big' };
        // One byte more than the bound, so a file that grew after the listing is told from one that fits.
        const bytes = await folder.readBytes(fenced(folder, found.path), maxBytes + 1);
        return bytes.length > maxBytes ? { ok: false, reason: 'too_big' } : { ok: true, bytes };
      });
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }
}

/**
 * A skill folder's name, as Skills' own rule has it (`usableSkillName`): one plain component a harness can load as a
 * skill, no leading dot, no `..`. Copied here because Runtimes imports nothing of Skills; both ends test the same names.
 */
const ASSET_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const assetSkillName = (name: string): boolean => ASSET_SKILL_NAME.test(name) && !name.includes('..');

/** The most a listing of the asset tree asks for: past it nothing is listed (a bound the caller cannot widen). */
const ASSET_SKILLS_LIMIT = 1000;
/** The most one `SKILL.md` read asks for (what Skills asks, 256 KiB): past it nothing is read (a bound the caller cannot widen). */
const ASSET_SKILL_MAX_BYTES = 256 * 1024;

/** Said once per refused call, to the daemon's log: the answer itself has no field for a sentence. Never names a path or a file's text. */
const LIMIT_REFUSED = `The fleet's installed skills were asked for with a limit that is not a whole number from 0 to ${ASSET_SKILLS_LIMIT}, so none were listed.`;
const MAX_BYTES_REFUSED = `An installed skill was asked for with a byte bound that is not a whole number from 1 to ${ASSET_SKILL_MAX_BYTES}, so it was not read.`;

/** Where a refused bound is said; the default says nothing (a caller that has no log). */
type SaySentence = (sentence: string) => void;

/**
 * The fleet's own installed skills (`<fleet>/assets/skills/<name>`), listed and read only as plain folders: `assets/skills`
 * itself, each skill folder and its `SKILL.md` are judged by `lstat` on handles scoped to them, so a link at any of
 * those names, a hard-linked `SKILL.md` or any other kind is skipped and nothing is followed. Each call runs inside ONE
 * `publication.reading(...)`. A fault or an unreadable name gives an empty answer. `limit` (0 to 1000) and `maxBytes`
 * (1 to 256 KiB) are hard bounds: a call outside them is refused (an empty answer, never a throw) and `say` is told a
 * sentence, because the answer's types have no field for one. Nothing it says names a file's content or a path.
 */
function fleetAssetSkills(deps: Deps, say: SaySentence): RuntimeAssetSkills {
  const skills = (): RootHandle => deps.roots.root('fleet', { subfolder: 'assets/skills' });
  const plain = async (root: RootHandle, relative: string): Promise<boolean> =>
    (await root.lstat(fenced(root, relative)))?.kind === 'directory';
  /** The regular, singly-named `SKILL.md` of skill `name`, or `undefined`. */
  const manifestOf = async (name: string): Promise<{ root: RootHandle; size: number } | undefined> => {
    const folder = deps.roots.root('fleet', { subfolder: `assets/skills/${name}` });
    const found = (await listing(folder, '.')).find(entry => entry.name === SKILL_MANIFEST);
    return found?.kind === 'file' && found.links === 1 ? { root: folder, size: found.size } : undefined;
  };
  const listed = async (name: string): Promise<boolean> => {
    if (!assetSkillName(name)) return false;
    const fleet = deps.roots.root('fleet');
    if (!(await plain(fleet, 'assets')) || !(await plain(fleet, 'assets/skills'))) return false;
    const entry = (await listing(skills(), '.')).find(candidate => candidate.name === name);
    return entry?.kind === 'directory' && (await manifestOf(name)) !== undefined;
  };
  return {
    skills: async limit => {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > ASSET_SKILLS_LIMIT) {
        say(LIMIT_REFUSED);
        return [];
      }
      try {
        return await deps.publication.reading(async () => {
          const fleet = deps.roots.root('fleet');
          if (!(await plain(fleet, 'assets')) || !(await plain(fleet, 'assets/skills'))) return [];
          const found: RuntimeHomeSkillEntry[] = [];
          for (const entry of await listing(skills(), '.')) {
            if (found.length > limit) break;
            if (entry.kind !== 'directory' || !assetSkillName(entry.name)) continue;
            if ((await manifestOf(entry.name)) === undefined) continue;
            found.push({
              name: entry.name,
              manifest: `${deps.directory}/assets/skills/${entry.name}/${SKILL_MANIFEST}`,
              managed: true,
            });
          }
          return found;
        });
      } catch {
        return [];
      }
    },
    skillManifest: async (name, maxBytes) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ASSET_SKILL_MAX_BYTES) {
        say(MAX_BYTES_REFUSED);
        return undefined;
      }
      try {
        return await deps.publication.reading(async () => {
          if (!(await listed(name))) return undefined;
          const manifest = await manifestOf(name);
          if (manifest === undefined || manifest.size > maxBytes) return undefined;
          return await manifest.root.readText(fenced(manifest.root, SKILL_MANIFEST), maxBytes);
        });
      } catch {
        return undefined;
      }
    },
  };
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
  say: SaySentence = () => {},
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
    } catch (error) {
      // Damage is retryable (the daemon rebuilds the manifest), and the sentence says so.
      throw unreadable(
        error instanceof FleetManifestUnreadableError
          ? error.message
          : `The fleet manifest at ${path} could not be read.`,
      );
    }
    known = new Set(homes.map(home => home.id));
    return homes;
  };
  const deps: Deps = { roots, directory, publication, published };
  return {
    homes: async () => await publication.reading(published),
    home: id => (known.has(id) ? new FleetHomeReader(id, deps) : undefined),
    assetSkills: () => fleetAssetSkills(deps, say),
  };
}
