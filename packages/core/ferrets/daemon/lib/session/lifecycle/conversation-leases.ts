import type { FerretId, FerretRecord, HarnessKey } from '../../../../contract/index.ts';
import {
  type ConversationHolderStanding,
  type ConversationId,
  ConversationIdSchema,
  ConversationLeaseHeldError,
  type ConversationLeaseStore,
  conversationFromArguments,
  type HistoryHarness,
} from '../../../../contract/conversation-lease.ts';
import type { FerretLaunchLeases } from '../../ferrets/launch-leases.ts';
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
  /** The session's state document as stored, or a rejection when it cannot be read. */
  readState(id: SessionId): Promise<unknown>;
}

/** The history pool a harness key writes to: Claude Code's and Codex's own. */
const POOL_OF: Readonly<Record<HarnessKey, HistoryHarness>> = { 'claude-code': 'claude', codex: 'codex' };

/**
 * What the leases know of a session, from the ferret registry (the harness and runtime a ferret launches on) and the
 * session store (whether it is still writing). A session the registry does not hold launches nothing the daemon can name.
 */
export function registryLeaseSessions(
  registry: { get(id: FerretId): Pick<FerretRecord, 'harness' | 'runtime'> | undefined },
  readState: ConversationLeaseSessions['readState'],
): ConversationLeaseSessions {
  return {
    launchOf: id => {
      const held = registry.get(id as unknown as FerretId);
      return held === undefined
        ? undefined
        : { harness: POOL_OF[held.harness], ...(held.runtime === undefined ? {} : { runtime: held.runtime }) };
    },
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
 * The holder is THIS daemon's pid plus the session id. The session, not the pid, is what a daemon reads back (a restarted
 * daemon must still see a pane it launched as writing), while a terminal claim sees the daemon's pid — which is why a
 * daemon-launched wrapper's own claim, carrying the session id, renews the lease with the harness pid it is about to
 * become. That is also the whole of what a session can claim for: its OWN lease. A claim for another session's
 * conversation names a different session, so a live holder refuses it whoever asks (a wrapper inside S is no exception),
 * and only a holder that is over lets it take the conversation.
 */
export class ConversationLeases implements SessionConversationLeases, FerretLaunchLeases {
  constructor(
    private readonly store: ConversationLeaseStore,
    private readonly sessions: ConversationLeaseSessions,
    private readonly holderPid: number,
  ) {}

  /** Throws {@link ConversationLeaseHeldError} when another live writer holds the conversation `command` names. */
  async claim(sessionId: string, command: readonly string[]): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return;
    const launch = this.sessions.launchOf(id);
    if (launch === undefined) return;
    // Index 0 is the executable, never an argument.
    const conversation = conversationFromArguments(launch.harness, command.slice(1));
    if (conversation === undefined) return;
    await this.hold(id, launch, conversation, this.holderPid);
  }

  /** {@link FerretLaunchLeases.claim}: the conversation a launch resumes or binds, as this daemon, before a pane exists. */
  async claimConversation(ferret: FerretId, conversation: string): Promise<void> {
    await this.holdFor(ferret, conversation, this.holderPid);
  }

  /** {@link FerretLaunchLeases.moveToPane}: a renewal as the pane's process; fails closed when its pid is not known. */
  async moveToPane(ferret: FerretId, conversation: string, pid: number | undefined): Promise<void> {
    if (pid === undefined)
      throw new Error(
        `ferret ${ferret} could not tell which process runs its terminal, so conversation ${conversation} cannot be kept for it`,
      );
    await this.holdFor(ferret, conversation, pid);
  }

  private async holdFor(ferret: FerretId, conversation: string, pid: number): Promise<void> {
    const id = tryParseSessionId(ferret);
    const launch = id === undefined ? undefined : this.sessions.launchOf(id);
    const parsed = ConversationIdSchema.safeParse(conversation);
    if (id === undefined || launch === undefined || !parsed.success) return;
    await this.hold(id, launch, parsed.data, pid);
  }

  private async hold(
    id: SessionId,
    launch: NonNullable<ReturnType<ConversationLeaseSessions['launchOf']>>,
    conversation: ConversationId,
    pid: number,
  ): Promise<void> {
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
   * Whether a session is still writing. Over means its record is gone or terminal; anything else — running, starting,
   * waiting between panes — still owns its conversation. A record that cannot be READ is not a record that is gone: the
   * pid then decides, which keeps a live holder held while this daemon runs.
   */
  private async standing(session: string): Promise<ConversationHolderStanding> {
    const id = tryParseSessionId(session);
    if (id === undefined) return 'unknown';
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
