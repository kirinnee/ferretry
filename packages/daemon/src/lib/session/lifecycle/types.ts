import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { MAX_SESSION_TITLE_LENGTH } from '../../names/types.ts';
import { SessionIdSchema, type SessionId } from '../../session-id.ts';

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
  agent: AbsolutePathSchema,
  command: z.array(z.string().min(1)).min(1),
  cwd: AbsolutePathSchema,
  mode: z.enum(['auto', 'interactive']),
  prompt: z.string().min(1).max(MAX_ASSIGNED_TASK_LENGTH).optional(),
  parent: SessionIdSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  tmuxSession: z.string().min(1).max(MAX_TMUX_SESSION_NAME_LENGTH),
  /**
   * SHA-256 of the session's own credential, never the credential itself.
   *
   * The task-board domain keys every grant, invitation proof and child grant on this hash
   * (`TaskBoardSession.sessionCapabilityHash`), so it must be durable and readable by the daemon
   * without the plaintext — which lives only in the session environment store. Optional because
   * sessions started before the credential existed have none, and a board simply cannot address
   * them.
   */
  sessionCapabilityHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});
export type SessionLifecycleConfig = z.infer<typeof SessionLifecycleConfigSchema>;

export const SessionLifecycleStateSchema = z.object({
  id: SessionIdSchema,
  status: LifecycleSessionStatusSchema,
  startedAt: z.iso.datetime({ offset: true }).optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  reason: z.string().min(1).optional(),
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
  read(id: SessionId): Promise<SessionLifecycleRecord | undefined>;
  write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void>;
}

/** Process boundary for one managed terminal session. */
export interface SessionLifecycleLauncher {
  /** True when this session's terminal already exists — the only safe guard against a second pane. */
  alive(record: SessionLifecycleRecord): Promise<boolean>;
  launch(record: SessionLifecycleRecord): Promise<void>;
  /** Types one instruction into the live terminal once it is ready to accept input. */
  deliver(record: SessionLifecycleRecord, instruction: string): Promise<void>;
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
 * The environment variable the fleet wrappers read their own session credential from. It is the
 * name `packages/cli/src/lib/task-boards/board-credentials.ts` demands before it will send an
 * `invite-accept`, so it is a wire contract with the CLI rather than a local choice.
 */
export const SESSION_BOARD_CAPABILITY_VARIABLE = 'FY_SESSION_BOARD_CAPABILITY';

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

/** Mints session ids server-side. */
export interface SessionIdFactory {
  next(): SessionId;
}
