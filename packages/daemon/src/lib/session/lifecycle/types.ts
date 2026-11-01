import { isAbsolute } from 'node:path';
import {
  type BoardProjectId,
  BoardProjectIdSchema,
  type SessionLaunchInstructions,
  SessionLaunchInstructionsSchema,
  SessionStatusSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import { MAX_SESSION_TITLE_LENGTH } from '../../names/types.ts';
import { type SessionId, SessionIdSchema } from '../../session-id.ts';

/**
 * A stop that did not run because a launch of the same session is still in flight in this daemon.
 *
 * Distinct from a stop that failed: nothing was attempted and nothing was written, so the session is
 * exactly as it was and the stop can simply be asked again once the launch settles.
 */
export class SessionStopPending extends Error {
  constructor(
    readonly sessionId: string,
    waitedMs: number,
  ) {
    super(
      `session ${sessionId} is still launching after ${Math.round(waitedMs / 1_000)}s; nothing was stopped — ` +
        'stop it again once the launch settles',
    );
    this.name = 'SessionStopPending';
  }
}

export const LifecycleSessionStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'failed',
  'kill_failed',
  'stopped',
]);
export type LifecycleSessionStatus = z.infer<typeof LifecycleSessionStatusSchema>;

/**
 * Every status a session's state document may carry — the protocol's, not the lifecycle's.
 *
 * ONE DOCUMENT, TWO WRITERS. The lifecycle owns six of these (`LifecycleSessionStatusSchema`), but the
 * turn watcher, the send path and the signal path write the rest into the same `state.json` the moment
 * a turn changes: `interrupted`, `awaiting_user`, `thinking`, `completed` and the others. A reader
 * that accepts only the lifecycle's six declares every such session unusable, and a session nobody can
 * stop, revive or fork is exactly what a person pressing Stop on an interrupted turn met.
 */
export const RecordedSessionStatusSchema = SessionStatusSchema;
export type RecordedSessionStatus = z.infer<typeof RecordedSessionStatusSchema>;

/**
 * The assigned task is durable in the record because that makes creation a single write: a torn
 * create leaves nothing to reconstruct, and a retried launch can re-deliver the same task. The
 * bound is what keeps the document a document — an unbounded prompt is re-serialized on every
 * transition.
 */
export const MAX_ASSIGNED_TASK_LENGTH = 256 * 1024;

/** The longest name tmux itself accepts as a session address (see `lib/tmux/address.ts`). */
export const MAX_TMUX_SESSION_NAME_LENGTH = 128;

/** A relative or unresolved cwd would start the agent in the daemon's own directory. */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine(value => isAbsolute(value), 'must be an absolute path');

export const SessionLifecycleConfigSchema = z.object({
  id: SessionIdSchema,
  name: z.string().min(1).max(MAX_SESSION_TITLE_LENGTH),
  /** Who chose `name`: the daemon (`auto`, retitlable) or a person (`owner`, final). */
  nameSource: z.enum(['auto', 'owner']).optional(),
  agent: AbsolutePathSchema,
  command: z.array(z.string().min(1)).min(1),
  cwd: AbsolutePathSchema,
  mode: z.enum(['auto', 'interactive']),
  prompt: z.string().min(1).max(MAX_ASSIGNED_TASK_LENGTH).optional(),
  parent: SessionIdSchema.optional(),
  /** The board this session works on, stamped once at creation. Absent on older sessions: a reader resolves it. */
  projectId: BoardProjectIdSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  tmuxSession: z.string().min(1).max(MAX_TMUX_SESSION_NAME_LENGTH),
  /**
   * SHA-256 of the credential the session's CURRENT pane holds, never the credential itself.
   *
   * The agent-tool identity resolver authenticates a presented credential against this hash, so it
   * must be durable and readable by the daemon without the plaintext — which lives only in the
   * session environment store. Optional because sessions started before the credential existed have
   * none, and nothing can authenticate as them.
   *
   * IT IS THE ONE FIELD OF THIS CONFIGURATION THAT A LAUNCH REWRITES. Every pane launch re-issues the
   * credential ({@link SessionCredentialRotator}), so the hash names one pane rather than the whole
   * session: a copy that leaked from a pane stops authenticating the moment the next pane replaces
   * it, instead of for as long as the session lives. It stays here rather than in the state document
   * because every reader of it — the resolver, the fork binder — already reads it here, and a second
   * home would be a second answer to "which credential is current".
   */
  sessionCapabilityHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});
export type SessionLifecycleConfig = z.infer<typeof SessionLifecycleConfigSchema>;

export const SessionLifecycleStateSchema = z.object({
  id: SessionIdSchema,
  status: RecordedSessionStatusSchema,
  startedAt: z.iso.datetime({ offset: true }).optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  reason: z.string().min(1).optional(),
  /** What the current pane was told at launch (`SessionLaunchInstructions`), refreshed by every launch. */
  launchInstructions: SessionLaunchInstructionsSchema.optional(),
});
export type SessionLifecycleState = z.infer<typeof SessionLifecycleStateSchema>;

