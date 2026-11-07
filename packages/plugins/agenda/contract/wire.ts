import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { AskItemSchema, AskListSnapshotSchema } from '@ferretry/core-asks/contract';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

/** The id the daemon agenda goes by: the daemon's own ledger for notices that belong to no ferret. */
export const DAEMON_AGENDA_ID = 'machine-agenda';

// ─── agenda mode, per ferret ─────────────────────────────────────────────────────────────────────────────────────
/** `PATCH /v1/ferrets/:ferret/agenda-mode`: whether a ferret is told to keep an agenda. */
export const AgendaModePatchSchema = z.strictObject({ enabled: z.boolean() });
export type AgendaModePatch = z.infer<typeof AgendaModePatchSchema>;

export const AgendaModeSchema = z.strictObject({
  enabled: z.boolean(),
  /** A running ferret was instructed at launch, so a change reaches it only at its next launch. */
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type AgendaMode = z.infer<typeof AgendaModeSchema>;

export const AgendaModePatchResultSchema = z.strictObject({
  ferret: FerretIdSchema,
  enabled: z.boolean(),
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type AgendaModePatchResult = z.infer<typeof AgendaModePatchResultSchema>;

// ─── the roll-up ─────────────────────────────────────────────────────────────────────────────────────────────────
export const AGENDA_OPEN_MAX_LIMIT = 500;
export const AGENDA_OPEN_DEFAULT_LIMIT = 200;

export const AgendaOpenQuerySchema = z.strictObject({
  after: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(AGENDA_OPEN_MAX_LIMIT).optional(),
});
export type AgendaOpenQuery = z.infer<typeof AgendaOpenQuerySchema>;

/** One ferret's asks in the roll-up: every ask still open or parked (snoozed or replied). */
export const AgendaOpenSessionSchema = z.strictObject({
  sessionId: z.string().min(1),
  items: z.array(AskItemSchema).min(1).max(20),
});
export type AgendaOpenSession = z.infer<typeof AgendaOpenSessionSchema>;

/** One page, in ferret-id order. A ferret is never split across pages; `next` is the `after` for the following page. */
export const AgendaOpenPageSchema = z.strictObject({
  sessions: z.array(AgendaOpenSessionSchema),
  next: z.string().min(1).optional(),
});
export type AgendaOpenPage = z.infer<typeof AgendaOpenPageSchema>;

// ─── clearing the agent ferrets' backlog ─────────────────────────────────────────────────────────────────────────
export const AGENDA_CLEAR_AGENTS_NOTE = 'cleared: agent-ferret backlog';
export const AgendaClearAgentsRequestSchema = z.strictObject({ dryRun: z.boolean().optional() });
export type AgendaClearAgentsRequest = z.infer<typeof AgendaClearAgentsRequestSchema>;
/** How many asks the call dismissed (or, on a dry run, would), on how many agent ferrets' agendas. */
export const AgendaClearAgentsResultSchema = z.strictObject({
  cleared: z.number().int().nonnegative(),
  ferrets: z.number().int().nonnegative(),
});
export type AgendaClearAgentsResult = z.infer<typeof AgendaClearAgentsResultSchema>;

// ─── the daemon agenda ───────────────────────────────────────────────────────────────────────────────────────────
export const DaemonAgendaSchema = AskListSnapshotSchema;
export type DaemonAgenda = z.infer<typeof DaemonAgendaSchema>;
/** The owner's few verbs on the daemon agenda: dismiss, snooze, unsnooze, resolve. Raising and editing are the daemon's. */
export const DaemonAgendaActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('dismiss'),
    id: z.string().regex(/^A[1-9][0-9]*$/u),
    note: z.string().max(64_000).optional(),
  }),
  z.strictObject({ action: z.literal('snooze'), id: z.string().regex(/^A[1-9][0-9]*$/u), until: InstantSchema }),
  z.strictObject({ action: z.literal('unsnooze'), id: z.string().regex(/^A[1-9][0-9]*$/u) }),
  z.strictObject({
    action: z.literal('resolve'),
    id: z.string().regex(/^A[1-9][0-9]*$/u),
    note: z.string().max(64_000).optional(),
  }),
]);
export type DaemonAgendaAction = z.infer<typeof DaemonAgendaActionSchema>;

