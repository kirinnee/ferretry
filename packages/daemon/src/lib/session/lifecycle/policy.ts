import { basename } from 'node:path';
import { HARNESS_LABEL, HYPERMEDIA_ENV, QUESTION_ASKED_FILE_ENV } from '@ferretry/fleet';
import {
  type BoardProjectId,
  INTERACTIVE_PLACEHOLDER_NAME,
  assignedTaskDocument as protocolAssignedTaskDocument,
  type SessionLaunchInstructions,
  taskTitleFor,
  turnFileInstruction,
} from '@ferretry/protocol';
import type { CoreAccount } from '../../core/inventory.ts';
import { formatSessionTitle } from '../../names/policy.ts';
import { parseSessionId, type SessionId } from '../../session-id.ts';
import { sessionTarget } from '../../tmux/address.ts';
import type { SessionLifecycleSettings } from './settings.ts';
import {
  type CreateSessionLifecycleRequest,
  type LifecycleSessionStatus,
  type RecordedSessionStatus,
  SESSION_BOARD_CAPABILITY_VARIABLE,
  SESSION_ID_VARIABLE,
  SESSION_MEDIA_VARIABLE,
  SESSION_TOKEN_VARIABLE,
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
 * Whether `path` is a launcher the fleet generated: a version-1 auto-wrapper name, or a version-2
 * runtime wrapper in a fleet's `bin` directory.
 *
 * This is the PATH half of the rule, the only half a launch can check: it sees an argv, not the
 * manifest. Whether that launcher is an AGENT runtime is the other half, and it is decided where the
 * published runtimes are in hand — {@link unrunnableAccountRefusal}, through `resolveStartAccount` —
 * from the manifest's own declaration rather than from anything in a name.
 */
export function isFleetLauncher(path: string, settings: SessionLifecycleSettings): boolean {
  return settings.agentWrapperPattern.test(basename(path)) || settings.runtimeLauncherPattern.test(path);
}

/**
 * The daemon launches fleet launchers, nothing else. Without this an `agent` of `/bin/sh` with a
 * `-c` payload is a remote shell holding the daemon's privileges.
 */
export function authorizeSessionCommand(
  agent: string,
  command: readonly string[],
  settings: SessionLifecycleSettings,
): readonly string[] {
  if (!isFleetLauncher(agent, settings)) throw new Error(`agent is not a fleet auto wrapper: ${agent}`);
  if (command[0] !== agent) throw new Error(`command must start with the agent wrapper: ${agent}`);
  return command;
}

/**
 * Whether a published account may run unattended sessions: the manifest declares it an agent
 * (`mode: auto` — a version-2 runtime with "Ferretry launches this as an agent" is published so, and a
 * version-1 auto route always was) AND its wrapper is one {@link authorizeSessionCommand} accepts.
 *
 * Both, so the two halves can never disagree: an account this calls runnable is one the launch
 * accepts, and a launcher the launch accepts is runnable only when the manifest says it is an agent.
 * The `-auto-` name is no longer the test — a runtime's name is the person's choice (§8.4).
 */
export function isAgentAccount(account: CoreAccount, settings: SessionLifecycleSettings): boolean {
  return account.mode === 'auto' && isFleetLauncher(account.wrapper, settings);
}

/**
 * Why a published account cannot run a session, in words that name the ones that can — or
 * `undefined` when it can.
 *
 * The rule is {@link isAgentAccount}, not a second opinion about which accounts are runnable: every
 * account it names is one the launch would accept. Asking here, where the published accounts are in
 * hand, is the point — the launch sees only a path and can only say the path is wrong.
 *
 * IT NAMES, IT NEVER SUBSTITUTES. An account and the auto account beside it usually share one
 * sign-in, but nothing published says so: which accounts share a login is declared in the fleet
 * configuration, which a start deliberately does not read. Quietly running the session on "the auto
 * account of the same harness" would, on a host with two logins, run it on somebody else's. So the
 * caller is told which accounts can run it and chooses; accounts of the requested harness come first
 * because that is the likely intent, and an account declared unavailable is never offered.
 */
export function unrunnableAccountRefusal(
  requested: CoreAccount,
  published: readonly CoreAccount[],
  settings: SessionLifecycleSettings,
  clientName: string,
): string | undefined {
  const runnable = (account: CoreAccount): boolean => isAgentAccount(account, settings);
  if (runnable(requested)) return undefined;
  const candidates = published.filter(account => account.available && runnable(account));
  const sameHarness = candidates.filter(account => account.kind === requested.kind);
  const offered = (sameHarness.length > 0 ? sameHarness : candidates).map(account => account.agent);
  const refused = `${requested.agent} is for using ${HARNESS_LABEL[requested.kind]} yourself in a terminal, so ${clientName} cannot start sessions on it, in either --mode`;
  const [first] = offered;
  if (first === undefined)
    return `${refused}, and no runtime on this machine can run sessions yet. Add an agent runtime with \`${clientName} runtime add <name> --credential <login> --profile <profile> --agent\`; \`${clientName} runtimes\` marks the agent runtimes.`;
  const choice = offered.length === 1 ? first : `one of ${offered.join(', ')}`;
  return `${refused}. Start it on ${choice} instead: \`${clientName} start --agent ${first} "your task"\`. \`${clientName} runtimes\` marks the agent runtimes, which can run sessions.`;
}

/** The turn-one document an agent reads. */
export function assignedTaskDocument(prompt: string): string {
  return protocolAssignedTaskDocument(prompt);
}

/** What is typed into a ready terminal so the agent picks its assignment up. */
export function firstTurnInstruction(taskFile: string): string {
  return turnFileInstruction(taskFile);
}

/**
 * The environment one pane is launched with: whatever the session's own environment store holds,
 * plus the identity the daemon derives from the id itself.
 *
 * THE IDENTITY IS DERIVED, NEVER STORED, and it is written LAST so nothing can rename the session.
 * The stored document is read-modify-written by a third party — a task board delivering a grant
 * merges variables into it — and it can be absent entirely for a session created before the store
 * existed. Either would cost a pane its own name if the id came from the file: a merge that shipped
 * an `FY_SESSION_ID` would make the pane claim to be a different session, and a lost file would make
 * it claim to be nobody. The id is on the record the launch is already reading, so this cannot fail
 * for a reason the record cannot see.
 *
 * Both launch paths call it — the first launch and the revive that replaces a dead pane — because a
 * session that could identify itself until its pane was replaced is worse than one that never could:
 * the failure arrives later, in the middle of a conversation, and looks like the peer going silent.
 *
 * HYPERMEDIA DEFAULTS BY MODE, written FIRST so a stored switch wins: ON for an interactive ferret, OFF for an
 * auto one (a worker, a warden, a miner), so a ferret whose switch was never written follows its mode at the
 * next launch and only an explicit value the owner set overrides it (docs/hypermedia.md). THE MODE IS REQUIRED,
 * read from the session's own record by every launch path: an optional one let a caller that forgot it launch
 * an interactive ferret with hypermedia silently off.
 *
 * THE MEDIA FOLDER IS DERIVED TOO, and written last for the same reason as the id: a stored variable
 * must not be able to point an agent's "show this" files somewhere the media route does not read. So is
 * the question file Claude's hook records an asked question in: the observer reads only the session's own.
 *
 * THE SESSION TOKEN IS DERIVED as well: `FY_SESSION_TOKEN` is the stored credential under its documented
 * name, written after the store so a stored value under that name can never name a different credential —
 * and absent with it, so a session that holds none is not handed an empty one.
 */
export function sessionPaneEnvironment(
  id: SessionId,
  stored: Readonly<Record<string, string>>,
  mode: 'auto' | 'interactive',
  files?: SessionPaneFiles,
): Readonly<Record<string, string>> {
  const { [SESSION_TOKEN_VARIABLE]: _stale, ...kept } = stored;
  const credential = stored[SESSION_BOARD_CAPABILITY_VARIABLE];
  return {
    [HYPERMEDIA_ENV]: mode === 'interactive' ? '1' : '0',
    ...kept,
    ...(credential === undefined || credential === '' ? {} : { [SESSION_TOKEN_VARIABLE]: credential }),
    [SESSION_ID_VARIABLE]: id,
    ...(files === undefined
      ? {}
      : { [SESSION_MEDIA_VARIABLE]: files.media, [QUESTION_ASKED_FILE_ENV]: files.questionAsked }),
  };
}

/**
 * A ferret's identity in an environment: its credential under both names, and its id.
 *
 * A DAEMON NEVER CARRIES ONE, because everything it starts inherits its environment — the tmux server, and
 * through it every pane and terminal. A daemon started from inside a ferret's pane (`fy daemon restart`
 * typed there, a development run) would otherwise hand THAT ferret's credential to every child that is not
 * handed its own: a sub-ferret, a terminal, a session from before the credential existed. A child never
 * inherits its parent's credential; it holds its own (`sessionPaneEnvironment`) or none.
 */
export const FERRET_IDENTITY_VARIABLES = [
  SESSION_TOKEN_VARIABLE,
  SESSION_BOARD_CAPABILITY_VARIABLE,
  SESSION_ID_VARIABLE,
] as const;

/** The session's own files a pane is handed by name; see `SessionPaths.media` and `SessionPaths.questionAsked`. */
export interface SessionPaneFiles {
  readonly media: string;
  readonly questionAsked: string;
}

/** Creates (if needed) the session's media folder and names it and the session's other pane files. */
export type SessionPaneFolders = (id: SessionId) => Promise<SessionPaneFiles>;

/** Everything the daemon had to resolve before a record could be built. */
export interface SessionRecordContext {
  readonly id: SessionId;
  /** Canonical, existing directory — never the raw request value. */
  readonly cwd: string;
  /** The board this session works on, when the daemon could resolve one; absent leaves it to be resolved on read. */
  readonly projectId?: BoardProjectId;
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
  const named = formatSessionTitle(request.name ?? '');
  const name = named || formatSessionTitle(prompt ? taskTitleFor(prompt, 'Task') : INTERACTIVE_PLACEHOLDER_NAME);
  // Parsed, not asserted: this is the same shape `read` parses back, so a config that violates its
  // own schema can never reach the store and strand the session there.
  const record = SessionLifecycleRecordSchema.parse({
    config: {
      id: context.id,
      name,
      nameSource: named ? 'owner' : 'auto',
      agent,
      command,
      cwd: context.cwd,
      mode: request.mode,
      ...(prompt ? { prompt } : {}),
      ...(parent ? { parent } : {}),
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
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
 * The record with the launch fact its new pane answered, or unchanged when the launcher could not say —
 * a pane the launcher did not describe keeps the description of the last one that was.
 */
export function withLaunchInstructions(
  record: SessionLifecycleRecord,
  instructions: SessionLaunchInstructions | undefined,
): SessionLifecycleRecord {
  return instructions === undefined
    ? record
    : { ...record, state: { ...record.state, launchInstructions: instructions } };
}

/**
 * The lifecycle phase a recorded status implies.
 *
 * The six lifecycle statuses are their own phase. Every turn-level status the watcher writes while a
 * pane is up (`thinking`, `awaiting_user`, `interrupted`, …) means the session is `running`. A
 * `completed` session is over by its own verdict, which a stop must not overwrite with `stopped`, so
 * it is the `stopped` phase; a `stalled` one has an ending nobody confirmed and may still hold a
 * pane, so it is the `failed` phase — killable and retryable like any other failure.
 */
export function lifecyclePhase(status: RecordedSessionStatus): LifecycleSessionStatus {
  switch (status) {
    case 'created':
    case 'starting':
    case 'failed':
    case 'kill_failed':
    case 'stopped':
      return status;
    case 'completed':
      return 'stopped';
    case 'stalled':
      return 'failed';
    case 'running':
    case 'thinking':
    case 'tool_running':
    case 'awaiting_question':
    case 'awaiting_user':
    case 'interrupted':
    case 'rate_limited':
    case 'retrying':
    case 'waiting':
      return 'running';
  }
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
  failed: ['starting', 'kill_failed', 'stopped'],
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
  if (!transitions[lifecyclePhase(record.state.status)].includes(status))
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