export const SessionLifecycleRecordSchema = z.object({
  config: SessionLifecycleConfigSchema,
  state: SessionLifecycleStateSchema,
});
export type SessionLifecycleRecord = z.infer<typeof SessionLifecycleRecordSchema>;

/**
 * A creation request as a client states it. It carries no id: the daemon mints one, so no client
 * can name — and therefore overwrite — a session that already exists.
 */
/** Names the board a session about to start works on. */
export interface SessionProjectResolver {
  projectForStart(start: { readonly cwd: string; readonly parent?: string }): Promise<BoardProjectId>;
}

export interface CreateSessionLifecycleRequest {
  readonly name?: string;
  readonly agent: string;
  readonly command?: readonly string[];
  readonly cwd: string;
  readonly mode: 'auto' | 'interactive';
  readonly prompt?: string;
  readonly parent?: string;
  /** SHA-256 of the credential this session will hold; the plaintext never travels in the record. */
  readonly sessionCapabilityHash?: string;
}

export interface SessionLifecycleEvent {
  readonly type:
    | 'session.created'
    | 'session.starting'
    | 'session.running'
    | 'session.failed'
    | 'session.kill_failed'
    | 'session.stopped';
  readonly data: Readonly<Record<string, string>>;
}

/** Durable boundary for lifecycle records; concrete persistence belongs to adapters. */
export interface SessionLifecycleRepository {
  /**
   * Durably claims the session's storage layout without publishing a lifecycle record.
   *
   * Credentialled creation uses this as its first write: the plaintext environment can then land
   * inside the claimed directory before any config document exposes its hash. It is idempotent, and
   * `read(id)` must still answer `undefined` until `write` publishes the record.
   */
  reserve(id: SessionId): Promise<void>;
  read(id: SessionId): Promise<SessionLifecycleRecord | undefined>;
  write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void>;
}

/** Process boundary for one managed terminal session. */
export interface SessionLifecycleLauncher {
  /** True when this session's terminal already exists — the only safe guard against a second pane. */
  alive(record: SessionLifecycleRecord): Promise<boolean>;
  /**
   * Opens the pane, and answers what it was told — the launch's system-prompt sections and question
   * rule — read off the environment it was actually built with. `undefined` from a launcher that
   * cannot say; the lifecycle then keeps whatever the record already held.
   */
  launch(record: SessionLifecycleRecord): Promise<SessionLaunchInstructions | undefined>;
  /**
   * Waits until the newly launched harness is at an idle prompt, clearing only recognised startup
   * dialogs. Required so pre-turn runtime work cannot weaken the interactive control path's
   * refuse-rather-than-queue rule.
   */
  ready(record: SessionLifecycleRecord): Promise<void>;
  /**
   * Types one instruction into the live terminal once it is ready to accept input.
   *
   * `beforeWrite` is called after readiness is proved and immediately before the first composer
   * write. A durable effect ledger uses that exact boundary: a cold-pane refusal remains retryable,
   * while a crash after the callback can never cause the instruction to be typed twice.
   */
  deliver(record: SessionLifecycleRecord, instruction: string, beforeWrite?: () => Promise<void>): Promise<void>;
  /** Captures a live final frame before a durable terminal transition, if one exists. */
  snapshot(record: SessionLifecycleRecord): Promise<void>;
  stop(record: SessionLifecycleRecord): Promise<void>;
}

/**
 * Where an agent reads its assignment. Turn one is a file the agent is told to open rather than a
 * payload typed into a TUI, so a task of any size survives paste handling.
 */
export interface SessionTaskStore {
  /** Persists the turn-one document and returns the absolute file the agent must read. */
  writeAssignedTask(id: SessionId, document: string): Promise<string>;
}

/** Canonicalizes a requested working directory, or refuses one the agent could not start in. */
export interface WorkingDirectoryResolver {
  resolve(cwd: string): Promise<string>;
}

/**
 * The environment one session's pane is launched with, and the ONLY place a per-session plaintext
 * secret is kept.
 *
 * It is deliberately not part of `SessionLifecycleConfig`. The config is merged into the session
 * DOCUMENT, which the session list, the task-board enrichment and analytics all read back and the
 * API projects — so a capability stored there would be handed to every caller holding the admin
 * token, and the whole point of a per-session credential is that only that session holds it.
 *
 * `read` answers the empty environment for a session that has none, because a launch must never fail
 * on the absence of a secret it was not given.
 */
export interface SessionEnvironmentStore {
  write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void>;
  read(id: SessionId): Promise<Readonly<Record<string, string>>>;
}

/**
 * The environment variable the fleet wrappers read their own session credential from. The agent
 * tools present it, so its name is a wire contract with the wrappers rather than a local choice.
 */
export const SESSION_BOARD_CAPABILITY_VARIABLE = 'FY_SESSION_BOARD_CAPABILITY';

