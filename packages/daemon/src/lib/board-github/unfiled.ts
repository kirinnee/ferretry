/**
 * UNFILED CARDS GO WHERE THEY BELONG (`docs/board.md` § Which board a card is on). The Unfiled board is only
 * for work outside any git repository, so an open card there that belongs on a project's board is refiled to
 * it, through `BoardService` as the daemon, and the refile's own fact check then puts it in the lane its PRs
 * say. Two things say where a card belongs, the first that answers wins:
 *
 *   1. **a linked PR's repository** is a registered project's ({@link refileTargets});
 *   2. **the folder its owner ferret works in** belongs to a project: the session's own board, the project its
 *      folder resolves to, else the repository it stands in registered as a project by the same rules a
 *      ferret's first card follows (`ProjectAdoption`: never the home folder, a temp or scratch folder, a
 *      folder that is not a git repository, or one outside every project root).
 *
 * It runs on every watcher tick and once at boot, and is idempotent: a refiled card is no longer Unfiled, a
 * card someone put on the Unfiled board on purpose stays there, and two runs never overlap — a run asked for
 * while one is going gets that one's answer. A ferret whose folder said nothing is asked again only after
 * {@link SESSION_BOARD_RETRY_MS}, so a board of old cards costs no git call per card per tick. It never
 * throws: a card it cannot refile is reported once, and the rest go on.
 */
