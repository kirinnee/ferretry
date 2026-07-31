import { parseSessionId, type SessionId } from '../../session-id.ts';
import type {
  CreateSessionLifecycleRequest,
  LifecycleSessionStatus,
  SessionLifecycleEvent,
  SessionLifecycleRecord,
} from './types.ts';

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function event(type: SessionLifecycleEvent['type'], data: Readonly<Record<string, string>>): SessionLifecycleEvent {
  return { type, data };
}

/** Creates a durable session record before any terminal process is touched. */
export function createSessionRecord(
  request: CreateSessionLifecycleRequest,
  at: string,
): { readonly record: SessionLifecycleRecord; readonly event: SessionLifecycleEvent } {
  const id = parseSessionId(request.id);
  const agent = required(request.agent, 'agent');
  const cwd = required(request.cwd, 'cwd');
  const prompt = request.prompt?.trim();
  if (request.mode === 'auto' && !prompt) throw new Error('prompt is required for auto sessions');
  const command = (request.command ?? [agent]).map(value => required(value, 'command item'));
  const parent = request.parent === undefined ? undefined : parseSessionId(request.parent);
  const name = request.name?.trim() || (prompt ? prompt.split(/\s+/u).slice(0, 5).join('-') : 'interactive');
  const record: SessionLifecycleRecord = {
    config: {
      id,
      name,
      agent,
      command,
      cwd,
      mode: request.mode,
      ...(prompt ? { prompt } : {}),
      ...(parent ? { parent } : {}),
      createdAt: at,
      updatedAt: at,
      tmuxSession: `fy-${id}`,
    },
    state: { id, status: 'created' },
  };
  return { record, event: event('session.created', { agent, mode: request.mode, cwd }) };
}

const transitions: Readonly<Record<LifecycleSessionStatus, readonly LifecycleSessionStatus[]>> = {
  created: ['starting', 'stopped'],
  starting: ['running', 'failed', 'stopped'],
  running: ['failed', 'stopped'],
  failed: ['stopped'],
  stopped: [],
};

/** Applies only legal lifecycle transitions and produces the matching journal event. */
export function transitionSessionRecord(
  record: SessionLifecycleRecord,
  status: Exclude<LifecycleSessionStatus, 'created'>,
  at: string,
  reason?: string,
): { readonly record: SessionLifecycleRecord; readonly event: SessionLifecycleEvent } {
  if (!transitions[record.state.status].includes(status))
    throw new Error(`cannot transition session ${record.config.id} from ${record.state.status} to ${status}`);
  const state = {
    ...record.state,
    status,
    ...(status === 'starting' || status === 'running' ? { startedAt: record.state.startedAt ?? at } : {}),
    ...(status === 'failed' || status === 'stopped' ? { finishedAt: at } : {}),
    ...(reason ? { reason } : {}),
  } as SessionLifecycleRecord['state'];
  const next: SessionLifecycleRecord = {
    config: { ...record.config, updatedAt: at },
    state,
  };
  const type = `session.${status}` as SessionLifecycleEvent['type'];
  return { record: next, event: event(type, reason ? { reason } : {}) };
}

export function lifecycleSessionId(value: string): SessionId {
  return parseSessionId(value);
}
