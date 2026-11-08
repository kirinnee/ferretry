/**
 * THE LIVE READOUT AND THE TRANSCRIPT SIGNAL, MOUNTED (U5, G161): what `?live=1` and `?transcript=1` on
 * `GET /v1/events` carry. Both are today's, copied: `StorageLiveActivitySource` (a working turn's verb, token counts and
 * compaction, sampled at the stream's 500 ms) and `FileTranscriptChanges` (a frame with no content when the proved
 * transcript was written). What is new is only where their reads come from.
 *
 * WHAT A LIVE FRAME MAY CARRY is the closed list in `FerretLiveActivitySchema`: ids and instants, token counts, the
 * compaction's counts and timings, and ONE free text, the harness's own status verb (80 characters, cut from the pane by
 * a pattern). That verb is read from a pane the runner already masked and is masked AGAIN here inside one
 * `kernel.redaction` read before it leaves, so a verb that matches a secret never goes out as one. No pane text and no
 * transcript text is ever a frame: the harness's tail records carry none (`HarnessTailRecord`), and a transcript signal
 * has no body at all.
 *
 * WHAT IT READS, EACH THROUGH ITS OWNER: the state document (Ferrets' own store), the pane through `Runner.look` (inside
 * `kernel.act(terminal, 'read')`, so a Vault hold refuses it and nothing is sent from a held pane), and the transcript
 * through the harness that wrote it (`transcriptStamp`, `transcriptTail`): Ferrets opens no transcript path. A ferret the
 * registry does not hold, or holds stopped, has no pane to look at.
 *
 * NO FASTER THAN TODAY: the stream samples at 500 ms; a quiet transcript costs one stamp per sample and is re-read only
 * when its stamp moved; an idle pane is looked at every 2 s; a followed transcript is asked every second (the kernel has
 * no file watch on a root: GAP(live)).
 */
import type { Redaction } from '@ferretry/kernel/contract';
import type { FerretId, FerretRecord, Runner, RunnerHandle } from '../../contract/index.ts';
import { FerretLiveActivitySchema, type SessionLiveActivity } from '../lib/protocol/session-live.ts';
import type { ClockPort } from '../lib/ports.ts';
import type { SessionId } from '../lib/session-id.ts';
import type { LiveActivitySource, TranscriptChangeSource } from '../lib/session/events/service.ts';
import type { CompactionHistory } from '../lib/session/live/compaction.ts';
import type { PaneState } from '../lib/session/peers/tmux.ts';
import { FileTranscriptChanges } from '../adapters/session/live/file-transcript-changes.ts';
import type { HarnessTranscript } from '../adapters/session/live/harness-transcript.ts';
import { PolledTranscriptEvents } from '../adapters/session/live/polled-transcript-events.ts';
import { StorageLiveActivitySource } from '../adapters/session/live/storage-live-activity.ts';

export interface LiveEventsDeps {
  /** The ferret's state document, unparsed (Ferrets' own store). */
  readonly readState: (id: SessionId) => Promise<unknown>;
  /** The registry's record of a ferret: which runner and handle its pane is, and whether it still runs. */
  readonly record: (ferret: FerretId) => FerretRecord | undefined;
  readonly runner: () => Runner | undefined;
  readonly transcript: HarnessTranscript;
  readonly clock: ClockPort;
  /** Runs `tick` every `intervalMs` until the answer is called (`kernel.clock.every`). */
  readonly every: (intervalMs: number, tick: () => void) => () => void;
  readonly redaction: Pick<Redaction, 'read'>;
  /** Compaction history is Usage's (RULING #27, Q6): absent here, and live frames work without it. */
  readonly history?: CompactionHistory;
}

/** The longest verb a frame carries (the schema's own bound). */
const VERB_MAX = 80;

/**
 * The live source with every frame passed through the schema and the verb through the redaction on its way out: a frame
 * the schema refuses is dropped, and the verb is cut to the schema's bound after it is masked.
 */
class MaskedLiveActivity implements LiveActivitySource {
  constructor(
    private readonly inner: LiveActivitySource,
    private readonly redaction: Pick<Redaction, 'read'>,
  ) {}

  async sample(sessionId: string, signal: AbortSignal): Promise<SessionLiveActivity | undefined> {
    const sample = await this.inner.sample(sessionId, signal);
    if (sample === undefined) return undefined;
    const masked =
      sample.verb === undefined
        ? sample
        : await this.redaction.read(scope => {
            const verb = scope.text(sample.verb as string).slice(0, VERB_MAX);
            const { verb: _unmasked, ...rest } = sample;
            return verb === '' ? rest : { ...rest, verb };
          });
    const parsed = FerretLiveActivitySchema.safeParse(masked);
    return parsed.success ? parsed.data : undefined;
  }
}

/** One look at a live ferret's pane as the live readout reads it: the status lines of the masked frame, or nothing. */
const paneOf = async (deps: LiveEventsDeps, id: SessionId): Promise<PaneState | undefined> => {
  const record = deps.record(id as unknown as FerretId);
  if (record === undefined || record.state === 'stopped' || record.handle === undefined) return undefined;
  const look = await deps
    .runner()
    ?.look?.(record.handle as RunnerHandle)
    .catch(() => undefined);
  if (look?.status === undefined) return undefined;
  return { dead: false, alive: true, promptReady: look.atPrompt === true, history: '', visible: look.status };
};

/** The `?live=1` source and the `?transcript=1` source, both over the harness's transcript and the runner's look. */
export function buildLiveEvents(deps: LiveEventsDeps): {
  readonly live: LiveActivitySource;
  readonly transcript: TranscriptChangeSource;
} {
  const live = new StorageLiveActivitySource(
    {
      readState: deps.readState,
      paneState: async id => await paneOf(deps, id),
      transcriptFile: deps.transcript.reads.transcriptFile,
      transcriptStat: deps.transcript.reads.transcriptStat,
    },
    deps.transcript.tail,
    deps.clock,
    deps.history,
  );
  return {
    live: new MaskedLiveActivity(live, deps.redaction),
    transcript: new FileTranscriptChanges({
      file: async sessionId => await deps.transcript.reads.transcriptFile(sessionId as SessionId),
      stat: deps.transcript.reads.transcriptStat,
      files: new PolledTranscriptEvents(deps.every),
      clock: deps.clock,
    }),
  };
}
