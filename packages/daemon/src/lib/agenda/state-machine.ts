import {
  AGENDA_SCHEMA_VERSION,
  AGENDA_URGENT_WAKE_MS,
  canCarryCardAsk,
  type AgendaAsk,
  type AgendaBrief,
  type AgendaCardAnswer,
  type AgendaCardRow,
  type AgendaClearableField,
  agendaItemRevision,
  type AgendaConfirms,
  type AgendaConversationEntry,
  AgendaConversationEntrySchema,
  type AgendaCopyPlanRef,
  type AgendaDisposition,
  type AgendaErrorCode,
  type AgendaCardAsk,
  type AgendaGate,
  type AgendaHistoryEntry,
  AgendaHistoryEntrySchema,
  type AgendaId,
  AgendaIdSchema,
  type AgendaInputRef,
  type AgendaItem,
  AgendaItemSchema,
  type AgendaKind,
  type AgendaPhoneApprovalRef,
  type AgendaRecipeProposalRef,
  type AgendaResponse,
  type AgendaResting,
  type AgendaRevisableField,
  type AgendaRevision,
  type AgendaSignInRuleSuggestionRef,
  type AgendaSnapshot,
  type AgendaSource,
  type AgendaStage,
  type AgendaTaskPlanRef,
  type AgendaTwoFactorSeedRef,
  type AgendaUndelivered,
  agendaBriefOf,
  agendaBriefRequiredProblems,
  agendaCardKind,
  applyAgendaTabEdits,
  type AgendaTabEdit,
  agendaEditShapeProblems,
  agendaFormProblems,
  agendaNoticeProblems,
  agendaOfferCloseProblems,
  agendaOptionDetailProblems,
  agendaReplyEnvelopeLength,
  agendaShape,
  agendaAnswerProblems,
  agendaShapeProblems,
  agendaStage,
  agendaStageOfKind,
  agendaState,
  agendaWakeAt,
  fitAgendaItem,
  formAnswerProblems,
  formatTaskRef,
  cardAgendaReference,
  cardAskReference,
  cardAskStage,
  hasOpenCardAsk,
  openCardAsks,
  parseCardAgendaReference,
  gateReference,
  MAX_AGENDA_PER_SESSION,
  MAX_AGENDA_CARDS,
  MAX_AGENDA_LINKS,
  MAX_AGENDA_REST_WHY_LENGTH,
  MAX_AGENDA_REPLY_ENVELOPE_LENGTH,
  MAX_AGENDA_REPLY_LENGTH,
  MAX_AGENDA_RESOLUTIONS,
  MAX_AGENDA_REVISIONS,
  MAX_AGENDA_STAGES,
  parseGateFollowupReference,
  parseGateReference,
  type ResolvedAgendaItem,
  ResolvedAgendaItemSchema,
  StoredAgendaItemSchema,
  StoredResolvedAgendaItemSchema,
  type TaskRef,
} from '@ferretry/protocol';
import { z } from 'zod';
import {
  type AgendaArchiveCursor,
  AgendaArchiveCursorSchema,
  type AgendaArchiveRecord,
  AgendaArchiveRecordSchema,
} from './archive.ts';
import {
  interleaved,
  loggedFromChat,
  mergedThreads,
  type RecordedItem,
  relinked,
  responseWords,
  resumedConversation,
  said,
  seedConversation,
  speakerOf,
  wordsOf,
} from './item-words.ts';
import {
  applyCardAsk,
  type CardAskOperation,
  closeRefusal,
  joinCardAsks,
  leaveCardAsks,
  restRefusal,
  sealCardAsks,
  withCardAsks,
  withoutCardAsks,
} from './card-asks.ts';

/** Agent-raised requests are capped separately so automatic sources retain board capacity. */
export const MAX_AGENT_AGENDA_PER_SESSION = 10;

/** Every cause the daemon raises an item for: ONE list, so the type and the ledger's parser cannot disagree. */
export const DAEMON_AGENDA_CAUSES = [
  'source-reconciliation',
  'warden-escalation',
  'system',
  'harness-prompt',
  'input-request',
  'secure-copy',
  'login-recipe',
  'phone-approval',
] as const;
export type DaemonAgendaCause = (typeof DAEMON_AGENDA_CAUSES)[number];
const isDaemonAgendaCause = (value: unknown): value is DaemonAgendaCause =>
  (DAEMON_AGENDA_CAUSES as readonly unknown[]).includes(value);

/**
 * Provenance is a tagged value, not a user-supplied collection of nullable fields. The daemon
 * cause deliberately distinguishes warden escalation from ordinary session Attention.
 */
export type AgendaActor =
  | { readonly kind: 'human' }
  | {
      readonly kind: 'agent';
      readonly sessionId: string;
      readonly name: string | null;
      /**
       * Set only by the agenda service, after it proved by lineage that this session started the session
       * whose board it is changing: the lead may then edit, surface, resolve or dismiss that board's items.
       */
      readonly overSubFerret?: true;
    }
  | { readonly kind: 'daemon'; readonly cause: DaemonAgendaCause };

/** Whether an agent actor is confined to the board or session it is trying to change. */
export function agentConfinedTo(actor: AgendaActor, sessionId: string): boolean {
  return actor.kind !== 'agent' || actor.sessionId === sessionId || actor.overSubFerret === true;
}

export type AgendaEntry =
  | { readonly lifecycle: 'active'; readonly origin: AgendaActor; readonly item: AgendaItem }
  | { readonly lifecycle: 'addressed'; readonly origin: AgendaActor; readonly item: ResolvedAgendaItem };

const ArchivedOwnerHistorySchema = z.array(z.strictObject({ id: AgendaIdSchema, entry: AgendaHistoryEntrySchema }));

/** Internal durable state. Active state and count are both derived from the entry lifecycle. */
export interface AgendaLedger {
  /** Bounded position in the private append-only sidecar. */
  readonly archive?: AgendaArchiveCursor;
  /** Transaction-local records. The repository appends these before committing and clears them from the hot file. */
  readonly archivePending?: readonly AgendaArchiveRecord[];
  readonly sessionId: string;
  readonly nextId: number;
  readonly entries: readonly AgendaEntry[];
  /** Full threads, outside the bounded current item, committed atomically with the ledger. Never sent in snapshots. */
  readonly conversations?: Readonly<Record<string, readonly AgendaConversationEntry[]>>;
  /** Original legacy entries whose bounded history/revisions had to move to make room for new metadata. */
  readonly carriedEntries?: Readonly<Record<string, AgendaEntry>>;
  readonly updatedAt: string;
  /**
   * The entries on disk that do not read as an item, exactly as they were read: kept so a write never drops
   * them, counted as the snapshot's `parseErrors`, and never handed to a transition. Absent when there are none.
   */
  readonly unreadable?: readonly unknown[];
  /**
   * The shape the file was written in: {@link AGENDA_LEDGER_VERSION} once this daemon read it; absent on a file an
   * older one wrote, which reads as 1 and is brought to the current shape as it is read ({@link toChannel}).
   */
  readonly version?: number;
}

/**
 * The ledger shape this daemon writes. 2 (docs/agenda.md § States): an item an owner's reply parked RESTS, saying
 * how (`resting`), and every item names its stage. 3 (§ The conversation): an item stores what is said on it
 * (`conversation`), seeded from its history as it is read. Version 4 moves full threads into the ledger-level
 * conversations map, leaving bounded recent tails in current items and wire snapshots. Card asks (docs/agenda.md
 * § Card asks) need no new shape marker: {@link liftGateItems} reads every ledger, of any version, into them.
 */
export const AGENDA_LEDGER_VERSION = 4;

/** The card an item is: what it is about, its kind and its answers by direction (all derived when absent). */
export interface AgendaCardFields {
  readonly title?: string;
  readonly kind?: AgendaKind;
  readonly answers?: AgendaCardAnswer[];
}

/** A raise carries the item's card and structured brief (the ask line is the `subject`) alongside its ask. */
export interface RaiseAgendaRequest extends AgendaBrief, AgendaCardFields {
  readonly source: AgendaSource;
  readonly sourceRef: string | null;
  readonly sourceSeq?: number;
  readonly subject: string;
  readonly why: string;
  readonly context?: string | null;
  readonly waitingSince?: string;
  readonly howToResolve: string;
  readonly ask?: AgendaAsk;
  /** A plain notification (`fy notify`): kind info, no ask, never a turn. */
  readonly notice?: true;
  /** The notice asks the phone to buzz; only a notice can. */
  readonly ping?: true;
  /**
   * The held configuration change the owner's answer acts on, resolved by the route from the config files
   * (never taken from the caller): the file, the held edit's digest and its words.
   */
  readonly confirms?: AgendaConfirms;
  /** The board card the item belongs to, kept on the item as sent (`DAEMON_FEATURES.agendaTask`). */
  readonly task?: TaskRef;
  /** The input request an `input` card presents (`AgendaInputRef`); only the daemon raises one. */
  readonly input?: AgendaInputRef;
  /** The paste plan a card presents (`AgendaCopyPlanRef`); only the daemon raises one. */
  readonly copyPlan?: AgendaCopyPlanRef;
  /** The task plan a card presents (`AgendaTaskPlanRef`); only the daemon raises one (an agenda add has no field for it). */
  readonly taskPlan?: AgendaTaskPlanRef;
  /** The ferret's standing-rule suggestion a card presents (`AgendaSignInRuleSuggestionRef`); only the daemon raises one. */
  readonly signInRuleSuggestion?: AgendaSignInRuleSuggestionRef;
  /** The staged 2FA seed a card asks the owner to save with a passkey (`AgendaTwoFactorSeedRef`); only the daemon raises one. */
  readonly twoFactorSeed?: AgendaTwoFactorSeedRef;
  /** The ferret's proposed sign-in recipe a card presents (`AgendaRecipeProposalRef`); only the daemon raises one. */
  readonly recipeProposal?: AgendaRecipeProposalRef;
  /** The approve-on-phone card an `info` item presents (`AgendaPhoneApprovalRef`); only the daemon raises one. */
  readonly phoneApproval?: AgendaPhoneApprovalRef;
  /** The board cards a machine notice lists, each with Open, Start and Close (`AgendaCardRow`); only the daemon raises them. */
  readonly cards?: readonly AgendaCardRow[];
  /** The owner's one tap may close `task` too (`DAEMON_FEATURES.agendaOfferClose`); needs a card. */
  readonly offerClose?: true;
  /** DEPRECATED: a standalone gate item (`AgendaGate`). No daemon raises one any more; kept for an item carried over. */
  readonly gate?: AgendaGate;
  /**
   * The card asks the new agenda carries (docs/agenda.md § Card asks): only the daemon raises one with any, when it
   * opens the agenda of a card that nobody's agenda carries yet. `gateAttached` mirrors the first open one.
   */
  readonly cardAsks?: readonly AgendaCardAsk[];
  /**
   * The item starts on the FERRET's turn, in discussion (`waitingFor: 'discussion'`), instead of the owner's: a
   * gate's follow-up conversation, which the owner opened by saying Not good. Only the daemon raises one so.
   */
  readonly discussion?: true;
  /**
   * The gate item this new one REPLACES on another ferret's agenda, because its card changed hands: the new item
   * goes on as that one stood (`AgendaCarried`). Only the daemon carries one (a gate item moved on a hand-over, an item moved to its agenda home).
   */
  readonly carried?: AgendaCarried;
  /** What the item needs from the owner now (`--stage`); its kind says when absent (`agendaStageOfKind`). */
  readonly stage?: AgendaStage;
}

/**
 * What a gate item moved to its card's new ferret keeps of the one it replaces (docs/board.md § Gates ask the
 * owner): when it began waiting, the owner's snooze, whose turn it is, and the conversation and edits so far.
 */
export type AgendaCarried = Pick<
  AgendaItem,
  | 'waitingSince'
  | 'parked'
  | 'waitingOn'
  | 'askedAt'
  | 'waitingFor'
  | 'infoRequests'
  | 'history'
  | 'revisions'
  | 'conversation'
  | 'urgentAt'
  | 'resting'
  | 'stage'
  | 'stages'
  | 'cardAsks'
  | 'gateAttached'
  | 'gateAttachedChangedAt'
>;

const CARRIED_FIELDS = [
  'waitingSince',
  'parked',
  'waitingOn',
  'askedAt',
  'waitingFor',
  'infoRequests',
  'history',
  'revisions',
  'conversation',
  'urgentAt',
  'resting',
  'stage',
  'stages',
  // An agenda carried to another ferret takes its card asks with it: they are the card's, not the ferret's.
  'cardAsks',
  'gateAttached',
  'gateAttachedChangedAt',
] as const satisfies readonly (keyof AgendaCarried)[];

/** The carried fields an item has, and only those: an absent one stays absent. */
const agendaCarriedOf = (item: AgendaCarried): AgendaCarried =>
  Object.fromEntries(
    CARRIED_FIELDS.flatMap(field => (item[field] === undefined ? [] : [[field, item[field]]])),
  ) as AgendaCarried;

/** One RESTING item a nudge is about: which rest (`since`) and how many nudges it had had when the Warden looked. */
export interface AgendaNudgeTarget {
  readonly id: AgendaId;
  readonly since: string;
  readonly nudges: number;
}

/**
 * What an edit may change: the writing, the stage, and — REPLACING the ask (`askReplaced`) — the ask, the kind, the
 * answers and the questions; never the reason or who raised the item.
 */
export interface EditAgendaPatch extends AgendaBrief {
  readonly subject?: string;
  readonly title?: string;
  readonly context?: string | null;
  readonly stage?: AgendaStage;
  readonly ask?: AgendaAsk;
  readonly kind?: AgendaKind;
  readonly answers?: AgendaCardAnswer[];
  /** The why line and the how-to-resolve line (`agenda.patch.1`): rewritten, never removed. */
  readonly why?: string;
  readonly howToResolve?: string;
  /** READ BEFORE WRITE (`agenda.patch.1`): the revision the writer read; refused `stale` once the item moved on. */
  readonly revision?: string;
  /** Agenda fields to take off the item (`--not-blocking`, `--clear-will-block`, `--clear-by`). */
  readonly clear?: readonly AgendaClearableField[];
  /** Tab operations (`agenda.tabs.1`), turned into the new `tabs` before the edit applies (`withTabEdits`). */
  readonly tabEdits?: readonly AgendaTabEdit[];
  /** The edit's tab operations removed every tab of the ferret's own: `tabs` is cleared. Set by `withTabEdits`. */
  readonly clearTabs?: true;
}

export type AgendaCommand =
  | {
      readonly action: 'raise';
      readonly actor: AgendaActor;
      readonly request: RaiseAgendaRequest;
      readonly at: string;
    }
  | {
      readonly action: 'answer';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly response: AgendaResponse;
      readonly note?: string | null;
      readonly receipt?: string;
      /** The ask the answer was given to (`AgendaItem.askVersion`); refused `ask_changed` once the ask moved on. */
      readonly askVersion?: number;
      readonly at: string;
    }
  | {
      readonly action: 'resolve';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      /** The ask this close was given from (a to-do's Done); refused `ask_changed` once the ask moved on. */
      readonly askVersion?: number;
      readonly at: string;
    }
  | {
      readonly action: 'dismiss';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      /** The ask this close was given from; refused `ask_changed` once the ask moved on. */
      readonly askVersion?: number;
      readonly at: string;
    }
  | {
      readonly action: 'edit';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly patch: EditAgendaPatch;
      /** The ferret says it is urgent: a SNOOZED item wakes (`backFromParked`), at most once an hour. */
      readonly now?: boolean;
      /** The ferret needs something NEW from the owner: an item the owner REPLIED to comes back to their list. */
      readonly back?: boolean;
      readonly at: string;
    }
  | {
      readonly action: 'progress';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly step: number;
      readonly done: boolean;
      readonly at: string;
    }
  | {
      readonly action: 'needs-info';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'discuss';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      /**
       * The owner's chat message named this open item (`[re !A5 «title»] …`): the item stays open but is PARKED
       * as `replied`, their words kept in its history. Nobody is pushed — the message itself is the delivery. The
       * ferret brings it back (`surface`, `edit`) if the owner still has to decide or do something, or closes it
       * (`done`). Only the owner replies.
       */
      readonly action: 'reply';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      /** The chat message the words came from, kept on the conversation entry; a message is logged on an item once. */
      readonly fromChat?: { readonly messageId: string; readonly at: string };
      readonly at: string;
    }
  | {
      /**
       * The ferret LOGS the owner's chat message on the item (`fy agenda log`, docs/agenda.md § The conversation): the
       * daemon copied `chat` verbatim from the session's own messages. The owner's words rest the item, as a reply
       * does; then the ferret's `words` either answer them (`reply`: the item returns to the owner, to its old place)
       * or say what it is doing (`rest`: the item rests as working).
       */
      readonly action: 'log';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly mode: 'reply' | 'rest';
      readonly words: string;
      readonly chat: { readonly messageId: string; readonly at: string; readonly text: string };
      readonly at: string;
    }
  | {
      /** `from` is merged into `id` (`fy agenda merge`): one conversation, every card and link kept, `from` closed. */
      readonly action: 'merge';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly from: AgendaId;
      readonly at: string;
    }
  | {
      /** A new item is split off `id` (`fy agenda split`), linked both ways; `moveCards` go along with it. */
      readonly action: 'split';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly request: RaiseAgendaRequest;
      readonly moveCards?: readonly TaskRef[];
      readonly at: string;
    }
  | {
      /** An item leaves discussion for the owner's queue; `why` is the one line kept in its history. */
      readonly action: 'surface';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly why?: string | null;
      /** The ferret says it is urgent: a SNOOZED item wakes (`backFromParked`), at most once an hour. */
      readonly now?: boolean;
      readonly at: string;
    }
  | {
      /**
       * The raising ferret takes an item on without asking anything yet (docs/agenda.md § States): it RESTS as
       * `working`, quiet and never nudged, `why` saying what it is doing.
       */
      readonly action: 'rest';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly why: string;
      readonly at: string;
    }
  | {
      /**
       * The Warden decided to nudge the ferret about these RESTING items with one message, `sendId`: each records it
       * BEFORE the send, so a restart resumes that very message. Each names the rest it saw (`since`, `nudges`); one
       * that has moved on is left alone. Daemon-only.
       */
      readonly action: 'nudging';
      readonly actor: AgendaActor;
      readonly items: readonly AgendaNudgeTarget[];
      readonly sendId: string;
      readonly at: string;
    }
  | {
      /**
       * The Warden nudged the ferret about this RESTING item (`rest-nudge.ts`): its nudge record moves on. It names the
       * rest it nudged for (`since`, `nudges`): a delivery that finishes after the owner replied again, or the ferret
       * answered, records nothing on the newer rest. Daemon-only.
       */
      readonly action: 'nudged';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly since: string;
      readonly nudges: number;
      readonly at: string;
    }
  | {
      /** The owner puts an open item away `until` a time still ahead (docs/agenda.md § Parked items). */
      readonly action: 'snooze';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly until: string;
      readonly at: string;
    }
  | {
      /** The owner brings a parked item (snoozed, or replied to) back to their queue now. */
      readonly action: 'unsnooze';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly at: string;
    }
  | {
      /** The daemon's timer: a snoozed item whose time (`agendaWakeAt`) has come is back, fresh and unread. */
      readonly action: 'wake';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly at: string;
    }
  | {
      /**
       * The owner's action on an agent-raised item never reached the ferret (docs/agenda.md § Delivery):
       * the item is open again, as a card, with what the owner did kept for a retry. `request` names the
       * request for more information or to discuss it that was not delivered; absent for an answer.
       */
      readonly action: 'undelivered';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly request?: number;
      readonly reason: string;
      readonly at: string;
    }
  | {
      /**
       * The held configuration change an item confirms moved on after it was raised (docs/agenda.md §
       * Confirming a configuration change): the item now names the new one, marked restated, and is the
       * owner's turn again. Daemon-only: the config files are the one witness.
       */
      readonly action: 'restate-confirms';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly confirms: AgendaConfirms;
      /** The card's premise for the new change: its words, as the raise wrote them. */
      readonly premise: string;
      readonly at: string;
    }
  | {
      /**
       * A card ask on this agenda (docs/agenda.md § Card asks): put on it, restated, withdrawn, or the owner's answer to
       * it recorded (`CardAskOperation`). Daemon-only: the card's lane is the witness, and the gate engine moved the
       * card before it records an answer.
       */
      readonly action: 'card-ask';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly operation: CardAskOperation;
      readonly at: string;
    }
  | {
      /**
       * An open thread is linked to the card made to carry it out (docs/board.md § Thread cards link, they do not
       * hide): its `task` becomes that card. Daemon-only; refused for a thread already linked to another card, a gate
       * item and a notice.
       */
      readonly action: 'link-task';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly task: TaskRef;
      readonly at: string;
    }
  | {
      readonly action: 'resolve-source';
      readonly actor: AgendaActor;
      readonly source: AgendaSource;
      readonly sourceRef: string;
      readonly note?: string | null;
      readonly at: string;
    };

