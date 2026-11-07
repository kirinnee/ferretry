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
 * **Only where the board is on** (`board-switch.ts`): the board is opt-in. On a board that is off a start makes
 * no card, and a `fy new` makes one only when the lead holds a card to put it under (the brief names one, or
 * the lead's focus) or hands one over (`--card`): a lead may always give its helpers cards.
 *
 * The card is written after the session's record and before its agent launches, so the agent's first turn
 * already has its focus card, and a start refused earlier leaves no card behind. **A board failure never
 * fails a start**: the session starts, and what could not be done is said (`notes`) instead.
 *
 * A project with no lanes yet gets the inferred template PROPOSED (unconfirmed, one agenda choice for the
 * owner) and the card lands on its real board; only when proposing fails does it go on the Unfiled board,
 * with a note saying how to move it.
 */
import { cardTitleFor, deriveCardTitle } from './card-title.ts';
import { type BoardProjectId, type Card, type CardCreateRequest, type CardId, firstCardRefIn, formatCardRef, MAX_CARD_BRIEF_LENGTH, type CardMessage, type CardRef, UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import type { BoardSwitchReader } from '../lanes/board-switch.ts';
import { effectiveAssignee } from './authority.ts';
import { BoardError } from './errors.ts';
import { cardCategory } from './graph.ts';
import type { BoardDiagnostics, LaneProposer, LaneSetSource, ProjectAdopter, FerretFocus } from './ports.ts';
import type { BoardService, CardHolders, SignalDoneOutcome } from './service.ts';
import { clip } from './signal-done.ts';

/** The longest ask a card keeps; a longer brief is cut, and the brief field says so. */
const MAX_ASK_LENGTH = MAX_CARD_BRIEF_LENGTH;

/** The source an ask carries when the owner said it. */
const OWNER_ASK_SOURCE = 'owner';

/** The source an ask carries when a `fy new` made the card for a ferret no lead was recorded for: the work of a ferret, never the owner's ask. */
const PACK_ASK_SOURCE = 'fy new';

/** The source an ask carries when a ferret's brief said it. */
const ferretAskSource = (ferret: string): string => `session:${ferret}`;

/** The board's name as the owner reads it. */
interface BoardProjectNames {
  nameOf(projectId: BoardProjectId): Promise<string>;
}

export interface FerretCardsPorts {
  readonly board: Pick<
    BoardService,
    | 'reserve'
    | 'spawn'
    | 'signalDone'
    | 'snapshot'
    | 'requireHandOver'
    | 'handOver'
    | 'assignForOwner'
    | 'trigger'
    | 'mayAdoptUnder'
  >;
  readonly lanes: LaneSetSource;
  /** The board a session about to start in a folder will work on, for a `fy new --cwd` (`FerretProjects`). */
  readonly starts: {
    projectForStart(start: { readonly cwd: string; readonly parent?: string }): Promise<BoardProjectId>;
  };
  /** Whether a board is on: a start on a board that is off makes no card of its own. */
  readonly switches: BoardSwitchReader;
  readonly proposer: LaneProposer;
  /** Registers the repository of a session on the Unfiled board, so its card goes on that project's board. */
  readonly adoption?: ProjectAdopter;
  readonly projects: BoardProjectNames;
  readonly focus: Pick<FerretFocus, 'anchorOf'>;
  readonly diagnostics: BoardDiagnostics;
  /** The shipped command name, so every command a note prints exists after a rename. */
  readonly bin: string;
}

/** Where a delegated card's parent came from: the brief that names it, or the lead's explicit focus card. */
export type ParentFrom = 'brief' | 'focus';

/** A `fy new`'s card, decided before the child exists so its brief can name it. */
export interface Delegation {
  readonly lead: string;
  /** The helper's brief as the lead wrote it, without the footer the daemon adds. */
  readonly brief: string;
  /** The child's card id: reserved for a new card, the lead's own for an existing one. */
  readonly id: CardId;
  /** The card already exists (`--card`, or the lead's open card with this title): it is assigned, not made. */
  readonly existing: boolean;
  /** The card the child's card sits under; `null` for a top-level card. */
  readonly parent: CardRef | null;
  /** Why it sits there; absent for a top-level card and for an existing card, which keeps the parent it had. */
  readonly parentFrom?: ParentFrom;
  /** The board's name as the owner reads it; `undefined` when the child may run on another board. */
  readonly project?: string;
  /** The OWNER started the ferret on this existing card (`ownerDelegation`): no lead hands it down, the owner assigns it. */
  readonly byOwner?: true;
  /** Who held the existing card when the start judged it: the assignment writes only if it still finds them (`CardHolders`). */
  readonly held?: CardHolders;
}

/** Who holds a card now, as a start must still find them when it assigns it. */
const holdersOf = (card: Pick<Card, 'owner' | 'assignee'>): CardHolders => ({
  owner: card.owner,
  assignee: card.assignee,
});

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
  readonly card?: CardId | undefined;
}

/** A card's title as compared for twins: case, spacing and punctuation do not tell two titles apart. */
const normalisedTitle = (title: string): string =>
  title
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** What a start is about to launch. */
export interface StartedFerret {
  readonly ferret: string;
  readonly name?: string | undefined;
  /** The brief as given; a `fy new`'s is its delegation's. */
  readonly brief: string;
  /** The starting ferret (`config.parent`); absent when the owner started it. */
  readonly parent?: string | undefined;
  /** Set for a `fy new`: the card the lead's delegation reserved. */
  readonly delegation?: Delegation | undefined;
  /** The start came through `fy new`: with no lead recorded, its card is still a ferret's errand, never the owner's ask. */
  readonly viaPack?: true | undefined;
}

/** The card a start made, or why it made none. */
export interface OpenedCard {
  readonly card?: Card;
  /** The board's name as the owner reads it. */
  readonly project?: string;
  readonly notes: readonly string[];
}

/** A card's title: the session's name, else the brief's own, never its raw first words. */
export const cardTitle = (name: string | undefined, brief: string): string =>
  (name === undefined ? null : deriveCardTitle(name)) ?? cardTitleFor(brief, 'Task');

/** A brief as a card's ask: verbatim, cut only at the field's limit. */
export const askOf = (text: string, source: string): CardMessage => ({ text: clip(text, MAX_ASK_LENGTH), source });

/**
 * The delegation of a start the owner made on an existing card ("Start a ferret on it"): it is assigned to the new
 * ferret as the owner's act, and the card keeps its owner and its parent.
 */
export const ownerDelegation = (card: Pick<Card, 'id' | 'owner' | 'assignee' | 'parent'>): Delegation => ({
  lead: card.owner,
  brief: '',
  id: card.id,
  existing: true,
  parent: card.parent,
  byOwner: true,
  held: holdersOf(card),
});

/** The line a helper's brief gains (`subFerretFooter`): its card and where it is. */
export const cardFooterLine = (
  id: CardId,
  project: string | undefined,
  bin: string,
  parent: CardRef | null = null,
): string =>
  `Your card is ${formatCardRef({ id })} on the ${project === undefined ? "project's" : project} board${parent === null ? '' : `, under ${formatCardRef(parent)}`}; the daemon moves it for you (\`${bin} card note\` adds progress).`;

/** A card request the daemon fills for a start. */
const startRequest = (fields: {
  readonly title: string;
  readonly brief: string;
  readonly ask: CardMessage;
  readonly parent: CardRef | null;
  readonly assignee: string | null;
}): CardCreateRequest => ({
  kind: 'feature',
  title: fields.title,
  summary: '',
  ask: fields.ask,
  premise: '',
  context: '',
  terms: [],
  brief: clip(fields.brief, MAX_CARD_BRIEF_LENGTH),
  howToTest: '',
  workflow: 'quick',
  parent: fields.parent,
  assignee: fields.assignee,
  dependsOn: [],
  files: [],
  docs: [],
});

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class FerretCards {
  constructor(private readonly ports: FerretCardsPorts) {}

  /**
   * A `fy new`'s card, before the child starts, and the child's id reserved (or the existing card named).
   * Its parent comes from intent: the card the brief names, else the lead's explicit focus card, else none.
   * `inLeadFolder` says the child runs where the lead does, so it inherits the lead's board and the footer can
   * name it; otherwise `cwd` is the folder it runs in. No delegation when the board can do nothing (the child then
   * starts with no card, and `notes` is what to say) or when `--card` named a card that cannot be handed over
   * (`refusal`). The board is opt-in, and asked of the board the CHILD will work on: a card is made there only when
   * it is on, or under a parent the lead holds on that same board (docs/board.md § The board is opt-in).
   */
  async delegate(
    lead: string,
    request: DelegationRequest,
    inLeadFolder: boolean,
    cwd?: string,
  ): Promise<DelegationOutcome> {
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
            held: holdersOf(twin),
            ...(project === undefined ? {} : { project }),
          },
          notes: [
            `You already had ${formatCardRef(twin)} ("${twin.title}") for this work, so it was assigned to the helper instead of making a second card.`,
          ],
        };
      }
      const { parent, from } = await this.parentFor(lead, request.brief);
      const childBoard =
        projectId ??
        (cwd === undefined
          ? await this.ports.lanes.projectOf(lead)
          : await this.ports.starts.projectForStart({ cwd, parent: lead }));
      if (!(await this.licensed(childBoard, parent))) {
        const name = project ?? (await this.ports.projects.nameOf(childBoard));
        return {
          notes: [
            `No card was made for the helper: the ${name} board is off and you hold no card for this work. \`${this.ports.bin} new --card <id>\` hands it one.`,
          ],
        };
      }
      const id = await this.ports.board.reserve('feature');
      const notes =
        parent === null
          ? [
              `The helper's card has no parent, so it is at the top level of the board: \`${this.ports.bin} card reparent ${formatCardRef({ id })} --parent <id>\` moves it, and \`${this.ports.bin} card focus <id>\` (or \`--card <id>\`) says where your helpers' cards go next time.`,
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
      const note = `No card was made for the helper: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /**
   * `fy start --card <id>`, before the session exists: the existing card the new session takes over, judged with the
   * same authority as `fy new --card`. A ferret's start (`lead`) hands over only a card it may hand down; the owner's
   * (no lead) needs the card to exist. Either way the card must still be open work: a dropped or closed card is refused
   * here, before anything is written, and so is a start that is not an ordinary ferret (a miner, a guide builder or a
   * warden takes no card). `refusal` says why a card cannot be had; the start must not go on. The judgement is early,
   * not final: {@link takeOver} re-judges inside the write that assigns the card.
   */
  async startOn(lead: string | undefined, id: CardId, ordinary = true): Promise<DelegationOutcome> {
    if (!ordinary) {
      return {
        refusal: `--card is for an ordinary ferret: a worker the daemon starts for itself takes no card`,
        notes: [],
      };
    }
    try {
      const outcome = lead === undefined ? await this.ownerStart(id) : await this.existingCard(lead, id);
      if (outcome.delegation === undefined) return outcome;
      const unavailable = await this.unavailable(id);
      return unavailable === undefined ? outcome : { refusal: unavailable, notes: [] };
    } catch (error) {
      return { refusal: `the board could not be read: ${said(error)}`, notes: [] };
    }
  }

  /**
   * `fy start --card`, once the session's record exists and before its agent launches: the card is assigned to it, or
   * the start is refused and `stop` takes the record down, so a session never runs on a card it was not given. The
   * assignment is one write that re-judges the card (dropped, closed, still the lead's to hand down), so a drop or a
   * reassignment between {@link startOn} and here loses the race cleanly: nothing is assigned and nothing launches.
   */
  async takeOver(
    delegation: Delegation,
    ferret: string,
    stop: (reason: string) => Promise<void>,
  ): Promise<{ readonly opened?: OpenedCard; readonly refusal?: string }> {
    try {
      return { opened: await this.handOver(delegation, ferret) };
    } catch (error) {
      const refusal = `${formatCardRef({ id: delegation.id })} could not be handed to the new session: ${said(error)}`;
      await stop(refusal).catch((stopped: unknown) => {
        this.ports.diagnostics.warn(`could not stop ${ferret} after a refused card: ${said(stopped)}`);
      });
      return { refusal };
    }
  }

  private async ownerStart(id: CardId): Promise<DelegationOutcome> {
    const { cards } = await this.ports.board.snapshot();
    const card = cards.find(each => each.id === id);
    if (card === undefined) return { refusal: `there is no card ${formatCardRef({ id })} on this machine`, notes: [] };
    return { delegation: ownerDelegation(card), notes: [] };
  }

  /** Why a card cannot take a new session: it is dropped or closed. `undefined` when it is open work. */
  private async unavailable(id: CardId): Promise<string | undefined> {
    const { cards, laneSets } = await this.ports.board.snapshot();
    const card = cards.find(each => each.id === id);
    if (card === undefined) return `there is no card ${formatCardRef({ id })} on this machine`;
    if (card.dropped !== null) return `${formatCardRef(card)} is dropped; reopen it before you start a ferret on it`;
    if (cardCategory(card, laneSets) === 'closed')
      return `${formatCardRef(card)} is closed; reopen it before you start a ferret on it`;
    return undefined;
  }

  /** `--card`: the lead's existing card, handed over; refused (not failed) when it cannot be. */
  private async existingCard(lead: string, id: CardId): Promise<DelegationOutcome> {
    let card: Card;
    try {
      card = await this.ports.board.requireHandOver(id, lead);
    } catch (error) {
      if (error instanceof BoardError) return { refusal: error.message, notes: [] };
      throw error;
    }
    const project = await this.ports.projects.nameOf(card.projectId);
    return {
      delegation: { lead, brief: '', id, existing: true, parent: card.parent, project, held: holdersOf(card) },
      notes: [],
    };
  }

  /**
   * The parent a NEW card goes under, from the lead's intent in priority order: the first card the brief
   * names, then the lead's explicit focus card. Neither is the card the lead merely touched last. Either counts
   * only when the lead may put a child under it and it is still work (`BoardService.mayAdoptUnder`): a brief that
   * merely mentions somebody else's card, or a closed one, gives no parent, so the board's switch decides.
   */
  private async parentFor(
    lead: string,
    brief: string,
  ): Promise<{ readonly parent: CardRef | null; readonly from?: ParentFrom }> {
    const named = firstCardRefIn(brief);
    const usable = async (ref: CardRef | null | undefined): Promise<CardRef | null> => {
      if (ref === null || ref === undefined) return null;
      return (await this.ports.board.mayAdoptUnder(lead, ref.id)) ? { id: ref.id } : null;
    };
    const fromBrief = await usable(named);
    if (fromBrief !== null) return { parent: fromBrief, from: 'brief' };
    const anchored = await usable(await this.ports.focus.anchorOf(lead));
    return anchored === null ? { parent: null } : { parent: anchored, from: 'focus' };
  }

  /**
   * The lead's own open card for this very work — same board, same title once case and punctuation are set
   * aside, still the lead's to give (nobody else is on it) — so a delegation reuses it rather than twinning it.
   */
  private async twinOf(lead: string, projectId: BoardProjectId, title: string): Promise<Card | undefined> {
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
  async open(start: StartedFerret): Promise<OpenedCard> {
    try {
      const delegation = start.delegation;
      const owner = delegation?.lead ?? start.ferret;
      const from = delegation?.lead ?? start.parent;
      const brief = delegation?.brief ?? start.brief;
      if (delegation?.existing === true) return await this.handOver(delegation, start.ferret);
      // A start with no delegation makes its own card only where the board is on.
      if (
        delegation === undefined &&
        !(await this.ports.switches.isOn(await this.ports.lanes.projectOf(start.ferret)))
      )
        return { notes: [] };
      const placed = await this.place(start.ferret, owner);
      // The board the child landed on is the one asked: a guess at start time that came out otherwise makes no card.
      if (delegation !== undefined && !(await this.licensed(placed.projectId, delegation.parent))) {
        return {
          notes: [
            `No card was made for the helper: the ${placed.project} board is off and you hold no card on it for this work.`,
          ],
        };
      }
      const id = delegation?.id ?? (await this.ports.board.reserve('feature'));
      const card = await this.ports.board.spawn(
        id,
        startRequest({
          title: cardTitle(start.name, brief),
          brief,
          ask: askOf(
            brief,
            from !== undefined ? ferretAskSource(from) : start.viaPack === true ? PACK_ASK_SOURCE : OWNER_ASK_SOURCE,
          ),
          parent: delegation?.parent ?? null,
          assignee: delegation === undefined ? null : start.ferret,
        }),
        { owner, by: owner, focus: start.ferret, projectId: placed.projectId },
      );
      if (delegation?.project !== undefined && delegation.project !== placed.project) {
        placed.notes.push(
          `The brief said ${formatCardRef(card)} is on the ${delegation.project} board; it is on the ${placed.project} board, where the helper runs.`,
        );
      }
      for (const note of placed.notes) this.ports.diagnostics.warn(`${formatCardRef(card)}: ${note}`);
      return { card: await this.workStarted(card, start.ferret), project: placed.project, notes: placed.notes };
    } catch (error) {
      const note = `No card was made for ${start.ferret}: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /** Whether a lead's new card may go on `projectId`: its board is on, or the parent (already judged) is on it. */
  private async licensed(projectId: BoardProjectId, parent: CardRef | null): Promise<boolean> {
    if (await this.ports.switches.isOn(projectId)) return true;
    if (parent === null) return false;
    const { cards } = await this.ports.board.snapshot();
    return cards.find(card => card.id === parent.id)?.projectId === projectId;
  }

  /** The existing card, assigned to the session just started (by the lead, or by the owner); it keeps its owner and its parent. */
  private async handOver(delegation: Delegation, ferret: string): Promise<OpenedCard> {
    const held = delegation.held;
    if (held === undefined)
      throw new Error(`${formatCardRef({ id: delegation.id })} was not judged before it was handed over`);
    const card =
      delegation.byOwner === true
        ? await this.ports.board.assignForOwner(delegation.id, ferret, held)
        : await this.ports.board.handOver(delegation.id, delegation.lead, ferret, held);
    // The card is assigned: nothing after this may undo the start, so the board's name is best effort.
    const project = await this.ports.projects.nameOf(card.projectId).catch((error: unknown) => {
      this.ports.diagnostics.warn(`could not name the board of ${formatCardRef(card)}: ${said(error)}`);
      return undefined;
    });
    return {
      card: await this.workStarted(card, ferret),
      ...(project === undefined ? {} : { project }),
      notes: [],
    };
  }

  /**
   * A start IS the work starting (`work.started`), so the card enters the lane that trigger names for its
   * workflow (In progress, or Plan/Design for a plan-first card), whoever may move cards: a helper cannot,
   * and a card left in the backlog while it is built tells the owner nothing. Best effort, like the card.
   */
  private async workStarted(card: Card, ferret: string): Promise<Card> {
    try {
      const moved = await this.ports.board.trigger(card.id, 'work.started', {
        ferret,
        reason: 'the session started on it',
      });
      return moved === null ? card : moved.card;
    } catch (error) {
      this.ports.diagnostics.warn(`could not move ${formatCardRef(card)} to its working lane: ${said(error)}`);
      return card;
    }
  }

  /**
   * `fy signal done` on the board: the note and the move ({@link BoardService.signalDone}). Nothing is
   * typed into the lead's chat: the done message reaches it through `fy wait`, in the ferret's own words,
   * and the board shows the move. Never rejects: the signal is already recorded.
   */
  async signalled(ferret: string, message: string | undefined): Promise<SignalDoneOutcome | null> {
    let outcome: SignalDoneOutcome | null;
    try {
      outcome = await this.ports.board.signalDone(ferret, message);
    } catch (error) {
      this.ports.diagnostics.warn(`could not record ${ferret}'s done on its card: ${said(error)}`);
      return null;
    }
    return outcome;
  }

  /** The repository's board for a session on the Unfiled board; `null` when it stays where it is. */
  private async adopt(
    ferret: string,
    proposer: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly proposed: boolean } | null> {
    const adoption = this.ports.adoption;
    if (adoption === undefined) return null;
    if ((await this.ports.lanes.projectOf(ferret)) !== UNFILED_PROJECT_ID) return null;
    return await adoption.adopt(ferret, proposer).catch((error: unknown) => {
      this.ports.diagnostics.warn(`could not register the repository of ${ferret}: ${said(error)}`);
      return null;
    });
  }

  /**
   * The board a session's card goes on: its project's, with lanes proposed when the project has none, else
   * the Unfiled board with a note that says how to move it.
   */
  private async place(
    ferret: string,
    proposer: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly project: string; notes: string[] }> {
    const adopted = await this.adopt(ferret, proposer);
    if (adopted !== null) {
      const project = await this.ports.projects.nameOf(adopted.projectId);
      return {
        projectId: adopted.projectId,
        project,
        notes: [
          `${project} was registered as a project, so the card is on its board${adopted.proposed ? '; its lanes were proposed for the owner to confirm (an ask)' : ''}.`,
        ],
      };
    }
    const projectId = await this.ports.lanes.projectOf(ferret);
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
        notes: [`${project} had no lanes, so they were proposed for the owner to confirm (an ask).`],
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
