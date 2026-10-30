import type { BoardActor, BoardProjectId, BoardTask, BoardTaskId, LaneSet } from '@ferretry/protocol';
import type { BoardStore } from '../board/ports.ts';
import type { TaskEntry } from '../tasks/task-snapshot.ts';
import {
  buildCard,
  isUntriagedCard,
  legacyRefOf,
  planSession,
  type SessionPlan,
  untriagedCard,
} from './legacy-card.ts';
import type {
  AskLink,
  BoardImportClock,
  BoardImportMarker,
  BoardImportSummary,
  ImportAgenda,
  ImportProblem,
  ImportProjects,
  ImportSessions,
  LegacySessionTasks,
  LegacyTaskSource,
} from './ports.ts';

export interface BoardImporterPorts {
  readonly tasks: LegacyTaskSource;
  readonly store: BoardStore;
  readonly projects: ImportProjects;
  readonly sessions: ImportSessions;
  readonly agenda: ImportAgenda;
  readonly marker: BoardImportMarker;
  readonly clock: BoardImportClock;
  readonly machineId: () => string | undefined;
}

export interface BoardImportOptions {
  /** Report what would happen and change nothing: no card, no proposal, no link, no marker. */
  readonly dryRun?: boolean;
  /** Run although the marker says it already did. The import is idempotent, so this only fills what is missing. */
  readonly force?: boolean;
}

/** Where a run's counts accumulate. One per run, so the importer itself holds nothing between runs. */
interface Tally {
  imported: number;
  alreadyImported: number;
  linkedAsks: number;
  untriagedCards: number;
  sessions: number;
  readonly proposed: BoardProjectId[];
  readonly problems: ImportProblem[];
  /** A failure that a later run could mend (a store or agenda that would not answer): the marker is withheld. */
  transient: boolean;
}

interface Existing {
  readonly byLegacyRef: Map<string, BoardTaskId>;
  readonly untriaged: Map<string, BoardTaskId>;
  readonly cards: readonly BoardTask[];
}