export interface AgendaFailure {
  readonly code: AgendaErrorCode;
  readonly message: string;
}

export type AgendaChange =
  | 'created'
  | 'refreshed'
  | 'progressed'
  | 'needs-info'
  | 'discussing'
  | 'replied'
  | 'surfaced'
  | 'info-added'
  | 'reopened'
  | 'parked'
  | 'unparked'
  | 'woke'
  | 'rested'
  | 'nudged'
  | 'answered'
  | 'logged'
  | 'merged'
  | 'split'
  | 'resolved'
  | 'dismissed'
  | 'unchanged';

export type AgendaMutation =
  | { readonly ok: false; readonly error: AgendaFailure }
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly change: AgendaChange;
      readonly ledger: AgendaLedger;
      readonly snapshot: AgendaSnapshot;
      /** The item on every change that leaves it open; absent for the ones that close it. */
      readonly item?: AgendaItem;
      /**
       * The item as it was closed, on resolved and dismissed mutations and on an answer that closed it; absent
       * otherwise. An answer that RESTS a ferret's item (`restsOnAnswer`) is `answered` with the open `item` instead.
       */
      readonly addressed?: ResolvedAgendaItem;
      /** What the daemon changed about the request the caller should be told, as the route prints it. */
      readonly notes?: readonly string[];
    };

export function emptyAgendaLedger(sessionId: string, at: string): AgendaLedger {
  return { sessionId, nextId: 1, entries: [], updatedAt: at, version: AGENDA_LEDGER_VERSION };
}

export function isActiveAgenda(entry: AgendaEntry): entry is Extract<AgendaEntry, { lifecycle: 'active' }> {
  return entry.lifecycle === 'active';
}

export function isWardenEscalationAgenda(entry: AgendaEntry): boolean {
  return entry.origin.kind === 'daemon' && entry.origin.cause === 'warden-escalation';
}

/** A card gate the daemon raised (`AgendaItem.gate`): only the owner answers or closes it, never a ferret or its lead. */
export function isGateAgenda(entry: Pick<AgendaEntry, 'item'>): boolean {
  return isGateItem(entry.item);
}

/** The gate items' own producer: the daemon's `task` source, carrying the `gate` it asks about. */
function isGateItem(item: Pick<AgendaItem, 'gate' | 'source'>): boolean {
  return item.gate !== undefined && item.source === 'task';
}

/** A gate follow-up as its item says: the gate producer's `task` source, raised by the daemon, under its reference. */
export function isGateFollowupItem(item: Pick<AgendaItem, 'raisedBy' | 'source' | 'sourceRef'>): boolean {
  return (
    item.raisedBy === 'daemon' && item.source === 'task' && parseGateFollowupReference(item.sourceRef) !== undefined
  );
}

/**
 * The agenda the daemon opened for a card nobody's agenda carried (`card-agenda:`, docs/agenda.md § Card asks): like a
 * follow-up, raised ON BEHALF of the card's ferret, which works and closes it as its own.
 */
export function isCardAgendaItem(item: Pick<AgendaItem, 'raisedBy' | 'source' | 'sourceRef'>): boolean {
  return item.raisedBy === 'daemon' && item.source === 'task' && parseCardAgendaReference(item.sourceRef) !== undefined;
}

/** An item the daemon raised on behalf of the ferret whose board holds it: a gate's follow-up, or a card's agenda. */
export function isOnBehalfItem(item: Pick<AgendaItem, 'raisedBy' | 'source' | 'sourceRef'>): boolean {
  return isGateFollowupItem(item) || isCardAgendaItem(item);
}

/** {@link isOnBehalfItem}, of an entry the daemon raised. */
export function isOnBehalfAgenda(entry: Pick<AgendaEntry, 'origin' | 'item'>): boolean {
  return entry.origin.kind === 'daemon' && isOnBehalfItem(entry.item);
}

export function canDismissAgenda(actor: AgendaActor, entry: AgendaEntry): boolean {
  if (actor.kind === 'human') return true;
  if (actor.kind === 'agent') {
    // A gate is the owner's: no ferret, lead or ancestor answers, closes or rewords one (docs/board.md § Gates).
    if (isGateAgenda(entry)) return false;
    // Confined to its own board (or a sub-ferret's) by `agentConfinedTo` before it gets here.
    if (isOnBehalfAgenda(entry)) return true;
    if (actor.overSubFerret === true) return !isWardenEscalationAgenda(entry);
    return entry.origin.kind === 'agent' && entry.origin.sessionId === actor.sessionId;
  }
  return entry.origin.kind === 'daemon';
}

export function agendaSnapshot(ledger: AgendaLedger): AgendaSnapshot {
  const items = ledger.entries
    .filter(isActiveAgenda)
    .map(entry => entry.item)
    .sort(compareActive);
  const resolved = ledger.entries
    .filter((entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> => !isActiveAgenda(entry))
    .map(entry => entry.item)
    .sort(compareAddressed);

  return {
    v: AGENDA_SCHEMA_VERSION,
    sessionId: ledger.sessionId,
    items,
    resolved,
    // EVERY open item, parked ones included: the wire's contract (and every older client's check) is
    // count === items.length. A badge leaves parked items out itself (`agendaBadgeCount`).
    count: items.length,
    parseErrors: ledger.unreadable?.length ?? 0,
    updatedAt: ledger.updatedAt,
  };
}

export function applyAgendaCommand(current: AgendaLedger, command: AgendaCommand): AgendaMutation {
  return applyToLedger(current, command);
}

/** Apply a command for a known board without making the session id part of every command. */
export function applyAgendaCommandToSession(
  current: AgendaLedger | null,
  sessionId: string,
  command: AgendaCommand,
): AgendaMutation {
  return applyToLedger(current ?? emptyAgendaLedger(sessionId, command.at), command);
}

/**
 * Decodes the internal durable form before an adapter supplies it to the state
 * machine. Keeping this validation in the pure layer prevents corrupt storage
 * from being silently replaced by a fresh board.
 */
export function parseAgendaLedger(
  value: unknown,
  sessionId: string,
  archived: readonly AgendaArchiveRecord[] = [],
  recorded?: Readonly<Record<string, RecordedItem>>,
): AgendaLedger | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.sessionId !== sessionId ||
    !Number.isSafeInteger(raw.nextId) ||
    (raw.nextId as number) < 1 ||
    typeof raw.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.updatedAt)) ||
    !Array.isArray(raw.entries)
  ) {
    return null;
  }
  const threads = z.record(AgendaIdSchema, z.array(AgendaConversationEntrySchema)).safeParse(raw.conversations ?? {});
  if (!threads.success) return null;
  const carriedEntries: Record<string, AgendaEntry> = {};
  if (raw.carriedEntries !== undefined) {
    if (raw.carriedEntries === null || typeof raw.carriedEntries !== 'object' || Array.isArray(raw.carriedEntries))
      return null;
    for (const [id, value] of Object.entries(raw.carriedEntries)) {
      const entry = parseAgendaEntry(value, false, []);
      if (entry === null || entry.item.id !== id) return null;
      carriedEntries[id] = entry;
    }
  }
  const entries: AgendaEntry[] = [];
  const archive = ArchivedOwnerHistorySchema.safeParse(raw.ownerHistory ?? []);
  if (!archive.success) return null;
  const pending = z.array(AgendaArchiveRecordSchema).safeParse(raw.archivePending ?? []);
  const cursor = AgendaArchiveCursorSchema.optional().safeParse(raw.archive);
  if (!pending.success || !cursor.success) return null;
  const archivePending: AgendaArchiveRecord[] = [
    ...pending.data,
    ...archive.data.map(record => ({ kind: 'owner-history' as const, ...record })),
  ];
  const legacy = raw.version === undefined || raw.version === 1;
  const unreadable: unknown[] = [];
  const ids = new Set<string>();
  let maxId = 0;
  let active = 0;
  let agentActive = 0;
  let addressed = 0;
  // ONE BAD ENTRY IS ONE BAD ENTRY: it is set aside (and written back as it was) while the rest of the board
  // reads. A board that refused to read over one item hid every other item on it, and the Inbox could only say
  // "Couldn't read" for all of them. It still counts as what it was (`setAsideOf`): its id is never reused and
  // it holds its place under the caps, so the board stays one that reads whole should the entry read again.
  for (const rawEntry of raw.entries) {
    const entry = parseAgendaEntry(rawEntry, legacy, archivePending);
    if (entry === null) {
      unreadable.push(rawEntry);
      continue;
    }
    if (ids.has(entry.item.id)) return null;
    ids.add(entry.item.id);
    maxId = Math.max(maxId, idNumber(entry.item.id));
    if (entry.lifecycle === 'active') {
      active += 1;
      if (entry.origin.kind === 'agent') agentActive += 1;
    } else {
      addressed += 1;
    }
    entries.push(entry);
  }
  const aside = setAsideOf(unreadable);
  if (
    (raw.nextId as number) <= Math.max(maxId, ...aside.ids) ||
    aside.ids.some(id => ids.has(`A${id}`)) ||
    active + aside.active > MAX_AGENDA_PER_SESSION ||
    agentActive + aside.agentActive > MAX_AGENT_AGENDA_PER_SESSION ||
    addressed + aside.addressed > MAX_AGENDA_RESOLUTIONS
  ) {
    return null;
  }
  const parked = parkOwnerReplies({
    sessionId,
    nextId: raw.nextId as number,
    entries,
    ...(Object.keys(threads.data).length === 0 ? {} : { conversations: threads.data }),
    ...(Object.keys(carriedEntries).length === 0 ? {} : { carriedEntries }),
    updatedAt: raw.updatedAt,
    ...(cursor.data === undefined ? {} : { archive: cursor.data }),
    ...(archivePending.length === 0 ? {} : { archivePending }),
    ...(unreadable.length === 0 ? {} : { unreadable }),
  });
  return liftedOnRead(toChannel(parked, legacy, archived, recorded));
}

/**
 * THE MIGRATION TO THE AGENDA AS A CHANNEL (docs/agenda.md § States), read-time, so no file is rewritten until a
 * transition writes it: every item still reads, and nothing on it is dropped.
 *
 * - An open item PARKED as `replied` with no `resting` rests as `waiting-on-ferret`, its reply time its nudge clock.
 *   One from a file an older daemon wrote (`legacy`) is marked `migrated`: the Warden nudges it once after the
 *   upgrade, never again, so a board of old replies is not a burst of nudges. One without it here is an item a
 *   path parked without saying how; it rests the same way, unmarked.
 * - An item that names no stage gets the one its kind says (`done` once it is closed), as the first of its stages.
 * - The ledger is marked {@link AGENDA_LEDGER_VERSION}.
 * - An item with no stored conversation gets one, seeded from the words its history, answers and closing note kept
 *   ({@link seedConversation}); nothing is dropped, and an item that has one is left as it is. An item with a
 *   `recorded` version (a board an older daemon wrote after this one kept it) starts from that version's whole thread
 *   and its merge and split links, and adds only the words said since ({@link resumedConversation}).
 * - What the fit to the transport bound shed from an item's history of the owner's words goes to `archivePending`.
 *
 * Pure, total and idempotent: a ledger already in this shape comes back as it came, the same object.
 */
export function toChannel(
  ledger: AgendaLedger,
  legacy: boolean,
  archived: readonly AgendaArchiveRecord[] = [],
  recorded?: Readonly<Record<string, RecordedItem>>,
): AgendaLedger {
  let moved = ledger.version !== AGENDA_LEDGER_VERSION;
  const conversations = { ...(ledger.conversations ?? {}) };
  const carriedEntries = { ...(ledger.carriedEntries ?? {}) };
  const shed: AgendaArchiveRecord[] = [];
  const entries = ledger.entries.map(entry => {
    const history = [
      ...[...archived, ...(ledger.archivePending ?? [])]
        .filter(
          (record): record is Extract<AgendaArchiveRecord, { kind: 'owner-history' }> =>
            record.kind === 'owner-history' && record.id === entry.item.id,
        )
        .map(record => record.entry),
      ...(entry.item.history ?? []),
    ];
    const stored = conversations[entry.item.id] ?? entry.item.conversation;
    const version = recorded?.[entry.item.id];
    const seed = (): AgendaConversationEntry[] => {
      const seeded = seedConversation({ ...entry.item, history });
      return version === undefined ? seeded : resumedConversation(version, seeded);
    };
    const previous = stored ?? seed();
    const full = interleaved(previous, undefined);
    if (full.some((word, index) => word !== previous[index])) moved = true;
    conversations[entry.item.id] = full;
    const normalized = channelItem(version === undefined ? entry.item : relinked(entry.item, version), legacy);
    const item = fitAgendaItem(boundedConversation(normalized, full));
    (entry.lifecycle === 'active' ? AgendaItemSchema : ResolvedAgendaItemSchema).parse(item);
    shed.push(...shedOwnerHistory(entry.item, item));
    if (
      item.history !== normalized.history ||
      item.revisions !== normalized.revisions ||
      (entry.item.stages !== undefined && normalized.stages !== entry.item.stages)
    ) {
      carriedEntries[entry.item.id] ??= entry;
    }
    if (item === entry.item) return entry;
    moved = true;
    return { ...entry, item } as AgendaEntry;
  });
  return moved
    ? {
        ...ledger,
        entries,
        ...(Object.keys(conversations).length === 0 ? {} : { conversations }),
        ...(Object.keys(carriedEntries).length === 0 ? {} : { carriedEntries }),
        ...(shed.length === 0 ? {} : { archivePending: [...(ledger.archivePending ?? []), ...shed] }),
        version: AGENDA_LEDGER_VERSION,
      }
    : ledger;
}

/** The owner's words in history entries that `fitted` shed from `before` (they are kept in the sidecar, as the fit does). */
function shedOwnerHistory(before: AgendaItem | ResolvedAgendaItem, after: AgendaItem | ResolvedAgendaItem) {
  const kept = (after.history ?? []).map(record => JSON.stringify(record));
  const shed: AgendaArchiveRecord[] = [];
  for (const record of before.history ?? []) {
    const index = kept.indexOf(JSON.stringify(record));
    if (index >= 0) kept.splice(index, 1);
    else if (['replied', 'needs-info', 'discuss'].includes(record.kind))
      shed.push({ kind: 'owner-history', id: before.id, entry: record });
  }
  return shed;
}

/** A bounded recent tail; complete entries only. The durable thread is held separately. */
function boundedConversation<Item extends AgendaItem | ResolvedAgendaItem>(
  item: Item,
  full: readonly AgendaConversationEntry[],
): Item {
  const tail: AgendaConversationEntry[] = [];
  let size = 0;
  for (const entry of [...full].reverse()) {
    size += JSON.stringify(entry).length;
    if (size > 8192) break;
    tail.unshift(entry);
  }
  const { conversation: _conversation, conversationCount: _count, conversationLastAt: _last, ...rest } = item;
  const next = {
    ...rest,
    ...(tail.length === 0 ? {} : { conversation: tail }),
    conversationCount: full.length,
    ...(full.at(-1) === undefined ? {} : { conversationLastAt: full.at(-1)?.at }),
  } as Item;
  return JSON.stringify(next) === JSON.stringify(item) ? item : next;
}

/** Internal reopen boundary: validate the current item without putting the full thread on the wire. */
function parseTransitionItem(item: AgendaItem) {
  const parsed = AgendaItemSchema.safeParse(fitAgendaItem(boundedConversation(item, item.conversation ?? [])));
  return parsed.success
    ? {
        ...parsed,
        data: { ...parsed.data, ...(item.conversation === undefined ? {} : { conversation: item.conversation }) },
      }
    : parsed;
}

/** One item in the channel's shape: resting as its park says, and naming its stage; the same item when it already is. */
function channelItem<Item extends AgendaItem | ResolvedAgendaItem>(item: Item, legacy: boolean): Item {
  const closed = 'resolvedAt' in item && typeof item.resolvedAt === 'string';
  const rests = !closed && item.parked?.reason === 'replied' && item.resting === undefined;
  const staged = item.stage === undefined;
  if (!rests && !staged) return item;
  const stage = agendaStage(item);
  const since = closed ? (item as ResolvedAgendaItem).resolvedAt : item.waitingSince;
  return {
    ...item,
    ...(rests && item.parked !== undefined
      ? {
          resting: {
            sub: 'waiting-on-ferret',
            at: item.parked.at,
            ...(legacy ? { migrated: true as const } : {}),
          } satisfies AgendaResting,
        }
      : {}),
    ...(staged ? { stage, stages: [...(item.stages ?? []), { stage, at: since }].slice(-MAX_AGENDA_STAGES) } : {}),
  };
}

/** What a card's agenda asks of its own, beside its card asks: a reply, if the owner wants to talk it over. */
export const CARD_AGENDA_HOW_TO_RESOLVE =
  "Answer the card's ask here (its buttons move the card); reply to talk it over. The ferret marks this done.";

const MIGRATION_ACTOR: AgendaActor = { kind: 'daemon', cause: 'system' };

/** A gate item's gate as the card ask it becomes: open, put on the agenda when the gate item was raised. */
const liftedAsk = (item: AgendaItem, gate: AgendaGate): AgendaCardAsk => {
  const notYet = (item.history ?? []).findLast(
    entry => entry.kind === 'gate-answered' && entry.note === gateReference(gate),
  );
  return {
    gate,
    at: item.waitingSince,
    ...(item.gate !== undefined && item.body !== undefined && item.body.trim() !== '' ? { howToTest: item.body } : {}),
    ...(notYet === undefined ? {} : { notYet: { at: notYet.at } }),
  };
};

/** The item as it reads, or `undefined` when the lifted shape would not read back (it is then left as it was). */
const readable = (item: AgendaItem): AgendaItem | undefined => {
  const parsed = AgendaItemSchema.safeParse(item);
  return parsed.success ? parsed.data : undefined;
};

/**
 * An open gate item as its card's agenda (docs/agenda.md § Card asks): the same id, history, snooze and turn, raised
 * on its ferret's behalf (`card-agenda:<card>`), its gate now its card ask, asking nothing of its own but a reply.
 */
