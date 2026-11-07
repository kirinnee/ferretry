import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { AskSchema, FerretIdSchema } from './core.ts';

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
export const AgendaOpenFerretSchema = z.strictObject({
  ferret: FerretIdSchema,
  asks: z.array(AskSchema).min(1),
});
export type AgendaOpenFerret = z.infer<typeof AgendaOpenFerretSchema>;

/** One page, in ferret-id order. A ferret is never split across pages; `next` is the `after` for the following page. */
export const AgendaOpenPageSchema = z.strictObject({
  ferrets: z.array(AgendaOpenFerretSchema),
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
export const DaemonAgendaSchema = z.strictObject({ asks: z.array(AskSchema), resolved: z.array(AskSchema) });
export type DaemonAgenda = z.infer<typeof DaemonAgendaSchema>;
/** The owner's few verbs on the daemon agenda: dismiss, snooze, unsnooze, resolve. Raising and editing are the daemon's. */
export const DaemonAgendaActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('dismiss'), ask: z.string().min(1) }),
  z.strictObject({ action: z.literal('snooze'), ask: z.string().min(1), until: InstantSchema }),
  z.strictObject({ action: z.literal('unsnooze'), ask: z.string().min(1) }),
  z.strictObject({ action: z.literal('resolve'), ask: z.string().min(1) }),
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
