import type { FerretId } from '@ferretry/kernel/contract';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { BoardProjectId } from '../../../contract/index.ts';
import type { FerretProjectFactSource, FerretProjectFacts } from '../../lib/lanes/ferret-projects.ts';
import type { FerretProjectStamp } from '../../lib/lanes/project-adoption.ts';
import type { FerretParents } from '../../lib/lanes/lineage.ts';
import { UNFILED_PROJECT_ID } from '../../../contract/index.ts';

/**
 * The board each ferret was moved onto after it started (a ferret that registered its repository on its first card).
 * Kept in memory for this run: a ferret is otherwise resolved from its folder and parent chain on every ask, which
 * gives the same board once its repository is a project, so a restart loses a shortcut and never a board.
 */
export class FerretProjectStamps implements FerretProjectStamp {
  readonly #stamped = new Map<string, BoardProjectId>();

  of(ferretId: string): BoardProjectId | undefined {
    return this.#stamped.get(ferretId);
  }

  async stamp(ferretId: string, projectId: BoardProjectId): Promise<void> {
    const stamped = this.#stamped.get(ferretId);
    if (stamped !== undefined && stamped !== UNFILED_PROJECT_ID) return;
    this.#stamped.set(ferretId, projectId);
  }
}

/** Reads a ferret's board facts from Ferrets: its folder, its parent, and the board it was moved onto. */
export class FerretsProjectFacts implements FerretProjectFactSource, FerretParents {
  constructor(
    private readonly ferrets: Pick<FerretsApi, 'get'>,
    private readonly stamps: Pick<FerretProjectStamps, 'of'>,
  ) {}

  async read(ferretId: string): Promise<FerretProjectFacts | null> {
    const ferret = await this.ferrets.get(ferretId as FerretId).catch(() => undefined);
    if (ferret === undefined) return null;
    const projectId = this.stamps.of(ferretId);
    return {
      folder: ferret.folder,
      ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
      ...(projectId === undefined ? {} : { projectId }),
    };
  }

  async parentOf(ferretId: string): Promise<string | undefined> {
    return (await this.ferrets.get(ferretId as FerretId).catch(() => undefined))?.parent;
  }
}
