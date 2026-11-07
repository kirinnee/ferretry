/**
 * THE PROJECT BOARD's wire and storage shapes: one board per project, holding the cards of every ferret that works there.
 * Copied from today's `protocol/src/lib/{board,board-projects,board-refs,tasks}.ts` (+ #1552's `PrLink.changes`) with the
 * words renamed (task -> card, status -> progress, session -> ferret, agenda item -> ask), every compatibility member
 * dropped (`legacyRef`, the `migrated` event, the `#` sigil, `BoardImport`, the deprecated waiting/to-test members) and
 * every stored format starting at 1.
 *
 * - **A card is the only work record, and read-only status.** Its lane, ask, links and history live here; a question for
 *   the owner is an ask in the Agenda (Asks source `card`, {@link CardAskRefSchema}). Nothing is copied both ways.
 * - **Stored vs derived.** {@link CardSchema} is what the daemon writes. {@link CardViewSchema} adds what is derived at
 *   read time from ferret liveness, Asks and other cards, and is never stored.
 * - **History is append-only and gap-free**, and a move back or a reopen always says why.
 */
import { z } from 'zod';
import {
  DependencyUntilSchema,
  ExternalLaneTriggerSchema,
  isBackwardMove,
  isExternalTrigger,
  type LaneCategory,
  LaneIdSchema,
  LaneLayoutSchema,
  type LaneLookupError,
  LaneRenamesSchema,
  type LaneSet,
  LaneSetSchema,
  LaneTemplateNameSchema,
  LaneTriggerSchema,
} from './lanes.ts';
import {
  BoardAttachmentIdSchema,
  BoardProjectIdSchema,
  BoardReopenAttachmentsSchema,
  type BoardResult,
  BoardSkipSchema,
  CardIdSchema,
  boardErr,
  boardOk,
  MachineIdSchema,
  MAX_BOARD_REOPEN_ATTACHMENTS,
  type CardRef,
  CardRefSchema,
  CardActorViaSchema,
  FerretRefSchema,
} from './refs.ts';
import { NonNegativeIntegerSchema, PositiveIntegerSchema } from '@ferretry/std';
import { BoardInstantSchema as InstantSchema } from './refs.ts';
import {
  CARD_KIND_PREFIX,
  type CardKind,
  CardKindSchema,
  CardMessageSchema,
  CardTitleSchema,
  unnestBullets,
  WorkflowSchema,
} from './workflow.ts';

export const CARD_FORMAT = 1 as const;
export const MAX_CARD_SUMMARY_LENGTH = 140;
export const MAX_BOARD_PREMISE_LENGTH = 4 * 1024;
export const MAX_BOARD_CONTEXT_LENGTH = 16 * 1024;
/** The owner's test steps: a short checklist, sized like the context. */
export const MAX_BOARD_HOW_TO_TEST_LENGTH = 16 * 1024;
/** Each part of a card's status (Now, Done so far, Next): the three together are at most 24 KiB. */
export const MAX_PROGRESS_PART_LENGTH = 8 * 1024;
export const MAX_CARD_BRIEF_LENGTH = 64 * 1024;
export const MAX_BOARD_REASON_LENGTH = 2 * 1024;
export const MAX_CARD_NOTE_LENGTH = 2 * 1024;
export const MAX_BOARD_SOURCE_LENGTH = 2 * 1024;
export const MAX_BOARD_TERMS = 32;
export const MAX_BOARD_TERM_LENGTH = 80;
export const MAX_BOARD_TERM_MEANING_LENGTH = 400;
export const MAX_BOARD_CLARIFICATIONS = 128;
export const MAX_BOARD_DEPENDENCIES = 128;
export const MAX_BOARD_LINK_LENGTH = 512;
export const MAX_BOARD_LINKS_PER_FIELD = 64;
export const MAX_BOARD_FILES = 256;
export const MAX_BOARD_FILE_LENGTH = 1024;
export const MAX_BOARD_QUERY_LENGTH = 200;
export const MAX_BOARD_PAGE = 500;
export const DEFAULT_BOARD_PAGE = 100;
export const MAX_BOARD_ATTACHMENT_NAME_LENGTH = 255;

const reason = z.string().trim().min(1).max(MAX_BOARD_REASON_LENGTH);

/**
 * A file the owner sent with a move back, as the card's history names it: enough to say "2 images" and to
 * open it from the ferret's chat, never its bytes.
 */
export const BoardAttachmentSchema = z.object({
  id: BoardAttachmentIdSchema,
  filename: z.string().min(1).max(MAX_BOARD_ATTACHMENT_NAME_LENGTH),
  mime: z.string().min(1).max(MAX_BOARD_ATTACHMENT_NAME_LENGTH),
});
export type BoardAttachment = z.infer<typeof BoardAttachmentSchema>;

const oneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine(value => !/[\r\n]/u.test(value), 'one line');

/** The id prefix a kind's cards carry: `F` for a feature. Kind is immutable because the prefix must match. */
export const cardIdPrefix = (kind: CardKind): string => CARD_KIND_PREFIX[kind];

// ---------------------------------------------------------------------------------------------------
// Ask references
// ---------------------------------------------------------------------------------------------------

/** An ask's id on its ferret's own ledger (`A48`): Asks keeps per-ferret ledgers and `A<n>` ids. */
export const AskIdTextSchema = z.string().regex(/^A[1-9][0-9]*$/u, 'an ask id is A and a number');

/** An ask, named. Ask ids repeat per ferret, so the ferret is part of the name. */
export const AskRefSchema = z.strictObject({ ferret: FerretRefSchema, id: AskIdTextSchema });
export type AskRef = z.infer<typeof AskRefSchema>;

/** The sigil of the `!ask` reference kind. Cards are `&`, asks `!`, and the two never swap. */
export const ASK_REF_SIGIL = '!';

/** How an ask is written: `!A48`. */
export const formatAskRef = (ref: AskRef): string => `${ASK_REF_SIGIL}${ref.id}`;

// ---------------------------------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------------------------------

/**
 * Who did something to a card. A ferret is always a session; the owner may have acted from one (a chat)
 * or from nowhere in particular (the Board page); the daemon names the session it acted for, if any.
 *
 * The union is CLOSED and each member strict, so it never grows: an older reader would refuse a whole board
 * over one member it does not know. What the daemon knows beyond it travels beside it ({@link CardActorVia}).
 */
export const CardActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ferret'), ferret: FerretRefSchema }),
  z.strictObject({ kind: z.literal('owner'), ferret: FerretRefSchema.optional() }),
  z.strictObject({ kind: z.literal('daemon'), ferret: FerretRefSchema.optional() }),
]);
export type CardActor = z.infer<typeof CardActorSchema>;

// ---------------------------------------------------------------------------------------------------
// Card parts
// ---------------------------------------------------------------------------------------------------

/** One more thing the owner said about the ask, verbatim. */
export const BoardClarificationSchema = z.object({
  text: z.string().min(1).max(MAX_CARD_BRIEF_LENGTH),
  source: z.string().min(1).max(MAX_BOARD_SOURCE_LENGTH),
  at: InstantSchema,
  by: CardActorSchema,
  /** {@link CardActorVia}: absent unless the owner actor was the admin token. */
  byVia: CardActorViaSchema.optional(),
});
export type BoardClarification = z.infer<typeof BoardClarificationSchema>;

