import { join } from 'node:path';
import { GuideUndoSchema, PackGuideJobResultSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { ReplacedGuide } from '../../lib/pack/builder/file.ts';
import type { GuideRun, GuideRunStore } from '../../lib/pack/builder/service.ts';
import type { FileSystemPort } from '../../lib/ports.ts';

/** A run's id: what `newId` makes, so a path built from one never leaves the runs folder. */
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/u;

const RUN_FILE = 'run.json';

/**
 * The guide builder's runs in the state home: one folder per run (`<root>/<id>/`) holding the inventory the
 * builder was shown, the draft it wrote and `run.json` — the job and, once read, its checked suggestion.
 * Owner-only, like the rest of the state home. A run document that does not read is skipped, never fatal.
 */
export class FileGuideRunStore implements GuideRunStore {
  constructor(
    private readonly files: Pick<FileSystemPort, 'ensureDirectory' | 'listDirectory' | 'readText' | 'writeTextAtomic'>,
    private readonly root: string,
    /** Removes a run's folder and everything in it. */
    private readonly removeTree: (path: string) => Promise<void>,
  ) {}

  private folder(id: string): string {
    if (!RUN_ID.test(id)) throw new Error(`not a guide builder run id: ${id}`);
    return join(this.root, id);
  }

  pathOf(id: string, name: string): string {
    return join(this.folder(id), name);
  }

  async writeFile(id: string, name: string, text: string): Promise<string> {
    await this.files.ensureDirectory(this.folder(id), 0o700);
    const path = this.pathOf(id, name);
    await this.files.writeTextAtomic(path, text);
    return path;
  }

  async readFile(id: string, name: string): Promise<string | undefined> {
    return RUN_ID.test(id) ? await this.files.readText(this.pathOf(id, name)) : undefined;
  }

  async save(run: GuideRun): Promise<void> {
    await this.writeFile(run.job.id, RUN_FILE, `${JSON.stringify(run, null, 2)}\n`);
  }

  async load(id: string): Promise<GuideRun | undefined> {
    const text = await this.readFile(id, RUN_FILE);
    if (text === undefined) return undefined;
    try {
      const parsed = PackGuideJobResultSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<readonly GuideRun[]> {
    const entries = await this.files.listDirectory(this.root);
    const runs = await Promise.all(
      entries
        .filter(entry => entry.directory && RUN_ID.test(entry.name))
        .map(async entry => await this.load(entry.name)),
    );
    return runs
      .filter((run): run is GuideRun => run !== undefined)
      .toSorted((left, right) => right.job.startedAt.localeCompare(left.job.startedAt));
  }

  async remove(id: string): Promise<void> {
    await this.removeTree(this.folder(id));
  }
}

const ReplacedGuideSchema = GuideUndoSchema.extend({ text: z.string().nullable() });

/**
 * The file the last accepted suggestion replaced, kept in the state home so `undo` can put it back. One
 * document; a document that does not read is "nothing to undo", never a guess at what was there.
 */
export class FileReplacedGuide {
  constructor(
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'removeFile'>,
    private readonly path: string,
  ) {}

  async read(): Promise<ReplacedGuide | undefined> {
    const text = await this.files.readText(this.path);
    if (text === undefined) return undefined;
    try {
      const parsed = ReplacedGuideSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async write(value: ReplacedGuide | undefined): Promise<void> {
    if (value === undefined) await this.files.removeFile(this.path);
    else await this.files.writeTextAtomic(this.path, `${JSON.stringify(value)}\n`);
  }
}
