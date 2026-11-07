import { defineEvent, defineHook, definePort, defineState, type FerretId } from '@ferretry/kernel/contract';
import { type Brand, InstantSchema, KEBAB_NAME } from '@ferretry/std';
import { z } from 'zod';
import type { AgendaSnapshot } from './snapshot/agenda.ts';

/**
 * The agenda wire shapes the Agenda app and the daemon share: schemas, types and the pure helpers around them
 * (today's `protocol/src/lib/agenda*.ts`). One copy, here; the daemon's `lib/protocol` files re-export it.
 */
export * from './snapshot/account-ids.ts';
export * from './snapshot/agenda.ts';
export * from './snapshot/agenda-card-asks.ts';
export * from './snapshot/agenda-card.ts';
export * from './snapshot/agenda-form.ts';
export * from './snapshot/agenda-gate-wording.ts';
export * from './snapshot/agenda-gate.ts';
export * from './snapshot/agenda-list.ts';
export * from './snapshot/agenda-message.ts';
export * from './snapshot/agenda-patch.ts';
export * from './snapshot/agenda-shape.ts';
export * from './snapshot/agenda-stage.ts';
export * from './snapshot/agenda-state.ts';
export * from './snapshot/agenda-tabs.ts';
export * from './snapshot/agenda-versions.ts';
export * from './snapshot/board-refs.ts';
export * from './snapshot/plain-label.ts';
export * from './snapshot/sha256.ts';

/** Complete boards, including parked items, owner answers, card asks and conversation. */
export {
  AgendaItemSchema as AskItemSchema,
  AgendaSnapshotSchema as AskBoardSnapshotSchema,
  AgendaListSnapshotSchema as AskListSnapshotSchema,
  type AgendaItem as AskItem,
  type AgendaSnapshot as AskBoardSnapshot,
  type AgendaListSnapshot as AskListSnapshot,
} from './snapshot/agenda.ts';

/**
 * `@ferretry/core-asks/contract` (§2.2, §7.4): every question for the owner and every answer, with a GENERIC source
 * envelope. No plugin's ids live here: a source registers the schema of its own `ref` through `ask.sources`, and Asks
 * parses `ref` with it on raise and on read ("source unavailable" when that plugin is later off).
 *
 * Answering happens only through Asks' own route; the port has no answer method, so no plugin can answer through it.
 * Who may answer is today's rule (lead decision 2026-11-07): a ferret may answer an ORDINARY ask on its own board
 * only. An owner-only ask — an input card, a held configuration change, a task plan, a 2FA seed, a phone approval —
 * and every ask a source raised through this port are the owner's alone, the ferret's own board included; no ferret
 * answers an ask on another ferret's board. So every answer {@link AsksApi.answers} hands a source is the owner's.
 *
 * Limits and kinds are today's agenda (`protocol/src/lib/agenda.ts`); the words are §1's (ask, notice, answer).
 */

// ─── ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An ask's id, `A12`, as `!A12` references it (today's `AgendaIdSchema`). Numbered per ferret's board (lead decision
 * #13): unique only together with its ferret, so every call names an {@link AskRef}.
 */
export type AskId = Brand<string, 'AskId'>;
export const AskIdSchema = z
  .string()
  .regex(/^A[1-9][0-9]*$/u, 'an ask id is A and a number')
  .transform(value => value as AskId);

/** Which ask: its ferret's board and its id there (lead decision #13). */
export const AskRefSchema = z.strictObject({
  ferret: z.string().min(1).max(128),
  id: AskIdSchema,
});
export type AskRef = z.infer<typeof AskRefSchema>;

/** The owner's machine-board verbs. Snooze keeps today's required future `until`. */
export const AskOwnerActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('dismiss'), ref: AskRefSchema, note: z.string().max(64_000).optional() }),
  z.strictObject({ action: z.literal('resolve'), ref: AskRefSchema, note: z.string().max(64_000).optional() }),
  z.strictObject({ action: z.literal('snooze'), ref: AskRefSchema, until: InstantSchema }),
  z.strictObject({ action: z.literal('unsnooze'), ref: AskRefSchema }),
]);
export type AskOwnerAction = z.infer<typeof AskOwnerActionSchema>;