const cardAgendaOf = (item: AgendaItem & { readonly gate: AgendaGate }, at: string): AgendaItem => {
  const { gate, ask: _ask, answers: _answers, kind: _kind, ...rest } = item;
  const stage = cardAskStage(gate);
  const base: AgendaItem = {
    ...rest,
    sourceRef: cardAgendaReference(gate.cardId),
    kind: 'reply',
    ask: { kind: 'open-question' },
    howToResolve: CARD_AGENDA_HOW_TO_RESOLVE,
    ...staged({ ...rest, kind: 'reply', ask: { kind: 'open-question' } }, stage, at),
  };
  return withCardAsks(base, [liftedAsk(item, gate)]);
};

/** Whether an open item is a thread about this card: an agent's own item on it, never a notice or a gate item. */
const isCardThread = (item: AgendaItem, cardId: string): boolean =>
  item.raisedBy === 'agent' && canCarryCardAsk(item) && item.task?.id === cardId;

/** The thread that takes a card's ask: one already carrying it, else one on the owner's turn, else the newest. */
const threadFor = (entries: readonly AgendaEntry[], cardId: string): AgendaItem | undefined => {
  const threads = entries
    .filter(isActiveAgenda)
    .flatMap(entry => (isCardThread(entry.item, cardId) ? [entry.item] : []));
  const newest = (pool: readonly AgendaItem[]): AgendaItem | undefined =>
    pool.reduce<AgendaItem | undefined>(
      (kept, each) =>
        kept === undefined || Date.parse(each.waitingSince) > Date.parse(kept.waitingSince) ? each : kept,
      undefined,
    );
  return (
    newest(threads.filter(each => (each.cardAsks ?? []).some(ask => ask.gate.cardId === cardId))) ??
    newest(threads.filter(each => each.waitingOn === undefined && each.parked === undefined)) ??
    newest(threads)
  );
};

/**
 * The thread with a gate item's ask added: when the gate item was in the owner's queue and the thread was not, the
 * thread takes its place there (`waitingSince`), so moving the ask never takes it out of the owner's sight.
 */
const threadWithAsk = (thread: AgendaItem, gateItem: AgendaItem & { readonly gate: AgendaGate }): AgendaItem => {
  const ask = liftedAsk(gateItem, gateItem.gate);
  const asks = thread.cardAsks ?? [];
  const carried = asks.some(each => cardAskReference(each) === cardAskReference(ask)) ? asks : [...asks, ask];
  const shown = agendaState(gateItem).state === 'needs-you' && agendaState(thread).state !== 'needs-you';
  if (!shown) return withCardAsks(thread, carried);
  const {
    parked: _parked,
    resting: _resting,
    waitingOn: _waitingOn,
    askedAt: _askedAt,
    waitingFor: _waitingFor,
    ...awake
  } = thread;
  return withCardAsks({ ...awake, waitingSince: gateItem.waitingSince }, carried);
};

const withItem = (ledger: AgendaLedger, item: AgendaItem): AgendaLedger => ({
  ...ledger,
  entries: ledger.entries.map(entry =>
    entry.lifecycle === 'active' && entry.item.id === item.id ? { ...entry, item } : entry,
  ),
});

/**
 * THE MIGRATION TO CARD ASKS (docs/agenda.md § Card asks), read-time like {@link toChannel}: a card never asks the
 * owner itself any more, so no open standalone gate item is left on a board, and nothing on one is lost.
 *
 * - A thread with a bare `gateAttached` (no `cardAsks`) carries that gate as its open card ask; a `gate-answered`
 *   entry for it in its history (the owner's Not yet) is kept as the ask's `notYet`.
 * - An open gate item whose card has an open thread on this board (an agent's own item about the card) puts its ask
 *   on that thread and closes, saying where its ask went, so the card has ONE agenda here. The thread takes the gate
 *   item's place in the owner's queue when only the gate item was in it. The closed item keeps its history.
 * - Any other open gate item BECOMES its card's agenda in place: the same id, history, snooze and turn, its gate now
 *   its card ask, asking nothing of its own but a reply, at stage `test` or `plan`, raised on its ferret's behalf.
 *   A second open gate item of the same card adds its ask to that agenda and closes the same way.
 * - Closed items are left exactly as they are: an answered gate keeps its receipt, so a replay still finds it.
 * - An item whose lifted shape would not read back is left as it was.
 *
 * Pure, total and idempotent: a board with no open gate item and no bare `gateAttached` comes back as it came.
 */
export function liftGateItems(ledger: AgendaLedger): AgendaLedger {
  const at = ledger.updatedAt;
  let current = ledger;
  for (const entry of ledger.entries.filter(isActiveAgenda)) {
    const gate = entry.item.gateAttached;
    if (gate === undefined || entry.item.cardAsks !== undefined || isGateItem(entry.item)) continue;
    const lifted = readable(
      withCardAsks(entry.item, [{ ...liftedAsk(entry.item, gate), at: entry.item.waitingSince }]),
    );
    if (lifted !== undefined) current = withItem(current, lifted);
  }
  const gateItems = current.entries
    .filter(isActiveAgenda)
    .flatMap(entry =>
      isGateItem(entry.item) && entry.item.gate !== undefined
        ? [entry.item as AgendaItem & { readonly gate: AgendaGate }]
        : [],
    )
    .sort((left, right) => Date.parse(right.waitingSince) - Date.parse(left.waitingSince));
  for (const cardId of new Set(gateItems.map(item => item.gate.cardId))) {
    const ofCard = gateItems.filter(item => item.gate.cardId === cardId);
    let carrier = threadFor(current.entries, cardId);
    let closing = ofCard;
    if (carrier === undefined) {
      const [newest, ...older] = ofCard;
      const converted = newest === undefined ? undefined : readable(cardAgendaOf(newest, at));
      if (converted === undefined) continue;
      current = withItem(current, converted);
      carrier = converted;
      closing = older;
    }
    for (const gateItem of closing) {
      const carrying = current.entries.find(
        (entry): entry is Extract<AgendaEntry, { lifecycle: 'active' }> =>
          entry.lifecycle === 'active' && entry.item.id === carrier?.id,
      );
      const target = current.entries.find(
        (entry): entry is Extract<AgendaEntry, { lifecycle: 'active' }> =>
          entry.lifecycle === 'active' && entry.item.id === gateItem.id,
      );
      if (carrying === undefined || target === undefined) continue;
      const taken = readable(threadWithAsk(carrying.item, gateItem));
      if (taken === undefined) continue;
      const closed = addressed(
        withItem(current, taken),
        target,
        MIGRATION_ACTOR,
        `its card's ask is now on !${taken.id}`,
        at,
        'done',
        'resolved',
      );
      if (closed.ok) current = { ...closed.ledger, updatedAt: ledger.updatedAt };
    }
  }
  return current;
}

const isWardenActor = (actor: AgendaActor): boolean => actor.kind === 'daemon' && actor.cause === 'warden-escalation';

/** `text` cut at a word to at most `limit` characters, ending in an ellipsis; its line breaks are kept. */
function fitText(text: string, limit: number): string {
  const room = text.slice(0, limit - 1);
  const space = room.search(/\s\S*$/u);
  const cut = space >= Math.floor(limit / 2) ? room.slice(0, space) : room;
  return `${cut.trimEnd()}…`;
}

/** What the entries a ledger set aside still claim: their ids, their places under the caps, and their sources. */
interface SetAside {
  readonly ids: readonly number[];
  readonly active: number;
  readonly agentActive: number;
  /** Everything not plainly open counts as closed history: an entry too damaged to say is never an open item. */
  readonly addressed: number;
  readonly refs: readonly { readonly open: boolean; readonly source: unknown; readonly sourceRef: unknown }[];
}

const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;

function setAsideOf(unreadable: readonly unknown[] | undefined): SetAside {
  const entries = unreadable ?? [];
  const open = entries.filter(entry => field(entry, 'lifecycle') === 'active');
  return {
    ids: entries.flatMap(entry => {
      const id = field(field(entry, 'item'), 'id');
      return typeof id === 'string' && /^A[1-9]\d*$/u.test(id) ? [Number(id.slice(1))] : [];
    }),
    active: open.length,
    agentActive: open.filter(entry => field(field(entry, 'origin'), 'kind') === 'agent').length,
    addressed: entries.length - open.length,
    refs: entries.map(entry => ({
      open: field(entry, 'lifecycle') === 'active',
      source: field(field(entry, 'item'), 'source'),
      sourceRef: field(field(entry, 'item'), 'sourceRef'),
    })),
  };
}

/**
 * The ledger as the file holds it: the entries that read, then the ones that did not, as they were read.
 * Every writer of `agenda.json` goes through here, so a write never loses an entry it could not read.
 */
export function agendaLedgerDocument(ledger: AgendaLedger): string {
  const { unreadable, ...document } = ledger;
  const whole = unreadable === undefined ? document : { ...document, entries: [...document.entries, ...unreadable] };
  return `${JSON.stringify(whole, null, 2)}\n`;
}

/** Whether an open item sits on the ferret's turn only because the owner wrote about it (not asked for more or to discuss). */
function waitsOnOwnerReply(item: AgendaItem): boolean {
  return (
    item.waitingOn === 'ferret' &&
    item.waitingFor === 'discussion' &&
    item.notice !== true &&
    item.askedAt !== undefined &&
    Date.parse(item.askedAt) > Date.parse(item.waitingSince) &&
    !(item.history ?? []).some(entry => entry.kind === 'discuss' && entry.at === item.askedAt)
  );
}

/**
 * THE MIGRATION (docs/agenda.md § Parked items): a reply PARKS an item, so a board an earlier daemon wrote is
 * brought to that shape the moment it is read —
 *
 * - an item left on the ferret's turn after an owner reply (before replies closed items) is parked as
 *   `replied` at the reply;
 * - an item CLOSED as `replied` (while replies closed items) is open again, parked as `replied` at its close —
 *   newest first, and only while the board has room (`MAX_AGENDA_PER_SESSION`, and the agent cap for a
 *   ferret's item). The rest stay closed; the ferret's `surface` or `edit` still brings one back.
 *
 * Pure and idempotent: the next write persists it, and a board with nothing to move is returned as it came.
 */
export function parkOwnerReplies(ledger: AgendaLedger): AgendaLedger {
  const closed = ledger.entries
    .filter(
      (entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> =>
        entry.lifecycle === 'addressed' && entry.item.disposition === 'replied',
    )
    .sort((left, right) => compareAddressed(left.item as ResolvedAgendaItem, right.item as ResolvedAgendaItem));
  const waiting = ledger.entries.some(entry => entry.lifecycle === 'active' && waitsOnOwnerReply(entry.item));
  if (!waiting && closed.length === 0) return ledger;
  const active: AgendaEntry[] = ledger.entries
    .filter(isActiveAgenda)
    .map(entry =>
      entry.item.askedAt !== undefined && waitsOnOwnerReply(entry.item)
        ? { ...entry, item: parkedReply(entry.item, entry.item.askedAt) }
        : entry,
    );
  const aside = setAsideOf(ledger.unreadable);
  let agents = active.filter(entry => entry.origin.kind === 'agent').length + aside.agentActive;
  const reopened: AgendaEntry[] = [];
  for (const entry of closed) {
    const room =
      active.length + aside.active + reopened.length < MAX_AGENDA_PER_SESSION &&
      (entry.origin.kind !== 'agent' || agents < MAX_AGENT_AGENDA_PER_SESSION);
    const item = room ? reopenedReply(entry.item as ResolvedAgendaItem) : null;
    if (item === null) continue;
    reopened.push({ lifecycle: 'active', origin: entry.origin, item });
    if (entry.origin.kind === 'agent') agents += 1;
  }
  const back = new Set(reopened.map(entry => entry.item.id));
  const addressedLeft = ledger.entries.filter(entry => entry.lifecycle === 'addressed' && !back.has(entry.item.id));
  return { ...ledger, entries: [...active, ...reopened, ...addressedLeft] };
}

/** An open item the owner replied to, parked as `replied` at `at`: out of any wait, with the reply in its history. */
function parkedReply(item: AgendaItem, at: string): AgendaItem {
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, undelivered: _u, ...open } = item;
  return {
    ...open,
    parked: { reason: 'replied', at },
    history: withHistory(open.history, { at, kind: 'replied' }),
  };
}

/** A closed `replied` item open again and parked as `replied` at its close; `null` when it no longer reads as an item. */
function reopenedReply(closed: ResolvedAgendaItem): AgendaItem | null {
  const {
    resolvedAt,
    resolutionNote: _resolutionNote,
    response: _response,
    disposition: _disposition,
    resolvedBy: _resolvedBy,
    resolvedBySession: _resolvedBySession,
    resolvedByName: _resolvedByName,
    ...rest
  } = closed;
  const parsed = AgendaItemSchema.safeParse({ ...rest, parked: { reason: 'replied', at: resolvedAt } });
  return parsed.success ? parsed.data : null;
}

/**
 * WHAT IS WRITTEN READS BACK. A transition builds its items from what its caller handed it, and the daemon's own
 * callers are typed but not parsed — a Warden notice once carried a 471-character subject. The reader refuses
 * such an item, so writing it would set it aside on every read. Every entry a transition made or changed is
 * held to the schema the reader holds it to, and a change that fails is refused instead of written.
 */
function applyToLedger(ledger: AgendaLedger, command: AgendaCommand): AgendaMutation {
  // Accepted chat has its own send bound: reply keeps that full source outside the bounded legacy history note.
  if (
    ['answer', 'resolve', 'dismiss', 'needs-info', 'discuss', 'reply'].includes(command.action) &&
    !(command.action === 'reply' && command.fromChat !== undefined) &&
    agendaReplyEnvelopeLength(command as { response?: AgendaResponse; note?: string | null }) >
      MAX_AGENDA_REPLY_ENVELOPE_LENGTH
  ) {
    return failure('invalid', `an answer plus note is at most ${MAX_AGENDA_REPLY_ENVELOPE_LENGTH} characters as JSON`);
  }
  // Transitions see the full thread; only the fitted, validated item can leave this boundary.
  const transitioned = transition(withWholeThreads(ledger), command);
  if (!transitioned.ok) return transitioned;
  if (!transitioned.changed) return unchanged(ledger);
  const mutation = fitted(ledger, transitioned);
  const problem = unreadableWrite(ledger, mutation.ledger);
  return problem === undefined ? mutation : failure('invalid', problem);
}

/** The ledger with every item holding its whole thread from the conversations map, as a transition reads it. */
function withWholeThreads(ledger: AgendaLedger): AgendaLedger {
  return {
    ...ledger,
    entries: ledger.entries.map(entry => {
      const conversation = ledger.conversations?.[entry.item.id];
      return conversation === undefined || conversation.length === 0
        ? entry
        : ({ ...entry, item: { ...entry.item, conversation: [...conversation] } } as AgendaEntry);
    }),
  };
}

/**
 * {@link liftGateItems} as a read runs it: on the whole threads, as a transition, and what it changed stored as every
 * write is ({@link fitted}: the thread in the conversations map, a bounded tail on the item), so the words it says
 * when it closes a gate item read back. The same ledger when there is nothing to lift.
 */
function liftedOnRead(channel: AgendaLedger): AgendaLedger {
  const expanded = withWholeThreads(channel);
  const lifted = liftGateItems(expanded);
  if (lifted === expanded) return channel;
  // An entry the lift left alone is the stored one again, so only what it changed is fitted.
  const stored = new Map(expanded.entries.map((entry, index) => [entry, channel.entries[index] ?? entry]));
  const mutation = success(
    { ...lifted, entries: lifted.entries.map(entry => stored.get(entry) ?? entry) },
    true,
    'refreshed',
  );
  return mutation.ok ? fitted(channel, mutation).ledger : channel;
}

/**
 * Every item a change made or changed, fit to the transport bound by shedding its oldest versions (`fitAgendaItem`):
 * a long item stays closable, restable and shortenable, because its history never crowds the room those need.
 */
function fitted(
  before: AgendaLedger,
  mutation: Extract<AgendaMutation, { ok: true }>,
): Extract<AgendaMutation, { ok: true }> {
  const kept = new Set(before.entries);
  const conversations = { ...(before.conversations ?? {}) };
  const swaps = new Map<object, object>();
  const archived = [...(mutation.ledger.archivePending ?? [])];
  const remaining = new Set(mutation.ledger.entries.map(entry => entry.item.id));
  // Closed-history pruning removes the hot view, never the owner's words: the conversation, and the closing note or
  // answer, go to the sidecar as the item's complete last snapshot. An item this very change closed is archived
  // closed, not as the open copy it was: with every closed slot held by a set-aside entry it is pruned at once.
  for (const entry of before.entries) {
    if (remaining.has(entry.item.id)) continue;
    const last = mutation.addressed?.id === entry.item.id ? mutation.addressed : entry.item;
    archived.push({ kind: 'version', id: last.id, item: last });
    for (const record of last.history ?? []) {
      if (['replied', 'needs-info', 'discuss'].includes(record.kind)) {
        archived.push({ kind: 'owner-history', id: last.id, entry: record });
      }
    }
  }
  const entries = mutation.ledger.entries.map(entry => {
    if (kept.has(entry)) return entry;
    const full = entry.item.conversation ?? conversations[entry.item.id] ?? [];
    conversations[entry.item.id] = full;
    const item = fitAgendaItem(boundedConversation(entry.item, full));
    // Include the old history too: some transitions fit an intermediate item before returning it.
    const previous = before.entries.find(old => old.item.id === entry.item.id)?.item.history ?? [];
    const candidates = [...(entry.item.history ?? [])];
    const present = candidates.map(record => JSON.stringify(record));
    for (const record of previous) {
      const index = present.indexOf(JSON.stringify(record));
      if (index < 0) candidates.push(record);
      else present.splice(index, 1);
    }
    const retained = (item.history ?? []).map(record => JSON.stringify(record));
    for (const record of candidates) {
      const index = retained.indexOf(JSON.stringify(record));
      if (index >= 0) retained.splice(index, 1);
      else if (['replied', 'needs-info', 'discuss'].includes(record.kind)) {
        archived.push({ kind: 'owner-history', id: item.id, entry: record });
      }
    }
    if (item === entry.item) return entry;
    swaps.set(entry.item, item);
    return { ...entry, item } as typeof entry;
  });
  if (swaps.size === 0 && archived.length === (mutation.ledger.archivePending?.length ?? 0)) return mutation;
  const ledger = {
    ...mutation.ledger,
    entries,
    conversations,
    ...(archived.length === 0 ? {} : { archivePending: archived }),
  };
  const item = mutation.item === undefined ? undefined : (swaps.get(mutation.item) as AgendaItem | undefined);
  const addressed =
    mutation.addressed === undefined ? undefined : (swaps.get(mutation.addressed) as ResolvedAgendaItem | undefined);
  return {
    ...mutation,
    ledger,
    snapshot: agendaSnapshot(ledger),
    ...(item === undefined ? {} : { item }),
    ...(addressed === undefined ? {} : { addressed }),
  };
}

/** Why one of the entries `after` made or changed would not read back, or `undefined` when every one does. */
function unreadableWrite(before: AgendaLedger, after: AgendaLedger): string | undefined {
  const threads = z.record(AgendaIdSchema, z.array(AgendaConversationEntrySchema)).safeParse(after.conversations ?? {});
  if (!threads.success) return 'conversation words would not read back';
  const kept = new Set(before.entries);
  for (const entry of after.entries) {
    if (kept.has(entry)) continue;
    const parsed = (entry.lifecycle === 'active' ? AgendaItemSchema : ResolvedAgendaItemSchema).safeParse(entry.item);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
    return `agenda item ${entry.item.id} would not read back (${where}${issue?.message ?? 'invalid'})`;
  }
  return undefined;
}

