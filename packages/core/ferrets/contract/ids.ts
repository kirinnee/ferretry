import type { FerretId } from '@ferretry/kernel/contract';
import { type Brand, InstantSchema, KEBAB_NAME } from '@ferretry/std';
import { z } from 'zod';
import {
  FerretProjectIdSchema,
  SessionProvenanceSchema,
  SessionTransferEdgeSchema,
  TranscriptProvenanceSchema,
  TranscriptViewSchema,
} from './records.ts';
import { SessionOutdatedSchema } from './view/ferret-view.ts';

/**
 * Ferret identity (§2.2): ids, names, parent/child, packs, the state machine. `FerretId` is the kernel's (it only
 * carries it); Ferrets mints it. Today's session id shape, unchanged.
 */
export type { FerretId };

export const FerretIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, 'a ferret id is letters, digits, - and _')
  .transform(value => value as FerretId);

/** A ferret's name as the owner reads it (`:name` references it). */
export const FerretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u, 'a ferret name is letters, digits, spaces, . - and _');

export type PackId = Brand<string, 'PackId'>;
export const PackIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
  .transform(value => value as PackId);

/**
 * The harnesses this build ships (`claude-code`, `codex`). A type-level convenience only: it is NOT the list of
 * harnesses a machine has. That list is the registry the harness plugins declare (the `Harness` providers under
 * `harnesses`, asked through `FerretsApi.harnessKeys()`); a third plugin adds a key without editing this file.
 */
export const KNOWN_HARNESS_KEYS = ['claude-code', 'codex'] as const;
export type KnownHarnessKey = (typeof KNOWN_HARNESS_KEYS)[number];

/**
 * The plugins allowed to provide a harness under `harnesses` (the hook's `takers`, a security-path allowlist): the ids of
 * the harness plugins this build ships. A third harness plugin is added HERE, beside the keys it declares, and nowhere else.
 */
export const HARNESS_PLUGIN_IDS: readonly string[] = [...KNOWN_HARNESS_KEYS, 'opencode'];

/**
 * The closed spelling of those two keys, for a consumer that has not been opened yet (runtimes plan U4b opens each plugin
 * in its own step): its wire keeps rejecting any other key at its own boundary, exactly as before, and its code keeps
 * the two-literal type. A consumer that has been opened uses {@link HarnessKeySchema} and `harnessFacts` instead.
 */
export const KnownHarnessKeySchema = z.enum(KNOWN_HARNESS_KEYS);
/** Whether `key` is one of the two this build ships: the entry check where an open key meets a not-yet-opened consumer. */
export const isKnownHarnessKey = (key: string): key is KnownHarnessKey =>
  (KNOWN_HARNESS_KEYS as readonly string[]).includes(key);

/**
 * A harness key under `harnesses`: the harness plugin's id. Open: `KnownHarnessKey` keeps its literals (so `=== 'codex'`
 * and autocompletion still work) and any other well-shaped string is a key too. Whether a key names a harness this
 * machine has is decided by the registry, never by this type.
 */
export type HarnessKey = KnownHarnessKey | (string & {});

/** A harness key's SHAPE (kebab-case, at most 40). Membership is the registry's to decide, at the point of use. */
export const HarnessKeySchema = z
  .string()
  .regex(KEBAB_NAME, 'a harness key is lowercase letters, digits and -')
  .max(40);

/** A runner key under `runners`: `tmux`. */
export const RUNNER_KEYS = ['tmux'] as const;
export const RunnerKeySchema = z.enum(RUNNER_KEYS);
export type RunnerKey = z.infer<typeof RunnerKeySchema>;

/** A login kind key under `logins` (§4.4). */
export const LOGIN_KIND_KEYS = ['anthropic', 'openai', 'api-key', 'proxy', 'endpoint'] as const;
export const LoginKindKeySchema = z.enum(LOGIN_KIND_KEYS);
export type LoginKindKey = z.infer<typeof LoginKindKeySchema>;

