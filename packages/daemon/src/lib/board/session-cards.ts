/**
 * A SESSION STARTED WITH A BRIEF GETS A CARD (`board-design.md` §3.1 items 1–2), made by the daemon with
 * the session, so nobody has to remember to.
 *
 * - **`fy start` and the app's New session**: the session owns its own card. Title from `--name`, brief and
 *   ask the prompt verbatim — the ask's source is the starting ferret (`session:<parent>`) or the owner —
 *   in the first backlog lane, and the session's focus.
 * - **`fy new`** (Pack): the card is the LEAD's delegation. Owner the lead, assignee the child, on the board
 *   the child inherits. Its parent comes from the lead's INTENT, never from the card it touched last: the
 *   card the brief names (`&F138`), else the lead's explicit focus card (`config.focusAnchor`), else none —
 *   a top-level card, said in the start's output. `--card <id>` names an EXISTING card instead: it is
 *   assigned to the child, and so is the lead's own open card with the same title, so a delegation never
 *   leaves a twin. The card's id is reserved BEFORE the start, because the child's brief names it.
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
  firstTaskRefIn,
  formatTaskRef,
  MAX_BOARD_BRIEF_LENGTH,
  type TaskMessage,
  type TaskRef,
  taskTitleFor,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import { effectiveAssignee } from './authority.ts';
import { cardCategory } from './graph.ts';
import type { BoardDiagnostics, LaneProposer, LaneSetSource, ProjectAdopter, SessionFocus } from './ports.ts';
import type { BoardService, SignalDoneOutcome } from './service.ts';
import { BoardError } from './errors.ts';
import { clip } from './signal-done.ts';

/** The longest ask a card keeps; a longer brief is cut, and the brief field says so. */
const MAX_ASK_LENGTH = MAX_BOARD_BRIEF_LENGTH;

/** The source an ask carries when the owner said it. */
const OWNER_ASK_SOURCE = 'owner';

/** The source an ask carries when a ferret's brief said it. */
const sessionAskSource = (sessionId: string): string => `session:${sessionId}`;

/** The board's name as the owner reads it. */
interface BoardProjectNames {
  nameOf(projectId: BoardProjectId): Promise<string>;
}

export interface SessionCardsPorts {
  readonly board: Pick<
    BoardService,
    'reserve' | 'spawn' | 'signalDone' | 'snapshot' | 'requireHandOver' | 'handOver' | 'trigger'
  >;
  readonly lanes: LaneSetSource;
  readonly proposer: LaneProposer;
  /** Registers the repository of a session on the Unfiled board, so its card goes on that project's board. */
  readonly adoption?: ProjectAdopter;
  readonly projects: BoardProjectNames;
  readonly focus: Pick<SessionFocus, 'anchorOf'>;
  readonly diagnostics: BoardDiagnostics;
  /** The shipped command name, so every command a note prints exists after a rename. */
  readonly bin: string;
}

/** Where a delegated card's parent came from: the brief that names it, or the lead's explicit focus card. */
export type ParentFrom = 'brief' | 'focus';

/** A `fy new`'s card, decided before the child exists so its brief can name it. */
export interface Delegation {
  readonly lead: string;
  /** The sub-ferret's brief as the lead wrote it, without the footer the daemon adds. */
  readonly brief: string;
  /** The child's card id: reserved for a new card, the lead's own for an existing one. */
  readonly id: BoardTaskId;
  /** The card already exists (`--card`, or the lead's open card with this title): it is assigned, not made. */
  readonly existing: boolean;
  /** The card the child's card sits under; `null` for a top-level card. */
  readonly parent: TaskRef | null;
  /** Why it sits there; absent for a top-level card and for an existing card, which keeps the parent it had. */
  readonly parentFrom?: ParentFrom;
  /** The board's name as the owner reads it; `undefined` when the child may run on another board. */
  readonly project?: string;
}

/** What delegating a card came to: the delegation, or why the start must not go on. */
export interface DelegationOutcome {
  readonly delegation?: Delegation;
  /** Set when `--card` named a card the lead may not hand over: the start is refused with this. */
  readonly refusal?: string;
  readonly notes: readonly string[];
}