/** A refused owner action, with the engine's original reason and words. */
export class AskOwnerActionError extends Error {
  override readonly name = 'AskOwnerActionError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** An answer's own id: each answer is applied once, by this id (§7.4 rule 4). */
export type AnswerId = Brand<string, 'AnswerId'>;
export const AnswerIdSchema = z
  .string()
  .regex(/^an_[0-9a-f]{24}$/u, 'an answer id is an_ and 24 hex digits')
  .transform(value => value as AnswerId);

/** A source: one per `ask.sources` taker (`card`, `sign-in-approval`, `question`, `input`), plus `ferret` and `daemon`. */
export type SourceKey = Brand<string, 'SourceKey'>;
export const SourceKeySchema = z
  .string()
  .regex(KEBAB_NAME)
  .max(40)
  .transform(value => value as SourceKey);

/** The two sources Asks itself owns: a ferret's own `fy ask`, and a daemon notice with no plugin behind it. */
export const BUILT_IN_SOURCES = ['ferret', 'daemon'] as const;

/** The source's own entry id (a card's gate entry, an approval id); `(source, entry)` makes a raise idempotent. */
export type EntryId = Brand<string, 'EntryId'>;
export const EntryIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/u)
  .transform(value => value as EntryId);

// ─── the envelope ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The generic source envelope (§7.4): `ref` is validated by the schema the source registered. */
export const AskSourceSchema = z.strictObject({
  source: SourceKeySchema,
  ref: z.unknown(),
  entry: EntryIdSchema,
});
export type AskSource = z.infer<typeof AskSourceSchema>;

export const MAX_ASK_SUBJECT_LENGTH = 240;
export const MAX_ASK_DETAIL_LENGTH = 2_048;
export const MAX_ASK_CONTEXT_LENGTH = 64_000;
export const MAX_ASK_OPTIONS = 12;
export const MAX_ASK_OPTION_LENGTH = 120;
export const MAX_ASK_OPTION_DETAIL_LENGTH = 240;

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]*$/u, 'one line');

/** What kind of answer an ask wants (today's `AgendaKindSchema`, with `info` named `notice`). */
export const ASK_KINDS = [
  'task',
  'yesno',
  'permission',
  'choice',
  'review',
  'notice',
  'reply',
  'form',
  'input',
] as const;
export const AskKindSchema = z.enum(ASK_KINDS);
export type AskKind = z.infer<typeof AskKindSchema>;

export const AskOptionSchema = z.strictObject({
  label: singleLine(MAX_ASK_OPTION_LENGTH),
  description: singleLine(MAX_ASK_OPTION_DETAIL_LENGTH).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

/** Who raised an ask. A ferret is the kernel-stamped caller, never a claimed name. */
export const AskRaiserSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ferret'), ferret: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('daemon') }),
  z.strictObject({ kind: z.literal('owner') }),
]);
export type AskRaiser = z.infer<typeof AskRaiserSchema>;

/** What a source hands `raise` (§7.4). */
export const AskDraftSchema = z
  .strictObject({
    ...AskSourceSchema.shape,
    kind: AskKindSchema,
    subject: singleLine(MAX_ASK_SUBJECT_LENGTH),
    why: z.string().trim().min(1).max(MAX_ASK_DETAIL_LENGTH),
    howToResolve: z.string().trim().min(1).max(MAX_ASK_DETAIL_LENGTH).optional(),
    context: z.string().max(MAX_ASK_CONTEXT_LENGTH).optional(),
    options: z.array(AskOptionSchema).min(2).max(MAX_ASK_OPTIONS).optional(),
    raisedBy: AskRaiserSchema,
    /** The ferret this ask is about (its sitrep shows it as a blocker). */
    ferret: z.string().min(1).max(128).optional(),
    /** Pings the owner. */
    blocking: z.boolean().optional(),
  })
  .superRefine((draft, context) => {
    if ((draft.kind === 'choice') !== (draft.options !== undefined))
      context.addIssue({ code: 'custom', path: ['options'], message: 'a choice names its options, and only a choice' });
    const labels = (draft.options ?? []).map(option => option.label);
    if (new Set(labels).size !== labels.length)
      context.addIssue({ code: 'custom', path: ['options'], message: 'option labels must be unique' });
  });
export type AskDraft = z.input<typeof AskDraftSchema>;

/** What an answer did (today's `AgendaAnswerEffectSchema`). */
export const ANSWER_EFFECTS = [
  'choose',
  'approve',
  'reject',
  'good',
  'clarify',
  'done',
  'needs-info',
  'dismiss',
] as const;
export const AnswerEffectSchema = z.enum(ANSWER_EFFECTS);
export type AnswerEffect = z.infer<typeof AnswerEffectSchema>;

/**
 * Who answered an ask a source raised: only ever the owner, at the machine or from a device (never a ferret, never the
 * warden). A ferret's answer to an ordinary ask on its own board is the ferret's own business and is never handed to a
 * source.
 */