/** One row of a card's glossary: the work's ubiquitous language, spelled out for a newcomer. */
export const BoardTermSchema = z.strictObject({
  term: oneLine(MAX_BOARD_TERM_LENGTH).pipe(z.string().min(1)),
  meaning: z.string().trim().min(1).max(MAX_BOARD_TERM_MEANING_LENGTH),
});
export type BoardTerm = z.infer<typeof BoardTermSchema>;

export const BoardTermsSchema = z
  .array(BoardTermSchema)
  .max(MAX_BOARD_TERMS)
  .refine(
    terms => new Set(terms.map(entry => entry.term.toLowerCase())).size === terms.length,
    'each term appears once',
  );

/** The owner's override of one dependency: the card may advance although the blocker is not done. */
export const DependencyOverrideSchema = z.strictObject({ by: z.literal('owner'), reason, at: InstantSchema });
export type DependencyOverride = z.infer<typeof DependencyOverrideSchema>;

export const BoardDependencySchema = z.object({
  task: CardRefSchema,
  until: DependencyUntilSchema,
  override: DependencyOverrideSchema.optional(),
});
export type BoardDependency = z.infer<typeof BoardDependencySchema>;

/** An outside-world blocker. Blocks by the owner or by another card are derived, never stored here. */
export const ExternalBlockSchema = z.strictObject({ on: z.literal('external'), reason, since: InstantSchema });
export type ExternalBlock = z.infer<typeof ExternalBlockSchema>;

/** A card that was abandoned or superseded. Terminal and hidden like Closed, until a reopen clears it. */
export const BoardDropSchema = z.strictObject({ reason, at: InstantSchema });
export type BoardDrop = z.infer<typeof BoardDropSchema>;

/** The release a merged PR first shipped in, from the first `v*` tag containing its merge commit. */
export const ReleasedInSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  tag: z.string().min(1).max(MAX_BOARD_LINK_LENGTH),
  at: InstantSchema,
});
export type ReleasedIn = z.infer<typeof ReleasedInSchema>;

/** What GitHub said of a PR. `unknown` until the watcher has polled it once. */
export const PrStateSchema = z.enum(['unknown', 'open', 'closed', 'merged']);
export type PrState = z.infer<typeof PrStateSchema>;

/** The PR's CI checks, summarised: none run, some still running, all passing, or any failing. */
export const PrChecksSchema = z.enum(['none', 'pending', 'passing', 'failing']);
export type PrChecks = z.infer<typeof PrChecksSchema>;

/**
 * What a PR changed, as the watcher read its files: `docs-tests` when every file is a doc, a design note or a test,
 * else `code`. Absent on a link nobody has read the files of: an unknown kind is treated as code.
 */
export const PrChangeKindSchema = z.enum(['docs-tests', 'code']);
export type PrChangeKind = z.infer<typeof PrChangeKindSchema>;

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/u;

/** The `owner/name` and number a GitHub PR URL names, or `null` when it is not one. */
export const prUrlParts = (url: string): { readonly repo: string; readonly number: number } | null => {
  const match = PR_URL.exec(url);
  return match?.[1] === undefined ? null : { repo: match[1], number: Number(match[2]) };
};

/**
 * A linked pull request: the URL somebody linked, plus the watcher's cache of what GitHub says about it.
 * The cache is a labelled projection (`polledAt`), never edited by hand; GitHub owns the facts.
 */
export const PrLinkSchema = z
  .object({
    url: z.string().max(MAX_BOARD_LINK_LENGTH).regex(PR_URL, 'a GitHub pull request URL'),
    number: PositiveIntegerSchema,
    repo: z.string().min(1).max(MAX_BOARD_LINK_LENGTH),
    state: PrStateSchema,
    draft: z.boolean(),
    checks: PrChecksSchema,
    mergedAt: InstantSchema.nullable(),
    mergeSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    releasedIn: ReleasedInSchema.nullable(),
    polledAt: InstantSchema.nullable(),
    /** When the PR was opened on GitHub; absent on a link cached before the watcher read it. */
    createdAt: InstantSchema.nullable().optional(),
    /** What the PR changed (docs and tests only, or code); absent when its files were not read: an older link. */
    changes: PrChangeKindSchema.optional(),
    /**
     * The commit `changes` was read at: the head while the PR is open, the merge commit once merged. A kind is kept
     * across polls only for that SAME commit; absent on a link cached before it was kept, whose kind then goes unless a
     * poll reads the files again.
     */
    changesRevision: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .optional(),
  })
  .superRefine((value, context) => {
    const parts = prUrlParts(value.url);
    if (parts !== null && (parts.repo !== value.repo || parts.number !== value.number)) {
      context.addIssue({ code: 'custom', message: 'repo and number must be the ones the URL names', path: ['url'] });
    }
    if (value.polledAt === null && value.state !== 'unknown') {
      context.addIssue({ code: 'custom', message: 'a PR never polled has an unknown state', path: ['state'] });
    }
    const merged = value.state === 'merged';
    if (merged !== (value.mergedAt !== null) || merged !== (value.mergeSha !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'mergedAt and mergeSha are set exactly when merged',
        path: ['state'],
      });
    }
    if (value.releasedIn !== null && !merged) {
      context.addIssue({ code: 'custom', message: 'only a merged PR is in a release', path: ['releasedIn'] });
    }
  });
export type PrLink = z.infer<typeof PrLinkSchema>;

const linkValue = z.string().trim().min(1).max(MAX_BOARD_LINK_LENGTH);

export const CardLinksSchema = z.object({
  prs: z
    .array(PrLinkSchema)
    .max(MAX_BOARD_LINKS_PER_FIELD)
    .refine(prs => new Set(prs.map(pr => pr.url)).size === prs.length, 'each PR is linked once'),
  branch: linkValue.nullable(),
  commits: z.array(linkValue).max(MAX_BOARD_LINKS_PER_FIELD),
  docs: z.array(linkValue).max(MAX_BOARD_LINKS_PER_FIELD),
});
export type CardLinks = z.infer<typeof CardLinksSchema>;

export const BoardLinkFieldSchema = z.enum(['pr', 'branch', 'commit', 'doc']);
export type BoardLinkField = z.infer<typeof BoardLinkFieldSchema>;

/** The card fields an edit may change, each recorded as its own `field-edited` event. */
export const BoardEditableFieldSchema = z.enum([
  'title',
  'summary',
  'premise',
  'context',
  'terms',
  'brief',
  'howToTest',
  'progress',
]);
export type BoardEditableField = z.infer<typeof BoardEditableFieldSchema>;

// ---------------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------------

const EventBase = {
  seq: PositiveIntegerSchema,
  at: InstantSchema,
  actor: CardActorSchema,
  /** {@link CardActorVia}: absent unless the owner actor was the admin token. */
  actorVia: CardActorViaSchema.optional(),
};

/**
 * A lane move. `backward` is recorded by the writer, which had the lane set in hand, so the event can
 * enforce on its own that a move back says why. A daemon move is `auto` and names its trigger. A move on an
 * external trigger somebody reported (the task action `trigger`) is still the daemon's, and `reportedBy`
 * says who reported it (`reportedVia` beside it, as `actorVia` is beside the actor).
 */
