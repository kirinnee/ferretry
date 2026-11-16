import type { FerretId, FerretRecord, FerretState, HarnessKey } from '../../../../contract/index.ts';
import {
  type ConversationHolderStanding,
  ConversationLeaseHeldError,
  type ConversationLeaseStore,
  conversationFromArguments,
  type HistoryHarness,
} from '../../../../contract/conversation-lease.ts';
import { type SessionId, tryParseSessionId } from '../../session-id.ts';
import type { SessionConversationLeases } from '../peers/conversation-lease.ts';
import { type ResumableSessionStatus, TERMINAL_RESUME_STATUSES } from '../resume/types.ts';

/** What the daemon knows of a session that its leases need: how it launches, and whether it is still writing. */
export interface ConversationLeaseSessions {
  /**
   * The harness history pool a session's launches write to and the runtime it runs on (for the refusal sentence).
   * `undefined` for a session that has none, or one this daemon does not know: it launches nothing that can be leased.
   */
  launchOf(id: SessionId): { readonly harness: HistoryHarness; readonly runtime?: string } | undefined;
  /**
   * What the ferret registry says of the session NOW: the one live fact, written by the same call that launches or
   * stops it. `undefined` when the registry does not hold it.
   */
  registryState(id: SessionId): FerretState | undefined;
  /**
   * The session's state document as stored, or a rejection when it cannot be read. It FOLLOWS the registry
   * asynchronously (and a reconcile start never moves it to `starting`), so it only answers for a session the registry
   * does not hold.
   */
  readState(id: SessionId): Promise<unknown>;
}

/** The history pool a harness key writes to: Claude Code's and Codex's own. */
const POOL_OF: Readonly<Record<HarnessKey, HistoryHarness>> = { 'claude-code': 'claude', codex: 'codex' };

/**
 * What the leases know of a session, from the ferret registry (the harness and runtime a ferret launches on) and the
 * session store (whether it is still writing). A session the registry does not hold launches nothing the daemon can name.
 */
export function registryLeaseSessions(
  registry: { get(id: FerretId): Pick<FerretRecord, 'harness' | 'runtime' | 'state'> | undefined },
  readState: ConversationLeaseSessions['readState'],
): ConversationLeaseSessions {
  return {
    launchOf: id => {
      const held = registry.get(id as unknown as FerretId);
      return held === undefined
        ? undefined
        : { harness: POOL_OF[held.harness], ...(held.runtime === undefined ? {} : { runtime: held.runtime }) };
    },
    registryState: id => registry.get(id as unknown as FerretId)?.state,
    readState,
  };
}

/** A field bag, or nothing. */
function fields(document: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * The daemon's conversation leases (docs/design/account-model.md H2, §9.3): one live writer per harness conversation,
 * across every ferret, claimed BEFORE a pane exists and freed once the session is over.
 *
 * The holder is the session id plus a pid. The session, not the pid, is what a daemon reads back (a restarted daemon must
 * still see a pane it launched as writing). A terminal claim cannot ask the daemon, so it reads the PID — and the pid
 * must be the pane's, not this daemon's, or a restarted daemon's dead pid would let it take the conversation while the
 * pane writes. So the lease names this daemon's pid only from `claim` (before any pane exists) until
 * {@link ConversationLeases.moveToPane}, which the lifecycle calls as soon as the pane has opened (a pane the daemon
 * launches never runs the runtime wrapper, so no wrapper claim ever moves it). That is the whole of what a session can
 * claim for: its OWN lease. A claim for another session's conversation names a different session, so a live holder
 * refuses it whoever asks, and only a holder that is over lets it take the conversation.
 */
export class ConversationLeases implements SessionConversationLeases {
  constructor(
    private readonly store: ConversationLeaseStore,
    private readonly sessions: ConversationLeaseSessions,
    private readonly holderPid: number,
  ) {}

  /** Throws {@link ConversationLeaseHeldError} when another live writer holds the conversation `command` names. */
  async claim(sessionId: string, command: readonly string[]): Promise<void> {
    await this.lease(sessionId, command, this.holderPid);
  }

  /** The same session claiming again, now as the pane's process: a renewal, under the pool's lock. */
  async moveToPane(sessionId: string, command: readonly string[], pid: number | undefined): Promise<void> {
    await this.lease(sessionId, command, pid);
  }

  private async lease(sessionId: string, command: readonly string[], pid: number | undefined): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return;
    const launch = this.sessions.launchOf(id);
    if (launch === undefined) return;
    // Index 0 is the executable, never an argument.
    const conversation = conversationFromArguments(launch.harness, command.slice(1));
    if (conversation === undefined) return;
    if (pid === undefined)
      throw new Error(
        `session ${id} could not tell which process runs its terminal, so conversation ${conversation} cannot be kept ` +
          'for it; it was stopped rather than risk a second writer',
      );
    const outcome = await this.store.claim(
      {
        harness: launch.harness,
        conversation,
        holder: {
          pid,
          session: id,
          ...(launch.runtime === undefined ? {} : { runtime: launch.runtime }),
        },
      },
      async session => await this.standing(session),
    );
    if (outcome.kind === 'held') throw new ConversationLeaseHeldError(outcome.lease);
  }

  async release(sessionId: string): Promise<void> {
    await this.store.releaseSession(sessionId);
  }

  /**
   * Whether a session is still writing. The registry decides when it holds the session (a ferret it runs — started by a
   * lifecycle OR a reconcile — is live, whatever its document has not yet followed to; one it says stopped is over).
   * Otherwise the document: over means its record is gone or terminal; anything else — running, starting, waiting between
   * panes — still owns its conversation. A record that cannot be READ is not a record that is gone: the pid then decides,
   * which keeps a live holder held while this daemon runs.
   */
  private async standing(session: string): Promise<ConversationHolderStanding> {
    const id = tryParseSessionId(session);
    if (id === undefined) return 'unknown';
    const registered = this.sessions.registryState(id);
    if (registered !== undefined) return registered === 'stopped' ? 'over' : 'live';
    const document = await this.sessions.readState(id).then(
      value => ({ value }),
      () => undefined,
    );
    if (document === undefined) return 'unknown';
    const state = fields(document.value);
    if (state === undefined) return 'over';
    return TERMINAL_RESUME_STATUSES.has(state.status as ResumableSessionStatus) ? 'over' : 'live';
  }
}