/** A configured login's name (`config/logins/<name>.yaml`); Logins owns the files, this is only the name. */
export const LoginNameSchema = z.string().regex(KEBAB_NAME).max(40);
/** A runtime's name (`config/runtimes/<name>.yaml`). */
export const RuntimeNameSchema = z.string().regex(KEBAB_NAME).max(40);

/** The four states (§1 word table): starting, working, idle, stopped. A stopped ferret can resume. */
export const FERRET_STATES = ['starting', 'working', 'idle', 'stopped'] as const;
export const FerretStateSchema = z.enum(FERRET_STATES);
export type FerretState = z.infer<typeof FerretStateSchema>;

/** A lead started it, or its parent did (a helper); the owner's ferrets have no parent. */
export const FerretRoleSchema = z.enum(['lead', 'helper']);
export type FerretRole = z.infer<typeof FerretRoleSchema>;

/** The longest harness sentence a `start_failed` cause keeps (`explained`). */
export const START_EXPLAINED_MAX = 300;

/**
 * Why a ferret ended, in today's words (the Warden's `ReviveCause` and `ReviveLeaveReason` names, unchanged). The
 * first four are an END NOBODY CHOSE (the terminal vanished, a signal killed the agent, it exited non-zero); the rest
 * are an end somebody decided or a launch that never ran: `stopped` (anyone stopped it), `completed` (it said
 * `signal done`), `start_failed` (it never started, or a launch failed) and `clean_exit` (exit 0).
 *
 * `start_failed.explained` is the harness's own fixed sentence for a start that failed at its first turn
 * (`Harness.startFailure`), kept so a plugin that hears the ferret stop can say why. Only that sentence is ever kept,
 * never what the pane showed, and only when it fits {@link START_EXPLAINED_MAX}.
 */
export const FerretEndCauseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tmux_crashed') }),
  z.strictObject({ kind: z.literal('terminal_gone') }),
  z.strictObject({ kind: z.literal('signal'), signal: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('agent_crashed'), exitCode: z.number().int() }),
  z.strictObject({ kind: z.literal('stopped') }),
  z.strictObject({ kind: z.literal('completed') }),
  z.strictObject({ kind: z.literal('start_failed'), explained: z.string().min(1).max(START_EXPLAINED_MAX).optional() }),
  z.strictObject({ kind: z.literal('clean_exit') }),
]);
export type FerretEndCause = z.infer<typeof FerretEndCauseSchema>;

/** Who first started a ferret: the kind of the launch origin it was born under (`LaunchOrigin.kind`). */
export const FerretBirthSchema = z.enum(['person', 'daemon', 'agent']);
export type FerretBirth = z.infer<typeof FerretBirthSchema>;