const MovedEventSchema = z
  .object({
    ...EventBase,
    type: z.literal('moved'),
    from: LaneIdSchema,
    to: LaneIdSchema,
    backward: z.boolean(),
    reason: reason.nullable(),
    auto: z.literal(true).optional(),
    trigger: LaneTriggerSchema.optional(),
    reportedBy: CardActorSchema.optional(),
    reportedVia: CardActorViaSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.from === value.to) context.addIssue({ code: 'custom', message: 'a move changes lane', path: ['to'] });
    if (value.backward && value.reason === null) {
      context.addIssue({ code: 'custom', message: 'a backward move needs a reason', path: ['reason'] });
    }
    if ((value.auto === true) !== (value.trigger !== undefined)) {
      context.addIssue({ code: 'custom', message: 'an automatic move names its trigger', path: ['trigger'] });
    }
    if (value.auto === true && value.actor.kind !== 'daemon') {
      context.addIssue({ code: 'custom', message: 'only the daemon moves a card automatically', path: ['auto'] });
    }
    if (value.reportedBy !== undefined && (value.trigger === undefined || !isExternalTrigger(value.trigger))) {
      context.addIssue({ code: 'custom', message: 'only an external trigger is reported', path: ['reportedBy'] });
    }
    if (value.reportedVia !== undefined && value.reportedBy === undefined) {
      context.addIssue({ code: 'custom', message: 'how it was reported needs who reported it', path: ['reportedVia'] });
    }
  });

/**
 * The card's history. Every event names its actor; the union is closed, so an event this build does not
 * know is refused rather than half-read.
 */