export const AnswererSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('device'), holder: z.string().min(1).max(128) }),
]);
export type Answerer = z.infer<typeof AnswererSchema>;

/** One answer. Never a secret: an input card's value goes to its target through the Vault, never through here. */
export const AskAnswerSchema = z.strictObject({
  id: AnswerIdSchema,
  /** The board the ask is on: `ask` is unique only with it. */
  ferret: z.string().min(1).max(128),
  ask: AskIdSchema,
  source: SourceKeySchema,
  entry: EntryIdSchema,
  effect: AnswerEffectSchema,
  choice: singleLine(MAX_ASK_OPTION_LENGTH).optional(),
  text: z.string().trim().min(1).max(MAX_ASK_DETAIL_LENGTH).optional(),
  /** A form's plain values, by field id. */
  values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u), z.string().max(MAX_ASK_DETAIL_LENGTH)).optional(),
  by: AnswererSchema,
  at: InstantSchema,
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export const ASK_STATES = ['open', 'answered', 'closed'] as const;
export const AskStateSchema = z.enum(ASK_STATES);
export type AskState = z.infer<typeof AskStateSchema>;

/** Why an ask was closed. */
export const CLOSE_REASONS = ['answered', 'withdrawn', 'superseded', 'source-gone', 'expired', 'dismissed'] as const;
export const CloseReasonSchema = z.enum(CLOSE_REASONS);
export type CloseReason = z.infer<typeof CloseReasonSchema>;

export const AskSummarySchema = z.strictObject({
  id: AskIdSchema,
  source: SourceKeySchema,
  entry: EntryIdSchema,
  kind: AskKindSchema,
  subject: z.string(),
  raisedBy: AskRaiserSchema,
  ferret: z.string().optional(),
  state: AskStateSchema,
  raisedAt: InstantSchema,
  /** Pings the owner: today's notice flag, read by notify's buzz decision. */
  blocking: z.boolean().optional(),
  /** The source's plugin is off or no longer registers this ref: the app shows "source unavailable". */
  sourceUnavailable: z.literal(true).optional(),
});
export type AskSummary = z.infer<typeof AskSummarySchema>;

export interface AskFilter {
  readonly source?: SourceKey;
  readonly entry?: EntryId;
  readonly ferret?: FerretId;
  readonly state?: AskState;
}

// ─── the port ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Asks port (§7.4). `raise` is idempotent by `(source, entry)`. Effects across subsystems are owed, then
 * reconciled: a source records "owed: raise" in its own write, calls `raise`, and on `AskAnswered` reads `answers`
 * and applies each once BY ANSWER ID.
 */
export interface AsksApi {
  /** Raised on the board of the draft's `ferret`, which a raise therefore names. */
  raise(ask: AskDraft): Promise<AskRef>;
  /** A notice: something the owner should know; no answer. Idempotent by `(source, entry)`. */
  notify(notice: Omit<AskDraft, 'kind' | 'options'>): Promise<AskRef>;
  answers(
    filter: { readonly source: SourceKey; readonly entry?: EntryId },
    since?: string,
  ): Promise<readonly AskAnswer[]>;
  close(ask: AskRef, reason: CloseReason): Promise<void>;
  open(filter: AskFilter): Promise<readonly AskSummary[]>;
  get(ask: AskRef): Promise<AskSummary | undefined>;
  /** All boards, or one board (including an empty one); open and parked items are complete. */
  snapshots(filter?: { readonly ferret?: string }): Promise<readonly AgendaSnapshot[]>;
  /** Apply a machine-board owner verb with the owner as actor. Ferret-board answers still use Asks' own route. */
  ownerAction(action: AskOwnerAction): Promise<AgendaSnapshot>;
}

export const AsksPort = definePort<AsksApi>('asks');

/** What a source registers under `ask.sources:<key>` (§7.4). */
export interface AskSourceSpec {
  /** Parses this source's `ref`; a strict object. */
  readonly schema: z.ZodType;
  /** The card title template, `{field}` filled from the ref (`Card {card}`). */
  readonly title: string;
  /** Whether an answer carries form values. */
  readonly form: boolean;
  /**
   * Applies the owner's answer in the source's own world BEFORE the ask is marked answered (lead decision #13; the
   * #1552 order: the card moves first). A refusal leaves the ask open and is the sentence the owner is told. Absent,
   * an answer is owed and the source reconciles on {@link AskAnswered}.
   */
  readonly apply?: (answer: AskAnswer) => Promise<'applied' | { readonly refused: string }>;
}

export const AskSources = defineHook('ask.sources', {
  mode: 'provide',
  key: SourceKeySchema,
  value: z.custom<AskSourceSpec>(),
});

