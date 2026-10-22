/**
 * One live writer per harness conversation (docs/design/account-model.md H2, §9.3).
 *
 * Every runtime of a harness shares one history pool, so two sessions — or a session and a person's
 * own terminal — can now reach the same conversation. Each launch this daemon makes claims the
 * conversation its argv names before the pane exists; a conversation another live writer holds
 * refuses the launch with that writer named, and the lease is released when the session stops,
 * fails or exits.
 *
 * The rules (what makes a lease stale, which argv names which conversation, the sentence) are the
 * fleet package's, shared with `fy history claim`; this file only decides WHEN the daemon claims and
 * releases, and answers the one question only a daemon can: whether the session a lease names is
 * still writing.
 */
import {
  type ConversationHolderStanding,
  ConversationLeaseHeldError,
  type ConversationLeaseStore,
  conversationFromArguments,
  type HarnessKind,
} from '@ferretry/fleet';
import { type SessionId, tryParseSessionId } from '../session-id.ts';
import type { ExitedSessionTransition, SessionExitObservation } from './health/exit.ts';
import type { SessionExitPort } from './health/service.ts';
import type { SurveyedSession } from './health/types.ts';
import { type ResumableSessionStatus, TERMINAL_RESUME_STATUSES } from './resume/types.ts';

/** What a launch path needs: claim before a pane exists, release once the session is over. */
export interface SessionConversationLeases {
  /** Throws {@link ConversationLeaseHeldError} when another live writer holds the conversation. */
  claim(sessionId: string, command: readonly string[]): Promise<void>;
  release(sessionId: string): Promise<void>;
}

/** The two documents a session's lease facts are read from. `DaemonStorage` satisfies it. */
export interface ConversationLeaseDocuments {
  readConfig(id: SessionId): Promise<unknown>;
  readState(id: SessionId): Promise<unknown>;
}

/** A field bag, or nothing. */
function fields(document: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Readonly<Record<string, unknown>>)
    : undefined;
}

function harnessOf(value: unknown): HarnessKind | undefined {
  return value === 'claude' || value === 'codex' ? value : undefined;
}

/**
 * The daemon's leases, over the shared store.
 *
 * The holder is THIS daemon's pid plus the session id. The session, not the pid, is what a daemon
 * reads back (a restarted daemon must still see a pane it launched as writing), while a terminal
 * claim sees the daemon's pid — which is why a daemon-launched wrapper's own claim, carrying the
 * session id, renews the lease with the harness pid it is about to become.
 */
export class ConversationLeases implements SessionConversationLeases {
  constructor(
    private readonly store: ConversationLeaseStore,
    private readonly documents: ConversationLeaseDocuments,
    private readonly holderPid: number,
  ) {}

  async claim(sessionId: string, command: readonly string[]): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return;
    const config = fields(await this.documents.readConfig(id).catch(() => undefined));
    const harness = harnessOf(config?.harness);
    // A session whose document names no harness launches nothing this file can read an id from.
    if (harness === undefined) return;
    // Index 0 is the executable, never an argument.
    const conversation = conversationFromArguments(harness, command.slice(1));
    if (conversation === undefined) return;
    const runtime = typeof config?.agent === 'string' && config.agent !== '' ? config.agent : undefined;
    const outcome = await this.store.claim(
      {
        harness,
        conversation,
        holder: { pid: this.holderPid, session: id, ...(runtime === undefined ? {} : { runtime }) },
      },
      async session => await this.standing(session),
    );
    if (outcome.kind === 'held') throw new ConversationLeaseHeldError(outcome.lease);
  }

  async release(sessionId: string): Promise<void> {
    await this.store.releaseSession(sessionId);
  }

  /**
   * Whether a session is still writing. Over means its record is gone or terminal; anything else —
   * running, starting, waiting between panes — still owns its conversation.
   */
  private async standing(session: string): Promise<ConversationHolderStanding> {
    const id = tryParseSessionId(session);
    if (id === undefined) return 'unknown';
    // A record that cannot be READ is not a record that is gone: the pid then decides, which keeps a
    // live holder held while this daemon runs.
    const document = await this.documents.readState(id).then(
      value => ({ value }),
      () => undefined,
    );
    if (document === undefined) return 'unknown';
    const state = fields(document.value);
    if (state === undefined) return 'over';
    return TERMINAL_RESUME_STATUSES.has(state.status as ResumableSessionStatus) ? 'over' : 'live';
  }
}

/**
 * The exited-session reconcile (the health pass's exit settle), releasing what the exited session held.
 *
 * A decorator rather than an edit to the health pass, so the pass keeps its single job. A release
 * that fails leaves a lease the daemon already reads as stale (its session is terminal), so it never
 * fails the settle that proved the exit.
 */
export class LeaseReleasingSessionExits implements SessionExitPort {
  constructor(
    private readonly exits: SessionExitPort,
    private readonly leases: Pick<SessionConversationLeases, 'release'>,
  ) {}

  async observe(survey: readonly SurveyedSession[]): Promise<readonly SessionExitObservation[]> {
    return await this.exits.observe(survey);
  }

  async settle(observation: SessionExitObservation, transition: ExitedSessionTransition): Promise<boolean> {
    const settled = await this.exits.settle(observation, transition);
    if (settled) await this.leases.release(observation.id).catch(() => undefined);
    return settled;
  }
}

/** The launch-argv hook a revive runs its command through. The resume launcher's limits wrapper satisfies it. */
export interface LaunchCommandWrapper {
  command(sessionId: string, command: readonly string[]): Promise<readonly string[]>;
}

/**
 * A revive's claim, at the one point a relaunch hands over the exact argv it is about to run.
 *
 * The launch-argv hook is called only by a relaunch, never by the pane reads that share its spec, so a
 * conversation another live session holds refuses the revive and nothing else. A revive of the
 * session that already holds the lease renews it.
 */
export class LeaseClaimingLaunchWrapper implements LaunchCommandWrapper {
  constructor(
    private readonly leases: Pick<SessionConversationLeases, 'claim'>,
    private readonly inner?: LaunchCommandWrapper,
  ) {}

  async command(sessionId: string, command: readonly string[]): Promise<readonly string[]> {
    await this.leases.claim(sessionId, command);
    return (await this.inner?.command(sessionId, command)) ?? command;
  }
}