export const CardEventSchema = z.discriminatedUnion('type', [
  z.object({ ...EventBase, type: z.literal('created'), laneId: LaneIdSchema }),
  MovedEventSchema,
  /** The owner's words that reopened it are ALSO appended to the card's clarifications: they are a new ask. */
  z.object({
    ...EventBase,
    type: z.literal('reopened'),
    from: LaneIdSchema,
    to: LaneIdSchema,
    reason,
    ask: CardMessageSchema,
    /** The files the owner sent with it; absent when there were none. */
    attachments: z.array(BoardAttachmentSchema).min(1).max(MAX_BOARD_REOPEN_ATTACHMENTS).optional(),
  }),
  z.object({ ...EventBase, type: z.literal('note'), text: z.string().trim().min(1).max(MAX_CARD_NOTE_LENGTH) }),
  z.object({
    ...EventBase,
    type: z.literal('clarified'),
    text: z.string().min(1).max(MAX_CARD_BRIEF_LENGTH),
    source: z.string().min(1).max(MAX_BOARD_SOURCE_LENGTH),
  }),
  z.object({ ...EventBase, type: z.literal('linked'), field: BoardLinkFieldSchema, value: linkValue }),
  z.object({
    ...EventBase,
    type: z.literal('assigned'),
    from: FerretRefSchema.nullable(),
    to: FerretRefSchema.nullable(),
    /** Present when the card's assignee handed it down to one of its own descendants; the actor is that assignee. */
    handedDown: z.literal(true).optional(),
    /** Present when the daemon returned the card to a live lead because this ferret, its assignee, ended: the one that finished. */
    returnedFrom: FerretRefSchema.optional(),
    /** Present when the card's assignee took it from a lead of its own (`fy card claim`): the lead that held it. The actor is the claimer. */
    claimedFrom: FerretRefSchema.optional(),
    /** Present when a live lead adopted the card because its owner ferret and its assignee had both ended (`fy card adopt`): the owner ferret it took the card from, and why. The actor is the adopter. */
    adopted: z.strictObject({ from: FerretRefSchema, reason }).optional(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('depended'),
    task: CardRefSchema,
    until: DependencyUntilSchema,
    override: DependencyOverrideSchema.optional(),
  }),
  z.object({ ...EventBase, type: z.literal('undepended'), task: CardRefSchema, reason }),
  z.object({ ...EventBase, type: z.literal('blocked'), reason }),
  z.object({ ...EventBase, type: z.literal('unblocked'), reason: reason.nullable() }),
  z.object({ ...EventBase, type: z.literal('field-edited'), field: BoardEditableFieldSchema }),
  z.object({ ...EventBase, type: z.literal('file-claimed'), path: z.string().min(1).max(MAX_BOARD_FILE_LENGTH) }),
  z.object({
    ...EventBase,
    type: z.literal('file-released'),
    path: z.string().min(1).max(MAX_BOARD_FILE_LENGTH),
    reason: reason.nullable(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('ordered'),
    from: NonNegativeIntegerSchema.nullable(),
    to: NonNegativeIntegerSchema.nullable(),
  }),
  /** The owner put the card aside until `until`, or woke it early (`until: null`). */
  z.object({ ...EventBase, type: z.literal('snoozed'), until: InstantSchema.nullable() }),
  z.object({
    ...EventBase,
    type: z.literal('refiled'),
    fromProject: BoardProjectIdSchema,
    toProject: BoardProjectIdSchema,
    toLane: LaneIdSchema,
    reason: reason.nullable(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('reparented'),
    from: CardRefSchema.nullable(),
    to: CardRefSchema.nullable(),
    reason: reason.nullable(),
  }),
  z.object({ ...EventBase, type: z.literal('dropped'), reason }),
]);
export type CardEvent = z.infer<typeof CardEventSchema>;
export type CardEventType = CardEvent['type'];

// ---------------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------------

/** Who asked for the work, for the surfaces that wait on the owner: a `person`, or an `agent` on its own errand. */
export const CardAskedBySchema = z.enum(['person', 'agent']);
export type CardAskedBy = z.infer<typeof CardAskedBySchema>;

/**
 * Whether a card is on the board by default. `public` is what the owner asked for; `private` is the ferrets' own
 * bookkeeping: sub-cards, helper cards and cards a ferret made for itself (docs/board.md § Public and private cards).
 */
export const CardVisibilitySchema = z.enum(['public', 'private']);
export type CardVisibility = z.infer<typeof CardVisibilitySchema>;

/**
 * Where a stored visibility came from: `default` is the one the daemon derived from who asked and where the card
 * sits, and re-derives when those facts change; `chosen` was set by a person or a ferret and is never re-derived.
 */
export const CardVisibilitySourceSchema = z.enum(['default', 'chosen']);
export type CardVisibilitySource = z.infer<typeof CardVisibilitySourceSchema>;

/**
 * A card's status: its current state in three Markdown parts, kept current by the ferret that holds the card. An edit
 * names the parts it replaces and the daemon merges them in the card's own write. A part with nothing to say is ''.
 * The field itself is optional on a card: absent means no status yet, and no reader invents one.
 */
export const ProgressSchema = z.strictObject({
  /** What is happening on the card at this moment. */
  now: z.string().max(MAX_PROGRESS_PART_LENGTH),
  /** What is implemented, one bullet each, with the PR link where there is one. */
  doneSoFar: z.string().max(MAX_PROGRESS_PART_LENGTH),
  /** What comes after, in order. */
  next: z.string().max(MAX_PROGRESS_PART_LENGTH),
});
export type Progress = z.infer<typeof ProgressSchema>;

/** The three parts of a status in reading order, each with the label every surface draws it under. */
export const PROGRESS_PARTS = [
  { key: 'now', label: 'Now' },
  { key: 'doneSoFar', label: 'Done so far' },
  { key: 'next', label: 'Next' },
] as const satisfies readonly { readonly key: keyof Progress; readonly label: string }[];

/** The parts of a status that say something, in reading order; none for an absent status or one with every part empty. */
export const writtenProgressParts = (
  progress: Progress | undefined,
): readonly { readonly key: keyof Progress; readonly label: string; readonly text: string }[] =>
  progress === undefined
    ? []
    : PROGRESS_PARTS.map(part => ({ ...part, text: progress[part.key] })).filter(part => part.text.trim() !== '');

const CardShape = {
  format: z.literal(CARD_FORMAT),
  id: CardIdSchema,
  machineId: MachineIdSchema,
  projectId: BoardProjectIdSchema,
  laneId: LaneIdSchema,
  kind: CardKindSchema,
  title: CardTitleSchema,
  /** What the card face shows: one line. Empty until the ferret knows it. */
  summary: oneLine(MAX_CARD_SUMMARY_LENGTH),
  /** The owner's words, verbatim, and where they were said. Never paraphrased. */
  ask: CardMessageSchema,
  clarifications: z.array(BoardClarificationSchema).max(MAX_BOARD_CLARIFICATIONS),
  /** Why this work exists: the problem or belief it rests on (markdown, short). */
  premise: z.string().max(MAX_BOARD_PREMISE_LENGTH).transform(unnestBullets),
  /** What a newcomer needs: prior PRs, related cards, constraints (markdown). */
  context: z.string().max(MAX_BOARD_CONTEXT_LENGTH).transform(unnestBullets),
  terms: BoardTermsSchema,
  /** The full description or plan (markdown); a sub-ferret's brief for a card `fy new` made. */
  brief: z.string().max(MAX_CARD_BRIEF_LENGTH),
  /**
   * How the owner checks the result before pressing Done (markdown, ideally a numbered list): where to go, what
   * to do, what they should see. Empty until the ferret writes it; a card stored before it existed reads empty.
   */
  howToTest: z.string().max(MAX_BOARD_HOW_TO_TEST_LENGTH).default(''),
  /** The card's current state, rewritten whole by its holder; absent until a ferret writes one. */
  progress: ProgressSchema.optional(),
  /** The accountable ferret: the creator by default, the lead for a delegated card. */
  owner: FerretRefSchema,
  /** The ferret doing it now; `null` reads as the owner. */
  assignee: FerretRefSchema.nullable(),
  /** The lead's card. It may live on another project's board; roll-up follows it. */
  parent: CardRefSchema.nullable(),
  dependsOn: z.array(BoardDependencySchema).max(MAX_BOARD_DEPENDENCIES),
  blocked: ExternalBlockSchema.nullable(),
  dropped: BoardDropSchema.nullable(),
  /** Selects the lane variant. Immutable after create. */
  workflow: WorkflowSchema,
  links: CardLinksSchema,
  /** Advisory: the files the work expects to touch. */
  files: z.array(z.string().min(1).max(MAX_BOARD_FILE_LENGTH)).max(MAX_BOARD_FILES),
  order: NonNegativeIntegerSchema.nullable(),
  /**
   * The owner's snooze: the card is put aside until `until`. It holds only while the card is still in `laneId`, the
   * lane it was snoozed in, so a card sent back and released again is not hidden by an old snooze. Absent when never
   * snoozed (and on a card stored before it existed).
   */
  snoozed: z.strictObject({ until: InstantSchema, laneId: LaneIdSchema }).nullable().optional(),
  createdAt: InstantSchema,
  createdBy: CardActorSchema,
  /** {@link CardActorVia}: absent unless the card was opened on the admin token. */
  createdByVia: CardActorViaSchema.optional(),
  history: z.array(CardEventSchema).min(1),
  /**
   * Whether a PERSON asked for the card, decided by the daemon once (at creation, or at the first boot that
   * finds the card without it) and never taken from a caller: the Inbox's cards to test are only a person's.
   * Absent on a card stored before it existed; a reader then falls back to the ask's source.
   */
  askedBy: CardAskedBySchema.optional(),
  /**
   * Whether the card shows on the board by default. Stored once (at creation, or at the first boot that finds the
   * card without it) and changed only by `visibility` actions the daemon authorises. A card that has none reads by
   * the rule in the daemon's `cardVisibility`: public when a person asked and it has no parent, otherwise private.
   * The VIEW always carries it; absent only on a card stored before it existed.
   */
  visibility: CardVisibilitySchema.optional(),
  /**
   * Whether the stored visibility is the daemon's `default` (it follows the card's asker and parent) or was
   * `chosen`. Absent beside a stored visibility reads `chosen`: a value of unknown origin is never undone.
   */
  visibilitySource: CardVisibilitySourceSchema.optional(),
  /**
   * The owner's Yes this card was made on where its board is off (docs/board.md § The board is opt-in): an item on
   * the creating ferret's agenda. One Yes makes one card. Absent on every other card.
   */
  approval: AskRefSchema.optional(),
};

type CardCoherence = Pick<
  z.infer<z.ZodObject<typeof CardShape>>,
  'id' | 'machineId' | 'kind' | 'parent' | 'dependsOn' | 'files' | 'history'
>;

/** Names this card, on its own machine or with the machine spelled out. */
const namesSelf = (card: { readonly id: string; readonly machineId: string }, ref: CardRef): boolean =>
  ref.id === card.id && (ref.machineId === undefined || ref.machineId === card.machineId);

const refKey = (ref: CardRef): string => `${ref.machineId ?? ''}/${ref.id}`;

const refineCard = (value: CardCoherence, context: z.RefinementCtx): void => {
  if (!value.id.startsWith(cardIdPrefix(value.kind))) {
    context.addIssue({ code: 'custom', message: 'card id prefix must match its kind', path: ['id'] });
  }
  if (value.parent !== null && namesSelf(value, value.parent)) {
    context.addIssue({ code: 'custom', message: 'a card is not its own parent', path: ['parent'] });
  }
  if (value.dependsOn.some(dependency => namesSelf(value, dependency.task))) {
    context.addIssue({ code: 'custom', message: 'a card does not depend on itself', path: ['dependsOn'] });
  }
  if (new Set(value.dependsOn.map(dependency => refKey(dependency.task))).size !== value.dependsOn.length) {
    context.addIssue({ code: 'custom', message: 'each dependency is listed once', path: ['dependsOn'] });
  }
  if (new Set(value.files).size !== value.files.length) {
    context.addIssue({ code: 'custom', message: 'each file is listed once', path: ['files'] });
  }
  if (value.history.some((event, index) => event.seq !== index + 1)) {
    context.addIssue({ code: 'custom', message: 'history seq runs 1, 2, 3… with no gap', path: ['history'] });
  }
  if (value.history[0]?.type !== 'created' || value.history.slice(1).some(event => event.type === 'created')) {
    context.addIssue({ code: 'custom', message: 'history opens with its one created event', path: ['history'] });
  }
};

/** A card as the daemon stores it. */
export const CardSchema = z.object(CardShape).superRefine(refineCard);
export type Card = z.infer<typeof CardSchema>;

/**
 * A SUB-CARD is a card made under a bigger one for one piece of work (one PR, one review, one fix round). The owner
 * tests the parent, never the sub-card, so the board closes it when its work ships and hides it by default.
 */
export const isSubCard = (card: { readonly parent: CardRef | null }): boolean => card.parent !== null;

// ---------------------------------------------------------------------------------------------------
// Derived at read time
// ---------------------------------------------------------------------------------------------------

/**
 * How a card is doing, derived from session liveness and the board (`board-design.md` §3.3): `active`
 * (an attributed session is working), `idle`, `stale` (idle past its lane's threshold) or `orphaned` (its
 * ferrets are gone with the card still in an active or review lane). A card that is blocked, depends on an
 * unfinished card, or whose agenda carries its open ask is `idle` and never stale: someone else's clock.
 */
export const CardActivitySchema = z.enum(['active', 'idle', 'stale', 'orphaned']);
export type CardActivity = z.infer<typeof CardActivitySchema>;

/** Whether the owner asked for a card or an agent made it (`docs/board.md` § Human and agent cards). */
export const CardOriginSchema = z.enum(['human', 'agent']);
export type CardOrigin = z.infer<typeof CardOriginSchema>;

const categoryCounts = z.strictObject({
  backlog: NonNegativeIntegerSchema,
  active: NonNegativeIntegerSchema,
  review: NonNegativeIntegerSchema,
  shipped: NonNegativeIntegerSchema,
  verify: NonNegativeIntegerSchema,
  closed: NonNegativeIntegerSchema,
});

/** A parent card's children, summed: how many (dropped ones excluded), where they are, and how many work now. */
export const RollupSchema = z
  .object({
    children: NonNegativeIntegerSchema,
    byCategory: categoryCounts,
    active: NonNegativeIntegerSchema,
    lastTouchedAt: InstantSchema.nullable(),
  })
  .superRefine((value, context) => {
    const total = Object.values(value.byCategory).reduce((sum, count) => sum + count, 0);
    if (total !== value.children) {
      context.addIssue({ code: 'custom', message: 'byCategory sums to children', path: ['byCategory'] });
    }
    if (value.active > value.children) {
      context.addIssue({ code: 'custom', message: 'no more active children than children', path: ['active'] });
    }
  });
export type Rollup = z.infer<typeof RollupSchema>;

const CardViewShape = {
  ...CardShape,
  /** The latest real activity on the card or any descendant; `null` when there has been none. */
  lastTouchedAt: InstantSchema.nullable(),
  touchedBy: FerretRefSchema.nullable(),
  activity: CardActivitySchema,
  rollup: RollupSchema,
  /** The lane the children suggest moving to; `null` when they suggest nothing. */
  suggestedLane: LaneIdSchema.nullable(),
  /** The open asks about this card: its gate entry's ask, or an ask that names it. */
  openAsks: z.array(AskRefSchema),
  /** Dependencies not yet done and not overridden. */
  blockedBy: z.array(CardRefSchema),
  /** The cards that depend on this one: the inverse index, never stored. */
  blocks: z.array(CardRefSchema),
  /** The earliest release any merged PR of the card shipped in. */
  shippedIn: ReleasedInSchema.nullable(),
  /**
   * Who the work is for: `human` when the owner asked for it, `agent` when a ferret or the daemon made it on
   * its own (a sub-ferret's card, a Warden finding). Absent from a daemon older than the split, which a
   * reader takes as "show it".
   */
  origin: CardOriginSchema.optional(),
  /** The nearest ANCESTOR card (never the card itself) whose origin is `human`; `null` when there is none. */
  humanParent: CardRefSchema.nullable().optional(),
};

const askKey = (ref: AskRef): string => `${ref.ferret}/${ref.id}`;

export const CardViewSchema = z.object(CardViewShape).superRefine((value, context) => {
  refineCard(value, context);
  const open = new Set(value.openAsks.map(askKey));
  if (open.size !== value.openAsks.length) {
    context.addIssue({ code: 'custom', message: 'each open ask is listed once', path: ['openAsks'] });
  }
});
export type CardView = z.infer<typeof CardViewSchema>;

// ---------------------------------------------------------------------------------------------------
// The board query and its answer
// ---------------------------------------------------------------------------------------------------

export const BoardPrStateFilterSchema = z.enum(['none', 'draft', 'open', 'ci_red', 'merged', 'released']);
export type BoardPrStateFilter = z.infer<typeof BoardPrStateFilterSchema>;

/** The activity states, plus the `blocked` view the Board's one-tap pill opens. */
export const BoardActivityFilterSchema = z.enum([...CardActivitySchema.options, 'blocked']);
export type BoardActivityFilter = z.infer<typeof BoardActivityFilterSchema>;

/** Which cards: `open` (the default) excludes closed and dropped ones, which there will be thousands of. */
export const BoardStateFilterSchema = z.enum(['open', 'closed', 'dropped', 'all']);
export type BoardStateFilter = z.infer<typeof BoardStateFilterSchema>;

/**
 * Whether a card belongs in a state filter. A dropped card is only ever `dropped` (or `all`), whatever
 * lane it was dropped from; `open` is everything neither closed nor dropped.
 */
export const isInBoardState = (filter: BoardStateFilter, category: LaneCategory, dropped: boolean): boolean => {
  if (filter === 'all') return true;
  if (dropped) return filter === 'dropped';
  return filter === 'closed' ? category === 'closed' : filter === 'open' && category !== 'closed';
};

/**
 * Which cards a board read selects by visibility: `public`, `private` or `all`. Absent reads `all`, so an app that
 * sends no filter keeps every card it relies on; the Board page and `fy board` ask for `public` themselves.
 */
export const BoardVisibilityFilterSchema = z.enum(['public', 'private', 'all']);
export type BoardVisibilityFilter = z.infer<typeof BoardVisibilityFilterSchema>;

export const BoardQuerySchema = z.strictObject({
  /** One project's board; absent reads every project's. */
  project: BoardProjectIdSchema.optional(),
  /** Cards this session owns or is assigned. */
  ferret: FerretRefSchema.optional(),
  kind: CardKindSchema.optional(),
  prState: BoardPrStateFilterSchema.optional(),
  activity: BoardActivityFilterSchema.optional(),
  state: BoardStateFilterSchema.default('open'),
  /** Public cards, private ones, or both (absent). It scopes the board, so the header counts follow it. */
  visibility: BoardVisibilityFilterSchema.optional(),
  /** Free text over id, title, summary and ask. */
  query: z.string().trim().min(1).max(MAX_BOARD_QUERY_LENGTH).optional(),
  cursor: z.string().min(1).max(MAX_BOARD_LINK_LENGTH).optional(),
  limit: z.number().int().min(1).max(MAX_BOARD_PAGE).default(DEFAULT_BOARD_PAGE),
});
export type BoardQuery = z.infer<typeof BoardQuerySchema>;
export type BoardQueryInput = z.input<typeof BoardQuerySchema>;

/** The header's counts, over the whole board the query scoped (not just this page). */
export const BoardCountsSchema = z.strictObject({
  closedHidden: NonNegativeIntegerSchema,
  stale: NonNegativeIntegerSchema,
  orphaned: NonNegativeIntegerSchema,
  active: NonNegativeIntegerSchema,
});
export type BoardCounts = z.infer<typeof BoardCountsSchema>;

/**
 * A card the daemon could not read. It is set aside and reported, never fatal to the board read: `id` is
 * the card file's name, and `reason` a short summary of what failed to parse — never a path or the file's
 * contents.
 */
export const BoardQuarantinedCardSchema = z.strictObject({ id: CardIdSchema, reason });
export type BoardQuarantinedCard = z.infer<typeof BoardQuarantinedCardSchema>;

/**
 * One page of a board. Scoped to one project, it carries that project's lanes, and every card is on it;
 * across every project (`projectId: null`) there is no one lane set, so the app reads each project's.
 * `quarantined` names the cards on it that could not be read.
 */
export const BoardResponseSchema = z
  .object({
    projectId: BoardProjectIdSchema.nullable(),
    laneSet: LaneSetSchema.nullable(),
    cards: z.array(CardViewSchema),
    counts: BoardCountsSchema,
    nextCursor: z.string().min(1).nullable(),
    quarantined: z.array(BoardQuarantinedCardSchema).default([]),
  })
  .superRefine((value, context) => {
    if (value.projectId === null) {
      if (value.laneSet !== null) {
        context.addIssue({ code: 'custom', message: 'a board across projects has no lane set', path: ['laneSet'] });
      }
      return;
    }
    if (value.laneSet !== null && value.laneSet.projectId !== value.projectId) {
      context.addIssue({ code: 'custom', message: "the lane set is the project's own", path: ['laneSet'] });
    }
    if (value.cards.some(card => card.projectId !== value.projectId)) {
      context.addIssue({ code: 'custom', message: "a project's board holds its own cards", path: ['cards'] });
    }
  });
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

/** One card, in full. */
export const CardResponseSchema = z.object({ card: CardViewSchema, laneSet: LaneSetSchema.nullable() });
export type CardResponse = z.infer<typeof CardResponseSchema>;

/**
 * The owner's start of a ferret on a card: the card, and the ferret that is on it. `started: false` means a live
 * ferret already held the card, so none was started and `ferret` is that ferret (the app then offers its chat).
 */
export const CardStartResponseSchema = z.strictObject({
  card: CardIdSchema,
  ferret: FerretRefSchema,
  started: z.boolean(),
});
export type CardStartResponse = z.infer<typeof CardStartResponseSchema>;

/**
 * Every card id this machine holds, whatever its project, lane, state or assignee, and nothing else about
 * it: what `&F12` is proved against, so a reference to a card on another project still opens its card.
 */
export const BoardIdsResponseSchema = z.strictObject({ ids: z.array(CardIdSchema) });
export type BoardIdsResponse = z.infer<typeof BoardIdsResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------------

const PrUrlSchema = z.string().max(MAX_BOARD_LINK_LENGTH).regex(PR_URL, 'a GitHub pull request URL');

/** One card of a PR's merge unit still waiting on a card outside it, and how far that card must get. */
export const BoardMergeWaitSchema = z.strictObject({
  card: CardRefSchema,
  on: CardRefSchema,
  until: DependencyUntilSchema,
});
export type BoardMergeWait = z.infer<typeof BoardMergeWaitSchema>;

/**
 * `GET /v1/board/merge-gate?pr=<url>` (docs/board.md § Clashing claims queue the later card): whether a PR may merge as
 * far as the board's queue goes, decided from ONE read of the board. The PR may merge when `waits` and `unreadable`
 * are both empty.
 */
export const BoardMergeGateResponseSchema = z.strictObject({
  pr: PrUrlSchema,
  /** The cards that ship in this PR: the open cards linking it, and their open sub-cards that link no PR of their own. */
  unit: z.array(CardRefSchema),
  /** Each wait of a unit card on a card outside the unit that is not done yet. */
  waits: z.array(BoardMergeWaitSchema),
  /** Cards this daemon could not read: any of them might link the PR, so the gate cannot call it free. */
  unreadable: z.array(CardIdSchema),
});
export type BoardMergeGateResponse = z.infer<typeof BoardMergeGateResponseSchema>;

/**
 * A new card. Who creates it is the caller, never a field; the daemon fills the machine, the counter id,
 * the lane (the variant's first backlog lane unless one is named) and the history.
 */
export const CardCreateRequestSchema = z.strictObject({
  kind: CardKindSchema,
  title: CardTitleSchema,
  summary: oneLine(MAX_CARD_SUMMARY_LENGTH).default(''),
  ask: CardMessageSchema,
  premise: z.string().max(MAX_BOARD_PREMISE_LENGTH).transform(unnestBullets).default(''),
  context: z.string().max(MAX_BOARD_CONTEXT_LENGTH).transform(unnestBullets).default(''),
  terms: BoardTermsSchema.default([]),
  brief: z.string().max(MAX_CARD_BRIEF_LENGTH).default(''),
  howToTest: z.string().max(MAX_BOARD_HOW_TO_TEST_LENGTH).default(''),
  progress: ProgressSchema.optional(),
  workflow: WorkflowSchema.default('quick'),
  /** The board; absent means the creating session's project. */
  projectId: BoardProjectIdSchema.optional(),
  laneId: LaneIdSchema.optional(),
  parent: CardRefSchema.nullable().default(null),
  assignee: FerretRefSchema.nullable().default(null),
  dependsOn: z
    .array(z.strictObject({ task: CardRefSchema, until: DependencyUntilSchema.default('shipped') }))
    .max(MAX_BOARD_DEPENDENCIES)
    .default([]),
  files: z.array(z.string().min(1).max(MAX_BOARD_FILE_LENGTH)).max(MAX_BOARD_FILES).default([]),
  branch: linkValue.optional(),
  docs: z.array(linkValue).max(MAX_BOARD_LINKS_PER_FIELD).default([]),
  /**
   * Where the board is off, a ferret's card needs the owner's Yes: the id of the answered "Track this on the
   * board?" item on the ferret's own agenda (docs/board.md § The board is opt-in). Ignored for the owner.
   */
  approval: AskIdTextSchema.optional(),
  /** The caller's own open agenda thread this card carries out: only linked to it (the thread's `task`), nothing else. */
  thread: AskIdTextSchema.optional(),
  /**
   * `public` or `private`; absent takes the default (public when a person asked and it has no parent). A ferret may
   * choose for its own agent-asked card, and never hides a person's ask or publishes a sub-card.
   */
  visibility: CardVisibilitySchema.optional(),
});
export type CardCreateRequest = z.infer<typeof CardCreateRequestSchema>;
export type CardCreateRequestInput = z.input<typeof CardCreateRequestSchema>;

/** The text fields `fy card edit` (and `fy card patch`, `board-patch.ts`) changes, each with its wire schema. */
export const CardEditFields = {
  title: CardTitleSchema.optional(),
  summary: oneLine(MAX_CARD_SUMMARY_LENGTH).optional(),
  premise: z.string().max(MAX_BOARD_PREMISE_LENGTH).transform(unnestBullets).optional(),
  context: z.string().max(MAX_BOARD_CONTEXT_LENGTH).transform(unnestBullets).optional(),
  terms: BoardTermsSchema.optional(),
  brief: z.string().max(MAX_CARD_BRIEF_LENGTH).optional(),
  howToTest: z.string().max(MAX_BOARD_HOW_TO_TEST_LENGTH).optional(),
  /**
   * The parts of the status to replace: each part named replaces that part, each part left out keeps the card's (an
   * empty part for a card with no status yet). The daemon merges them in the card's own write, so two ferrets
   * rewriting different parts at once never undo each other.
   */
  progress: ProgressSchema.partial().optional(),
};

/**
 * Everything else a card can be asked to do. Who may do which is the daemon's decision (ownership and
 * lineage, `board-design.md` §2.5); a dependency override is the owner's alone, enforced there too.
 */
export const CardActionRequestSchema = z.discriminatedUnion('action', [
  /** A move back needs a reason; the schema cannot tell direction, so {@link moveReasonProblem} does. */
  z.strictObject({
    action: z.literal('move'),
    to: LaneIdSchema,
    reason: reason.optional(),
    /** Files for the card's ferret: only an owner's move back (a reopen) carries them. */
    attachments: BoardReopenAttachmentsSchema.optional(),
  }),
  /**
   * Report an external trigger (`deploy.done`, `pr.review_approved`): something Ferretry cannot see
   * happened, so the card moves the way that trigger moves it, as the daemon would — forward only, never into
   * an owner-gated closed lane, and never out of a gate the owner has not answered. `reason` is what happened.
   */
  z.strictObject({ action: z.literal('trigger'), event: ExternalLaneTriggerSchema, reason: reason.optional() }),
  /** Make this the card the calling session's activity is attributed to. */
  z.strictObject({ action: z.literal('focus') }),
  z.strictObject({ action: z.literal('block'), reason }),
  z.strictObject({ action: z.literal('unblock'), reason: reason.optional() }),
  z.strictObject({
    action: z.literal('depend'),
    task: CardRefSchema,
    until: DependencyUntilSchema.default('shipped'),
    override: z.strictObject({ reason }).optional(),
  }),
  z.strictObject({ action: z.literal('undepend'), task: CardRefSchema, reason }),
  z.strictObject({ action: z.literal('drop'), reason }),
  /** Back to a lane with the owner's words: the reason, and the ask as said (appended to clarifications). */
  z.strictObject({
    action: z.literal('reopen'),
    to: LaneIdSchema,
    reason,
    ask: CardMessageSchema,
    attachments: BoardReopenAttachmentsSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('clarify'),
    text: z.string().min(1).max(MAX_CARD_BRIEF_LENGTH),
    source: z.string().min(1).max(MAX_BOARD_SOURCE_LENGTH),
  }),
  z
    .strictObject({
      action: z.literal('link'),
      pr: PrUrlSchema.optional(),
      branch: linkValue.optional(),
      commit: linkValue.optional(),
      doc: linkValue.optional(),
    })
    .refine(
      value => [value.pr, value.branch, value.commit, value.doc].filter(field => field !== undefined).length === 1,
      'a link names exactly one of pr, branch, commit or doc',
    ),
  z.strictObject({ action: z.literal('assign'), assignee: FerretRefSchema.nullable() }),
  /** A ferret takes a card its own lead holds: the daemon reads who is asking, so the request names nobody. */
  z.strictObject({ action: z.literal('claim') }),
  /**
   * A live lead takes a card whose owner ferret and assignee have BOTH ended: it becomes the card's owner and assignee, and
   * `reason` is kept in the history. The daemon reads who is asking and judges the orphan; the request names nobody.
   */
  z.strictObject({ action: z.literal('adopt'), reason: reason.optional() }),
  z.strictObject({ action: z.literal('note'), text: z.string().trim().min(1).max(MAX_CARD_NOTE_LENGTH) }),
  z
    .strictObject({
      action: z.literal('edit'),
      ...CardEditFields,
      /**
       * READ BEFORE WRITE (`board.patch.1`, `fy card patch`): the card's revision as the writer read it
       * (`cardRevision`, the seq of its newest history event). A card that has changed since is refused
       * `version-conflict` and nothing is written: read it again.
       */
      revision: PositiveIntegerSchema.optional(),
      /** Changes the card's visibility in the same mutation as its text, so one request is one outcome. */
      visibility: CardVisibilitySchema.optional(),
    })
    .refine(
      value =>
        value.visibility !== undefined || BoardEditableFieldSchema.options.some(field => value[field] !== undefined),
      'an edit changes at least one field',
    ),
  z.strictObject({
    action: z.literal('file'),
    path: z.string().min(1).max(MAX_BOARD_FILE_LENGTH),
    release: z.literal(true).optional(),
    reason: reason.optional(),
  }),
  z.strictObject({ action: z.literal('order'), order: NonNegativeIntegerSchema.nullable() }),
  /** Show the card on the board by default (`public`) or fold it with the ferrets' bookkeeping (`private`). */
  z.strictObject({ action: z.literal('visibility'), visibility: CardVisibilitySchema, reason: reason.optional() }),
  /** Put the card aside until `until`, or wake it now with `null`. The owner's own, like Done. */
  z.strictObject({ action: z.literal('snooze'), until: InstantSchema.nullable() }),
  /** Move the card under another card (or to the top level with `parent: null`); the reason goes in its history. */
  z.strictObject({ action: z.literal('reparent'), parent: CardRefSchema.nullable(), reason: reason.optional() }),
  /** Move the card to another project's board; absent `laneId` means the same-category lane there. */
  z.strictObject({
    action: z.literal('refile'),
    projectId: BoardProjectIdSchema,
    laneId: LaneIdSchema.optional(),
    reason: reason.optional(),
  }),
]);
export type CardActionRequest = z.infer<typeof CardActionRequestSchema>;

/** `fy card skip "<why>"`: the calling ferret records that its work needs no card (§3.4). */
export const BoardSkipRequestSchema = z.strictObject({ reason: BoardSkipSchema.shape.reason });
export type BoardSkipRequest = z.infer<typeof BoardSkipRequestSchema>;

/** The decision as recorded on the session. */
export const BoardSkipResponseSchema = z.object({ ferret: FerretRefSchema, skip: BoardSkipSchema });
export type BoardSkipResponse = z.infer<typeof BoardSkipResponseSchema>;
export type CardActionRequestInput = z.input<typeof CardActionRequestSchema>;

/**
 * A project's lanes: propose from a template (live at once, unconfirmed), edit against the version the
 * editor saw, or confirm. An edit that removes a lane says where its cards go (`relocate`), checked
 * against the current set by {@link laneEditProblems}.
 */
export const LaneSetActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('propose'),
    template: LaneTemplateNameSchema,
    renames: LaneRenamesSchema.default({}),
  }),
  z
    .strictObject({
      action: z.literal('edit'),
      version: PositiveIntegerSchema,
      layout: LaneLayoutSchema,
      relocate: z.partialRecord(LaneIdSchema, LaneIdSchema).default({}),
    })
    .superRefine((value, context) => {
      const kept = new Set(value.layout.lanes.map(lane => lane.id));
      for (const [from, to] of Object.entries(value.relocate)) {
        if (kept.has(from)) {
          context.addIssue({
            code: 'custom',
            message: `lane ${from} is kept, so it has no relocation`,
            path: ['relocate'],
          });
        }
        if (to !== undefined && !kept.has(to)) {
          context.addIssue({
            code: 'custom',
            message: `cards go to a lane of the new set, not ${to}`,
            path: ['relocate'],
          });
        }
      }
    }),
  z.strictObject({ action: z.literal('confirm'), version: PositiveIntegerSchema }),
]);
export type LaneSetActionRequest = z.infer<typeof LaneSetActionRequestSchema>;
export type LaneSetActionRequestInput = z.input<typeof LaneSetActionRequestSchema>;