function transition(ledger: AgendaLedger, command: AgendaCommand): AgendaMutation {
  // The board is part of the authorization decision, not just a storage key.
  // An agent's provenance proves authority only for that exact session. Keep
  // this check in the pure daemon-owned layer so a transport or future
  // in-process caller cannot bypass it by constructing a command directly.
  if (!agentConfinedTo(command.actor, ledger.sessionId)) {
    return failure('forbidden', 'an agent may change the agenda only in its own session');
  }
  const frozen = frozenSuggestion(ledger, command);
  if (frozen !== undefined) return frozen;
  switch (command.action) {
    case 'raise':
      return raise(ledger, command);
    case 'answer':
      return addressById(ledger, command, 'answered', 'done', command.response);
    case 'resolve':
      return addressById(ledger, command, 'resolved', 'done');
    case 'dismiss':
      return addressById(ledger, command, 'dismissed', 'dismissed');
    case 'edit':
      return edit(ledger, command);
    case 'progress':
      return progress(ledger, command);
    case 'needs-info':
      return needsInfo(ledger, command);
    case 'discuss':
      return discuss(ledger, command);
    case 'reply':
      return reply(ledger, command);
    case 'log':
      return log(ledger, command);
    case 'merge':
      return merge(ledger, command);
    case 'split':
      return split(ledger, command);
    case 'surface':
      return surface(ledger, command);
    case 'rest':
      return rest(ledger, command);
    case 'nudging':
      return nudging(ledger, command);
    case 'nudged':
      return nudged(ledger, command);
    case 'snooze':
      return snooze(ledger, command);
    case 'unsnooze':
      return unsnooze(ledger, command);
    case 'wake':
      return wake(ledger, command);
    case 'undelivered':
      return undelivered(ledger, command);
    case 'restate-confirms':
      return restateConfirms(ledger, command);
    case 'card-ask':
      return cardAsk(ledger, command);
    case 'link-task':
      return linkTask(ledger, command);
    case 'resolve-source':
      return resolveSource(ledger, command);
  }
}

/**
 * A FERRET'S STANDING-RULE SUGGESTION IS FROZEN (R1, C2): it sits on the ferret's own board, which the ferret reads
 * whole (`parked`, `history`, the resolution), so it stays exactly as raised until the DAEMON closes it at its expiry.
 * Every other actor's move on it (a close, Not needed, a snooze, a reply, an edit, a surface, "needs info") is
 * refused, so the ferret can never tell the owner's "no", or a glance, from silence. The owner says no with Dismiss on
 * its card, which is kept on the owner's side only. A plain answer keeps its own refusal (`addressById`).
 */
function frozenSuggestion(ledger: AgendaLedger, command: AgendaCommand): AgendaMutation | undefined {
  if (command.actor.kind === 'daemon' || command.action === 'answer' || !('id' in command)) return undefined;
  const target = ledger.entries.find(entry => entry.lifecycle === 'active' && entry.item.id === command.id);
  if (target?.item.signInRuleSuggestion === undefined) return undefined;
  return failure(
    'use_input_form',
    `${command.id} is a ferret's rule suggestion: Dismiss it on its card in the app. The ferret is not told; the card leaves its list when it expires`,
  );
}

type RaiseCommand = Extract<AgendaCommand, { action: 'raise' }>;
type AddressCommand = Extract<AgendaCommand, { action: 'answer' | 'resolve' | 'dismiss' }>;
type EditCommand = Extract<AgendaCommand, { action: 'edit' }>;
type ProgressCommand = Extract<AgendaCommand, { action: 'progress' }>;
type NeedsInfoCommand = Extract<AgendaCommand, { action: 'needs-info' }>;
type DiscussCommand = Extract<AgendaCommand, { action: 'discuss' }>;
type ReplyCommand = Extract<AgendaCommand, { action: 'reply' }>;
type LogCommand = Extract<AgendaCommand, { action: 'log' }>;
type MergeCommand = Extract<AgendaCommand, { action: 'merge' }>;
type SplitCommand = Extract<AgendaCommand, { action: 'split' }>;
type SurfaceCommand = Extract<AgendaCommand, { action: 'surface' }>;
type RestCommand = Extract<AgendaCommand, { action: 'rest' }>;
type NudgingCommand = Extract<AgendaCommand, { action: 'nudging' }>;
type NudgedCommand = Extract<AgendaCommand, { action: 'nudged' }>;
type SnoozeCommand = Extract<AgendaCommand, { action: 'snooze' }>;
type UnsnoozeCommand = Extract<AgendaCommand, { action: 'unsnooze' }>;
type WakeCommand = Extract<AgendaCommand, { action: 'wake' }>;
type ResolveSourceCommand = Extract<AgendaCommand, { action: 'resolve-source' }>;
type UndeliveredCommand = Extract<AgendaCommand, { action: 'undelivered' }>;
type RestateConfirmsCommand = Extract<AgendaCommand, { action: 'restate-confirms' }>;
type CardAskCommand = Extract<AgendaCommand, { action: 'card-ask' }>;
type LinkTaskCommand = Extract<AgendaCommand, { action: 'link-task' }>;

function raise(ledger: AgendaLedger, command: RaiseCommand): AgendaMutation {
  const { actor, request } = command;
  if (request.source !== 'agent-raised' && actor.kind !== 'daemon') {
    return failure('forbidden', `only the daemon may raise an agenda item from source ${request.source}`);
  }
  if (request.sourceRef !== null && actor.kind !== 'daemon') {
    return failure('forbidden', 'stable agenda source references are reserved for trusted daemon producers');
  }
  if (
    (request.gate !== undefined || request.discussion === true || request.cardAsks !== undefined) &&
    actor.kind !== 'daemon'
  ) {
    return failure('forbidden', 'only the daemon raises a gate item, its follow-up or a card ask');
  }
  if (request.carried !== undefined && actor.kind !== 'daemon') {
    return failure('forbidden', 'only the daemon carries an item over to another ferret\u2019s agenda');
  }
  // The recipe card's form approves a ferret's recipe through the owner's route: only the daemon points a card at one.
  if (request.recipeProposal !== undefined && actor.kind !== 'daemon') {
    return failure('forbidden', 'only the daemon raises a recipe proposal card');
  }
  const noticeProblem = agendaNoticeProblems(request)[0];
  if (noticeProblem !== undefined) return failure('invalid', noticeProblem);
  const offerCloseProblem = agendaOfferCloseProblems(request)[0];
  if (offerCloseProblem !== undefined) return failure('invalid', offerCloseProblem);
  if (request.offerClose === true && request.task === undefined) {
    return failure('invalid', 'there is no card to close: name it with --task F12 (--offer-close needs a card)');
  }
  const optionDetailProblem = agendaOptionDetailProblems(request)[0];
  if (optionDetailProblem !== undefined) return failure('invalid', optionDetailProblem);
  const formProblem = agendaFormProblems(request)[0];
  if (formProblem !== undefined) return failure('invalid', formProblem);
  if (request.notice === true && actor.kind === 'human') {
    return failure('forbidden', 'only a ferret or the daemon sends a notice');
  }
  // A ferret's new item carries its premise and context; the daemon's and the Warden's raises write their own.
  const briefProblems = actor.kind === 'agent' ? agendaBriefRequiredProblems(request) : [];
  if (briefProblems.length > 0) return failure('invalid', `a new agenda item needs both: ${briefProblems.join('; ')}`);
  // ONE ANSWER SHAPE PER KIND (docs/agenda.md, "What I need from you"): a ferret's raise that mixes shapes is
  // refused with the shape to write instead. The daemon's own raises carry their own fixed shapes.
  const shapeProblems = actor.kind === 'agent' ? agendaShapeProblems(request) : [];
  if (shapeProblems.length > 0) return failure('invalid', shapeProblems.join('; '));
  if (request.ask === undefined && request.kind !== 'info' && request.notice !== true && actor.kind !== 'daemon') {
    return failure(
      'invalid',
      'human and agent agenda items must declare a structured ask, or be kind info (something to know, no ask)',
    );
  }
  if (request.sourceSeq !== undefined && request.source !== 'agent-raised') {
    return failure('invalid', 'sourceSeq is valid only for agent-raised agenda items');
  }

  const active = ledger.entries.filter(isActiveAgenda);
  // A gate and its follow-up are raised once per entry: an open one is refreshed below, a closed one never comes
  // back (the owner's "Not needed" stays said).
  const once =
    request.sourceRef !== null &&
    (parseGateReference(request.sourceRef) !== undefined ||
      parseGateFollowupReference(request.sourceRef) !== undefined);
  const sameRef = (entry: AgendaEntry): boolean =>
    entry.item.source === request.source && entry.item.sourceRef === request.sourceRef;
  if (once && !active.some(sameRef) && ledger.entries.some(sameRef)) return unchanged(ledger);
  // A set-aside entry still holds its reference: an open one cannot be refreshed, and a gate's closed one keeps its
  // "raised once". Raising beside it would ask the owner again, or put a second item on the board for one source.
  const aside = setAsideOf(ledger.unreadable);
  if (
    request.sourceRef !== null &&
    aside.refs.some(ref => ref.source === request.source && ref.sourceRef === request.sourceRef && (ref.open || once))
  )
    return unchanged(ledger);
  const stable =
    request.sourceRef === null
      ? undefined
      : active.find(entry => entry.item.source === request.source && entry.item.sourceRef === request.sourceRef);
  if (stable !== undefined) return refreshStable(ledger, stable, command);

  const duplicate = active.some(
    entry =>
      request.sourceRef === null &&
      entry.item.source === request.source &&
      entry.item.sourceRef === null &&
      sameOrigin(entry.origin, actor) &&
      sameRequest(entry.item, request),
  );
  if (duplicate) return unchanged(ledger);

  if (active.length + aside.active >= MAX_AGENDA_PER_SESSION) {
    return failure('full', `this session already has ${MAX_AGENDA_PER_SESSION} unresolved items`);
  }
  if (
    actor.kind === 'agent' &&
    active.filter(entry => entry.origin.kind === 'agent').length + aside.agentActive >= MAX_AGENT_AGENDA_PER_SESSION
  ) {
    return failure('full', `this session already has ${MAX_AGENT_AGENDA_PER_SESSION} unresolved agent requests`);
  }
  if (!Number.isSafeInteger(ledger.nextId) || ledger.nextId < 1 || ledger.nextId >= Number.MAX_SAFE_INTEGER) {
    return failure('full', 'this session has exhausted its agenda id sequence');
  }

  const raised = withRaisedBy(
    {
      id: `A${ledger.nextId}` as AgendaId,
      source: request.source,
      sourceRef: request.sourceRef,
      ...(request.sourceSeq === undefined ? {} : { sourceSeq: request.sourceSeq }),
      subject: request.subject,
      why: request.why,
      ...(request.context === undefined ? {} : { context: request.context }),
      waitingSince: actor.kind === 'daemon' && request.waitingSince !== undefined ? request.waitingSince : command.at,
      howToResolve: request.howToResolve,
      ...(request.ask === undefined ? {} : { ask: request.ask }),
      ...cardFieldsOf(request),
      ...agendaBriefOf(request),
      // A new ask is the OWNER's turn: no `waitingOn`. The ferret's turn begins only when the owner replies.
      ...(request.notice === true ? { notice: true as const } : {}),
      ...(request.ping === true ? { ping: true as const } : {}),
      ...(request.confirms === undefined ? {} : { confirms: request.confirms }),
      ...(request.task === undefined ? {} : { task: request.task }),
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(request.copyPlan === undefined ? {} : { copyPlan: request.copyPlan }),
      ...(request.taskPlan === undefined ? {} : { taskPlan: request.taskPlan }),
      ...(request.signInRuleSuggestion === undefined ? {} : { signInRuleSuggestion: request.signInRuleSuggestion }),
      ...(request.twoFactorSeed === undefined ? {} : { twoFactorSeed: request.twoFactorSeed }),
      ...(request.recipeProposal === undefined ? {} : { recipeProposal: request.recipeProposal }),
      ...(request.phoneApproval === undefined ? {} : { phoneApproval: request.phoneApproval }),
      ...(request.cards === undefined ? {} : { cards: request.cards }),
      ...(request.offerClose === true ? { offerClose: true as const } : {}),
      ...(request.gate === undefined ? {} : { gate: request.gate }),
      ...(request.discussion === true
        ? { waitingOn: 'ferret' as const, askedAt: command.at, waitingFor: 'discussion' as const }
        : {}),
      ...firstStage(request.stage ?? agendaStageOfKind(agendaCardKind(request)), command.at),
      // A gate item moved to its card's new ferret goes on as the one it replaces stood.
      ...(request.carried === undefined ? {} : agendaCarriedOf(request.carried)),
    },
    actor,
  );
  // A card agenda opens with its card asks, the first open one mirrored for an app that predates them.
  // One that carries its talk over from another ferret's is not sealed: it reads its activity lines, as one from before the seal does.
  const asked = request.cardAsks === undefined ? raised : withCardAsks(raised, request.cardAsks);
  const item = request.cardAsks === undefined || request.carried !== undefined ? asked : sealCardAsks(asked);
  const next: AgendaLedger = {
    ...ledger,
    nextId: ledger.nextId + 1,
    entries: [...ledger.entries, { lifecycle: 'active', origin: actor, item }],
    updatedAt: command.at,
  };
  return success(next, true, 'created', item);
}

function refreshStable(
  ledger: AgendaLedger,
  existing: Extract<AgendaEntry, { lifecycle: 'active' }>,
  command: RaiseCommand,
): AgendaMutation {
  const request = command.request;
  if (
    existing.item.sourceSeq !== undefined &&
    (request.sourceSeq === undefined || request.sourceSeq < existing.item.sourceSeq)
  ) {
    return unchanged(ledger);
  }
  // A gate item an owner's chat message parked is the owner's again: its card still waits at the gate.
  const unpark = isGateItem(existing.item) && existing.item.parked?.reason === 'replied';
  if (sameRequest(existing.item, request) && existing.item.sourceSeq === request.sourceSeq && !unpark) {
    return unchanged(ledger);
  }

  const { parked: _parked, resting: _resting, ...kept } = existing.item;
  const item: AgendaItem = {
    ...(unpark ? kept : existing.item),
    ...(request.stage === undefined ? {} : staged(existing.item, request.stage, command.at)),
    // The gate it asks about follows the lane: a renamed lane or edited options are restated too.
    ...(request.gate === undefined ? {} : { gate: request.gate }),
    subject: request.subject,
    why: request.why,
    context: request.context ?? null,
    howToResolve: request.howToResolve,
    ...(request.ask === undefined ? { ask: undefined } : { ask: request.ask }),
    ...(request.sourceSeq === undefined ? { sourceSeq: undefined } : { sourceSeq: request.sourceSeq }),
    // The card is part of what a refresh restates: a title, kind or answers left out are cleared too.
    title: request.title,
    kind: request.kind,
    answers: request.answers,
    // A refresh replaces the brief whole: a field the new request leaves out is cleared, not kept.
    premise: request.premise,
    decided: request.decided,
    stillOpen: request.stillOpen,
    terms: request.terms,
    questions: request.questions,
    recommendation: request.recommendation,
    optionDetails: request.optionDetails,
    impact: request.impact,
    urgency: request.urgency,
    blockingNow: request.blockingNow,
    willBlock: request.willBlock,
    neededBy: request.neededBy,
    notice: request.notice,
    ping: request.ping,
    // The cards a notice lists are restated whole: a list that shrank or grew replaces the old one.
    cards: request.cards,
    links: request.links,
    steps: request.steps,
    body: request.body,
    questionAnswer: request.questionAnswer,
    whereWeAre: request.whereWeAre,
    detail: request.detail,
    // Ticks belong to the steps they were made on: the same steps keep them, new steps start clean.
    stepsDone: sameSteps(existing.item.steps, request.steps) ? existing.item.stepsDone : undefined,
  };
  const next: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === existing.item.id ? { ...entry, item } : entry,
    ),
    updatedAt: command.at,
  };
  return success(next, true, 'refreshed', item);
}

