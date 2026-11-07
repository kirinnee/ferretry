import type {
  BoardAlertPorts,
  FerretTranscriptTail,
  ReopenDelivery,
  ReopenMessenger,
  TranscriptTailResult,
} from '../lib/board/index.ts';

/**
 * Talking to a ferret: typing into its turn, resuming it, reading its transcript. Ferrets' contract has no way to do
 * any of it (that is Conversation's), and Board does not `use` Conversation in its manifest (§2.4). Until the lead
 * rules on that edge (see the report) every message Board owes a ferret is HELD: said in the log, never typed, and
 * never pretended delivered. The shapes below are the seams the Conversation adapter fills.
 */
export interface FerretMessenger {
  /** Sends one message to one ferret as the ordinary send path would; the same `key` twice is one message. */
  deliver: ReopenMessenger['deliver'];
  /** How the ferret takes messages; `undefined` when it cannot be read. */
  mode: BoardAlertPorts['mode'];
  /** The newest transcript events of a ferret. */
  tail: FerretTranscriptTail['tail'];
}

/** The messenger of a daemon where Conversation is not reachable: nothing is delivered, everything is said. */
export class HeldMessages implements FerretMessenger {
  constructor(private readonly diagnostics: { warn(message: string): void }) {}

  async deliver(ferret: string): Promise<ReopenDelivery> {
    this.diagnostics.warn(`a board message for ${ferret} was held: Board cannot reach Conversation on this daemon`);
    return 'absent';
  }

  async mode(_ferret: string): Promise<undefined> {
    return undefined;
  }

  async tail(_ferret: string, _limit: number): Promise<TranscriptTailResult> {
    return { kind: 'unresolved' };
  }
}