/** Why a board request was refused. */
export const BoardErrorCodeSchema = z.enum([
  'invalid',
  'not-found',
  'forbidden',
  'reason-required',
  'owner-gate',
  'blocked-by',
  'cycle',
  'unknown-lane',
  'no-lane-set',
  'version-conflict',
]);
export type BoardErrorCode = z.infer<typeof BoardErrorCodeSchema>;

export type MoveReasonProblem =
  | LaneLookupError
  | { readonly code: 'reason-required'; readonly from: string; readonly to: string };

/**
 * Whether a move is missing the reason it needs: a move back always says why. `ok(undefined)` means the
 * move may go ahead as far as its reason is concerned.
 */
export const moveReasonProblem = (
  laneSet: Pick<LaneSet, 'lanes' | 'variants'>,
  from: string,
  to: string,
  moveReason: string | undefined,
): BoardResult<undefined, MoveReasonProblem> => {
  const backward = isBackwardMove(laneSet, from, to);
  if (!backward.ok) return backward;
  return backward.value && (moveReason === undefined || moveReason.trim() === '')
    ? boardErr({ code: 'reason-required', from, to })
    : boardOk(undefined);
};

/** The lanes an edit removes without saying where their cards go. Empty when the edit is complete. */
export const laneEditProblems = (
  current: Pick<LaneSet, 'lanes'>,
  edit: {
    readonly layout: { readonly lanes: readonly { readonly id: string }[] };
    readonly relocate: Partial<Record<string, string>>;
  },
): readonly string[] => {
  const kept = new Set(edit.layout.lanes.map(lane => lane.id));
  return current.lanes.map(lane => lane.id).filter(id => !kept.has(id) && edit.relocate[id] === undefined);
};