function addressById(
  ledger: AgendaLedger,
  command: AddressCommand,
  change: Extract<AgendaChange, 'answered' | 'resolved' | 'dismissed'>,
  disposition: 'done' | 'dismissed',
  response?: AgendaResponse,
): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  if (command.action === 'dismiss') {
    if (!canDismissAgenda(command.actor, target)) {
      return failure('forbidden', 'an agent or daemon may dismiss only an agenda item it raised');
    }
  } else if (!canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may resolve only an agenda item it raised');
  }
  // The owner closes a gate by answering it (or Not needed): a bare "done" would close it with the card unmoved.
  if (command.action === 'resolve' && command.actor.kind === 'human' && isGateAgenda(target)) {
    return failure(
      'invalid',
      `answer ${command.id} instead: one of its options (Done / Not good / Not yet), or Not needed`,
    );
  }
  // A card ask is the owner's to answer (docs/agenda.md § Card asks): no ferret or lead closes the agenda that carries
  // an open one, and the owner's bare done would close it with the card unmoved, so they answer the ask or say Not needed.
  if (command.actor.kind === 'agent') {
    const refusal = closeRefusal(target.item);
    if (refusal !== undefined) return failure('invalid', refusal);
  }
  if (command.action === 'resolve' && command.actor.kind === 'human' && hasOpenCardAsk(target.item)) {
    const labels = openCardAsks(target.item).flatMap(ask => ask.gate.options.map(option => option.label));
    return failure(
      'invalid',
      `answer ${command.id}'s card ask instead (${[...new Set(labels)].join(' / ')}), or Not needed`,
    );
  }
  // A question the owner has ANSWERED (it rests on the answer) is not withdrawn by the ferret's done: it is settled.
  if (
    command.action === 'resolve' &&
    command.actor.kind === 'agent' &&
    isQuestionShape(target.item) &&
    target.item.ownerAnswer === undefined
  ) {
    if ((command.note ?? '').trim() === '') {
      return failure(
        'invalid',
        `${command.id} is a question the owner has not answered: closing it withdraws the question, so say why with --reason (the owner sees "withdrawn"); to answer the owner's own question, \`edit ${command.id} --question-answer\` instead and keep the options`,
      );
    }
  }
  // An answer — or a Done or Skip given from the ask — to an ask the ferret has since REPLACED is never applied to the
  // new one (a stale tab, the undo window). A close that names no version is the owner's deliberate closing of the item
  // as it stands now (the CLI, an older app): it closes whatever the item asks.
  if (command.askVersion !== undefined && command.askVersion !== (target.item.askVersion ?? 1)) {
    return failure(
      'ask_changed',
      `${command.id} asks something else now: the ferret replaced the ask you answered, so nothing was sent; read it again and answer the new ask`,
    );
  }
  if (command.action === 'answer') {
    // An answer that names no version cannot say which ask it answered: once the ferret has replaced the ask it may be
    // the old one (a stale tab, an older app, the undo window), so the owner re-reads it. A ferret's own answer is its own.
    if (command.askVersion === undefined && command.actor.kind === 'human' && (target.item.askVersion ?? 1) > 1) {
      return failure(
        'ask_changed',
        `${command.id} asks something else now: the ferret replaced the ask, and this answer does not say which ask it answers, so nothing was sent; read it again and answer the new ask`,
      );
    }
    // The input form answers an input card, because the value never travels as an agenda answer.
    if (target.item.kind === 'input') {
      return failure('use_input_form', `${command.id} is answered in its input form, not as an agenda answer`);
    }
    // A task plan is answered by the owner's plan routes (ticks, picks, and a passkey for a sign-in): an agenda answer
    // would approve nothing, and must never read as one.
    if (target.item.taskPlan !== undefined) {
      return failure(
        'use_input_form',
        `${command.id} is a task plan: answer it on its card in the app, where a sign-in is confirmed with your passkey`,
      );
    }
    // A ferret's standing-rule suggestion opens the owner's create sheet with nothing ticked: an agenda answer would
    // create nothing, and must never read as an approval.
    if (target.item.signInRuleSuggestion !== undefined) {
      return failure(
        'use_input_form',
        `${command.id} suggests a standing rule: open it in the app, where you choose what to allow and confirm with your passkey`,
      );
    }
    // A paste plan is answered by the owner's plan route, which makes its rules: an agenda answer would make none.
    if (target.item.copyPlan !== undefined) {
      return failure('use_input_form', `${command.id} is a paste plan: answer it on its card, or with fy plan approve`);
    }
    // A staged 2FA seed is saved only by the passkey ceremony its card runs: an agenda answer would save nothing.
    if (target.item.twoFactorSeed !== undefined) {
      return failure(
        'use_input_form',
        `${command.id} saves a 2FA key: allow it on its card in the app, with your passkey`,
      );
    }
    // An approval on the phone is answered by the phone and settled by what the daemon sees: never by an agenda answer.
    if (target.item.phoneApproval !== undefined) {
      return failure(
        'use_input_form',
        `${command.id} is a sign-in to approve on your phone: approve it there, or tap Not me on its card`,
      );
    }
    // A gate's answer moves the owner's card: never a ferret's, a lead's or the daemon's own.
    if (isGateAgenda(target) && command.actor.kind !== 'human') {
      return failure('forbidden', `only the owner answers ${command.id}: it decides where the card goes next`);
    }
    // An answer to a confirmation is the owner's decision about a configuration change: never a ferret's.
    if (target.item.confirms !== undefined && command.actor.kind !== 'human') {
      return failure(
        'forbidden',
        `only the owner answers ${command.id}: it decides a change to ${target.item.confirms.path}; close it with dismiss instead`,
      );
    }
    if (command.response.kind === 'form') {
      const formProblem =
        target.item.kind !== 'form' || target.item.fields === undefined
          ? `${command.id} is not a form`
          : formAnswerProblems(target.item.fields, command.response.answers)[0];
      if (formProblem !== undefined) return failure('invalid', formProblem);
    } else if (!responseMatchesAsk(target.item.ask, command.response)) {
      const message =
        target.item.ask === undefined
          ? `${command.id} has no structured ask`
          : `${command.id} asks for a ${target.item.ask.kind} response`;
      return failure('invalid', message);
    }
    // THE OWNER'S ANSWER NEVER CLOSES A FERRET'S ITEM: it rests, waiting on the ferret, until the ferret answers on it
    // (back to the owner) or marks it done. A ferret's own answer to its item (`done --choice`) still closes it.
    if (command.actor.kind === 'human' && restsOnAnswer(target)) return restAnswered(ledger, target.item, command);
  }
  // A structured ask may still be RESOLVED without its response: the owner can reply in words instead
  // of picking (the note carries them to the ferret), and the raising ferret closes its own item once
  // the matter settled some other way. An answer, when given, must still match the ask.
  //
  // THE EXCEPTION IS AN INPUT CARD: the owner's field next to it may hold a password, and the app sends
  // whatever is in the composer with Resolve or Dismiss. Only the daemon's own status words are kept.
  const note = target.item.kind === 'input' && command.actor.kind !== 'daemon' ? null : (command.note ?? null);
  const receipt = command.action === 'answer' ? command.receipt : undefined;
  const closed = addressed(
    ledger,
    target,
    command.actor,
    note,
    command.at,
    disposition,
    change,
    response,
    undefined,
    receipt,
  );
  // A ferret closing an item the owner already replied to tells nobody: it was off their list, so nothing on it moves.
  // The ferret reads that in the command's own result.
  if (closed.ok && command.actor.kind === 'agent' && target.item.parked?.reason === 'replied') {
    return { ...closed, notes: [`${command.id} closed; the owner is not notified (they had already replied)`] };
  }
  return closed;
}

/**
 * Whether the owner's ANSWER rests an item rather than closing it (docs/agenda.md § States): an item a ferret speaks
 * for — one it raised, or a gate's follow-up conversation opened on its behalf — that waits on the ferret's next move.
 * Exempt, and still closed by the answer, are the items whose answer the DAEMON acts on: a card's gate (until card
 * asks move into agendas), a held configuration change, an input card, and every item the daemon raised for itself.
 */
export function restsOnAnswer(entry: Pick<AgendaEntry, 'origin' | 'item'>): boolean {
  const speaksForFerret = entry.origin.kind === 'agent' || isOnBehalfAgenda(entry);
  return (
    speaksForFerret &&
    !isGateAgenda(entry) &&
    entry.item.confirms === undefined &&
    entry.item.kind !== 'input' &&
    entry.item.notice !== true
  );
}

/**
 * The owner answered a ferret's item: it RESTS, waiting on the ferret (`parked: replied` for every app, `resting` for
 * this one), the answer kept on it (`ownerAnswer`) and its words in the history. Whatever the item waited on before
 * (more information, a discussion, a snooze) ends with it. The answer's place in the request counter names its one
 * delivery (`needsInfoReplyKey`), so a second answer after the ferret replied is delivered too. Its place in the
 * queue (`waitingSince`) is kept, for the ferret's answer to bring it back to.
 */
function restAnswered(
  ledger: AgendaLedger,
  item: AgendaItem,
  command: Extract<AgendaCommand, { action: 'answer' }>,
): AgendaMutation {
  const request = (item.infoRequests ?? 0) + 1;
  const words = command.note?.trim() ?? '';
  const note = words === '' ? undefined : words.slice(0, MAX_AGENDA_REPLY_LENGTH);
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, undelivered: _u, parked: _p, resting: _r, ...open } = item;
  const rested: AgendaItem = {
    ...open,
    infoRequests: request,
    ownerAnswer: { at: command.at, response: command.response, ...(note === undefined ? {} : { note }), request },
    parked: { reason: 'replied', at: command.at },
    resting: { sub: 'waiting-on-ferret', at: command.at },
    history: withHistory(open.history, {
      at: command.at,
      kind: 'replied',
      ...(note === undefined ? {} : { note }),
      response: command.response,
    }),
    ...said(open, ...responseWords(command.response, note).map(text => wordsOf(command.at, 'owner', 'answer', text))),
  };
  return replaceItem(ledger, rested, command.at, 'answered');
}

function isQuestionShape(item: AgendaItem): boolean {
  const shape = agendaShape(item);
  return shape !== 'info' && shape !== 'input';
}

function resolveSource(ledger: AgendaLedger, command: ResolveSourceCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') {
    return failure('forbidden', 'only the daemon may reconcile a trusted agenda source');
  }
  const target = ledger.entries
    .filter(isActiveAgenda)
    .find(entry => entry.item.source === command.source && entry.item.sourceRef === command.sourceRef);
  return target === undefined
    ? unchanged(ledger)
    : addressed(ledger, target, command.actor, command.note ?? null, command.at, 'done', 'resolved');
}

export function parseAgendaEntry(value: unknown, legacy: boolean, pending: AgendaArchiveRecord[]): AgendaEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const origin = parseAgendaActor(raw.origin);
  if (origin === null) return null;
  if (raw.lifecycle === 'active') {
    const decoded = parseEntryItem(legacy ? StoredAgendaItemSchema : AgendaItemSchema, raw.item, origin);
    const item = decoded === null ? null : migrateStoredItem(decoded, legacy, pending);
    return item !== null && sameItemOrigin(item, origin) ? { lifecycle: 'active', origin, item } : null;
  }
  if (raw.lifecycle === 'addressed') {
    const decoded = parseEntryItem(
      legacy ? StoredResolvedAgendaItemSchema : ResolvedAgendaItemSchema,
      raw.item,
      origin,
    );
    const item = decoded === null ? null : migrateStoredItem(decoded, legacy, pending);
    return item !== null && sameItemOrigin(item, origin) ? { lifecycle: 'addressed', origin, item } : null;
  }
  return null;
}

/** Old writers had no aggregate wire limit. Decode their versions first and preserve them before fitting the view. */
function migrateStoredItem<Item extends AgendaItem | ResolvedAgendaItem>(
  item: Item,
  legacy: boolean,
  pending: AgendaArchiveRecord[],
): Item {
  if (!legacy) return item;
  const migrated = channelItem(item, true);
  const fitted = fitAgendaItem(migrated);
  if (fitted !== migrated) pending.push({ kind: 'version', id: item.id, item });
  return fitted;
}

/**
 * An entry's item, or `null` when it does not read as one.
 *
 * ONLY THE WARDEN'S OWN WORDS ARE FITTED: an item the Warden raised whose only fault is text past a limit — a
 * daemon before writes were checked (`unreadableWrite`) wrote its notices with a subject that long — reads with
 * that text cut to the limit, and the next write keeps the cut. Every other item is left as written, the
 * daemon's other items included, since those can quote a person or a ferret (an input card's prompt, a gate's
 * card title): such an item is set aside as unreadable instead, and the board says so.
 */
function parseEntryItem<Item>(schema: z.ZodType<Item>, value: unknown, origin: AgendaActor): Item | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isWardenActor(origin) || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const fitted: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const issue of parsed.error.issues) {
    const [field, ...deeper] = issue.path;
    if (issue.code !== 'too_big' || issue.origin !== 'string' || typeof field !== 'string' || deeper.length > 0)
      return null;
    fitted[field] = fitText(String(fitted[field]), Number(issue.maximum));
  }
  const again = schema.safeParse(fitted);
  return again.success ? again.data : null;
}

function parseAgendaActor(value: unknown): AgendaActor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'human') return { kind: 'human' };
  if (
    raw.kind === 'agent' &&
    typeof raw.sessionId === 'string' &&
    (typeof raw.name === 'string' || raw.name === null)
  ) {
    return { kind: 'agent', sessionId: raw.sessionId, name: raw.name };
  }
  if (raw.kind === 'daemon' && isDaemonAgendaCause(raw.cause)) return { kind: 'daemon', cause: raw.cause };
  return null;
}

function sameItemOrigin(item: AgendaItem | ResolvedAgendaItem, origin: AgendaActor): boolean {
  return (
    item.raisedBy === origin.kind &&
    item.raisedBySession === (origin.kind === 'agent' ? origin.sessionId : null) &&
    item.raisedByName === (origin.kind === 'agent' ? origin.name : null)
  );
}

function addressed(
  ledger: AgendaLedger,
  target: Extract<AgendaEntry, { lifecycle: 'active' }>,
  actor: AgendaActor,
  note: string | null,
  at: string,
  disposition: AgendaDisposition,
  change: Extract<AgendaChange, 'answered' | 'resolved' | 'dismissed' | 'replied'>,
  response?: AgendaResponse,
  entry?: AgendaHistoryEntry,
  receipt?: string,
): AgendaMutation {
  const {
    waitingOn: _waitingOn,
    askedAt: _askedAt,
    waitingFor: _waitingFor,
    undelivered: _undelivered,
    resting: _resting,
    ...open
  } = target.item;
  const item = withResolvedBy(
    {
      ...open,
      ...staged(open, 'done', at),
      ...(entry === undefined ? {} : { history: withHistory(open.history, entry) }),
      ...said(
        open,
        ...responseWords(response, note).map(text =>
          wordsOf(at, speakerOf(actor), change === 'answered' ? 'answer' : 'close', text),
        ),
      ),
      resolvedAt: at,
      resolutionNote: note,
      disposition,
      ...(response === undefined ? {} : { response }),
      ...(receipt === undefined ? {} : { answerReceipt: receipt }),
    },
    actor,
  );
  const active = ledger.entries.filter(
    (entry): entry is Extract<AgendaEntry, { lifecycle: 'active' }> =>
      entry.lifecycle === 'active' && entry.item.id !== target.item.id,
  );
  const history = [
    { lifecycle: 'addressed' as const, origin: target.origin, item },
    ...ledger.entries.filter(
      (entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> => entry.lifecycle === 'addressed',
    ),
    // Set-aside closed entries keep their places in the history, so it stays within its cap when they read again.
  ].slice(0, Math.max(0, MAX_AGENDA_RESOLUTIONS - setAsideOf(ledger.unreadable).addressed));
  const next: AgendaLedger = { ...ledger, entries: [...active, ...history], updatedAt: at };
  return success(next, true, change, undefined, item);
}

function canAddressAgenda(actor: AgendaActor, entry: AgendaEntry): boolean {
  return canDismissAgenda(actor, entry);
}

function responseMatchesAsk(ask: AgendaAsk | undefined, response: AgendaResponse): boolean {
  if (ask === undefined) return false;
  // The owner's own words instead of the options: any ask that offers options takes them.
  if (response.kind === 'other') return ask.kind !== 'open-question' && ask.kind !== 'task';
  if (ask.kind !== response.kind) return false;
  if (ask.kind !== 'multiple-choice' || response.kind !== 'multiple-choice') return true;
  return ask.options.some(option => option.label === response.choice);
}

function sameRequest(item: AgendaItem, request: RaiseAgendaRequest): boolean {
  return (
    item.subject === request.subject &&
    item.why === request.why &&
    (item.context ?? null) === (request.context ?? null) &&
    item.howToResolve === request.howToResolve &&
    JSON.stringify(item.ask ?? null) === JSON.stringify(request.ask ?? null) &&
    item.notice === request.notice &&
    item.ping === request.ping &&
    JSON.stringify(item.cards ?? null) === JSON.stringify(request.cards ?? null) &&
    JSON.stringify(item.gate ?? null) === JSON.stringify(request.gate ?? null) &&
    JSON.stringify(cardFieldsOf(item)) === JSON.stringify(cardFieldsOf(request)) &&
    JSON.stringify(agendaBriefOf(item)) === JSON.stringify(agendaBriefOf(request))
  );
}

/** Just the card fields a request or item carries, in one fixed key order, the absent ones left out. */
function cardFieldsOf(value: AgendaCardFields): AgendaCardFields {
  return {
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.answers === undefined ? {} : { answers: value.answers }),
  };
}

function sameOrigin(left: AgendaActor, right: AgendaActor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'human' && right.kind === 'human') return true;
  if (left.kind === 'agent' && right.kind === 'agent') return left.sessionId === right.sessionId;
  return left.kind === 'daemon' && right.kind === 'daemon' && left.cause === right.cause;
}

function withRaisedBy(
  item: Omit<AgendaItem, 'raisedBy' | 'raisedBySession' | 'raisedByName'>,
  actor: AgendaActor,
): AgendaItem {
  switch (actor.kind) {
    case 'human':
      return { ...item, raisedBy: 'human', raisedBySession: null, raisedByName: null };
    case 'agent':
      return { ...item, raisedBy: 'agent', raisedBySession: actor.sessionId, raisedByName: actor.name };
    case 'daemon':
      return { ...item, raisedBy: 'daemon', raisedBySession: null, raisedByName: null };
  }
}

function withResolvedBy(
  item: Omit<ResolvedAgendaItem, 'resolvedBy' | 'resolvedBySession' | 'resolvedByName'>,
  actor: AgendaActor,
): ResolvedAgendaItem {
  switch (actor.kind) {
    case 'human':
      return { ...item, resolvedBy: 'human', resolvedBySession: null, resolvedByName: null } as ResolvedAgendaItem;
    case 'agent':
      return {
        ...item,
        resolvedBy: 'agent',
        resolvedBySession: actor.sessionId,
        resolvedByName: actor.name,
      } as ResolvedAgendaItem;
    case 'daemon':
      return { ...item, resolvedBy: 'daemon', resolvedBySession: null, resolvedByName: null } as ResolvedAgendaItem;
  }
}

function idNumber(id: AgendaId): number {
  return Number(id.slice(1));
}

function compareActive(left: AgendaItem, right: AgendaItem): number {
  return left.waitingSince.localeCompare(right.waitingSince) || idNumber(left.id) - idNumber(right.id);
}

function compareAddressed(left: ResolvedAgendaItem, right: ResolvedAgendaItem): number {
  return right.resolvedAt.localeCompare(left.resolvedAt) || idNumber(left.id) - idNumber(right.id);
}

function unchanged(ledger: AgendaLedger): AgendaMutation {
  return success(ledger, false, 'unchanged');
}

function success(
  ledger: AgendaLedger,
  changed: boolean,
  change: AgendaChange,
  item?: AgendaItem,
  addressed?: ResolvedAgendaItem,
): AgendaMutation {
  return {
    ok: true,
    changed,
    change,
    ledger,
    snapshot: agendaSnapshot(ledger),
    ...(item === undefined ? {} : { item }),
    ...(addressed === undefined ? {} : { addressed }),
  };
}

function failure(code: AgendaErrorCode, message: string): AgendaMutation {
  return { ok: false, error: { code, message } };
}

const EDITABLE_FIELDS = [
  'subject',
  'why',
  'howToResolve',
  'title',
  'context',
  'ask',
  'kind',
  'answers',
  'premise',
  'decided',
  'stillOpen',
  'terms',
  'questions',
  'recommendation',
  'optionDetails',
  'fields',
  'impact',
  'urgency',
  'blockingNow',
  'willBlock',
  'neededBy',
  'links',
  'steps',
  'body',
  'questionAnswer',
  'whereWeAre',
  'tabs',
  'detail',
] as const satisfies readonly AgendaRevisableField[];

/**
 * An edit's TAB OPERATIONS as the new `tabs` (&F923): applied in order to the item's own tabs, so the edit stores the
 * whole list through the ordinary path — one edit, one version, one revision. Every tab removed clears `tabs`. A plain
 * sentence when one operation cannot apply, or when the edit also replaces `tabs` whole.
 */
function withTabEdits(item: AgendaItem, patch: EditAgendaPatch): EditAgendaPatch | string {
  const { tabEdits, ...rest } = patch;
  if (tabEdits === undefined) return patch;
  if (patch.tabs !== undefined) return 'an edit gives tabs or tab operations, not both';
  const applied = applyAgendaTabEdits(item.tabs, tabEdits);
  if (!applied.ok) return applied.problem;
  return applied.tabs.length === 0 ? { ...rest, clearTabs: true } : { ...rest, tabs: [...applied.tabs] };
}

/** The option labels of each question, in order — what an edit that keeps the ask leaves alone. */
function questionShape(questions: AgendaBrief['questions']): string {
  return JSON.stringify(
    (questions ?? []).map(question => question.options?.map(option => option.label.trim()) ?? null),
  );
}

/** The identity, type and option labels of each form field, in order — what an edit that rewords a field leaves alone. */
function fieldShape(fields: AgendaItem['fields']): string {
  return JSON.stringify(
    (fields ?? []).map(field => [field.id, field.type, field.options?.map(option => option.label.trim()) ?? null]),
  );
}

/** Whether a patch value says what the item already says; an absent context and a null one are the same. */
function sameField(left: unknown, right: unknown): boolean {
  return sortedJson(left ?? null) === sortedJson(right ?? null);
}

/**
 * Whether an edit REPLACES THE ASK (docs/agenda.md § Editable asks): a new ask or answers, questions that are added,
 * removed or given other options, form fields that are added, removed, retyped or given other options, or an explicit `kind` — even the kind the item already has, which is how a ferret
 * says "this is a different question". Rewording a question, or restating what the item says, is no new ask.
 */
