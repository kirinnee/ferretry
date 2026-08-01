/**
 * Transcript provenance, captured at the moment a session is created.
 *
 * THIS IS THE FIX FOR THE ROOT CAUSE THE TRANSCRIPT AUDIT FOUND: the daemon owned a complete
 * parser and a bounded follower and could mount neither, because a session document recorded no
 * transcript and no evidence from which one could be derived. Everything downstream — the
 * migration preflight's tool inventory, `state.lastTranscriptAt`, learning extraction, analytics
 * source enrollment — was blocked behind that single absence.
 *
 * The evidence has to be taken at creation and nowhere else. Afterwards the daemon can see only
 * files on disk, and files on disk cannot distinguish two teammates that share an account, a
 * working directory and a minute. So:
 *
 *   * CLAUDE is DECIDED. The daemon mints the harness session id, puts it on the launch argv, and
 *     the transcript path follows from it. There is no discovery step and therefore no way to be
 *     wrong.
 *   * CODEX is BASELINED. The daemon records which rollouts existed before the launch and the
 *     unique string it is about to inject into the session, and correlates later against both.
 *   * ANYTHING ELSE gets NOTHING. A session whose wrapper declares no resolvable harness home, and
 *     a Codex session with no injected token to correlate against, carry no transcript record at
 *     all. That is the deliberate answer: no transcript is recoverable, a guessed one is not.
 */

import type { Harness, TranscriptProvenance } from '@ferretry/protocol';
import { claudeSessionArguments, claudeTranscriptFile } from './claude-path.ts';
import type { HarnessWrapperSource } from './wrapper-home.ts';
import { harnessHomeFromWrapper } from './wrapper-home.ts';

/** Mints the identity the daemon hands a harness that accepts one. */
export interface HarnessSessionIdFactory {
  next(): string;
}

/** Lists the harness session ids a home already holds, for harnesses that name their own. */
export interface CodexRolloutBaseline {
  ids(home: string): Promise<readonly string[]>;
}

/** What a start knows before it launches anything. */
export interface TranscriptCaptureRequest {
  readonly harness: Harness;
  /** The absolute wrapper the session will be launched through. */
  readonly executable: string;
  /** The canonical working directory the session will run in. */
  readonly cwd: string;
  /**
   * A string this session — and only this session — will contain.
   *
   * The composition root passes the session's own directory, which the opening turn instructs the
   * agent to read, so the token reaches the transcript as ordinary session content rather than as
   * something extra the daemon had to arrange.
   */
  readonly correlationToken: string;
  readonly at: string;
}

/** The record to persist, and the arguments the launch must carry for it to come true. */
export interface TranscriptCapture {
  /** Absent when this session's transcript is genuinely not locatable. */
  readonly provenance?: TranscriptProvenance;
  /** Appended to the launch argv. Empty for a harness that names its own session. */
  readonly launchArguments: readonly string[];
}

/** Nothing was captured: no home, or no mechanism for this harness. */
const NOTHING: TranscriptCapture = { launchArguments: [] };

/**
 * Captures the evidence a session's transcript can later be identified from.
 *
 * It is a pure decision over two injected capabilities — reading the wrapper and listing the
 * existing rollouts — so a start can be tested for what it records without a harness on the box.
 */
export class TranscriptProvenanceCapture {
  constructor(
    private readonly wrappers: HarnessWrapperSource,
    private readonly harnessSessionIds: HarnessSessionIdFactory,
    private readonly baselines: CodexRolloutBaseline,
    /**
     * The daemon's own environment, injected rather than read.
     *
     * A wrapper writes its home in terms of `$HOME` and whatever else the fleet exports, and the
     * expansion has to happen against the environment the WRAPPER will run in — which is this
     * daemon's, because the daemon is what launches it.
     */
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  async capture(request: TranscriptCaptureRequest): Promise<TranscriptCapture> {
    const source = await this.wrappers.read(request.executable);
    if (source === undefined) return NOTHING;
    const home = harnessHomeFromWrapper(source, request.harness, this.environment);
    if (home === undefined) return NOTHING;
    return request.harness === 'claude' ? this.mint(home, request) : await this.baseline(home, request);
  }

  /**
   * Claude: choose the id, name the file, and put the id on the argv that makes it true.
   *
   * No correlation token is recorded, because nothing here needs correlating: the record would
   * suggest the attribution rests on finding a string in the file when it rests on having named
   * the file.
   */
  private mint(home: string, request: TranscriptCaptureRequest): TranscriptCapture {
    const harnessSessionId = this.harnessSessionIds.next();
    return {
      provenance: {
        v: 1,
        home,
        harnessSessionId,
        identity: 'minted',
        file: claudeTranscriptFile(home, request.cwd, harnessSessionId),
        resolvedAt: request.at,
      },
      launchArguments: claudeSessionArguments(harnessSessionId),
    };
  }

  /** Codex: record what already exists and what will prove ownership, and resolve later. */
  private async baseline(home: string, request: TranscriptCaptureRequest): Promise<TranscriptCapture> {
    return {
      provenance: {
        v: 1,
        home,
        identity: 'undiscovered',
        baseline: [...(await this.baselines.ids(home))],
        correlationToken: request.correlationToken,
      },
      launchArguments: [],
    };
  }
}
