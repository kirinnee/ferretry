/**
 * A SESSION STARTED WITH A BRIEF GETS A CARD (`board-design.md` §3.1 items 1–2), made by the daemon with
 * the session, so nobody has to remember to.
 *
 * - **`fy start` and the app's New session**: the session owns its own card. Title from `--name`, brief and
 *   ask the prompt verbatim — the ask's source is the starting ferret (`session:<parent>`) or the owner —
 *   in the first backlog lane, and the session's focus.
 * - **`fy new`** (Pack): the card is the LEAD's delegation. Owner the lead, assignee the child, parent the
 *   lead's focus card, on the board the child inherits. A lead with no focus card first gets one made from
 *   its own session (its title, and the owner's latest message as the ask), and the start says so. The
 *   card's id is reserved BEFORE the start, because the child's brief names it.
 *
 * The card is written after the session's record and before its agent launches, so the agent's first turn
 * already has its focus card, and a start refused earlier leaves no card behind. **A board failure never
 * fails a start**: the session starts, and what could not be done is said (`notes`) instead.
 *
 * A project with no lanes yet gets the inferred template PROPOSED (unconfirmed, one agenda choice for the
 * owner) and the card lands on its real board; only when proposing fails does it go on the Unfiled board,
 * with a note saying how to move it.
 */