function askReplaced(item: AgendaItem, patch: EditAgendaPatch): boolean {
  return (
    (patch.ask !== undefined && !sameField(patch.ask, item.ask)) ||
    patch.kind !== undefined ||
    (patch.answers !== undefined && !sameField(patch.answers, item.answers)) ||
    (patch.questions !== undefined && questionShape(patch.questions) !== questionShape(item.questions)) ||
    (patch.fields !== undefined && fieldShape(patch.fields) !== fieldShape(item.fields))
  );
}

/** Whether an edit carries the ferret's ANSWER on the item (`fy agenda answer`, `edit --question-answer`). */
function answersOn(patch: EditAgendaPatch): boolean {
  return (patch.questionAnswer ?? '').trim() !== '';
}

/**
 * Whether an edit asks to put a resting item back in front of the owner: the ferret's answer on it, a replaced ask,
 * or the older CLIs' explicit `back`.
 */
function bringsBack(command: EditCommand, item: AgendaItem): boolean {
  return command.back === true || answersOn(command.patch) || askReplaced(item, command.patch);
}

/**
 * Where a resting item the ferret brings back goes in the owner's queue: its OLD place when it is the ferret's
 * answer to the owner's reply (`waiting-on-ferret`), a FRESH one when it is a genuinely new ask — a replaced ask,
 * the older `back`, or any need after the ferret took the item on (`working`).
 */
function placeOnReturn(command: EditCommand, item: AgendaItem): 'old' | 'fresh' {
  const view = agendaState(item);
  const working = view.state === 'resting' && view.sub === 'working';
  return command.back === true || askReplaced(item, command.patch) || working ? 'fresh' : 'old';
}

/** The shape fields an item of one kind cannot carry over to another: a new kind takes only what its edit gives. */
const REPLACED_SHAPE = ['ask', 'answers', 'questions', 'optionDetails', 'fields', 'steps'] as const;

/**
 * The old shape an edit that REPLACES the ask leaves behind, which the edit does not give again: a moved kind takes
 * none of it; a new ask of the same kind (an explicit `kind`, or an ask or answers given) takes none of the old
 * questions or option details, which described the ask it replaces.
 */
function droppedShape(item: AgendaItem, patch: EditAgendaPatch): readonly (typeof REPLACED_SHAPE)[number][] {
  const newAsk = patch.kind !== undefined || patch.ask !== undefined || patch.answers !== undefined;
  const dropped: readonly (typeof REPLACED_SHAPE)[number][] = kindMoved(item, patch)
    ? REPLACED_SHAPE
    : newAsk
      ? ['questions', 'optionDetails']
      : [];
  return dropped.filter(field => patch[field] === undefined);
}

/** The item an edit that REPLACES the ask leaves: the old shape it drops goes, and the edit's own fields land. */
function composeReplacement(item: AgendaItem, patch: EditAgendaPatch): AgendaItem {
  const gone = new Set(droppedShape(item, patch));
  const { ask, answers, questions, optionDetails, fields, steps, ...rest } = item;
  return {
    ...rest,
    ...(ask === undefined || gone.has('ask') ? {} : { ask }),
    ...(answers === undefined || gone.has('answers') ? {} : { answers }),
    ...(questions === undefined || gone.has('questions') ? {} : { questions }),
    ...(optionDetails === undefined || gone.has('optionDetails') ? {} : { optionDetails }),
    ...(fields === undefined || gone.has('fields') ? {} : { fields }),
    ...(steps === undefined || gone.has('steps') ? {} : { steps }),
    ...(patch.ask === undefined ? {} : { ask: patch.ask }),
    ...(patch.kind === undefined ? {} : { kind: patch.kind }),
    ...(patch.answers === undefined ? {} : { answers: patch.answers }),
    ...(patch.questions === undefined ? {} : { questions: patch.questions }),
    ...(patch.optionDetails === undefined ? {} : { optionDetails: patch.optionDetails }),
    ...(patch.fields === undefined ? {} : { fields: patch.fields }),
    ...(patch.steps === undefined ? {} : { steps: patch.steps }),
  };
}

/** Why an edit may not replace this item's ask, or `undefined` when it may. */
function replaceProblem(item: AgendaItem, patch: EditAgendaPatch, actor: AgendaActor): string | undefined {
  if (item.confirms !== undefined) return `${item.id} confirms a configuration change: its answers are fixed`;
  if (item.notice === true || item.kind === 'input' || patch.kind === 'input') {
    return `${item.id} has no ask to replace`;
  }
  // A new kind takes none of the old shape: an old choice's options never answer an explainer.
  const next = composeReplacement(item, patch);
  const kind = agendaCardKind(next);
  if (next.ask === undefined && kind !== 'info') {
    return `a new ${kind} needs its ask: give it with the kind (\`--kind ${kind}\` with --option or --question)`;
  }
  return (
    agendaAnswerProblems(next.answers ?? [], next.ask)[0]?.[1] ??
    (actor.kind === 'agent' ? agendaShapeProblems(next)[0] : undefined) ??
    agendaFormProblems(next)[0]
  );
}

/** Whether an edit moves the item to another kind. */
function kindMoved(item: AgendaItem, patch: EditAgendaPatch): boolean {
  return patch.kind !== undefined && patch.kind !== agendaCardKind(item);
}

/**
 * Rewrites an OPEN item in place. Only whoever may close an item may edit it.
 *
 * - THE WRITING changes in place (summary, context, premise, what is decided and still open, terms, question wording,
 *   recommendation, impact, urgency, links, where we are, the detail), and so may the stage (`--stage`, kept in
 *   `stages`). An edit that changes nothing adds nothing; one that changes something appends ONE revision (who,
 *   which fields, what they said before), so the card reads as a living summary of its discussion.
 * - THE FERRET'S ANSWER on the item (`questionAnswer`) brings a RESTING item back to the owner: to its OLD place in the
 *   queue when it answers their reply, FRESH after the ferret took it on (`placeOnReturn`). An item on the ferret's
 *   turn for more information is handed back by any edit of the ferret's, as before.
 * - A REPLACED ASK (`askReplaced`) is a new ask: the item asks again, fresh, as its one entry in the queue; its
 *   `askVersion` moves on so an answer to the old one is refused; the owner's old answer and the ferret's old
 *   answer to their question go, unless this edit gives a new one; a kind that moves takes the stage it says.
 * - A resting item edited any other way stays resting: nothing it writes reaches the owner.
 * - A SNOOZED item stays asleep unless the ferret says it is urgent (`now`, at most once an hour per item
 *   (`AGENDA_URGENT_WAKE_MS`)) or newly marks it blocking, which wakes it whenever it happens.
 */
function edit(ledger: AgendaLedger, command: EditCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    // A patch read an OPEN item: one that has closed since is not the item it read.
    if (command.patch.revision !== undefined) {
      return failure('stale', `${command.id} is no longer open: read it again (agenda show ${command.id})`);
    }
    // An edit of an item closed as replied (before replies parked) is the ferret asking again: it reopens, then edits.
    const reopened = reopenReplied(
      ledger,
      command.id,
      command.actor,
      command.at,
      { at: command.at, kind: 'updated' },
      command.patch,
      command.back === true || answersOn(command.patch),
    );
    if (reopened === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
    if (!reopened.ok) return reopened;
    const edited = edit(reopened.ledger, command);
    return !edited.ok || edited.change === 'unchanged' ? (edited.ok ? reopened : edited) : edited;
  }
  if (!canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may edit only an agenda item it raised');
  }
  if (command.patch.revision !== undefined) {
    // READ BEFORE WRITE: the writer read the item at `revision`; anything written since would be overwritten unseen.
    if (agendaItemRevision(target.item) !== command.patch.revision) {
      return failure(
        'stale',
        `${command.id} changed since you read it: read it again (agenda show ${command.id} --yaml), update every part that is out of date, and patch it back`,
      );
    }
    const { revision: _revision, ...patch } = command.patch;
    return edit(ledger, { ...command, patch });
  }
  if (command.patch.tabEdits !== undefined) {
    const tabbed = withTabEdits(target.item, command.patch);
    return typeof tabbed === 'string' ? failure('invalid', tabbed) : edit(ledger, { ...command, patch: tabbed });
  }
  const replaces = askReplaced(target.item, command.patch);
  if (replaces) {
    const problem = replaceProblem(target.item, command.patch, command.actor);
    if (problem !== undefined) return failure('invalid', problem);
  }
  // A ferret's edit of a RESTING item rewrites the card and leaves it resting, unless it answers on it or asks anew.
  const repliedTo = target.item.parked?.reason === 'replied';
  const staysResting = repliedTo && command.actor.kind === 'agent' && !bringsBack(command, target.item);
  if (repliedTo && !staysResting && command.back === true) {
    const stale = repliedRefreshProblem(command.actor, command.id, command.patch, true);
    if (stale !== null) return failure('invalid', stale);
  }
  const newlyBlocking = command.patch.blockingNow === true && target.item.blockingNow !== true;
  const back = staysResting
    ? target.item
    : backFromParked(
        target.item,
        command.actor,
        command.at,
        command.now === true,
        placeOnReturn(command, target.item),
        newlyBlocking,
      );
  if ('code' in back) return failure(back.code, back.message);
  if (!('code' in back) && back !== target.item) {
    // The ferret's edit brings a parked item back first, then edits it as it stands.
    const unparked = replaceItem(ledger, back, command.at, 'unparked');
    if (!unparked.ok) return unparked;
    const edited = edit(unparked.ledger, { ...command, now: false, back: false });
    return !edited.ok || edited.change === 'unchanged' ? (edited.ok ? unparked : edited) : edited;
  }
  return editInPlace(ledger, target.item, command, replaces);
}

/** The edit applied to an item that is where it stays: in the queue, resting, snoozed, or on the ferret's turn. */
function editInPlace(ledger: AgendaLedger, item: AgendaItem, command: EditCommand, replaces: boolean): AgendaMutation {
  const patch = command.patch;
  // A replaced ask takes the ferret's old answer to the owner's question with it, unless the edit gives a new one.
  const dropsAnswer = replaces && patch.questionAnswer === undefined && item.questionAnswer !== undefined;
  // A new ask brings its own shape: the old fields it does not re-give go, and the revision records them.
  const clearing: (typeof EDITABLE_FIELDS)[number][] = [
    ...(patch.clear ?? []),
    ...(patch.clearTabs === true ? (['tabs'] as const) : []),
    ...(dropsAnswer ? (['questionAnswer'] as const) : []),
    ...(replaces ? droppedShape(item, patch) : []),
  ];
  const clears = clearing.filter(field => item[field] !== undefined);
  if (
    EDITABLE_FIELDS.every(field => patch[field] === undefined) &&
    clearing.length === 0 &&
    patch.stage === undefined
  ) {
    return failure('invalid', `nothing to edit: give at least one of stage, ${EDITABLE_FIELDS.join(', ')}`);
  }
  const composed = replaces ? composeReplacement(item, patch) : item;
  const optionDetailProblem = agendaOptionDetailProblems({
    ...composed,
    ...(patch.ask === undefined ? {} : { ask: patch.ask }),
    ...(patch.answers === undefined ? {} : { answers: patch.answers }),
    ...(patch.questions === undefined ? {} : { questions: patch.questions }),
    ...(patch.optionDetails === undefined ? {} : { optionDetails: patch.optionDetails }),
  })[0];
  if (optionDetailProblem !== undefined) return failure('invalid', optionDetailProblem);
  const fieldsProblem = agendaFormProblems({
    kind: patch.kind ?? agendaCardKind(item),
    fields: patch.fields ?? composed.fields,
  })[0];
  if (patch.fields !== undefined && fieldsProblem !== undefined) return failure('invalid', fieldsProblem);
  // Steps belong to a to-do alone: an edit that keeps the ask never gives them to a card of another shape.
  const shapeProblem =
    command.actor.kind === 'agent' && !replaces ? agendaEditShapeProblems(item, patch)[0] : undefined;
  if (shapeProblem !== undefined) return failure('invalid', shapeProblem);
  const changed = EDITABLE_FIELDS.filter(
    field =>
      clears.some(cleared => cleared === field) ||
      (patch[field] !== undefined && !sameField(patch[field], item[field])),
  );
  const stage =
    patch.stage ?? (kindMoved(item, patch) && patch.kind !== undefined ? agendaStageOfKind(patch.kind) : undefined);
  const stageFields = stage === undefined || stage === agendaStage(item) ? {} : staged(item, stage, command.at);
  // The ferret's edit answers its turn: the item goes back to the owner, whether or not the words changed.
  const handsBack = (item.waitingOn !== undefined && command.actor.kind === 'agent') || replaces;
  const answering = patch.questionAnswer !== undefined && !clears.includes('questionAnswer');
  if (changed.length === 0 && !handsBack && !answering && Object.keys(stageFields).length === 0)
    return unchanged(ledger);
  const { stepsDone, waitingOn: _waitingOn, askedAt: _askedAt, waitingFor: _waitingFor, ...kept } = item;
  const revision: AgendaRevision = {
    at: command.at,
    by: command.actor.kind,
    changed,
    previous: Object.fromEntries(changed.flatMap(field => (item[field] === undefined ? [] : [[field, item[field]]]))),
  };
  const edited: AgendaItem = {
    ...kept,
    ...(!handsBack && item.waitingOn !== undefined
      ? {
          waitingOn: item.waitingOn,
          ...(item.askedAt === undefined ? {} : { askedAt: item.askedAt }),
          ...(item.waitingFor === undefined ? {} : { waitingFor: item.waitingFor }),
        }
      : {}),
    ...(stepsDone === undefined || changed.includes('steps') ? {} : { stepsDone }),
    ...Object.fromEntries(
      changed.map(field => [field, clears.some(cleared => cleared === field) ? undefined : patch[field]]),
    ),
    ...(changed.length === 0 ? {} : { revisions: [...(item.revisions ?? []), revision].slice(-MAX_AGENDA_REVISIONS) }),
    ...said(
      item,
      answering ? wordsOf(command.at, speakerOf(command.actor), 'question-answer', patch.questionAnswer) : undefined,
    ),
    ...stageFields,
    // A new ask: asked again, fresh, under the next version; the owner's answer to the old one is history.
    // The answer that failed to reach the ferret answered the OLD ask: its Retry goes with it.
    ...(replaces
      ? {
          askVersion: (item.askVersion ?? 1) + 1,
          waitingSince: command.at,
          ownerAnswer: undefined,
          undelivered: undefined,
        }
      : {}),
  };
  const final: AgendaItem = handsBack
    ? { ...edited, history: withHistory(edited.history, { at: command.at, kind: 'updated' }) }
    : edited;
  // Only an answer to a request for MORE INFORMATION is `info-added`; a discussion handed back is a plain refresh.
  const change = handsBack && !replaces && item.waitingFor !== 'discussion' ? 'info-added' : 'refreshed';
  return replaceItem(ledger, final, command.at, change);
}

function replaceItem(
  ledger: AgendaLedger,
  item: AgendaItem,
  at: string,
  change: Extract<
    AgendaChange,
    | 'refreshed'
    | 'needs-info'
    | 'discussing'
    | 'surfaced'
    | 'info-added'
    | 'reopened'
    | 'replied'
    | 'parked'
    | 'unparked'
    | 'woke'
    | 'rested'
    | 'nudged'
    | 'answered'
    | 'logged'
  >,
): AgendaMutation {
  const tidy = tidied(item);
  const next: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === tidy.id ? { ...entry, item: tidy } : entry,
    ),
    updatedAt: at,
  };
  return success(next, true, change, tidy);
}

/** JSON with keys in sorted order, so two items compare by content and not by how their keys were spread. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, each: unknown) =>
    each !== null && typeof each === 'object' && !Array.isArray(each)
      ? Object.fromEntries(Object.entries(each).sort(([left], [right]) => left.localeCompare(right)))
      : each,
  );
}

/** The stage fields of a new item: the stage it starts at, as the first of its stages. */
function firstStage(stage: AgendaStage, at: string): Pick<AgendaItem, 'stage' | 'stages'> {
  return { stage, stages: [{ stage, at }] };
}

/** The stage fields of an item moved to `stage` at `at`, or none when it is already there. */
function staged(
  item: Pick<AgendaItem, 'stage' | 'stages' | 'kind' | 'ask'>,
  stage: AgendaStage,
  at: string,
): Partial<Pick<AgendaItem, 'stage' | 'stages'>> {
  if (agendaStage(item) === stage && item.stage !== undefined) return {};
  return { stage, stages: [...(item.stages ?? []), { stage, at }].slice(-MAX_AGENDA_STAGES) };
}

/**
 * An item with its `resting` only while something says it rests (`parked: replied`, or a wait on the ferret): every
 * path that brings an item back by dropping its park drops the detail of how it rested with it.
 */
function tidied(item: AgendaItem): AgendaItem {
  if (item.resting === undefined || item.parked?.reason === 'replied' || item.waitingOn !== undefined) return item;
  const { resting: _resting, ...rest } = item;
  return rest;
}

/** History before fitting: the fitter archives owner records before applying the wire bounds. */
function withHistory(
  history: readonly AgendaHistoryEntry[] | undefined,
  entry: AgendaHistoryEntry,
): AgendaHistoryEntry[] {
  return [...(history ?? []), entry];
}

/**
 * The owner asks the raising ferret for more information. The item stays OPEN, marked waiting on the
 * ferret, and each request is counted (`infoRequests`) so the delivery and the push after it are exactly
 * once per request. Only the owner asks, and only of an item a ferret raised: nobody else can be asked.
 * Asking again while the ferret has not yet answered is the same request.
 */
function needsInfo(ledger: AgendaLedger, command: NeedsInfoCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner may ask for more information');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.raisedBy !== 'agent') {
    return failure('invalid', 'more information can be asked only of an item a ferret raised');
  }
  if (target.item.waitingOn !== undefined) return unchanged(ledger);
  const note = command.note?.trim() ?? '';
  const { undelivered: _undelivered, ...current } = target.item;
  const item: AgendaItem = {
    ...current,
    waitingOn: 'ferret',
    askedAt: command.at,
    resting: { sub: 'waiting-on-ferret', at: command.at },
    infoRequests: (target.item.infoRequests ?? 0) + 1,
    history: withHistory(target.item.history, { at: command.at, kind: 'needs-info', ...(note === '' ? {} : { note }) }),
    ...said(current, wordsOf(command.at, 'owner', 'needs-info', note)),
  };
  return replaceItem(ledger, item, command.at, 'needs-info');
}

/**
 * The owner wants to talk an item through before answering it — they do not understand it, or its premise
 * is wrong. The item stays OPEN, waiting on the ferret FOR a discussion (`waitingFor: 'discussion'`), and
 * the request is counted on the same counter as a request for more information (`infoRequests`), so its
 * delivery is exactly once. The ferret's edit ends it like it ends a request for information; so does any
 * closing. Asking again while it is still in discussion is the same request; asking while the ferret owes
 * more information turns that wait into a discussion, a new request.
 */
function discuss(ledger: AgendaLedger, command: DiscussCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner may ask to discuss an item');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.raisedBy !== 'agent') {
    return failure('invalid', 'only an item a ferret raised can be discussed: nobody else would hear it');
  }
  if (target.item.waitingOn !== undefined && target.item.waitingFor === 'discussion') return unchanged(ledger);
  const note = command.note?.trim() ?? '';
  const { undelivered: _undelivered, ...current } = target.item;
  const item: AgendaItem = {
    ...current,
    waitingOn: 'ferret',
    askedAt: command.at,
    waitingFor: 'discussion',
    resting: { sub: 'waiting-on-ferret', at: command.at },
    infoRequests: (target.item.infoRequests ?? 0) + 1,
    history: withHistory(target.item.history, { at: command.at, kind: 'discuss', ...(note === '' ? {} : { note }) }),
    ...said(current, wordsOf(command.at, 'owner', 'discuss', note)),
  };
  return replaceItem(ledger, item, command.at, 'discussing');
}

