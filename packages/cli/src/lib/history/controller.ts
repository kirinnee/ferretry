import {
  type ConversationId,
  type ConversationLeaseStore,
  ConversationIdSchema,
  conversationFromArguments,
  conversationLeaseRefusal,
  HISTORY_CLAIM_HELD_EXIT_CODE,
  type HarnessKind,
} from '@ferretry/fleet';

/** The output a claim needs: a refusal is said on stderr and fails the command. */
export interface IHistoryIo {
  error(message: string): void;
  setExitCode(code: number): void;
}

/** What `fy history claim` was told. Exactly one of `conversation` or `arguments` names the conversation. */
export interface HistoryClaimRequest {
  readonly harness: HarnessKind;
  /** The process that will write: the wrapper passes `$$`, which `exec` hands to the harness. */
  readonly pid: number;
  readonly conversation?: string;
  /** The harness's own arguments, read for a conversation id when none is named. */
  readonly arguments?: readonly string[];
}

/** Facts the controller is told rather than reads. */
export interface HistoryContext {
  /** `FY_SESSION_ID`: set when the daemon launched this wrapper, which makes this claim the session's own. */
  readonly session?: string;
  /** `FY_RUNTIME`, for the refusal sentence another claimant reads. */
  readonly runtime?: string;
}

/**
 * `fy history claim`: the wrapper half of one live writer per conversation (account model §9.3).
 *
 * A wrapper whose arguments name a conversation runs this before `exec`. It claims the lease for the
 * pid it is about to become, so a person's own `claude --resume <id>` and a daemon session can never
 * write one conversation at once. Claimed, or nothing to claim, is silent: a wrapper prints nothing
 * on the way to its harness. Held is one sentence naming the holder and the exit status
 * `HISTORY_CLAIM_HELD_EXIT_CODE`, the ONLY status the wrapper turns into not launching: every other
 * failure of `fy` launches anyway.
 */
export class HistoryController {
  constructor(
    private readonly store: ConversationLeaseStore,
    private readonly io: IHistoryIo,
    private readonly context: HistoryContext,
  ) {}

  async claim(request: HistoryClaimRequest): Promise<void> {
    const conversation = this.conversationOf(request);
    if (conversation === undefined) return;
    const outcome = await this.store.claim(
      {
        harness: request.harness,
        conversation,
        holder: {
          pid: request.pid,
          ...(this.context.session === undefined ? {} : { session: this.context.session }),
          ...(this.context.runtime === undefined ? {} : { runtime: this.context.runtime }),
        },
      },
      // Only the daemon holds session records, so the holder's pid decides a terminal claim.
      async () => 'unknown',
    );
    if (outcome.kind === 'claimed') return;
    this.io.error(conversationLeaseRefusal(outcome.lease));
    this.io.setExitCode(HISTORY_CLAIM_HELD_EXIT_CODE);
  }

  private conversationOf(request: HistoryClaimRequest): ConversationId | undefined {
    if (request.conversation === undefined) return conversationFromArguments(request.harness, request.arguments ?? []);
    const parsed = ConversationIdSchema.safeParse(request.conversation);
    if (parsed.success) return parsed.data;
    throw new Error(`not a conversation id: ${JSON.stringify(request.conversation)}`);
  }
}