/**
 * The same credential under its documented name, `FY_SESSION_TOKEN` — the ferret's own bearer
 * (docs/agent-tools.md § "The ferret session credential").
 *
 * DERIVED, NEVER STORED: a pane is handed it from {@link SESSION_BOARD_CAPABILITY_VARIABLE} at launch, so
 * the two names can never hold different values. The older name stays for one release, because a
 * wrapper or a binary from before this one reads only that.
 */
export const SESSION_TOKEN_VARIABLE = 'FY_SESSION_TOKEN';

/**
 * The environment variable a pane reads its OWN session id from.
 *
 * It is a wire contract with the CLI exactly as the capability above is: `resolveConnection` sends
 * whatever it finds here as `x-ferretry-session-id`, the authorization boundary turns that into
 * `peer:<id>`, and the send domain takes its `from` — the attribution, and whose declared wait a
 * reply ends — from that actor and from nowhere else. A pane that cannot name itself is therefore a
 * teammate whose every message is anonymous and whose park no reply can end, which is what
 * "agents can talk to each other" actually rests on.
 *
 * IT IS AN IDENTIFIER, NOT A CREDENTIAL, and that is why it may live in an environment anything in
 * the pane can read. The board capability beside it is a secret, and it is in the pane environment
 * for the opposite reason — there is nowhere better for a per-session secret to travel, argv being
 * world-readable through `/proc` — with a 0600 file, a hash-only record and no API projection paying
 * for that decision. Nothing of the sort is owed to a session id: it is already in the URL of every
 * request about that session, and naming yourself buys no authority here. The routes a peer calls are
 * `admin`-scoped and the token is the fleet's, so this identifies the caller for attribution rather
 * than authorizing it.
 */
export const SESSION_ID_VARIABLE = 'FY_SESSION_ID';

/** The session's media folder, derived like the id and written after the stored environment. */
export const SESSION_MEDIA_VARIABLE = 'FY_MEDIA_DIR';

/** The credential a session proves its own identity with, beside the hash the daemon keeps. */
export interface SessionCredential {
  /** Handed to the session and to nobody else. */
  readonly capability: string;
  /** SHA-256 of the capability, in lowercase hex. Durable; safe beside the session document. */
  readonly hash: string;
}

/**
 * Mints per-session credentials. Randomness and hashing are capabilities, so the composition root
 * owns the source rather than the lifecycle reaching for `node:crypto` itself.
 */
export interface SessionCredentialIssuer {
  issue(): SessionCredential;
}

/**
 * Persists the hash of a session's newly issued credential into its configuration document.
 *
 * Its own port rather than a repository write, because a revive replaces a pane without holding a
 * lifecycle record, and the hash must still have exactly one place it is written to.
 */
export interface SessionCapabilityHashStore {
  record(id: SessionId, hash: string): Promise<void>;
  /** Drops the stored hash, so no presented credential names this session until a launch records a new one. */
  erase(id: SessionId): Promise<void>;
  /**
   * A PERSON CUT THIS SESSION OFF (`fy session revoke-credential`): drops the hash AND marks the session
   * `credentialRevoked`, in one write, so no launch rotates it a credential again until a person resumes it.
   */
  cutOff?(id: SessionId): Promise<void>;
  /** Whether the session carries that mark. */
  isCutOff?(id: SessionId): Promise<boolean>;
  /** Clears the mark: a person resumed the session, so its next launch is handed a credential again. */
  restore?(id: SessionId): Promise<void>;
}

/** A launch of a session a person cut off, refused until a person resumes it. */
export class SessionCredentialRevokedError extends Error {
  constructor(readonly sessionId: string) {
    super(`a person revoked ${sessionId}'s credential; only a person resuming it gives it one again`);
    this.name = 'SessionCredentialRevokedError';
  }
}

/**
 * Re-issues a session's credential for the pane about to launch, and answers the new hash.
 *
 * Called by every path that launches a pane — the first launch and every revive — and by nothing
 * else, which is what keeps a plain daemon restart from rotating it: live panes keep the environment
 * they were launched with across a restart, and a rotation they never saw would lock them out.
 */
export interface SessionCredentialRotator {
  rotate(id: SessionId): Promise<string>;
  /**
   * Revokes a STOPPED session's credential: its hash is dropped, so the value its pane held authenticates
   * nothing, even if something later wrote the session's status back. Only the next launch's rotation
   * gives it one again. Absent on a rotator with nothing to revoke.
   */
  revoke?(id: SessionId): Promise<void>;
  /**
   * Cuts a session off for a PERSON: its hash is dropped and the session is marked, so every later rotation —
   * a Warden revive, a peer's resume, a restart or migration — is refused ({@link SessionCredentialRevokedError})
   * until a person resumes it. Absent on a rotator with nothing to revoke.
   */
  cutOff?(id: SessionId): Promise<void>;
  /** A person's resume of a cut-off session: the mark goes, so the launch it makes rotates a credential again. */
  restore?(id: SessionId): Promise<void>;
}

/** Mints session ids server-side. */
export interface SessionIdFactory {
  next(): SessionId;
}