import {
  type BoardProjectId,
  type BoardTask,
  type BoardTaskCreateRequest,
  type BoardTaskId,
  deriveTaskTitle,
  formatTaskRef,
  MAX_BOARD_BRIEF_LENGTH,
  type TaskMessage,
  type TaskRef,
  taskTitleFor,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import type { PendingContext } from './pending-context.ts';
import type {
  BoardClock,
  BoardDiagnostics,
  LaneProposer,
  LaneSetSource,
  SessionFocus,
  SessionParents,
} from './ports.ts';
import type { BoardService, SignalDoneOutcome } from './service.ts';
import { clip, doneQuietText } from './signal-done.ts';

/** The longest ask a card keeps; a longer brief is cut, and the brief field says so. */
const MAX_ASK_LENGTH = MAX_BOARD_BRIEF_LENGTH;

/** The source an ask carries when the owner said it. */
const OWNER_ASK_SOURCE = 'owner';

/** The source an ask carries when a ferret's brief said it. */
const sessionAskSource = (sessionId: string): string => `session:${sessionId}`;

/** What a session that needs a card made after the fact is, as its own documents say. */
export interface SessionCardFacts {
  readonly name?: string | undefined;
  readonly prompt?: string | undefined;
  readonly parent?: string | undefined;
  /** The owner's latest message to it, verbatim; absent when none was recorded. */
  readonly latestOwnerMessage?: string | undefined;
}

export interface SessionCardSessions {
  /** `undefined` when there is no such session. */
  facts(sessionId: string): Promise<SessionCardFacts | undefined>;
}

/** The board's name as the owner reads it. */
interface BoardProjectNames {
  nameOf(projectId: BoardProjectId): Promise<string>;
}

export interface SessionCardsPorts {
  readonly board: Pick<BoardService, 'reserve' | 'spawn' | 'signalDone'>;
  readonly lanes: LaneSetSource;
  readonly proposer: LaneProposer;
  readonly projects: BoardProjectNames;
  readonly focus: Pick<SessionFocus, 'focusOf'>;
  readonly parents: SessionParents;
  readonly sessions: SessionCardSessions;
  readonly pending: PendingContext;
  readonly clock: BoardClock;
  readonly diagnostics: BoardDiagnostics;
  /** The shipped command name, so every command a note prints exists after a rename. */
  readonly bin: string;
}

/** A `fy new`'s card, decided before the child exists so its brief can name it. */
export interface Delegation {
  readonly lead: string;
  /** The sub-ferret's brief as the lead wrote it, without the footer the daemon adds. */
  readonly brief: string;
  /** The child's card id, reserved. */
  readonly id: BoardTaskId;
  /** The lead's focus card, the child card's parent. */
  readonly parent: TaskRef;
  /** The board the child will be on when it runs in the lead's folder; `undefined` when it may not be. */
  readonly project?: string;
  /** The lead's card, when the lead had none and one was made for it first. */
  readonly leadCard?: BoardTaskId;
  readonly notes: readonly string[];
}

/** What a start is about to launch. */
export interface StartedSession {
  readonly sessionId: string;
  readonly name?: string | undefined;
  /** The brief as given; a `fy new`'s is its delegation's. */
  readonly brief: string;
  /** The starting ferret (`config.parent`); absent when the owner started it. */
  readonly parent?: string | undefined;
  /** Set for a `fy new`: the card the lead's delegation reserved. */
  readonly delegation?: Delegation | undefined;
}

/** The card a start made, or why it made none. */
export interface OpenedCard {
  readonly card?: BoardTask;
  /** The board's name as the owner reads it. */
  readonly project?: string;
  readonly notes: readonly string[];
}

/** A card's title: the session's name, else the brief's own, never its raw first words. */
export const cardTitle = (name: string | undefined, brief: string): string =>
  (name === undefined ? null : deriveTaskTitle(name)) ?? taskTitleFor(brief, 'Task');

/** A brief as a card's ask: verbatim, cut only at the field's limit. */
export const askOf = (text: string, source: string): TaskMessage => ({ text: clip(text, MAX_ASK_LENGTH), source });

/** The line a sub-ferret's brief gains (`subFerretFooter`): its card and where it is. */
export const cardFooterLine = (id: BoardTaskId, project: string | undefined, bin: string): string =>
  `Your card is ${formatTaskRef({ id })} on the ${project === undefined ? "project's" : project} board; move it as you work (\`${bin} task …\`).`;

/** A card request the daemon fills for a start. */
const startRequest = (fields: {
  readonly title: string;
  readonly brief: string;
  readonly ask: TaskMessage;
  readonly parent: TaskRef | null;
  readonly assignee: string | null;
}): BoardTaskCreateRequest => ({
  kind: 'feature',
  title: fields.title,
  summary: '',
  ask: fields.ask,
  premise: '',
  context: '',
  terms: [],
  brief: clip(fields.brief, MAX_BOARD_BRIEF_LENGTH),
  workflow: 'quick',
  parent: fields.parent,
  assignee: fields.assignee,
  dependsOn: [],
  files: [],
  docs: [],
});

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class SessionCards {
  constructor(private readonly ports: SessionCardsPorts) {}

  /**
   * A `fy new`'s card, before the child starts: the lead's focus card (made now if it has none) as the
   * parent, and the child's id reserved. `inLeadFolder` says the child runs where the lead does, so it
   * inherits the lead's board and the footer can name it. `undefined` when the board can do nothing: the
   * child then starts with no card, and `notes` is what to say.
   */
  async delegate(
    lead: string,
    brief: string,
    inLeadFolder: boolean,
  ): Promise<{ readonly delegation?: Delegation; readonly notes: readonly string[] }> {
    try {
      const notes: string[] = [];
      let parent = await this.ports.focus.focusOf(lead);
      let leadCard: BoardTaskId | undefined;
      if (parent === null) {
        const made = await this.leadCard(lead);
        if (made.card === undefined) return { notes: made.notes };
        parent = { id: made.card.id };
        leadCard = made.card.id;
        notes.push(
          `You had no card, so ${formatTaskRef(parent)} was made for you from your session ("${made.card.title}") on the ${made.project ?? 'project'} board; your sub-ferret's card sits under it.`,
          ...made.notes,
        );
      }
      const id = await this.ports.board.reserve('feature');
      const project = inLeadFolder
        ? await this.ports.projects.nameOf(await this.ports.lanes.projectOf(lead))
        : undefined;
      return {
        delegation: {
          lead,
          brief,
          id,
          parent,
          ...(project === undefined ? {} : { project }),
          ...(leadCard === undefined ? {} : { leadCard }),
          notes,
        },
        notes,
      };
    } catch (error) {
      const note = `No card was made for the sub-ferret: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /**
   * The card of a session being started, after its record and before its launch. Never rejects: a board
   * failure is a note, and the start goes on.
   */
  async open(start: StartedSession): Promise<OpenedCard> {
    try {
      const delegation = start.delegation;
      const owner = delegation?.lead ?? start.sessionId;
      const from = delegation?.lead ?? start.parent;
      const brief = delegation?.brief ?? start.brief;
      const placed = await this.place(start.sessionId, owner);
      const id = delegation?.id ?? (await this.ports.board.reserve('feature'));
      const card = await this.ports.board.spawn(
        id,
        startRequest({
          title: cardTitle(start.name, brief),
          brief,
          ask: askOf(brief, from === undefined ? OWNER_ASK_SOURCE : sessionAskSource(from)),
          parent: delegation?.parent ?? null,
          assignee: delegation === undefined ? null : start.sessionId,
        }),
        { owner, by: owner, focus: start.sessionId, projectId: placed.projectId },
      );
      if (delegation?.project !== undefined && delegation.project !== placed.project) {
        placed.notes.push(
          `The brief said ${formatTaskRef(card)} is on the ${delegation.project} board; it is on the ${placed.project} board, where the sub-ferret runs.`,
        );
      }
      for (const note of placed.notes) this.ports.diagnostics.warn(`${formatTaskRef(card)}: ${note}`);
      return { card, project: placed.project, notes: placed.notes };
    } catch (error) {
      const note = `No card was made for ${start.sessionId}: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /**
   * `fy signal done` on the board: the note and the move ({@link BoardService.signalDone}), then a quiet
   * line to the lead — the card's owner when it is someone else, else the session's own parent. Never
   * rejects: the signal is already recorded.
   */
  async signalled(sessionId: string, message: string | undefined): Promise<SignalDoneOutcome | null> {
    let outcome: SignalDoneOutcome | null;
    try {
      outcome = await this.ports.board.signalDone(sessionId, message);
    } catch (error) {
      this.ports.diagnostics.warn(`could not record ${sessionId}'s done on its card: ${said(error)}`);
      return null;
    }
    if (outcome === null) return null;
    const lead = outcome.task.owner === sessionId ? await this.ports.parents.parentOf(sessionId) : outcome.task.owner;
    if (lead !== undefined && lead !== sessionId) {
      await this.ports.pending
        .append(lead, [
          {
            key: `${outcome.task.id}:done`,
            text: doneQuietText(outcome.task, outcome.moved, message),
            at: this.ports.clock.now(),
          },
        ])
        .catch((error: unknown) =>
          this.ports.diagnostics.warn(
            `could not tell ${lead} that ${formatTaskRef(outcome.task)} is done: ${said(error)}`,
          ),
        );
    }
    return outcome;
  }

  /** A card for a lead that has none, from its own session (§3.1 item 2), and its focus. */
  private async leadCard(lead: string): Promise<OpenedCard> {
    const facts = await this.ports.sessions.facts(lead);
    if (facts === undefined) return { notes: [`there is no session ${lead} to make a card for`] };
    const owner = facts.latestOwnerMessage?.trim();
    const brief = facts.prompt ?? '';
    const ask =
      owner !== undefined && owner !== ''
        ? askOf(owner, OWNER_ASK_SOURCE)
        : askOf(
            brief.trim() === '' ? cardTitle(facts.name, brief) : brief,
            facts.parent === undefined ? OWNER_ASK_SOURCE : sessionAskSource(facts.parent),
          );
    const placed = await this.place(lead, lead);
    const card = await this.ports.board.spawn(
      await this.ports.board.reserve('feature'),
      startRequest({ title: cardTitle(facts.name, brief), brief, ask, parent: null, assignee: null }),
      { owner: lead, by: lead, focus: lead, projectId: placed.projectId },
    );
    return { card, project: placed.project, notes: placed.notes };
  }

  /**
   * The board a session's card goes on: its project's, with lanes proposed when the project has none, else
   * the Unfiled board with a note that says how to move it.
   */
  private async place(
    sessionId: string,
    proposer: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly project: string; notes: string[] }> {
    const projectId = await this.ports.lanes.projectOf(sessionId);
    const project = await this.ports.projects.nameOf(projectId);
    if ((await this.ports.lanes.laneSet(projectId)) !== null) return { projectId, project, notes: [] };
    const proposed = await this.ports.proposer.propose(projectId, proposer).catch((error: unknown) => {
      this.ports.diagnostics.warn(`could not propose lanes for ${project}: ${said(error)}`);
      return null;
    });
    if (proposed !== null) {
      return {
        projectId,
        project,
        notes: [`${project} had no lanes, so they were proposed for the owner to confirm (an agenda choice).`],
      };
    }
    const unfiled = await this.ports.projects.nameOf(UNFILED_PROJECT_ID);
    return {
      projectId: UNFILED_PROJECT_ID,
      project: unfiled,
      notes: [
        `${project} has no lanes yet, so the card is on the ${unfiled} board: propose them with \`${this.ports.bin} board lanes propose --template <template>\`, then refile the card to ${project}.`,
      ],
    };
  }
}
