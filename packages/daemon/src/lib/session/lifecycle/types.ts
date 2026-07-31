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

/** Mints session ids server-side. */
export interface SessionIdFactory {
  next(): SessionId;
}