/** What a `fy new` hands the board to decide its card from. */
export interface DelegationRequest {
  readonly brief: string;
  /** The name the child session is given, which titles a new card. */
  readonly name?: string | undefined;
  /** An existing card the child works on (`--card`). */
  readonly card?: BoardTaskId | undefined;
}

/** A card's title as compared for twins: case, spacing and punctuation do not tell two titles apart. */
const normalisedTitle = (title: string): string =>
  title
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

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
export const cardFooterLine = (
  id: BoardTaskId,
  project: string | undefined,
  bin: string,
  parent: TaskRef | null = null,
): string =>
  `Your card is ${formatTaskRef({ id })} on the ${project === undefined ? "project's" : project} board${parent === null ? '' : `, under ${formatTaskRef(parent)}`}; the daemon moves it for you (\`${bin} task note\` adds progress).`;

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
  howToTest: '',
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
   * A `fy new`'s card, before the child starts, and the child's id reserved (or the existing card named).
   * Its parent comes from intent: the card the brief names, else the lead's explicit focus card, else none.
   * `inLeadFolder` says the child runs where the lead does, so it inherits the lead's board and the footer can
   * name it. No delegation when the board can do nothing (the child then starts with no card, and `notes` is
   * what to say) or when `--card` named a card that cannot be handed over (`refusal`).
   */
  async delegate(lead: string, request: DelegationRequest, inLeadFolder: boolean): Promise<DelegationOutcome> {
    try {
      if (request.card !== undefined) return await this.existingCard(lead, request.card);
      const title = cardTitle(request.name, request.brief);
      const projectId = inLeadFolder ? await this.ports.lanes.projectOf(lead) : undefined;
      const project = projectId === undefined ? undefined : await this.ports.projects.nameOf(projectId);
      const twin = projectId === undefined ? undefined : await this.twinOf(lead, projectId, title);
      if (twin !== undefined) {
        return {
          delegation: {
            lead,
            brief: request.brief,
            id: twin.id,
            existing: true,
            parent: twin.parent,
            ...(project === undefined ? {} : { project }),
          },
          notes: [
            `You already had ${formatTaskRef(twin)} ("${twin.title}") for this work, so it was assigned to the sub-ferret instead of making a second card.`,
          ],
        };
      }
      const { parent, from } = await this.parentFor(lead, request.brief);
      const id = await this.ports.board.reserve('feature');
      const notes =
        parent === null
          ? [
              `The sub-ferret's card has no parent, so it is at the top level of the board: \`${this.ports.bin} task reparent ${formatTaskRef({ id })} --parent <id>\` moves it, and \`${this.ports.bin} task focus <id>\` (or \`--card <id>\`) says where your sub-ferrets' cards go next time.`,
            ]
          : [];
      return {
        delegation: {
          lead,
          brief: request.brief,
          id,
          existing: false,
          parent,
          ...(from === undefined ? {} : { parentFrom: from }),
          ...(project === undefined ? {} : { project }),
        },
        notes,
      };
    } catch (error) {
      const note = `No card was made for the sub-ferret: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /** `--card`: the lead's existing card, handed over; refused (not failed) when it cannot be. */
  private async existingCard(lead: string, id: BoardTaskId): Promise<DelegationOutcome> {
    let card: BoardTask;
    try {
      card = await this.ports.board.requireHandOver(id, lead);
    } catch (error) {
      if (error instanceof BoardError) return { refusal: error.message, notes: [] };
      throw error;
    }
    const project = await this.ports.projects.nameOf(card.projectId);
    return {
      delegation: { lead, brief: '', id, existing: true, parent: card.parent, project },
      notes: [],
    };
  }

  /**
   * The parent a NEW card goes under, from the lead's intent in priority order: the first card the brief
   * names, then the lead's explicit focus card. Neither is the card the lead merely touched last.
   */
  private async parentFor(
    lead: string,
    brief: string,
  ): Promise<{ readonly parent: TaskRef | null; readonly from?: ParentFrom }> {
    const named = firstTaskRefIn(brief);
    const { cards } = await this.ports.board.snapshot();
    const usable = (ref: TaskRef | null | undefined): TaskRef | null => {
      const found = ref === null || ref === undefined ? undefined : cards.find(card => card.id === ref.id);
      return found === undefined || found.dropped !== null ? null : { id: found.id };
    };
    const fromBrief = usable(named);
    if (fromBrief !== null) return { parent: fromBrief, from: 'brief' };
    const anchored = usable(await this.ports.focus.anchorOf(lead));
    return anchored === null ? { parent: null } : { parent: anchored, from: 'focus' };
  }

  /**
   * The lead's own open card for this very work — same board, same title once case and punctuation are set
   * aside, still the lead's to give (nobody else is on it) — so a delegation reuses it rather than twinning it.
   */
  private async twinOf(lead: string, projectId: BoardProjectId, title: string): Promise<BoardTask | undefined> {
    const { cards, laneSets } = await this.ports.board.snapshot();
    const wanted = normalisedTitle(title);
    return cards.find(card => {
      if (card.owner !== lead || card.projectId !== projectId || card.dropped !== null) return false;
      if (effectiveAssignee(card) !== lead || normalisedTitle(card.title) !== wanted) return false;
      const category = cardCategory(card, laneSets);
      return category === 'backlog' || category === 'active' || category === 'review';
    });
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
      if (delegation?.existing === true) return await this.handOver(delegation, start.sessionId);
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
      return { card: await this.workStarted(card, start.sessionId), project: placed.project, notes: placed.notes };
    } catch (error) {
      const note = `No card was made for ${start.sessionId}: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /** The lead's existing card, assigned to the session just started; it keeps its owner and its parent. */
  private async handOver(delegation: Delegation, sessionId: string): Promise<OpenedCard> {
    const card = await this.ports.board.handOver(delegation.id, delegation.lead, sessionId);
    return {
      card: await this.workStarted(card, sessionId),
      project: await this.ports.projects.nameOf(card.projectId),
      notes: [],
    };
  }

  /**
   * A start IS the work starting (`work.started`), so the card enters the lane that trigger names for its
   * workflow (In progress, or Plan/Design for a plan-first card), whoever may move cards: a sub-ferret cannot,
   * and a card left in the backlog while it is built tells the owner nothing. Best effort, like the card.
   */
  private async workStarted(card: BoardTask, sessionId: string): Promise<BoardTask> {
    try {
      const moved = await this.ports.board.trigger(card.id, 'work.started', {
        sessionId,
        reason: 'the session started on it',
      });
      return moved === null ? card : moved.task;
    } catch (error) {
      this.ports.diagnostics.warn(`could not move ${formatTaskRef(card)} to its working lane: ${said(error)}`);
      return card;
    }
  }

  /**
   * `fy signal done` on the board: the note and the move ({@link BoardService.signalDone}). Nothing is
   * typed into the lead's chat: the done message reaches it through `fy wait`, in the ferret's own words,
   * and the board shows the move. Never rejects: the signal is already recorded.
   */
  async signalled(sessionId: string, message: string | undefined): Promise<SignalDoneOutcome | null> {
    let outcome: SignalDoneOutcome | null;
    try {
      outcome = await this.ports.board.signalDone(sessionId, message);
    } catch (error) {
      this.ports.diagnostics.warn(`could not record ${sessionId}'s done on its card: ${said(error)}`);
      return null;
    }
    return outcome;
  }

  /** The repository's board for a session on the Unfiled board; `null` when it stays where it is. */
  private async adopt(
    sessionId: string,
    proposer: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly proposed: boolean } | null> {
    const adoption = this.ports.adoption;
    if (adoption === undefined) return null;
    if ((await this.ports.lanes.projectOf(sessionId)) !== UNFILED_PROJECT_ID) return null;
    return await adoption.adopt(sessionId, proposer).catch((error: unknown) => {
      this.ports.diagnostics.warn(`could not register the repository of ${sessionId}: ${said(error)}`);
      return null;
    });
  }

  /**
   * The board a session's card goes on: its project's, with lanes proposed when the project has none, else
   * the Unfiled board with a note that says how to move it.
   */
  private async place(
    sessionId: string,
    proposer: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly project: string; notes: string[] }> {
    const adopted = await this.adopt(sessionId, proposer);
    if (adopted !== null) {
      const project = await this.ports.projects.nameOf(adopted.projectId);
      return {
        projectId: adopted.projectId,
        project,
        notes: [
          `${project} was registered as a project, so the card is on its board${adopted.proposed ? '; its lanes were proposed for the owner to confirm (an agenda choice)' : ''}.`,
        ],
      };
    }
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