/** `state/ferrets/<ferret>/ferret.json`: who a ferret is. Turn, usage and transcript facts are other owners'. */
export const FerretRecordSchema = z.strictObject({
  format: z.literal(1),
  id: FerretIdSchema,
  name: FerretNameSchema,
  parent: FerretIdSchema.optional(),
  pack: PackIdSchema.optional(),
  role: FerretRoleSchema,
  /** Whether this ferret works autonomously or is the person's interactive terminal. */
  mode: z.enum(['auto', 'interactive']).optional(),
  harness: HarnessKeySchema,
  runner: RunnerKeySchema,
  runtime: RuntimeNameSchema.optional(),
  login: LoginNameSchema.optional(),
  /** The folder it was started in: the one `WorkFolders` lets it work in. */
  folder: z.string().min(1).max(4_096),
  state: FerretStateSchema,
  /** The harness's own conversation id, for `resume`. */
  harnessConversation: z.string().min(1).max(256).optional(),
  /** The runner's handle while it runs (Terminals: the tmux pane id), for `attach` (spine D15). */
  handle: z.string().min(1).max(256).optional(),
  createdAt: InstantSchema,
  stateAt: InstantSchema,
  /** Why it ended; present only while `state` is `stopped` (a start or resume clears it). */
  cause: FerretEndCauseSchema.optional(),
  /**
   * WHO FIRST STARTED this ferret (`person`, `daemon` or `agent`), stamped once when the record is born and carried
   * unchanged by every later launch (resume, restart, move, revive, boot recovery). A ferret first started by an agent
   * is fenced out of the state home on every relaunch, whoever triggers it; a record with NO birth is fenced too.
   */
  birth: FerretBirthSchema.optional(),
  /** Who caused it to exist and whether it descends from a warden (today's `SessionConfig.provenance`). */
  provenance: SessionProvenanceSchema.optional(),
  /** Target-only lineage back to the transfer decision that created this fresh ferret (today's `transferredFrom`). */
  transferredFrom: SessionTransferEdgeSchema.optional(),
  /** The board it works on, resolved once at start (today's `projectId`). */
  projectId: FerretProjectIdSchema.optional(),
  /** Where its harness transcript lives: the agent home a resume needs, and the file (today's `transcript`). */
  transcript: TranscriptProvenanceSchema.optional(),
});
export type FerretRecord = z.infer<typeof FerretRecordSchema>;

/**
 * A board task's id (`F21`, `B3`), copied from today's `protocol/src/lib/board-refs.ts` (`BOARD_TASK_ID_PATTERN`).
 * Ferrets is core and cannot import the Board's contract, so the shape is kept here: a start names the EXISTING task
 * the ferret works on, and the summary shows it.
 */
export const FERRET_TASK_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const FerretCardIdSchema = z.string().regex(FERRET_TASK_ID_PATTERN);

/**
 * A ferret's task title (today's `start --name <title>`, `new --name <title>`, `rename --title`): free-form, kept
 * verbatim. Bounded as today's `PackNewRequestSchema.name` was (120 characters).
 */
export const FerretTitleSchema = z.string().trim().min(1).max(120);

/**
 * Who chose a ferret's title. `owner`: a person (`--name`, `rename --title`, the header's Rename) — nothing replaces it.
 * `auto`: a reader offered one made from the conversation's first exchange (`adoptTitle`) and a later, better one may
 * replace it.
 */
export const FerretTitleSourceSchema = z.enum(['owner', 'auto']);

/**
 * What a ferret is FOR, said when it is started: the small fixed list Usage groups spend by. Unset is a fact too — a ferret
 * started before the field, or by someone who named none — and is read as "Unlabelled", never guessed from a transcript.
 */
export const FERRET_PURPOSES = ['comms', 'review', 'planning', 'implementation', 'other'] as const;
export const FerretPurposeSchema = z.enum(FERRET_PURPOSES);
export type FerretPurpose = z.infer<typeof FerretPurposeSchema>;

// ─── quota (today's `protocol/src/lib/session.ts` QuotaSchema, unchanged) ──────────────────────────────────────────

const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const AccountAvailabilitySchema = z.enum(['available', 'unavailable']);
const AccountUnavailableReasonSchema = z.enum(['cooldown', 'spend_limit', 'auth', 'provider', 'no_credentials']);

/**
 * The account headroom a ferret's summary shows (today's `SessionView.quota`). Ferrets keeps no source for it: the
 * login and usage owners do, so a core summary leaves it out until a provider fills it.
 */
export const FerretQuotaSchema = z.object({
  usageBased: z.boolean().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  provider: z.string().optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).optional(),
  weeklyPercent: z.number().finite().min(0).max(100).optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.optional(),
  weeklyResetAt: NonNegativeFiniteSchema.optional(),
  resetAt: NonNegativeFiniteSchema.optional(),
  /** The harness's own words for the limit Ferretry read this session as `rate_limited` on (a pane dialog or a
   *  transcript record) — present exactly while that reading holds. */
  limitNotice: z.string().min(1).optional(),
});
export type FerretQuota = z.infer<typeof FerretQuotaSchema>;