// ─── delivery ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by a delivery when NOTHING was typed and the same batch may simply be tried again later: the ferret's
 * composer held a person's draft, could not be read, or the ferret is still starting (today's `AgendaNotTyped`).
 */
export class AskNotTypedError extends Error {
  override readonly name = 'AskNotTypedError';
}

/** What a ferret's composer holds: nothing (a dim ghost suggestion is nothing), text, or no reading. */
export type AskComposerState = 'empty' | 'occupied' | 'unreadable';

/** What the send ledger can prove about a batch it accepted. */
export type AskReceipt =
  | { readonly state: 'delivered' }
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly reason: string };

/**
 * How the owner's answers reach a ferret (today's `AgendaMessenger`, `AgendaComposer` and `AgendaReceipts`): a queued,
 * non-interrupting message into the ferret's own terminal, idempotent under its send id. Typing into a ferret is
 * Conversation's, so Conversation provides it under `ask.delivery:ferret`. Unprovided, answers stay held in the
 * ferret's outbox exactly as when nothing could be typed.
 */
export interface AskDelivery {
  /**
   * Resolves once the send path has ACCEPTED the message — not once it arrived. Rejects with {@link AskNotTypedError}
   * when nothing was typed and it may be tried again, and with any other error when the send was refused outright.
   */
  send(ferret: string, message: string, sendId: string): Promise<void>;
  /** Read before anything is typed; absent, the composer is taken as empty. */
  composer?(ferret: string): Promise<AskComposerState>;
  /** Delivered only when the transcript holds it; absent, an accepted send counts as delivered. */
  receipt?(ferret: string, sendId: string): Promise<AskReceipt>;
}

/** The one key `ask.delivery` is provided under. */
export const ASK_DELIVERY_KEY = 'ferret' as const;

export const AskDeliveries = defineHook('ask.delivery', {
  mode: 'provide',
  key: z.literal(ASK_DELIVERY_KEY),
  value: z.custom<AskDelivery>(),
});

/** An answer landed. A wake-up: the source reads `answers` and applies each once. */
export const AskAnswered = defineEvent(
  'asks.answered',
  z.strictObject({
    ferret: z.string().min(1).max(128),
    askId: AskIdSchema,
    answerId: AnswerIdSchema,
    source: SourceKeySchema,
    entry: EntryIdSchema,
  }),
);

/** An ask was raised, closed or changed. A wake-up for views (Agenda, sitrep). */
export const AsksChanged = defineEvent(
  'asks.changed',
  z.strictObject({ ferret: z.string().min(1).max(128), askId: AskIdSchema, state: AskStateSchema }),
);

// ─── state ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const StoredAskSchema = z.strictObject({
  ...AskSummarySchema.omit({ sourceUnavailable: true }).shape,
  ref: z.unknown(),
  why: z.string(),
  howToResolve: z.string().optional(),
  context: z.string().optional(),
  options: z.array(AskOptionSchema).optional(),
  blocking: z.boolean().optional(),
  closedAt: InstantSchema.optional(),
  closeReason: CloseReasonSchema.optional(),
});

export const AsksFile = defineState({
  name: 'asks',
  path: 'asks.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ format: z.literal(1), next: z.number().int().positive(), asks: z.array(StoredAskSchema) }),
});
export const AnswersFile = defineState({
  name: 'answers',
  path: 'answers.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ format: z.literal(1), answers: z.array(AskAnswerSchema) }),
});
export const AskHistoryFile = defineState({ name: 'history', path: 'history.jsonl', store: 'jsonl', format: 1 });
export const AskVersionsFiles = defineState({
  name: 'versions',
  path: 'versions/*.sqlite',
  store: 'sqlite',
  format: 1,
});

// ─── what an ask's renderer receives ──────────────────────────────────────────────────────────────────────────────
/**
 * The value the ask list hands the renderer that draws part of an ask (`ask:sign-in-approval`, `ask:input`): the ref (its own
 * kind and ids), the ask's words, and WHO the ask is from — the ferret's id (a plan or an approval is matched by it),
 * the ferret's spoken name ("{ferretName} wants…") and the board project it works in (the standing rule's scopes).
 */
export const AskOnScreenSchema = z.object({
  ref: z.looseObject({ kind: z.string() }),
  subject: z.string(),
  why: z.string().optional(),
  context: z.string().optional(),
  ferret: z.string().min(1),
  ferretName: z.string(),
  projectId: z.string().optional(),
});
export type AskOnScreen = z.infer<typeof AskOnScreenSchema>;