// ─── buzz ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The only moments the phone buzzes (docs/notifications.md): a stop, a deadline, a buzzed notice, a snooze wake, a card's ask. */
export const BUZZ_KINDS = ['stopped', 'deadline', 'notice', 'snooze-wake', 'card-ask', 'approve-on-phone'] as const;
export const BuzzKindSchema = z.enum(BUZZ_KINDS);
export type BuzzKind = z.infer<typeof BuzzKindSchema>;

/** One line of `state/agenda/buzzes.jsonl`: the ledger that keeps a moment from buzzing twice. Holds no endpoint or key. */
export const BuzzRecordSchema = z.strictObject({
  format: z.literal(1),
  key: z.string().min(1),
  at: InstantSchema,
  kind: BuzzKindSchema,
  ferret: FerretIdSchema.optional(),
  ask: z.string().min(1).optional(),
  title: z.string().min(1),
  enrolled: z.number().int().nonnegative(),
});
export type BuzzRecord = z.infer<typeof BuzzRecordSchema>;

/** `state/agenda/seen.json`: when the owner last saw each ask, so an unread badge can clear. */
export const AGENDA_SEEN_FORMAT = 1;
export const SeenFileSchema = z.strictObject({
  format: z.literal(AGENDA_SEEN_FORMAT),
  seen: z.record(z.string(), z.record(z.string(), InstantSchema)),
});
export type SeenFile = z.infer<typeof SeenFileSchema>;

/** `config/agenda.yaml`: nothing here widens authority or spend. */
export const AgendaConfigSchema = z.strictObject({
  /** Agenda mode for new ferrets (a ferret's own recorded switch wins). */
  agendaMode: z.boolean().default(true),
  /** A ferret whose reply asks the owner to act without raising an ask is reminded once. */
  agendaNudge: z.boolean().default(true),
  /** An ask's `neededBy` within this many hours buzzes once. */
  deadlineWarnHours: z.number().positive().default(3),
});
export type AgendaConfig = z.infer<typeof AgendaConfigSchema>;

// ─── seen: the owner opened an ask ───────────────────────────────────────────────────────────────────────────────
/** The tag an ask's buzz goes out under: its own, so opening the ask can take down exactly that line on every device. */
export const agendaAskBuzzTag = (ferret: string, ask: string): string => `agenda-${ferret}:${ask}`;
/** The tag a stop's buzz goes out under: it is about the ferret, not one ask. */
export const agendaStopBuzzTag = (ferret: string): string => `agenda-${ferret}`;
/** Where a buzz opens: the ask's own page in the app (`/agenda/:ferret/:ask`). */
export const agendaAskPath = (ferret: string, ask: string): string =>
  `/agenda/${encodeURIComponent(ferret)}/${encodeURIComponent(ask)}`;

/**
 * `POST /v1/push/seen`: the owner opened an ask in the app, so its buzz comes down on every OTHER device. Names the ask
 * and nothing more; which device asked is the credential's, never the body's.
 */
export const PushSeenRequestSchema = z.strictObject({
  /** A board's id: a ferret's, or the daemon agenda's. */
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, 'a board id'),
  agendaId: z.string().regex(/^A[1-9][0-9]*$/u, 'an ask id is A and a number'),
});
export type PushSeenRequest = z.infer<typeof PushSeenRequestSchema>;

/** The most tags one `seen` answers (an ask's own, and the ferret's stop tag). */
export const PUSH_SEEN_MAX_TAGS = 8;
const BuzzTagSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}\s]+$/u);
/** Whether a clear went out, and the tags it named (empty when nothing of that ask's was still up). */
export const PushSeenResponseSchema = z.strictObject({
  cleared: z.boolean(),
  tags: z.array(BuzzTagSchema).max(PUSH_SEEN_MAX_TAGS),
});
export type PushSeenResponse = z.infer<typeof PushSeenResponseSchema>;

// ─── the per-ferret switch ───────────────────────────────────────────────────────────────────────────────────────
/** `state/agenda/modes.json`: each ferret's own recorded agenda mode. A recorded value always wins over the default. */
export const AGENDA_MODES_FORMAT = 1;
export const ModesFileSchema = z.strictObject({
  format: z.literal(AGENDA_MODES_FORMAT),
  modes: z.record(z.string(), z.strictObject({ enabled: z.boolean(), at: InstantSchema })),
});
export type ModesFile = z.infer<typeof ModesFileSchema>;

/** The push text limits (a lock screen shows little): title and body are clipped at a word. */
export const AGENDA_PUSH_TITLE_LENGTH = 40;
export const AGENDA_PUSH_BODY_LENGTH = 120;
