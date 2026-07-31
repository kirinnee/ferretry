import { basename } from 'node:path';
import { formatSessionTitle } from '../../names/policy.ts';
import { parseSessionId, type SessionId } from '../../session-id.ts';
import { sessionTarget } from '../../tmux/address.ts';
import type { SessionLifecycleSettings } from './settings.ts';
import {
  type CreateSessionLifecycleRequest,
  type LifecycleSessionStatus,
  type SessionLifecycleEvent,
  type SessionLifecycleRecord,
  SessionLifecycleRecordSchema,
} from './types.ts';

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function event(type: SessionLifecycleEvent['type'], data: Readonly<Record<string, string>>): SessionLifecycleEvent {
  return { type, data };
}

/**
 * The tmux name for a session. A valid session id may be longer than tmux accepts, so the name is
 * clamped and then validated as a real tmux address: `create` can never mint a session whose every
 * `start` would fail on the address rules.
 */
export function sessionTmuxName(id: SessionId, settings: SessionLifecycleSettings): string {
  const clamped = `${settings.tmuxSessionPrefix}${id}`.slice(0, settings.maxTmuxSessionNameLength);
  return sessionTarget(clamped);
}

/**
 * The daemon launches fleet auto-wrappers, nothing else. Without this an `agent` of `/bin/sh` with
 * a `-c` payload is a remote shell holding the daemon's privileges.
 */
export function authorizeSessionCommand(
  agent: string,
  command: readonly string[],
  settings: SessionLifecycleSettings,
): readonly string[] {
  if (!settings.agentWrapperPattern.test(basename(agent)))
    throw new Error(`agent is not a fleet auto wrapper: ${agent}`);
  if (command[0] !== agent) throw new Error(`command must start with the agent wrapper: ${agent}`);
  return command;
}

/** The turn-one document an agent reads. */
export function assignedTaskDocument(prompt: string): string {
  return `# Assigned task\n\n${prompt}\n`;
}

/** What is typed into a ready terminal so the agent picks its assignment up. */
export function firstTurnInstruction(taskFile: string): string {
  return `Read the file ${taskFile} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
}

/** Everything the daemon had to resolve before a record could be built. */
export interface SessionRecordContext {
  readonly id: SessionId;
  /** Canonical, existing directory — never the raw request value. */
  readonly cwd: string;
  readonly at: string;
  readonly settings: SessionLifecycleSettings;
}

/** Creates a durable session record before any terminal process is touched. */
export function createSessionRecord(
  request: CreateSessionLifecycleRequest,
  context: SessionRecordContext,
): { readonly record: SessionLifecycleRecord; readonly event: SessionLifecycleEvent } {
  const agent = required(request.agent, 'agent');
  const prompt = request.prompt?.trim();
  // An auto session with no task can do nothing but idle, so the task is mandatory there. An
  // interactive session is a terminal a human drives; typing an opening turn into it is wrong.
  if (request.mode === 'auto' && !prompt) throw new Error('prompt is required for auto sessions');
  const command = authorizeSessionCommand(
    agent,
    (request.command ?? [agent]).map(value => required(value, 'command item')),
    context.settings,
  );
  const parent = request.parent === undefined ? undefined : parseSessionId(request.parent);
  // Titles are shown verbatim in listings, so control characters and length are normalized here
  // rather than left to whatever renders them.
  const name =
    formatSessionTitle(request.name ?? '') ||
    formatSessionTitle(prompt ? prompt.split(/\s+/u).slice(0, 5).join('-') : 'interactive');
  // Parsed, not asserted: this is the same shape `read` parses back, so a config that violates its
  // own schema can never reach the store and strand the session there.
  const record = SessionLifecycleRecordSchema.parse({
    config: {
      id: context.id,
      name,
      agent,
      command,
      cwd: context.cwd,
      mode: request.mode,
      ...(prompt ? { prompt } : {}),
      ...(parent ? { parent } : {}),
      ...(request.sessionCapabilityHash ? { sessionCapabilityHash: request.sessionCapabilityHash } : {}),
      createdAt: context.at,
      updatedAt: context.at,
      tmuxSession: sessionTmuxName(context.id, context.settings),
    },
    state: { id: context.id, status: 'created' },
  });
  return { record, event: event('session.created', { agent, mode: request.mode, cwd: context.cwd }) };
}

/**
 * `failed` is not terminal: a launch that lost a transient tmux error must be retryable, or one
 * flaky launch burns the session forever. `kill_failed` may repeat — a pane can refuse to die more
 * than once — and resolves to `stopped` when a later kill succeeds.
 */
const transitions: Readonly<Record<LifecycleSessionStatus, readonly LifecycleSessionStatus[]>> = {
  created: ['starting', 'stopped'],
  starting: ['running', 'failed', 'kill_failed', 'stopped'],
  running: ['failed', 'kill_failed', 'stopped'],
  failed: ['starting', 'stopped'],
  kill_failed: ['kill_failed', 'stopped'],
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
  const state: SessionLifecycleRecord['state'] = {
    ...record.state,
    status,
    ...(status === 'starting' || status === 'running' ? { startedAt: record.state.startedAt ?? at } : {}),
    // A pane that refused to die is not finished; only a real ending stamps a finish time.
    ...(status === 'failed' || status === 'stopped' ? { finishedAt: at } : {}),
    ...(reason ? { reason } : {}),
  };
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