// ---------------------------------------------------------------------------------------------------
// Boards and the board switch
// ---------------------------------------------------------------------------------------------------

/**
 * The wake-up the board publishes after a write: which cards moved on which board. (Today's `board.changed` feed
 * event, `taskIds` renamed.)
 */
export const BoardChangedSchema = z.strictObject({
  projectId: BoardProjectIdSchema,
  cardIds: z.array(CardIdSchema).min(1),
});
export type BoardChangedEvent = z.infer<typeof BoardChangedSchema>;

export const BoardProjectSchema = z.strictObject({
  id: BoardProjectIdSchema,
  name: z.string().min(1),
  /** The registered folder; `null` for the Unfiled board. */
  path: z.string().min(1).nullable(),
  laneSet: LaneSetSchema.nullable(),
});
export type BoardProject = z.infer<typeof BoardProjectSchema>;

export const BoardProjectsResponseSchema = z.strictObject({
  projects: z.array(BoardProjectSchema).min(1),
  /** The board the calling ferret works on; `null` for a caller that is not a ferret. */
  current: BoardProjectIdSchema.nullable(),
});
export type BoardProjectsResponse = z.infer<typeof BoardProjectsResponseSchema>;

/**
 * What a lane-set change answers. `ask` says whether the owner was asked: `raised` is the one choice on the proposing
 * ferret's ask ledger, `not-needed` is a confirmed set or an owner's own edit, and `failed` means the set is live but
 * no ask was raised (the proposer should say so itself).
 */