/**
 * A wait a ferret declared with `signal waiting` (today's `SessionState.waiting`, field for field): it is parked on an
 * outside condition or on a peer's reply, not stuck, and the daemon holds it to the deadline. `peer` is always a
 * resolved ferret id, never the reference the ferret gave.
 */
export const FerretWaitingSchema = z.strictObject({
  since: InstantSchema,
  until: InstantSchema.optional(),
  condition: z.string().min(1).optional(),
  peer: FerretIdSchema.optional(),
  peerName: z.string().min(1).optional(),
});
export type FerretWaiting = z.infer<typeof FerretWaitingSchema>;

/**
 * What other subsystems and the app read about a ferret: its record without the format stamp and runner handle, and
 * today's view fields Ferrets keeps beside it — the model and task it was started with and its task title (from its
 * `details.json`), the instant the owner pinned it, and its quota (no core source; see {@link FerretQuotaSchema}).
 * Provenance, transfer lineage, project and transcript show as today's session view showed them: the transcript
 * without its launch-time `baseline`.
 */
export const FerretSummarySchema = FerretRecordSchema.omit({ format: true, handle: true }).extend({
  /** The latest launch's advisory sentence, recorded with its effective options. */
  notice: z.string().min(1).max(4096).optional(),
  /** The ownership label given to start, independent of pack membership. */
  label: z.string().min(1).optional(),
  /** What it was started for (`fy new --purpose`); absent when none was named. */
  purpose: FerretPurposeSchema.optional(),
  transcript: TranscriptViewSchema.optional(),
  model: z.string().min(1).optional(),
  /**
   * The model the harness last REPORTED running (its own transcript), as `GET /v1/ferrets/:ferretId` reads it from the
   * state document: present for an unpinned ferret too, where `model` is absent, and after a switch inside the pane.
   * Never on the list, which does not open the document.
   */
  observedModel: z.string().min(1).optional(),
  /** The startup reasoning choice it was launched with (opaque: the runtime validated it). */
  effort: z.string().min(1).optional(),
  /** Whether it was launched in the harness's fast mode. */
  fast: z.boolean().optional(),
  /** The task it works on, from the stored start option `task`. */
  task: FerretCardIdSchema.optional(),
  /** The former name of `task`: read for one release, never written. */
  card: FerretCardIdSchema.optional(),
  title: FerretTitleSchema.optional(),
  /** Who chose `title`; present exactly when `title` is. A title stored before the field existed is the owner's. */
  titleSource: FerretTitleSourceSchema.optional(),
  pinnedAt: InstantSchema.optional(),
  quota: FerretQuotaSchema.optional(),
  /** Present exactly while the ferret has a declared wait (`signal waiting`); `signal working` clears it. */
  waiting: FerretWaitingSchema.optional(),
  /**
   * When the ferret said `signal done`, present only while it is stopped on that word: a stopped ferret that did not
   * say it (the owner stopped it, a launch failed) has none, and a resumed one is no longer finished.
   */
  finishedAt: InstantSchema.optional(),
  /**
   * The supervision times it was started with (today's `SessionConfig` fields): nudge a ferret that has been quiet
   * this long, kill one that has been stalled this long. Absent means the machine's default; `0` turns the reflex off.
   */
  nudgeAfterSeconds: z.number().int().nonnegative().optional(),
  killAfterSeconds: z.number().int().nonnegative().optional(),
  /**
   * Present only while a RUNNING ferret carries instructions a launch now would word differently (`fy restart
   * --outdated`): the same `{ sections }` today's session view carries (`SessionView.outdated`). Derived when the list
   * or the view is read (kept for a few seconds), never stored; a ferret nothing proves outdated has none.
   */
  outdated: SessionOutdatedSchema.optional(),
});
export type FerretSummary = z.infer<typeof FerretSummarySchema>;
