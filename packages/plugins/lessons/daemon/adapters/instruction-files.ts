import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FencedPath, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { GLOBAL_LESSONS_FILE, type GlobalLessonsPort, type LessonFilesPort, LessonsError } from '../lib/index.ts';
import type { LessonsStorePort } from '../lib/store.ts';

const trim = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);
const inside = (folder: string, path: string): boolean => path === trim(folder) || path.startsWith(`${trim(folder)}/`);
const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
};

/**
 * The instruction files an Apply writes. A Repo lesson goes into the project's own AGENTS.md / CLAUDE.md at its git
 * root, reached through the `work` root of a ferret whose folder holds that path (never by a bare path); the Global
 * lessons document is this plugin's own state. Written atomically by the root, so a crash never leaves an owner's file
 * half written.
 *
 * The project root is today's walk (`NodeLessonFiles.projectRoot`): up from the filing ferret's folder to the nearest
 * `.git`. Each step looks through ANY ferret whose folder holds it, so a ferret started in `repo/packages/daemon` still
 * finds `repo/` whenever some ferret's folder reaches it (a lead at the repository top, say).
 *
 * DECLARED GAP: the plugin may see only through a ferret's `work` root, so a git root above every ferret's folder is
 * out of sight; the walk then stops where sight ends and answers the filing folder, as today does for a folder with
 * no `.git` above it. Reaching higher needs a kernel root or a Projects read (a contract change; flagged to the lead).
 * A path no ferret's folder holds any more is a refusal with a sentence (`LessonsError`), never a crash.
 */
export class WorkRootLessonFiles implements LessonFilesPort {
  constructor(
    private readonly ferrets: Pick<FerretsApi, 'list'>,
    private readonly roots: Pick<RootsPort, 'root'>,
    private readonly store: Pick<LessonsStorePort, 'readGlobal' | 'writeGlobal'>,
  ) {}

  /** Every ferret whose folder holds `path`, the deepest first, each with its `work` root. */
  private async holdersOf(path: string): Promise<readonly RootHandle[]> {
    return (await this.ferrets.list())
      .filter(ferret => inside(ferret.folder, path))
      .toSorted((left, right) => right.folder.length - left.folder.length)
      .map(ferret => this.roots.root('work', { ferret: ferret.id as FerretId }));
  }

  /** The first holder's root that can name `path`, and the fenced path; `undefined` when no ferret's folder holds it. */
  private async reach(path: string): Promise<{ readonly root: RootHandle; readonly path: FencedPath } | undefined> {
    for (const root of await this.holdersOf(path)) {
      const fenced = root.resolve(path);
      if (fenced.ok) return { root, path: fenced.value };
    }
    return undefined;
  }

  private async exists(path: string): Promise<boolean> {
    const reached = await this.reach(path);
    return reached !== undefined && (await guarded(path, () => reached.root.stat(reached.path))) !== undefined;
  }

  /** The git root at or above `cwd`, as far as any ferret's folder reaches; else `cwd` itself. */
  async projectRoot(cwd: string): Promise<string> {
    let directory = trim(cwd);
    for (;;) {
      if ((await this.reach(directory)) === undefined) return cwd;
      if (await this.exists(`${directory === '/' ? '' : directory}/.git`)) return directory;
      const parent = parentOf(directory);
      if (parent === directory) return cwd;
      directory = parent;
    }
  }

  async read(path: string): Promise<string | undefined> {
    if (path === GLOBAL_LESSONS_FILE) return await this.store.readGlobal();
    const reached = await this.reach(path);
    if (reached === undefined) throw unreachable(path);
    if ((await guarded(path, () => reached.root.stat(reached.path))) === undefined) return undefined;
    return await guarded(path, () => reached.root.readText(reached.path));
  }

  async write(path: string, text: string): Promise<void> {
    if (path === GLOBAL_LESSONS_FILE) return await this.store.writeGlobal(text);
    const reached = await this.reach(path);
    if (reached === undefined) throw unreachable(path);
    await guarded(path, () => reached.root.writeText(reached.path, text));
  }

  join(directory: string, name: string): string {
    return `${trim(directory)}/${name}`;
  }
}

/** No ferret's folder holds `path` any more, so no root reaches it: a refusal, not a crash. */
function unreachable(path: string): LessonsError {
  return new LessonsError(
    'not-found',
    `${path} is outside every ferret's folder, so Ferretry cannot reach it; start a ferret in that project and apply again`,
  );
}

/**
 * A root that refuses `path` (a link that leads outside the ferret's folder, for one) is a refusal with a sentence,
 * never "the file does not exist" and never a bare error the dispatcher turns into a 500. Any error from the root
 * handle counts; the host's own error type is not imported.
 */
async function guarded<T>(path: string, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch {
    throw new LessonsError(
      'invalid',
      `${path} is a link that leads outside the ferret's folder, so Ferretry will not write through it`,
    );
  }
}

/** What the owner should know about the Global document, in the preview and in `GET /v1/lessons/global`. */
const GLOBAL_LESSONS_READ_NOTE = 'Every ferret reads this document at its next launch.';
const GLOBAL_LESSONS_EDIT_NOTE =
  'Change or remove a rule in it from Settings › Lessons or with `fy lesson global`; it is not a file on disk.';

/** The Global lessons document: `state/lessons/global.json`, shown to the owner by name and edited through `/v1/lessons/global`. */
export class StateGlobalLessons implements GlobalLessonsPort {
  async locate(): Promise<{ readonly path: string; readonly notes: readonly string[] }> {
    return {
      path: GLOBAL_LESSONS_FILE,
      notes: [GLOBAL_LESSONS_READ_NOTE, GLOBAL_LESSONS_EDIT_NOTE],
    };
  }

  /** There is no component file to create: the document is read by every launch. */
  async ensureComponent(): Promise<void> {}
}