export const LaneSetChangeResponseSchema = z.strictObject({
  laneSet: LaneSetSchema,
  ask: z.enum(['raised', 'not-needed', 'failed']),
});
export type LaneSetChangeResponse = z.infer<typeof LaneSetChangeResponseSchema>;

/**
 * WHETHER A PROJECT USES THE BOARD (docs/board.md § The board is opt-in). Off, a ferret makes no card unless the owner
 * asked for one or its lead handed it one. `setBy`: `default` is a board nobody decided (off), `owner` a switch the
 * owner threw. A ferret never throws it: it asks the owner first.
 */
export const BoardSwitchSchema = z.strictObject({
  projectId: BoardProjectIdSchema,
  on: z.boolean(),
  setBy: z.enum(['default', 'owner']),
  setAt: InstantSchema.nullable(),
});
export type BoardSwitch = z.infer<typeof BoardSwitchSchema>;

export const BoardSwitchRequestSchema = z.strictObject({ on: z.boolean() });
export type BoardSwitchRequest = z.infer<typeof BoardSwitchRequestSchema>;

/** The words a ferret is refused with: the owner decides whether a project uses the board. */
export const BOARD_SWITCH_OWNER_ONLY =
  'Only the owner switches a board on or off. Ask them first, as one ask yes/no: "Track this on the board?"';