import { type BoardProjectId, type BoardTask, formatTaskRef, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import type { BoardDiagnostics } from '../board/index.ts';
import { isRefilable, PROJECT_REMOTES_TTL_MS, type RefileTarget, refileTargets, repoKey } from './plan.ts';
import type { ProjectFolders, WatchedBoard, WatcherClock, WorkingCopies } from './ports.ts';

/** How long a ferret whose folder named no board is left before its folder is asked again. */
export const SESSION_BOARD_RETRY_MS = PROJECT_REMOTES_TTL_MS;

/** A registered project and the GitHub repository its folder's `origin` names. */
export interface ProjectRemote {
  readonly id: BoardProjectId;
  readonly name: string;
  readonly repo: string | null;
}

/** The board a session's folder belongs to, registering its repository when it may; `null` for none. */
export interface SessionBoards {
  boardOf(sessionId: string): Promise<BoardProjectId | null>;
}

export interface UnfiledRefilerPorts {
  readonly board: Pick<WatchedBoard, 'snapshot' | 'act'>;
  readonly sessions: SessionBoards;
  /** Read when a run is not handed the remotes (the boot run); the watcher hands its own. */
  readonly projects: ProjectFolders;
  readonly copies: Pick<WorkingCopies, 'repositoryOf'>;
  readonly clock: Pick<WatcherClock, 'now'>;
  readonly diagnostics: BoardDiagnostics;
}

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every registered project with the repository its folder names. */
export const readProjectRemotes = async (
  projects: ProjectFolders,
  copies: Pick<WorkingCopies, 'repositoryOf'>,
): Promise<readonly ProjectRemote[]> =>
  await Promise.all(
    (await projects.projects()).map(async project => ({
      id: project.id,
      name: project.name,
      repo: await copies.repositoryOf(project.path),
    })),
  );

export class UnfiledRefiler {
  /** When each ferret's folder last named no board, by session id. Forgotten on restart. */
  private readonly unplaced = new Map<string, number>();
  /** The keys warned about, so each problem is reported once until it clears. */
  private readonly warned = new Set<string>();
  private running: Promise<readonly string[]> | undefined;

  constructor(private readonly ports: UnfiledRefilerPorts) {}

  /**
   * Refiles every Unfiled card that belongs on a project's board; the cards refiled. `remotes` are the
   * projects' repositories when the caller already read them. A run asked for while one is going joins it.
   */
  async run(remotes?: readonly ProjectRemote[]): Promise<readonly string[]> {
    if (this.running !== undefined) return await this.running;
    this.running = this.refileAll(remotes).finally(() => {
      this.running = undefined;
    });
    return await this.running;
  }

  private async refileAll(given: readonly ProjectRemote[] | undefined): Promise<readonly string[]> {
    try {
      const { cards, laneSets } = await this.ports.board.snapshot();
      const open = cards.filter(card => isRefilable(card, laneSets));
      if (open.length === 0) return [];
      const remotes = given ?? (await this.remotes());
      const byPr = refileTargets(open, laneSets, owners(remotes));
      const claimed = new Set(byPr.map(target => target.card.id));
      const byFolder = await this.folderTargets(
        open.filter(card => !claimed.has(card.id)),
        remotes,
      );
      const refiled: string[] = [];
      for (const target of [...byPr, ...byFolder]) {
        if (await this.refile(target)) refiled.push(target.card.id);
      }
      this.warned.delete('run');
      return refiled;
    } catch (error) {
      this.warnOnce('run', `Unfiled board: could not look for cards to refile: ${detail(error)}`);
      return [];
    }
  }

  private async remotes(): Promise<readonly ProjectRemote[]> {
    return await readProjectRemotes(this.ports.projects, this.ports.copies).catch((error: unknown) => {
      this.warnOnce('projects', `Unfiled board: could not list the projects: ${detail(error)}`);
      return [];
    });
  }

  /** The cards whose owner ferret's folder names a board, each owner asked once per run. */
  private async folderTargets(
    cards: readonly BoardTask[],
    remotes: readonly ProjectRemote[],
  ): Promise<readonly RefileTarget[]> {
    const boards = new Map<string, BoardProjectId | null>();
    const targets: RefileTarget[] = [];
    for (const card of cards) {
      if (!boards.has(card.owner)) boards.set(card.owner, await this.boardOf(card.owner));
      const projectId = boards.get(card.owner) ?? null;
      if (projectId === null || projectId === UNFILED_PROJECT_ID) continue;
      const name = remotes.find(project => project.id === projectId)?.name ?? 'that project';
      targets.push({
        card,
        projectId,
        reason: `${formatTaskRef(card)}'s ferret ${card.owner} works in ${name}, so the card belongs on its board`,
      });
    }
    return targets;
  }

  /** The board a ferret's folder names, or `null` — remembered for a while when it named none. */
  private async boardOf(sessionId: string): Promise<BoardProjectId | null> {
    const nowMs = Date.parse(this.ports.clock.now());
    const since = this.unplaced.get(sessionId);
    if (since !== undefined && nowMs - since < SESSION_BOARD_RETRY_MS) return null;
    const projectId = await this.ports.sessions.boardOf(sessionId).catch((error: unknown) => {
      this.warnOnce(`session:${sessionId}`, `Unfiled board: could not tell where ${sessionId} works: ${detail(error)}`);
      return null;
    });
    if (projectId === null || projectId === UNFILED_PROJECT_ID) this.unplaced.set(sessionId, nowMs);
    else this.unplaced.delete(sessionId);
    return projectId;
  }

  /** Refiles one card as the daemon; `true` when it moved. */
  private async refile(target: RefileTarget): Promise<boolean> {
    try {
      await this.ports.board.act(
        target.card.id,
        { action: 'refile', projectId: target.projectId, reason: target.reason },
        { kind: 'daemon' },
      );
      this.warned.delete(`refile:${target.card.id}`);
      return true;
    } catch (error) {
      this.warnOnce(
        `refile:${target.card.id}`,
        `Unfiled board: could not refile ${formatTaskRef(target.card)}: ${detail(error)}`,
      );
      return false;
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ports.diagnostics.warn(message);
  }
}

/** Each case-folded repository to the project registered for it first. */
const owners = (
  remotes: readonly ProjectRemote[],
): ReadonlyMap<string, { readonly id: BoardProjectId; readonly name: string }> => {
  const found = new Map<string, { id: BoardProjectId; name: string }>();
  for (const project of remotes) {
    if (project.repo !== null && !found.has(repoKey(project.repo))) {
      found.set(repoKey(project.repo), { id: project.id, name: project.name });
    }
  }
  return found;
};
