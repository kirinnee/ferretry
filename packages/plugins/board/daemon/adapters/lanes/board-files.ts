import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { z } from 'zod';
import type { BoardFileSchema, BoardProjectId, BoardSwitch } from '../../../contract/index.ts';
import { BoardSwitchUnavailableError, LaneSetUnavailableError } from '../../lib/lanes/errors.ts';
import { type LaneSet, LaneSetSchema } from '../../lib/lanes/model.ts';
import type { BoardSwitchStore, LaneSetMutation, LaneSetStore } from '../../lib/lanes/ports.ts';
import { KeyedSerial, type SerialRun } from '../../lib/lanes/serial.ts';

export type BoardFile = z.infer<typeof BoardFileSchema>;

/** The declared `boards` state file (`state/board/boards/<project>.json`). */
export type BoardFilesDef = StateFileDef<string, BoardFile>;

/** The stored document could not be used; the views say which of their own errors that is. */
class BoardFileDamaged extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'BoardFileDamaged';
  }
}

const unswitched = (project: BoardProjectId): BoardSwitch => ({
  projectId: project,
  on: false,
  setBy: 'default',
  setAt: null,
});

/**
 * ONE FILE PER PROJECT: `boards/<project>.json` holds its lane set and whether it uses the board, so a lane set and
 * its switch are written together and read together. A project id is a UUID or `unfiled`, never a path, so it cannot
 * escape the folder. A document the kernel's store calls damaged (unparsable, another format, not its schema) is
 * refused and never overwritten: the evidence stays for an operator, and nobody is told the project has no lanes.
 */
export class BoardFiles {
  constructor(
    private readonly state: StatePort,
    private readonly file: BoardFilesDef,
    private readonly serial: SerialRun = new KeyedSerial(),
  ) {}

  async read(project: BoardProjectId): Promise<BoardFile | null> {
    const read = await this.state.read(this.file, project);
    if (!read.ok)
      throw new BoardFileDamaged(`refusing to use a damaged board at ${read.error.file}: ${read.error.reason}`);
    if (read.value === undefined) return null;
    if (read.value.project !== project) {
      throw new BoardFileDamaged(`refusing to use a board file that names another project (${project})`);
    }
    return read.value;
  }

  /** Reads, decides and writes one project's document under that project's lock. */
  async transact<T>(
    project: BoardProjectId,
    decide: (current: BoardFile | null) => { readonly next?: BoardFile; readonly result: T },
  ): Promise<T> {
    return await this.serial.run(project, async () => {
      const mutation = decide(await this.read(project));
      if (mutation.next !== undefined) await this.state.write(this.file, mutation.next, project);
      return mutation.result;
    });
  }
}

/** The lane sets of {@link BoardFiles}. */
export class LaneSetFiles implements LaneSetStore {
  constructor(private readonly files: BoardFiles) {}

  async read(projectId: BoardProjectId): Promise<LaneSet | null> {
    return await this.guarded(projectId, async () => this.laneSetOf(projectId, await this.files.read(projectId)));
  }

  async transact<T>(projectId: BoardProjectId, decide: (current: LaneSet | null) => LaneSetMutation<T>): Promise<T> {
    return await this.guarded(projectId, async () =>
      this.files.transact(projectId, current => {
        const mutation = decide(this.laneSetOf(projectId, current));
        if (mutation.next === undefined) return { result: mutation.result };
        const next: BoardFile = {
          format: 1,
          project: projectId,
          switch: current?.switch ?? unswitched(projectId),
          // Ours is the stricter schema of the same document; the stored file is read back through it.
          laneSet: mutation.next as BoardFile['laneSet'],
        };
        return { next, result: mutation.result };
      }),
    );
  }

  private laneSetOf(projectId: BoardProjectId, file: BoardFile | null): LaneSet | null {
    if (file?.laneSet === null || file === null) return null;
    const parsed = LaneSetSchema.safeParse(file.laneSet);
    if (!parsed.success) {
      throw new BoardFileDamaged(`refusing to use a damaged lane set for ${projectId}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  private async guarded<T>(_projectId: BoardProjectId, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BoardFileDamaged) throw new LaneSetUnavailableError(error.detail);
      throw error;
    }
  }
}

/** The switches of {@link BoardFiles}. */
export class BoardSwitchFiles implements BoardSwitchStore {
  constructor(private readonly files: BoardFiles) {}

  async read(projectId: BoardProjectId): Promise<BoardSwitch | null> {
    return await this.guarded(async () => {
      const file = await this.files.read(projectId);
      return file === null || file.switch.setBy === 'default' ? null : file.switch;
    });
  }

  async set(projectId: BoardProjectId, on: boolean, at: string): Promise<BoardSwitch> {
    return await this.guarded(async () =>
      this.files.transact(projectId, current => {
        const next: BoardFile = {
          format: 1,
          project: projectId,
          switch: { projectId, on, setBy: 'owner', setAt: at as BoardSwitch['setAt'] },
          laneSet: current?.laneSet ?? null,
        };
        return { next, result: next.switch };
      }),
    );
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BoardFileDamaged) throw new BoardSwitchUnavailableError(error.detail);
      throw error;
    }
  }
}