// ─── the Asks source `card` ──────────────────────────────────────────────────────────────────────────────────────
/**
 * The obligation envelope a card puts on the agenda (`{ source: 'card', ref, entry }`, #1552): `ref` is the card,
 * `lane` the gate lane it entered, `entry` the history seq of that entry (the entry id is
 * `gate:<card>:<lane>:<entry>`, so a raise is idempotent). The Agenda shows it as ONE answer row; the card is read-only
 * status and is named at most once, as a plain reference. Answering moves the card (Asks -> `asks.answered`).
 */
export const CardAskRefSchema = z.strictObject({
  card: CardIdSchema,
  lane: LaneIdSchema.optional(),
  entry: z.string().min(1).optional(),
});
export type CardAskRef = z.infer<typeof CardAskRefSchema>;

// ─── stored files ────────────────────────────────────────────────────────────────────────────────────────────────
export const CountersFileSchema = z.strictObject({
  format: z.literal(1),
  next: z.strictObject({
    bug: z.number().int().positive(),
    feature: z.number().int().positive(),
    infra: z.number().int().positive(),
    chore: z.number().int().positive(),
  }),
});
export const BoardFileSchema = z.strictObject({
  format: z.literal(1),
  project: BoardProjectIdSchema,
  switch: BoardSwitchSchema,
  laneSet: LaneSetSchema.nullable(),
});
/** `state/board/sweep.json`: what the last sweep saw and when each card was nudged. Open cards only. */
export const SweepFileSchema = z.strictObject({
  format: z.literal(1),
  sweptAt: InstantSchema.nullable(),
  nudged: z.record(z.string(), InstantSchema),
  seen: z.record(z.string(), z.looseObject({ blockedBy: z.array(z.string()) })),
});
export type SweepFile = z.infer<typeof SweepFileSchema>;

/**
 * `state/board/focus.json`: the card each ferret works on, the card its delegations go under, and why its work has no
 * card. Ferrets keeps no such fact, so Board holds it (today's `config.focusTask`, `focusAnchor`, `boardSkip`).
 */
export const FerretFocusEntrySchema = z.strictObject({
  card: CardRefSchema.nullable(),
  anchor: CardRefSchema.nullable(),
  skip: z.strictObject({ reason: z.string(), at: InstantSchema }).nullable(),
});
export const FocusFileSchema = z.strictObject({
  format: z.literal(1),
  ferrets: z.record(z.string(), FerretFocusEntrySchema),
});
export type FocusFile = z.infer<typeof FocusFileSchema>;
export const GithubFileSchema = z.strictObject({
  format: z.literal(1),
  prs: z.record(z.string(), PrLinkSchema),
});

/** `config/board.yaml`: the GitHub watch. Nothing here widens authority or spend. */
export const BoardConfigSchema = z.strictObject({
  github: z.strictObject({ watch: z.boolean().default(true) }).default({ watch: true }),
  /**
   * The folders a ferret's repository is registered from when its first card is made on the Unfiled board
   * (`~` is the home folder). A repository outside every one of them stays Unfiled.
   */
  projectRoots: z.array(z.string().trim().min(1)).default(['~/Workspace', '~/.config']),
});
export type BoardConfig = z.infer<typeof BoardConfigSchema>;

// ─── the `card_progress` agent tool ──────────────────────────────────────────────────────────────────────────────
/** What a ferret hands `card_progress`: the card and the parts of its progress it rewrites (the rest are kept). */
export const CardProgressToolInputSchema = z.strictObject({
  card: CardIdSchema,
  now: z.string().max(MAX_PROGRESS_PART_LENGTH).optional(),
  doneSoFar: z.string().max(MAX_PROGRESS_PART_LENGTH).optional(),
  next: z.string().max(MAX_PROGRESS_PART_LENGTH).optional(),
});
export type CardProgressToolInput = z.infer<typeof CardProgressToolInputSchema>;
