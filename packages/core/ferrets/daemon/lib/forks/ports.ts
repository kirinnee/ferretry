/**
 * What a fork reads from the plugins around Ferrets, named as the SMALLEST structural ports.
 *
 * Ferrets is core and cannot import a plugin's code, so the three facts below — owned by the harness plugins (the quirk
 * table, how a model reaches a launch argv) and the conversation plugin (where a transcript lives, and the evidence
 * a transcript is later identified from) — arrive through the fork module's needs. Each member keeps today's exact
 * signature and meaning; none is given a behaviour here. The host binds them, and a host that has no plugin able to
 * answer binds a fail-closed skeleton, so an unbound fork refuses rather than guesses.
 */

import type { TranscriptProvenance } from '../../../contract/records.ts';
import type { Harness } from '../protocol/session-base.ts';
import type { ConversationMessagePoint } from '../protocol/session-transfer-edge.ts';
import type { HarnessKind } from '../session/peers/fleet.ts';

/**
 * The two rows of the harness quirk table a fork reads (today's `HarnessQuirks`, narrowed).
 *
 * `effortIsRuntimeCommand`: reasoning effort is a native command the harness handles locally (Claude), rather than
 * something only its modal picker can set (Codex). `mintsOwnSessionIds`: the harness names its own sessions after launch
 * (Codex), so the daemon records a correlation token instead of choosing the id.
 */
interface ForkHarnessQuirks {
  readonly effortIsRuntimeCommand: boolean;
  readonly mintsOwnSessionIds: boolean;
}

/** Today's `harnessQuirks`, `startupModelArguments` and `claudeTranscriptFile`, as the harness plugins answer them. */
export interface ForkHarnessFacts {
  /** The quirks of one harness. */
  quirks(harness: HarnessKind): ForkHarnessQuirks;
  /**
   * The model selection every new harness invocation receives on its launch argv. Placed LAST so the daemon's explicit
   * choice wins over an account default or a carried flag.
   */
  startupModelArguments(model: string): readonly string[];
  /** The exact file Claude will write for a session launched with this id in this directory. */
  claudeTranscriptFile(home: string, cwd: string, harnessSessionId: string): string;
}

/** What a start knows before it launches anything (today's `TranscriptCaptureRequest`). */
interface ForkTranscriptCaptureRequest {
  readonly harness: Harness;
  /** The absolute wrapper the session will be launched through. */
  readonly executable: string;
  /** The canonical working directory the session will run in. */
  readonly cwd: string;
  /** A string this session, and only this session, will contain: the session's own directory. */
  readonly correlationToken: string;
  readonly at: string;
}

/** The record to persist and the arguments the launch must carry for it to come true (today's `TranscriptCapture`). */
interface ForkTranscriptCapture {
  /** Absent when this session's transcript is genuinely not locatable. */
  readonly provenance?: TranscriptProvenance;
  /** Appended to the launch argv: the minted session for Claude, the correlation root for Codex. */
  readonly launchArguments: readonly string[];
}

/** Today's `TranscriptProvenanceCapture.capture`: the evidence a session's transcript is later identified from. */
export interface ForkTranscriptCaptures {
  capture(request: ForkTranscriptCaptureRequest): Promise<ForkTranscriptCapture>;
}

/** What a selection binding is verified against: the exact source and the exact transcript it was issued for. */
interface ForkSelectionSubject {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly provenance: TranscriptProvenance;
}

/**
 * Today's `verifySessionTranscriptMessageToken` over the daemon-private message-token codec and the selection domain
 * (`SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN`), both of which the conversation plugin owns and the host binds in.
 * The codec shared with the operator message read surface is the point: a fork verifies the very evidence that surface
 * issued. `accepted` is the only verdict that admits a selection; `malformed` and `stale` are deliberately not told
 * apart by the caller.
 */
export interface ForkSelectionTokens {
  verifySelection(
    subject: ForkSelectionSubject,
    through: ConversationMessagePoint,
    rawPrefix: Uint8Array,
    binding: string,
  ): Promise<'accepted' | 'malformed' | 'stale'>;
}