/**
 * The owner's chat message named an open item (`[re !A5 «title»] …`): the item CLOSES for the owner at once, as
 * `replied` — "the owner replied; nothing more is needed unless the ferret asks again" — and their words stay in
 * its history. It leaves every open list, badge and count, so an item the ferret never acts on cannot hang
 * around. Nothing is pushed and `infoRequests` does not move: the owner's message is itself what the ferret reads.
 * The ferret brings it back with `edit` and `back` (see {@link reopenReplied}) when it needs something new.
 * Whatever the item waited on (a discussion, more information) ends with it. Only the owner replies, only an
 * open item is replied to, and a notice is read, not replied to.
 */
function reply(ledger: AgendaLedger, command: ReplyCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner replies to an item');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  if (target.item.notice === true) return failure('invalid', 'a notice is read, not replied to');
  // A gate item is never parked by a chat message: nobody but the owner's answer could bring it back.
  if (isGateAgenda(target)) return unchanged(ledger);
  if (command.fromChat !== undefined && loggedFromChat(target.item, command.fromChat.messageId)) {
    return unchanged(ledger);
  }
  const words = command.note?.trim() ?? '';
  const note = words === '' ? null : words.slice(0, MAX_AGENDA_REPLY_LENGTH);
  return restOnOwnerWords(
    ledger,
    target.item,
    command.at,
    note,
    wordsOf(command.fromChat?.at ?? command.at, 'owner', 'reply', command.note, command.fromChat),
  );
}

/**
 * RESTING, not closed: the item leaves the owner's queue (and any discussion) and waits on the ferret, whose answer
 * brings it back to its place and whose `done` closes it. A reply to a snoozed or working item is a reply too.
 */
function restOnOwnerWords(
  ledger: AgendaLedger,
  item: AgendaItem,
  at: string,
  note: string | null,
  entry: AgendaConversationEntry | undefined,
): AgendaMutation {
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, parked: _p, resting: _r, ...open } = item;
  const rested: AgendaItem = {
    ...open,
    parked: { reason: 'replied', at },
    resting: { sub: 'waiting-on-ferret', at },
    history: withHistory(open.history, { at, kind: 'replied', ...(note === null ? {} : { note }) }),
    ...said(open, entry),
  };
  return replaceItem(ledger, rested, at, 'replied');
}

/**
 * What a ferret's edit that brings an item back does to a PARKED one: a RESTING item (parked as `replied`) comes back
 * to the owner, in its old place or a fresh one (`place`, see `placeOnReturn`); one the owner `snoozed` stays asleep
 * unless the ferret says it is urgent (`now`), and then at most once an hour per item (`AGENDA_URGENT_WAKE_MS`), fresh.
 * A newly asserted blocker (`blocker`) wakes it too, but it is a separate reason: the hourly throttle belongs to the
 * optional urgency only, so a new blocker is never left asleep because of an earlier urgent wake.
 * Anyone else's move, and any item in play, is returned as it is.
 */
function backFromParked(
  item: AgendaItem,
  actor: AgendaActor,
  at: string,
  now: boolean,
  place: 'old' | 'fresh' = 'fresh',
  blocker = false,
): AgendaItem | AgendaFailure {
  if (item.parked === undefined || actor.kind !== 'agent') return item;
  if (item.parked.reason === 'snoozed') {
    if (!now && !blocker) return item;
    if (
      now &&
      !blocker &&
      item.urgentAt !== undefined &&
      Date.parse(at) - Date.parse(item.urgentAt) < AGENDA_URGENT_WAKE_MS
    ) {
      return {
        code: 'rate-limited',
        message: `${item.id} was already woken as urgent at ${item.urgentAt}; the owner snoozed it, so it may be woken again an hour after that`,
      };
    }
  }
  const { parked, resting: _resting, ...rest } = item;
  // A woken snooze and a new ask are fresh; the ferret's answer to the owner's reply goes back to its old place.
  const fresh = parked.reason === 'snoozed' || place === 'fresh';
  return { ...rest, ...(fresh ? { waitingSince: at } : {}), ...(parked.reason === 'snoozed' ? { urgentAt: at } : {}) };
}

/**
 * The ferret LOGS the owner's chat message on an item it speaks for (docs/agenda.md § The conversation). The owner's
 * words, copied verbatim by the daemon, are entered with their chat tag and rest the item as a chat reply does; then
 * the ferret's `words` follow: `reply` answers them — the item is back with the owner, to its old place — and `rest`
 * says what it is doing, so the item rests as working. One message is logged on an item once. Nothing is written
 * unless both steps are.
 */
function log(ledger: AgendaLedger, command: LogCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (command.actor.kind !== 'agent' || !canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'only the ferret that raised an item (or its lead) logs the owner\u2019s words on it');
  }
  if (target.item.notice === true) return failure('invalid', 'a notice is read, not talked through');
  if (isGateAgenda(target)) return failure('forbidden', `${command.id} is a card's gate: only the owner answers it`);
  if (loggedFromChat(target.item, command.chat.messageId)) {
    return failure(
      'invalid',
      `message ${command.chat.messageId} is already on ${command.id}\u2019s conversation: its words are kept; answer them with an edit (--back) or take the item on with rest`,
    );
  }
  if (command.chat.text.trim() === '') return failure('invalid', 'the owner message has no words');
  const words = command.words.trim();
  if (words === '') return failure('invalid', 'say what you answer or what you are doing');
  if (command.mode === 'rest' && words.length > MAX_AGENDA_REST_WHY_LENGTH) {
    return failure(
      'too-long',
      `what you are doing is held to ${MAX_AGENDA_REST_WHY_LENGTH} characters: say it shorter`,
    );
  }
  const fromChat = { messageId: command.chat.messageId, at: command.chat.at };
  const rested = restOnOwnerWords(
    ledger,
    target.item,
    command.at,
    command.chat.text.slice(0, MAX_AGENDA_REPLY_LENGTH),
    wordsOf(command.chat.at, 'owner', 'chat-log', command.chat.text, fromChat),
  );
  if (!rested.ok) return rested;
  const next =
    command.mode === 'rest'
      ? rest(rested.ledger, { action: 'rest', actor: command.actor, id: command.id, why: words, at: command.at })
      : edit(rested.ledger, {
          action: 'edit',
          actor: command.actor,
          id: command.id,
          patch: { questionAnswer: words },
          at: command.at,
        });
  return next.ok ? { ...next, change: 'logged' } : next;
}

/** Without `machineId` a ref means "on this machine", which this layer cannot name, so a bare ref matches any machine's id. */
const sameCard = (left: TaskRef, right: TaskRef): boolean =>
  left.id === right.id &&
  (left.machineId === undefined || right.machineId === undefined || left.machineId === right.machineId);

/** `items` without a repeat, by `key`; the first of each kept, in order. */
function distinctBy<Item>(items: readonly Item[], key: (item: Item) => string): Item[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const each = key(item);
    if (seen.has(each)) return false;
    seen.add(each);
    return true;
  });
}

/**
 * A thread the owner and a ferret talk through: not a gate item, a notice, or a card the daemon acts on. One carrying
 * card asks is one (docs/agenda.md § Card asks): `gateAttached` is then only their mirror for an older app.
 */
function plainThread(item: AgendaItem): boolean {
  return (
    !isGateItem(item) &&
    item.notice !== true &&
    (item.gateAttached === undefined || item.cardAsks !== undefined) &&
    item.confirms === undefined &&
    item.kind !== 'input' &&
    item.input === undefined &&
    item.taskPlan === undefined &&
    item.copyPlan === undefined &&
    item.signInRuleSuggestion === undefined &&
    item.twoFactorSeed === undefined &&
    item.recipeProposal === undefined &&
    item.phoneApproval === undefined
  );
}

/**
 * `from` is MERGED INTO `id` (docs/agenda.md § Merge and split): the two are one thread. Their conversations are one,
 * interleaved by time; every card, related card and link of both is kept, and nothing is trimmed to fit — a merge that
 * would pass a bound is refused. `id` keeps its state and its ask, and takes `from`'s card asks, once per card and
 * entry ({@link joinCardAsks}). `from` closes as "merged into !<id>", carrying no card ask, with both
 * pointing at the other (`mergedFrom`, `mergedInto`) and its versions kept. The owner may merge, and a ferret over
 * its own board (or a lead over a sub-ferret's); never a gate, a notice or a card the daemon acts on, an item with
 * itself, or into a closed item.
 */
function merge(ledger: AgendaLedger, command: MergeCommand): AgendaMutation {
  if (command.id === command.from) return failure('invalid', `${command.id} cannot be merged into itself`);
  if (command.actor.kind === 'daemon') return failure('forbidden', 'only the owner or a ferret merges items');
  const active = ledger.entries.filter(isActiveAgenda);
  const into = active.find(entry => entry.item.id === command.id);
  const from = active.find(entry => entry.item.id === command.from);
  const closedOrMissing = (id: AgendaId): AgendaMutation =>
    ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === id)
      ? failure('invalid', `${id} is already done: merge into, and from, open items`)
      : failure('not-found', `no unresolved agenda item ${id} in this session`);
  if (into === undefined) return closedOrMissing(command.id);
  if (from === undefined) return closedOrMissing(command.from);
  if (!canAddressAgenda(command.actor, into) || !canAddressAgenda(command.actor, from)) {
    return failure(
      'forbidden',
      'a ferret merges only the items it raised (or a sub-ferret\u2019s); the owner merges any',
    );
  }
  for (const entry of [into, from]) {
    if (!plainThread(entry.item)) {
      return failure('invalid', `${entry.item.id} is a gate, a notice or a card the daemon acts on: it is not merged`);
    }
  }
  const survivor = into.item;
  const absorbed = from.item;
  const cards = distinctBy([...(survivor.cards ?? []), ...(absorbed.cards ?? [])], row => formatTaskRef(row.task));
  const links = distinctBy([...(survivor.links ?? []), ...(absorbed.links ?? [])], link => sortedJson(link));
  const adopts = survivor.task === undefined || survivor.task === null ? absorbed.task : undefined;
  const task = adopts ?? survivor.task;
  const related = distinctBy(
    [...(survivor.relatedTasks ?? []), ...(absorbed.task ? [absorbed.task] : []), ...(absorbed.relatedTasks ?? [])],
    formatTaskRef,
  ).filter(ref => task === undefined || task === null || !sameCard(ref, task));
  if (cards.length > MAX_AGENDA_CARDS || related.length > MAX_AGENDA_CARDS || links.length > MAX_AGENDA_LINKS) {
    return failure(
      'full',
      `${command.id} and ${command.from} hold more cards or links together than one item keeps (${MAX_AGENDA_CARDS} cards, ${MAX_AGENDA_LINKS} links): close what is done first`,
    );
  }
  // Every card ask of both rides the one item, once per card and entry; the absorbed item keeps none.
  const asked = joinCardAsks(survivor, absorbed.cardAsks ?? [], command.at, (item, stage) => ({
    ...item,
    ...staged(item, stage, command.at),
  }));
  if (asked.kind === 'refused') return failure(asked.code, asked.message);
  const conversation = mergedThreads(survivor.conversation, absorbed.conversation);
  const mergedFrom = distinctBy(
    [...(survivor.mergedFrom ?? []), absorbed.id, ...(absorbed.mergedFrom ?? [])],
    id => id,
  );
  const { cards: _cards, links: _links, task: _task, relatedTasks: _related, ...base } = asked.into;
  const merged: AgendaItem = {
    ...base,
    ...(cards.length === 0 ? {} : { cards }),
    ...(links.length === 0 ? {} : { links }),
    ...(task === undefined ? {} : { task }),
    ...(related.length === 0 ? {} : { relatedTasks: related }),
    ...(conversation.length === 0 ? {} : { conversation }),
    mergedFrom,
  };
  const bare = { ...from, item: withoutCardAsks(absorbed) };
  const kept: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry === into ? { ...into, item: tidied(merged) } : entry === from ? bare : entry,
    ),
  };
  const closed = addressed(
    kept,
    bare,
    command.actor,
    `merged into !${command.id}`,
    command.at,
    'dismissed',
    'dismissed',
  );
  if (!closed.ok || closed.addressed === undefined) return closed;
  const absorbedItem: ResolvedAgendaItem = { ...closed.addressed, mergedInto: command.id };
  const next: AgendaLedger = {
    ...closed.ledger,
    entries: closed.ledger.entries.map(entry =>
      entry.lifecycle === 'addressed' && entry.item.id === absorbedItem.id ? { ...entry, item: absorbedItem } : entry,
    ),
  };
  return success(next, true, 'merged', tidied(merged), absorbedItem);
}

/**
 * A new item is SPLIT OFF `id` (docs/agenda.md § Merge and split): part of it stopped passing the one-agenda test. The
 * new item is raised as a fresh item of the same ferret (its own ask, its own place in the owner's queue), linked both
 * ways (`splitFrom`, `splitInto`); the cards named in `moveCards` go along with it, and so do their card asks
 * ({@link leaveCardAsks}, {@link joinCardAsks}). `id` keeps its state, ask and
 * conversation. Refused for a gate, a notice or a card the daemon acts on, a card `id` does not hold, and a request an
 * open item of the ferret already makes.
 */
function split(ledger: AgendaLedger, command: SplitCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (command.actor.kind === 'daemon' || !canAddressAgenda(command.actor, target)) {
    return failure(
      'forbidden',
      'a ferret splits only the items it raised (or a sub-ferret\u2019s); the owner splits any',
    );
  }
  if (!plainThread(target.item)) {
    return failure('invalid', `${command.id} is a gate, a notice or a card the daemon acts on: it is not split`);
  }
  const original = target.item;
  const moving = command.moveCards ?? [];
  const holds = (ref: TaskRef): boolean =>
    (original.task !== undefined && original.task !== null && sameCard(original.task, ref)) ||
    (original.cards ?? []).some(row => sameCard(row.task, ref)) ||
    (original.relatedTasks ?? []).some(card => sameCard(card, ref)) ||
    (original.cardAsks ?? []).some(ask => ask.gate.cardId === ref.id);
  const missing = moving.find(ref => !holds(ref));
  if (missing !== undefined) return failure('invalid', `${formatTaskRef(missing)} is not a card of ${command.id}`);
  const made = raise(ledger, { action: 'raise', actor: target.origin, request: command.request, at: command.at });
  if (!made.ok) return made;
  if (made.change !== 'created' || made.item === undefined) {
    return failure('invalid', 'an open item of this ferret already says the same: nothing was split off');
  }
  const moves = (ref: TaskRef): boolean => moving.some(card => sameCard(card, ref));
  // A moved card's asks go with it (docs/agenda.md § Merge and split): the new item carries them, the original keeps the rest.
  const { left, moved } = leaveCardAsks(original, ask => moves({ id: ask.gate.cardId }), command.at);
  const carried = joinCardAsks(made.item, moved, command.at, (item, stage) => ({
    ...item,
    ...staged(item, stage, command.at),
  }));
  if (carried.kind === 'refused') return failure(carried.code, carried.message);
  const movedRows = (original.cards ?? []).filter(row => moves(row.task));
  const keptRows = (original.cards ?? []).filter(row => !moves(row.task));
  const movedRelated = (original.relatedTasks ?? []).filter(moves);
  const keptRelated = (original.relatedTasks ?? []).filter(ref => !moves(ref));
  const movesTask = original.task !== undefined && original.task !== null && moves(original.task);
  const { cards: _cards, task: _task, relatedTasks: _related, ...base } = left;
  const parent: AgendaItem = {
    ...base,
    ...(keptRows.length === 0 ? {} : { cards: keptRows }),
    ...(original.task === undefined || movesTask ? {} : { task: original.task }),
    ...(keptRelated.length === 0 ? {} : { relatedTasks: keptRelated }),
    splitInto: [...(original.splitInto ?? []), made.item.id],
  };
  const child: AgendaItem = {
    ...carried.into,
    ...(movedRows.length === 0 ? {} : { cards: movedRows }),
    ...(movesTask && original.task ? { task: original.task } : {}),
    ...(movedRelated.length === 0 ? {} : { relatedTasks: movedRelated }),
    splitFrom: original.id,
  };
  const next: AgendaLedger = {
    ...made.ledger,
    entries: made.ledger.entries.map(entry =>
      entry.lifecycle !== 'active'
        ? entry
        : entry.item.id === original.id
          ? { ...entry, item: parent }
          : entry.item.id === child.id
            ? { ...entry, item: child }
            : entry,
    ),
  };
  return success(next, true, 'split', child);
}

/** The owner puts an open item away until a time still ahead: off their queue, back as fresh when it wakes. */
function snooze(ledger: AgendaLedger, command: SnoozeCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner snoozes an item');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.notice === true) return failure('invalid', 'a notice is read, not snoozed');
  if (!(Date.parse(command.until) > Date.parse(command.at))) {
    return failure('invalid', 'snooze an item until a time that is still ahead');
  }
  // A snooze is the owner's: whatever the item rested on, it now sleeps until then (`tidied` drops the rest).
  const item: AgendaItem = { ...target.item, parked: { reason: 'snoozed', at: command.at, until: command.until } };
  return replaceItem(ledger, item, command.at, 'parked');
}

/** The waiting-on-ferret item a Warden record is about, when it is still in the rest the Warden saw. */
function restedFor(ledger: AgendaLedger, target: AgendaNudgeTarget) {
  const entry = ledger.entries.filter(isActiveAgenda).find(each => each.item.id === target.id);
  const view = entry === undefined ? undefined : agendaState(entry.item);
  if (entry === undefined || view?.state !== 'resting' || view.sub !== 'waiting-on-ferret') return undefined;
  const resting: AgendaResting = entry.item.resting ?? { sub: 'waiting-on-ferret', at: view.since };
  // A newer rest (the owner replied again) or a nudge already recorded is not the one the Warden looked at.
  return view.since === target.since && (resting.nudges ?? 0) === target.nudges ? { entry, resting } : undefined;
}

/**
 * The Warden decided on ONE nudge message (`sendId`) for these resting items, before it sends it: each item records
 * the id, so a sweep after a restart resumes that message — the same id, which the send path deduplicates — and not a
 * second one for the items it did not get to record. An item that is no longer the rest the Warden saw is skipped.
 */
function nudging(ledger: AgendaLedger, command: NudgingCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the Warden records a nudge');
  const marked = new Map<AgendaId, AgendaResting>();
  for (const target of command.items) {
    const rested = restedFor(ledger, target);
    if (rested !== undefined && rested.resting.nudgeSend === undefined) {
      marked.set(target.id, { ...rested.resting, nudgeSend: command.sendId });
    }
  }
  if (marked.size === 0) return unchanged(ledger);
  const next: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry => {
      if (entry.lifecycle !== 'active') return entry;
      const resting = marked.get(entry.item.id);
      return resting === undefined ? entry : { ...entry, item: { ...entry.item, resting } };
    }),
    updatedAt: command.at,
  };
  return success(next, true, 'nudged');
}

/**
 * The Warden nudged the ferret about a RESTING item waiting on it: the item records when, and how many times, so the
 * next nudge waits its backoff and a migrated item is never nudged twice. Only the daemon says so, and only of the
 * rest it nudged for (`since`, `nudges`) — a rest that has moved on since is left as it is.
 */