const problemOf = (sessionId: string | null, taskId: string | null, detail: string): ImportProblem => ({
  sessionId,
  taskId,
  detail,
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * THE ONE-TIME IMPORT of the per-session task files (and the agenda items that name no card) into the project
 * boards (`board-design.md` §5).
 *
 * IDEMPOTENT: a task that already has a card (found by its `legacyRef`) is left exactly as it is, a project that
 * already has lanes is not proposed again, and an agenda item that already names a card is not touched. So a run
 * that stopped halfway, or a forced run, only fills in what is missing.
 *
 * TOTAL AND READ-ONLY ON THE OLD FILES: it never rejects, and a bad file or a task that will not become a card
 * is skipped and reported in the summary. The marker is written only when nothing transient went wrong, so a
 * damaged store is retried at the next start; a task that can never import does not hold the marker back.
 */
export class BoardImporter {
  constructor(private readonly ports: BoardImporterPorts) {}

  private machine(): string {
    const id = this.ports.machineId();
    if (id === undefined) throw new Error('the daemon identity is not open yet');
    return id;
  }

  async run(options: BoardImportOptions = {}): Promise<BoardImportSummary> {
    const dryRun = options.dryRun === true;
    const tally: Tally = {
      imported: 0,
      alreadyImported: 0,
      linkedAsks: 0,
      untriagedCards: 0,
      sessions: 0,
      proposed: [],
      problems: [],
      transient: false,
    };
    try {
      if (options.force !== true && !dryRun && (await this.ports.marker.ran())) {
        return summarize(tally, dryRun, true, false);
      }
      await this.importAll(tally, dryRun);
    } catch (error) {
      tally.transient = true;
      tally.problems.push(problemOf(null, null, `the import stopped: ${messageOf(error)}`));
    }
    const complete = !dryRun && !tally.transient;
    if (complete) {
      try {
        await this.ports.marker.record(this.ports.clock.now(), summarize(tally, dryRun, false, true));
      } catch (error) {
        tally.problems.push(problemOf(null, null, `the import's marker was not written: ${messageOf(error)}`));
        return summarize(tally, dryRun, false, false);
      }
    }
    return summarize(tally, dryRun, false, complete);
  }

  private async importAll(tally: Tally, dryRun: boolean): Promise<void> {
    const files = new Map((await this.ports.tasks.read()).map(file => [file.sessionId, file]));
    tally.sessions = files.size;
    const snapshot = await this.ports.store.read();
    const existing: Existing = {
      byLegacyRef: new Map(
        snapshot.cards.flatMap(card => (card.legacyRef === undefined ? [] : [[card.legacyRef, card.id]])),
      ),
      untriaged: new Map(
        snapshot.cards.flatMap(card => (isUntriagedCard(card, card.owner) ? [[card.owner, card.id] as const] : [])),
      ),
      cards: snapshot.cards,
    };
    const sessionIds = [...new Set([...files.keys(), ...(await this.ports.sessions.list())])].sort();
    for (const sessionId of sessionIds) {
      try {
        await this.importSession(sessionId, files.get(sessionId), existing, tally, dryRun);
      } catch (error) {
        tally.transient = true;
        tally.problems.push(problemOf(sessionId, null, `session skipped: ${messageOf(error)}`));
      }
    }
  }

  private async importSession(
    sessionId: string,
    file: LegacySessionTasks | undefined,
    existing: Existing,
    tally: Tally,
    dryRun: boolean,
  ): Promise<void> {
    if (file !== undefined) {
      for (const issue of file.issues) tally.problems.push(problemOf(sessionId, issue.taskId, issue.detail));
      if (file.fatal && file.issues.length === 0)
        tally.problems.push(problemOf(sessionId, null, 'tasks.json could not be read'));
    }
    const entries = file === undefined || file.fatal ? [] : file.entries;
    const asks = await this.ports.agenda.unlinked(sessionId);
    if (entries.length === 0 && asks.length === 0) return;

    const projectId = await this.ports.projects.projectOf(sessionId);
    const laneSet = await this.laneSetFor(projectId, sessionId, tally, dryRun);
    const fresh = entries.filter(entry => !existing.byLegacyRef.has(legacyRefOf(sessionId, entry.task.id)));
    tally.alreadyImported += entries.length - fresh.length;
    if (dryRun) {
      tally.imported += fresh.length;
      const target = askTarget(entries, asks.length);
      tally.linkedAsks += asks.length;
      if (target.kind === 'untriaged' && asks.length > 0 && !existing.untriaged.has(sessionId))
        tally.untriagedCards += 1;
      return;
    }
    if (laneSet === null) {
      tally.transient = true;
      tally.problems.push(problemOf(sessionId, null, `no lanes could be proposed for project ${projectId}`));
      return;
    }

    const cardOf = new Map<string, BoardTaskId>();
    for (const entry of entries) {
      const known = existing.byLegacyRef.get(legacyRefOf(sessionId, entry.task.id));
      cardOf.set(entry.task.id, known ?? (await this.ports.store.allocateId(entry.task.kind)));
    }
    const created = await this.writeCards(sessionId, fresh, entries, laneSet, cardOf, tally);
    for (const [oldId, card] of cardOf) {
      if (!created.has(oldId) && !existing.byLegacyRef.has(legacyRefOf(sessionId, oldId))) cardOf.delete(oldId);
      else existing.byLegacyRef.set(legacyRefOf(sessionId, oldId), card);
    }
    if (asks.length > 0) await this.linkAsks(sessionId, entries, asks, laneSet, cardOf, existing, tally);
  }

  /** The project's lanes, proposing the ones its folder suggests the first time a project is seen without any. */
  private async laneSetFor(
    projectId: BoardProjectId,
    sessionId: string,
    tally: Tally,
    dryRun: boolean,
  ): Promise<LaneSet | null> {
    const stored = await this.ports.projects.laneSet(projectId);
    if (stored !== null) return stored;
    if (dryRun) {
      if (!tally.proposed.includes(projectId)) tally.proposed.push(projectId);
      return null;
    }
    const proposed = await this.ports.projects.propose(projectId, sessionId);
    if (proposed !== null && !tally.proposed.includes(projectId)) tally.proposed.push(projectId);
    return proposed;
  }

  /** Writes the cards of the tasks not imported yet; resolves to the old ids whose card now exists. */
  private async writeCards(
    sessionId: string,
    fresh: readonly TaskEntry[],
    entries: readonly TaskEntry[],
    laneSet: LaneSet,
    cardOf: Map<string, BoardTaskId>,
    tally: Tally,
  ): Promise<ReadonlySet<string>> {
    const actors = await this.actorsOf(entries);
    const assignees = await this.assigneesOf(entries);
    const plan = planSession(entries);
    const hasAsks = (await this.ports.agenda.unlinked(sessionId)).length > 0;
    const askLinked = hasAsks && ownerBlocked(entries, plan).length === 1;
    const now = this.ports.clock.now();
    const attempt = (): { readonly cards: Map<string, BoardTask>; readonly failed: Set<string> } => {
      const cards = new Map<string, BoardTask>();
      const failed = new Set<string>();
      for (const entry of fresh) {
        const id = cardOf.get(entry.task.id);
        if (id === undefined) continue;
        const built = buildCard({
          sessionId,
          entry,
          id,
          machineId: this.machine(),
          laneSet,
          plan,
          cardOf,
          actorOf: raw => actorOf(raw, actors),
          assignee: entry.task.assignee === null ? null : (assignees.get(entry.task.assignee) ?? null),
          askLinked,
          now,
        });
        if (built.ok) cards.set(entry.task.id, built.card);
        else {
          failed.add(entry.task.id);
          tally.problems.push(problemOf(sessionId, entry.task.id, `not imported: ${built.detail}`));
        }
      }
      return { cards, failed };
    };
    let result = attempt();
    if (result.failed.size > 0) {
      // A card that could not be built is no card: tasks that pointed at it are built again without the edge.
      const failedProblems = tally.problems.length;
      for (const oldId of result.failed) cardOf.delete(oldId);
      result = attempt();
      tally.problems.length = failedProblems;
    }
    const written = new Set<string>();
    for (const [oldId, card] of result.cards) {
      try {
        const outcome = await this.ports.store.write(card.id, async current =>
          current === undefined
            ? { task: card, result: 'created' as const }
            : { task: null, result: 'exists' as const },
        );
        if (outcome === 'created') tally.imported += 1;
        else tally.alreadyImported += 1;
        written.add(oldId);
      } catch (error) {
        tally.transient = true;
        tally.problems.push(problemOf(sessionId, oldId, `not imported: ${messageOf(error)}`));
      }
    }
    return written;
  }

  private async linkAsks(
    sessionId: string,
    entries: readonly TaskEntry[],
    asks: readonly { readonly id: string }[],
    laneSet: LaneSet,
    cardOf: ReadonlyMap<string, BoardTaskId>,
    existing: Existing,
    tally: Tally,
  ): Promise<void> {
    const target = askTarget(entries, asks.length);
    let cardId: BoardTaskId | undefined;
    let blocking = false;
    if (target.kind === 'owner-blocked' || target.kind === 'in-progress') {
      cardId = cardOf.get(target.oldId);
      blocking = target.kind === 'owner-blocked';
    }
    if (cardId === undefined) cardId = await this.untriagedCardFor(sessionId, laneSet, existing, tally);
    if (cardId === undefined) return;
    const task = { id: cardId };
    const links: AskLink[] = asks.map(ask => ({ id: ask.id, task, blocking }));
    try {
      tally.linkedAsks += await this.ports.agenda.link(sessionId, links);
    } catch (error) {
      tally.transient = true;
      tally.problems.push(problemOf(sessionId, null, `agenda items not linked: ${messageOf(error)}`));
    }
  }

  private async untriagedCardFor(
    sessionId: string,
    laneSet: LaneSet,
    existing: Existing,
    tally: Tally,
  ): Promise<BoardTaskId | undefined> {
    const known = existing.untriaged.get(sessionId);
    if (known !== undefined) return known;
    try {
      const id = await this.ports.store.allocateId('chore');
      const card = untriagedCard({ sessionId, id, machineId: this.machine(), laneSet, now: this.ports.clock.now() });
      await this.ports.store.write(id, async () => ({ task: card, result: undefined }));
      existing.untriaged.set(sessionId, id);
      tally.untriagedCards += 1;
      return id;
    } catch (error) {
      tally.transient = true;
      tally.problems.push(problemOf(sessionId, null, `the untriaged-asks card was not created: ${messageOf(error)}`));
      return undefined;
    }
  }

  private async actorsOf(entries: readonly TaskEntry[]): Promise<ReadonlySet<string>> {
    const raws = new Set<string>();
    for (const { task, activity } of entries) {
      if (task.createdBy !== null) raws.add(task.createdBy);
      for (const clarification of task.clarifications) raws.add(clarification.by);
      for (const entry of activity) raws.add(entry.actor);
    }
    const known = new Set<string>();
    for (const raw of raws) if (await this.ports.sessions.exists(raw)) known.add(raw);
    return known;
  }

  private async assigneesOf(entries: readonly TaskEntry[]): Promise<ReadonlyMap<string, string | null>> {
    const resolved = new Map<string, string | null>();
    for (const { task } of entries) {
      if (task.assignee === null || resolved.has(task.assignee)) continue;
      resolved.set(task.assignee, await this.ports.sessions.resolveAssignee(task.assignee));
    }
    return resolved;
  }
}

const actorOf = (raw: string | null, sessions: ReadonlySet<string>): BoardActor => {
  if (raw === null || raw === 'daemon') return { kind: 'daemon' };
  return sessions.has(raw) ? { kind: 'ferret', sessionId: raw } : { kind: 'owner' };
};

const ownerBlocked = (entries: readonly TaskEntry[], plan: SessionPlan): readonly TaskEntry[] =>
  entries.filter(entry => entry.task.status === 'blocked' && plan.readings.get(entry.task.id)?.on === 'owner');

type AskTarget =
  | { readonly kind: 'owner-blocked'; readonly oldId: string }
  | { readonly kind: 'in-progress'; readonly oldId: string }
  | { readonly kind: 'untriaged' };

/**
 * The card a session's unlinked agenda items go to (`board-design.md` §5): the one task blocked on the owner, else
 * the one task in progress, else the "Untriaged asks" card. Two of either is no answer, so it falls through.
 */
const askTarget = (entries: readonly TaskEntry[], asks: number): AskTarget => {
  if (asks === 0) return { kind: 'untriaged' };
  const blocked = ownerBlocked(entries, planSession(entries));
  const only = blocked.length === 1 ? blocked[0] : undefined;
  if (only !== undefined) return { kind: 'owner-blocked', oldId: only.task.id };
  const working = entries.filter(entry => entry.task.status === 'in_progress');
  const single = working.length === 1 ? working[0] : undefined;
  return single === undefined ? { kind: 'untriaged' } : { kind: 'in-progress', oldId: single.task.id };
};

const summarize = (tally: Tally, dryRun: boolean, skipped: boolean, complete: boolean): BoardImportSummary => ({
  dryRun,
  skipped,
  sessions: tally.sessions,
  imported: tally.imported,
  alreadyImported: tally.alreadyImported,
  proposedProjects: [...tally.proposed],
  linkedAsks: tally.linkedAsks,
  untriagedCards: tally.untriagedCards,
  problems: [...tally.problems],
  complete,
});
