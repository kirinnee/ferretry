import { z } from 'zod';
import { SessionIdSchema, type SessionId } from '../../session-id.ts';

export const LifecycleSessionStatusSchema = z.enum(['created', 'starting', 'running', 'failed', 'stopped']);
export type LifecycleSessionStatus = z.infer<typeof LifecycleSessionStatusSchema>;

export const SessionLifecycleConfigSchema = z.object({
  id: SessionIdSchema,
  name: z.string().min(1),
  agent: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1),
  mode: z.enum(['auto', 'interactive']),
  prompt: z.string().min(1).optional(),
  parent: SessionIdSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  tmuxSession: z.string().min(1),
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

export interface CreateSessionLifecycleRequest {
  readonly id: string;
  readonly name?: string;
  readonly agent: string;
  readonly command?: readonly string[];
  readonly cwd: string;
  readonly mode: 'auto' | 'interactive';
  readonly prompt?: string;
  readonly parent?: string;
}

export interface SessionLifecycleEvent {
  readonly type: 'session.created' | 'session.starting' | 'session.running' | 'session.failed' | 'session.stopped';
  readonly data: Readonly<Record<string, string>>;
}

/** Durable boundary for lifecycle records; concrete persistence belongs to adapters. */
export interface SessionLifecycleRepository {
  read(id: SessionId): Promise<SessionLifecycleRecord | undefined>;
  write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void>;
}

/** Process boundary for one managed terminal session. */
export interface SessionLifecycleLauncher {
  launch(record: SessionLifecycleRecord): Promise<void>;
  stop(record: SessionLifecycleRecord): Promise<void>;
}

export interface LifecycleClock {
  now(): string;
}