function nudged(ledger: AgendaLedger, command: NudgedCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the Warden records a nudge');
  const rested = restedFor(ledger, { id: command.id, since: command.since, nudges: command.nudges });
  if (rested === undefined) return unchanged(ledger);
  const { nudgeSend: _sent, ...resting } = rested.resting;
  const item: AgendaItem = {
    ...rested.entry.item,
    resting: { ...resting, nudgedAt: command.at, nudges: (resting.nudges ?? 0) + 1 },
  };
  return replaceItem(ledger, item, command.at, 'nudged');
}

/**
 * The raising ferret (or its lead) takes an item on without asking anything yet: it RESTS as `working`, saying what it
 * is doing — off the owner's queue, quiet, never nudged — until the ferret answers on it (it then asks again, fresh)
 * or marks it done. A wait for more information or a discussion ends with it: the ferret has the item. Refused for an
 * item the owner snoozed (theirs until then), a card's gate (the owner's), and a notice (read, not worked on).
 */
function rest(ledger: AgendaLedger, command: RestCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (command.actor.kind !== 'agent' || !canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'only the ferret that raised an item (or its lead) takes it on');
  }
  if (target.item.notice === true) return failure('invalid', 'a notice is read, not worked on');
  const waiting = restRefusal(target.item);
  if (waiting !== undefined) return failure('invalid', waiting);
  if (target.item.parked?.reason === 'snoozed') {
    return failure(
      'invalid',
      `${command.id} is snoozed by the owner until ${target.item.parked.until}: it stays away until then`,
    );
  }
  const why = command.why.trim();
  const view = agendaState(target.item);
  if (view.state === 'resting' && view.sub === 'working' && target.item.resting?.why === why) return unchanged(ledger);
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, resting: _r, ...open } = target.item;
  const item: AgendaItem = {
    ...open,
    parked: { reason: 'replied', at: command.at },
    resting: { sub: 'working', at: command.at, why },
    history: withHistory(open.history, { at: command.at, kind: 'updated', note: `working: ${why}` }),
    ...said(open, wordsOf(command.at, 'ferret', 'rest', why)),
  };
  return replaceItem(ledger, item, command.at, 'rested');
}

/**
 * The owner brings a parked item (snoozed, or replied to) back to their queue now. The daemon's own `system` actor
 * may too, for the one thing only it knows: the machine agenda's item gained a member the owner has not seen.
 */
function unsnooze(ledger: AgendaLedger, command: UnsnoozeCommand): AgendaMutation {
  const daemonItself = command.actor.kind === 'daemon' && command.actor.cause === 'system';
  if (command.actor.kind !== 'human' && !daemonItself) {
    return failure('forbidden', 'only the owner unsnoozes an item');
  }
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.parked === undefined) return unchanged(ledger);
  const { parked: _parked, ...item } = target.item;
  return replaceItem(ledger, item, command.at, 'unparked');
}

/**
 * The daemon's timer wakes a snoozed item whose time has come — its `until`, or its `neededBy` when that is
 * sooner (`agendaWakeAt`): back on the owner's queue, FRESH (`waitingSince` is now), so it reads as new and
 * unread. Only the daemon's own timer wakes an item; an item not yet due, or no longer snoozed, is left alone.
 */
function wake(ledger: AgendaLedger, command: WakeCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon' || command.actor.cause !== 'system') {
    return failure('forbidden', "only the daemon's timer wakes a snoozed item");
  }
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  const due = target === undefined ? null : agendaWakeAt(target.item);
  if (target === undefined || due === null || Date.parse(due) > Date.parse(command.at)) return unchanged(ledger);
  const { parked: _parked, ...item } = target.item;
  return replaceItem(ledger, { ...item, waitingSince: command.at }, command.at, 'woke');
}

/**
 * Why a ferret may not bring back an item the owner replied to as it stands, or `null` when it may: the owner's
 * reply changed what the ask is, so the card must be written again whole — the ask (`subject`), the `premise`
 * and the `context` — to stay an isolated, self-contained statement of what is going on. Restating a field
 * unchanged counts; leaving one out does not. `patch` is `null` for a bare `surface`, which is always refused;
 * `back` is the ferret's own word that it needs something new from the owner. Owner and daemon are exempt.
 * An ANSWER TO THE OWNER'S QUESTION (`questionAnswer`) is the exception: the ask has not changed, so the item comes
 * back as it was, with that answer above its own options.
 */
function repliedRefreshProblem(
  actor: AgendaActor,
  id: AgendaId,
  patch: EditAgendaPatch | null,
  back: boolean,
): string | null {
  if (actor.kind !== 'agent') return null;
  if (patch === null) {
    return `${id} rests, waiting on you, since the owner replied: answer on it — \`fy agenda answer ${id} "<text>"\` brings it back to their list in its old place — or \`fy agenda done ${id}\` when nothing more is expected; not surface`;
  }
  if (!back) {
    return `${id} rests, waiting on you, since the owner replied: \`fy agenda answer ${id} "<text>"\` brings it back to them`;
  }
  const blank = (field: string | null | undefined): boolean => (field ?? '').trim() === '';
  if (!blank(patch.questionAnswer)) return null;
  const missing = [
    ...(blank(patch.subject) ? ['--summary'] : []),
    ...(blank(patch.premise) ? ['--premise'] : []),
    ...(blank(patch.context) ? ['--context'] : []),
  ];
  return missing.length === 0
    ? null
    : `bring ${id} back with the whole card refreshed: --summary, --premise and --context are required after the owner replied (missing ${missing.join(', ')})`;
}

/**
 * The ferret needs more from the owner after a reply closed the item: it is open again, on the OWNER's turn,
 * with its id, history and edits kept. Called by `surface` (as it stands) and by the ferret's `edit` (with the
 * new wording). Only whoever may close the item may reopen it, and a full board cannot take it back.
 * Returns `undefined` when the item is not a replied one.
 */
function reopenReplied(
  ledger: AgendaLedger,
  id: AgendaId,
  actor: AgendaActor,
  at: string,
  entry: AgendaHistoryEntry,
  patch: EditAgendaPatch | null,
  back: boolean,
): AgendaMutation | undefined {
  const closed = ledger.entries.find(
    (candidate): candidate is Extract<AgendaEntry, { lifecycle: 'addressed' }> =>
      candidate.lifecycle === 'addressed' && candidate.item.id === id && candidate.item.disposition === 'replied',
  );
  if (closed === undefined) return undefined;
  const allowed = actor.kind === 'daemon' && actor.cause === 'system' ? true : canAddressAgenda(actor, closed);
  if (!allowed) return failure('forbidden', 'only the owner or the ferret that raised an item may bring it back');
  const stale = repliedRefreshProblem(actor, id, patch, back);
  if (stale !== null) return failure('invalid', stale);
  const active = ledger.entries.filter(isActiveAgenda);
  if (active.length + setAsideOf(ledger.unreadable).active >= MAX_AGENDA_PER_SESSION) {
    return failure('full', `${id} cannot reopen: this board already holds ${MAX_AGENDA_PER_SESSION} open items`);
  }
  const {
    resolvedAt: _resolvedAt,
    resolutionNote: _resolutionNote,
    response: _response,
    disposition: _disposition,
    resolvedBy: _resolvedBy,
    resolvedBySession: _resolvedBySession,
    resolvedByName: _resolvedByName,
    ...rest
  } = closed.item;
  const parsed = parseTransitionItem(
    fitAgendaItem({
      ...rest,
      history: withHistory(rest.history, entry),
      ...said(rest, entry.kind === 'surfaced' ? wordsOf(at, speakerOf(actor), 'surface', entry.note) : undefined),
    }),
  );
  if (!parsed.success) return unchanged(ledger);
  const next: AgendaLedger = {
    ...ledger,
    entries: [
      ...active,
      { lifecycle: 'active', origin: closed.origin, item: parsed.data },
      ...ledger.entries.filter(candidate => candidate !== closed && candidate.lifecycle === 'addressed'),
    ],
    updatedAt: at,
  };
  return success(next, true, 'reopened', parsed.data);
}

/**
 * An item leaves discussion for the owner's queue: the owner did not answer it in chat. The raising ferret
 * surfaces it (so does the owner, and the daemon's own timer), and only an open item in discussion moves.
 * An item already in the queue is left as it is, so surfacing twice is surfacing once; an item that waits on
 * the ferret for more information is not in discussion, and is answered by editing it.
 */
function surface(ledger: AgendaLedger, command: SurfaceCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    const why = command.why?.trim() ?? '';
    const reopened = reopenReplied(
      ledger,
      command.id,
      command.actor,
      command.at,
      { at: command.at, kind: 'surfaced', ...(why === '' ? {} : { note: why }) },
      null,
      false,
    );
    if (reopened !== undefined) return reopened;
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  // The daemon's resurface timer (`system`) may surface any item; a warden or a source may surface only its own.
  const allowed =
    command.actor.kind === 'daemon' && command.actor.cause === 'system'
      ? true
      : canAddressAgenda(command.actor, target);
  if (!allowed) {
    return failure('forbidden', 'only the owner, the ferret that raised an item, or the daemon timer may surface it');
  }
  if (target.item.parked !== undefined) {
    if (target.item.parked.reason === 'replied') {
      const stale = repliedRefreshProblem(command.actor, command.id, null, false);
      if (stale !== null) return failure('invalid', stale);
    }
    const back = backFromParked(target.item, command.actor, command.at, command.now === true);
    if ('code' in back) return failure(back.code, back.message);
    if (back === target.item) return unchanged(ledger);
    const why = command.why?.trim() ?? '';
    // Surfacing also ends a discussion the item was in when it was parked: it is the owner's turn now.
    const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = back;
    const item: AgendaItem = {
      ...(back.waitingFor === 'discussion' ? open : back),
      history: withHistory(back.history, { at: command.at, kind: 'surfaced', ...(why === '' ? {} : { note: why }) }),
      ...said(back, wordsOf(command.at, speakerOf(command.actor), 'surface', why)),
    };
    return replaceItem(ledger, item, command.at, 'unparked');
  }
  if (target.item.waitingOn === undefined) return unchanged(ledger);
  if (target.item.waitingFor !== 'discussion') {
    return failure('invalid', `${command.id} waits on more information, not on a discussion: edit it instead`);
  }
  const why = command.why?.trim() ?? '';
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
  const item: AgendaItem = {
    ...open,
    history: withHistory(target.item.history, {
      at: command.at,
      kind: 'surfaced',
      ...(why === '' ? {} : { note: why }),
    }),
    ...said(open, wordsOf(command.at, speakerOf(command.actor), 'surface', why)),
  };
  return replaceItem(ledger, item, command.at, 'surfaced');
}

/**
 * The owner's action never reached the ferret, so the item goes back to the owner as a card
 * (docs/agenda.md § Delivery). Only the daemon says so, and only of an item a ferret raised.
 *
 * - An ANSWER (or done, or dismiss) that was not delivered: the closed item is OPEN again, with what the
 *   owner did kept in `undelivered` so a retry is one tap. An item no longer in the board's history, or
 *   already open again, is left alone.
 * - A request for more information or to discuss (`request`): the item stops waiting on the ferret, but
 *   only while it is still waiting on THAT request — the ferret may have answered it, or the owner asked
 *   again, since.
 *
 * A board already full of open items keeps the answer closed: the item cannot fit, and refusing is the
 * one honest outcome (the caller records it).
 */
function undelivered(ledger: AgendaLedger, command: UndeliveredCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the daemon may report an undelivered answer');
  const active = ledger.entries.filter(isActiveAgenda);
  if (command.request !== undefined) {
    const target = active.find(entry => entry.item.id === command.id);
    // An ANSWER that rested the item and never arrived: the item is the owner's again, in its old place, with the
    // answer kept for a retry — but only while it still rests, waiting on the ferret, from that very answer: the
    // ferret may have taken it on (`rest --why`) or the owner replied again since, and then the old failure is stale.
    const answer = target?.item.ownerAnswer;
    if (
      target !== undefined &&
      answer?.request === command.request &&
      target.item.parked?.reason === 'replied' &&
      target.item.resting?.sub === 'waiting-on-ferret' &&
      target.item.resting.at === answer.at
    ) {
      const { parked: _p, resting: _r, ...open } = target.item;
      const item: AgendaItem = {
        ...open,
        undelivered: {
          at: command.at,
          reply: {
            action: 'resolve',
            response: answer.response,
            ...(answer.note === undefined || answer.note.trim() === '' ? {} : { note: answer.note }),
          },
          reason: command.reason,
        },
      };
      return replaceItem(ledger, item, command.at, 'reopened');
    }
    if (target === undefined || target.item.waitingOn === undefined || target.item.infoRequests !== command.request)
      return unchanged(ledger);
    const note = lastNote(target.item.history, target.item.waitingFor === 'discussion' ? 'discuss' : 'needs-info');
    const action = target.item.waitingFor === 'discussion' ? ('discuss' as const) : ('needs-info' as const);
    const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
    const item: AgendaItem = {
      ...open,
      undelivered: {
        at: command.at,
        reply: { action, ...(note === undefined ? {} : { note }) },
        reason: command.reason,
      },
    };
    return replaceItem(ledger, item, command.at, 'reopened');
  }
  if (active.some(entry => entry.item.id === command.id)) return unchanged(ledger);
  const closed = ledger.entries.find(
    (entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> =>
      entry.lifecycle === 'addressed' && entry.item.id === command.id,
  );
  if (closed === undefined || closed.item.raisedBy !== 'agent') return unchanged(ledger);
  if (active.length + setAsideOf(ledger.unreadable).active >= MAX_AGENDA_PER_SESSION)
    return failure(
      'full',
      `${command.id} cannot reopen: this board already holds ${MAX_AGENDA_PER_SESSION} open items`,
    );
  const {
    resolvedAt: _resolvedAt,
    resolutionNote,
    response,
    disposition,
    resolvedBy: _resolvedBy,
    resolvedBySession: _resolvedBySession,
    resolvedByName: _resolvedByName,
    ...rest
  } = closed.item;
  const note = resolutionNote?.trim() === '' ? undefined : (resolutionNote ?? undefined);
  const reply: AgendaUndelivered['reply'] =
    disposition === 'dismissed'
      ? { action: 'dismiss', ...(note === undefined ? {} : { note }) }
      : {
          action: 'resolve',
          ...(note === undefined ? {} : { note }),
          ...(response === undefined ? {} : { response }),
        };
  const parsed = parseTransitionItem(
    fitAgendaItem({ ...rest, undelivered: { at: command.at, reply, reason: command.reason } }),
  );
  if (!parsed.success) return unchanged(ledger);
  const next: AgendaLedger = {
    ...ledger,
    entries: [
      ...active,
      { lifecycle: 'active', origin: closed.origin, item: parsed.data },
      ...ledger.entries.filter(entry => entry !== closed && entry.lifecycle === 'addressed'),
    ],
    updatedAt: command.at,
  };
  return success(next, true, 'reopened', parsed.data);
}

/**
 * The held change an item confirms moved on (docs/agenda.md § Confirming a configuration change): the item
 * names the new change and its digest, marked `restated` so the card says it was edited, and its premise is the
 * new change's words — kept as a revision by the daemon. It is the owner's turn again: a wait on the ferret ends.
 * Only the daemon says so, and only of an open item that confirms the same file.
 */
function restateConfirms(ledger: AgendaLedger, command: RestateConfirmsCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the daemon may restate a confirmation');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.confirms?.path !== command.confirms.path) {
    return failure('invalid', `${command.id} does not confirm a change to ${command.confirms.path}`);
  }
  const confirms: AgendaConfirms = { ...command.confirms, restated: true };
  if (sameField(confirms, target.item.confirms) && target.item.premise === command.premise) return unchanged(ledger);
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
  const premiseChanged = target.item.premise !== command.premise;
  const revision: AgendaRevision = {
    at: command.at,
    by: 'daemon',
    changed: ['premise'],
    previous: target.item.premise === undefined ? {} : { premise: target.item.premise },
  };
  const item: AgendaItem = {
    ...open,
    confirms,
    premise: command.premise,
    ...(premiseChanged ? { revisions: [...(target.item.revisions ?? []), revision].slice(-MAX_AGENDA_REVISIONS) } : {}),
  };
  return replaceItem(ledger, item, command.at, 'refreshed');
}

/**
 * A card ask on an open agenda (docs/agenda.md § Card asks): put on it, restated, withdrawn, or answered
 * (`applyCardAsk`). Only the daemon writes one, and only on an open agenda that can carry it: not a notice (it asks
 * nothing) and not a standalone gate item from before card asks (it IS the ask).
 */
function cardAsk(ledger: AgendaLedger, command: CardAskCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the daemon puts a card ask on an agenda');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (isGateItem(target.item) || target.item.notice === true) {
    return failure('invalid', `${command.id} is a gate item or a notice, so it carries no card ask`);
  }
  const outcome = applyCardAsk(target.item, command.operation, command.at, {
    stage: (item, stage) => ({ ...item, ...staged(item, stage, command.at) }),
    history: (item, kind, note) => ({ ...item, history: withHistory(item.history, { at: command.at, kind, note }) }),
    tidy: item => fitAgendaItem(tidied(item)),
  });
  if (outcome.kind === 'unchanged') return unchanged(ledger);
  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message);
  if (outcome.kind === 'closed') {
    const moved = { ...target, item: outcome.item };
    const entries = ledger.entries.map(entry => (entry === target ? moved : entry));
    return addressed({ ...ledger, entries }, moved, command.actor, outcome.note, command.at, 'done', 'resolved');
  }
  return replaceItem(ledger, outcome.item, command.at, outcome.change);
}

/**
 * An open thread is linked to a card: its `task` is set, and it is otherwise left exactly as it was. A thread that
 * already names another card is refused: one thread, one card.
 */
function linkTask(ledger: AgendaLedger, command: LinkTaskCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the daemon may link a thread to a card');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (isGateItem(target.item) || target.item.notice === true) {
    return failure('invalid', `${command.id} is a gate item or a notice, so it carries no card`);
  }
  const linked = target.item.task;
  if (linked !== undefined && linked !== null) {
    if (linked.id === command.task.id && linked.machineId === command.task.machineId) return unchanged(ledger);
    return failure('invalid', `${command.id} is already linked to ${formatTaskRef(linked)}`);
  }
  return replaceItem(ledger, { ...target.item, task: command.task }, command.at, 'refreshed');
}

/** The note on the newest history entry of this kind, if it had one. */
function lastNote(
  history: readonly AgendaHistoryEntry[] | undefined,
  kind: AgendaHistoryEntry['kind'],
): string | undefined {
  return history?.findLast(entry => entry.kind === kind)?.note;
}

function stepRange(id: AgendaId, count: number, step: number): string {
  return count === 0 ? `${id} has no steps` : `${id} has steps 0 to ${count - 1}, not ${step}`;
}

function sameSteps(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Ticks or unticks one step of an OPEN item. It is progress, not resolution: the item stays open, nobody
 * is pushed and the ferret is told nothing. The owner may do it, and so may the ferret that raised the item.
 */
function progress(ledger: AgendaLedger, command: ProgressCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (!canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may tick steps only on an agenda item it raised');
  }
  const count = target.item.steps?.length ?? 0;
  if (command.step >= count) return failure('invalid', stepRange(command.id, count, command.step));
  const before = target.item.stepsDone ?? [];
  if (before.includes(command.step) === command.done) return unchanged(ledger);
  const after = (command.done ? [...before, command.step] : before.filter(step => step !== command.step)).sort(
    (left, right) => left - right,
  );
  const { stepsDone: _previous, ...rest } = target.item;
  const item: AgendaItem = { ...rest, ...(after.length === 0 ? {} : { stepsDone: after }) };
  const next: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === item.id ? { ...entry, item } : entry,
    ),
    updatedAt: command.at,
  };
  return success(next, true, 'progressed', item);
}
