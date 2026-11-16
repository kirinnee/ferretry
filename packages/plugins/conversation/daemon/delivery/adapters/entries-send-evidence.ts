import type { BoundTranscriptReader } from '@ferretry/core-ferrets/contract';
import { instantFromEpochMs } from '@ferretry/std';
import { inputObserverFor, observedInputsOf } from '../../reader/adapters/input-proof.ts';
import type { TranscriptHarness } from '../../reader/lib/transcript/types.ts';
import type { SendEvidenceReading, SendEvidenceSource } from '../lib/tracker.ts';

/** A ferret's conversation as its harness plugin reads it: which harness wrote it, and the reader bound to the ferret. */
interface EvidenceTranscript {
  readonly harness: TranscriptHarness;
  readonly reader: Pick<BoundTranscriptReader, 'read' | 'readCovering'>;
}

/** The ferret's transcript, or nothing when this daemon does not know the ferret. */
export type EvidenceTranscripts = (ferret: string) => Promise<EvidenceTranscript | undefined>;

/** How far before the oldest watched send the evidence starts: clocks and record order both drift (today's window margin). */
const WINDOW_MARGIN_MS = 60_000;

/**
 * THE TRACKER'S EVIDENCE over the harness plugin's own entries (today's `TranscriptSendEvidence`, which read the file).
 *
 * STATELESS ON PURPOSE. A harness plugin parses its whole conversation on every `read` (paging does not make a read
 * cheaper), and an entry cursor that a rewrite of the file made stale would read as "nothing new" and let a look call a
 * delivered message absent, which types it a second time. So a look reads the whole conversation once, keeps what is
 * newer than the oldest watched send, and runs each entry through the harness's own input observer, in order.
 *
 * ABSENCE IS ONLY PROVABLE FROM A READ THAT WORKED. A conversation that cannot be read is `readable: false`; one that has
 * no entry at all is `unbound`, because an empty read is also what a plugin answers when it cannot find the file, and a
 * send accepted into a pane with no record of any kind is not proven absent by that. The tracker then says so
 * (`transcript_unbound`) instead of typing again.
 *
 * A LONG CONVERSATION IS READ BY ITS NEWEST PART. A harness may cut the read to its tail; what it found there still
 * proves a delivery, but the absence of a send is proved only by a read that reaches back to the window's start. A cut
 * read that does not is `readable: false` (unproved, never "nothing there"): the tracker then settles it unconfirmed
 * instead of typing the message again.
 */
export class EntriesSendEvidence implements SendEvidenceSource {
  constructor(private readonly transcripts: EvidenceTranscripts) {}

  async read(id: string, since: string): Promise<SendEvidenceReading> {
    const transcript = await this.transcripts(id).catch(() => undefined);
    if (transcript === undefined) return { readable: false, inputs: [] };
    const from = Date.parse(since) - WINDOW_MARGIN_MS;
    const reading = await (transcript.reader.readCovering === undefined || !Number.isFinite(from)
      ? transcript.reader.read().then(entries => ({ entries, covered: true }))
      : transcript.reader.readCovering(instantFromEpochMs(from))
    ).then(
      read => read,
      () => undefined,
    );
    if (reading === undefined) return { readable: false, inputs: [] };
    const { entries, covered } = reading;
    if (entries.length === 0) return { readable: false, unbound: true, inputs: [] };
    const observer = inputObserverFor(transcript.harness);
    const inputs = entries.flatMap((entry, ordinal) =>
      Number.isFinite(from) && Date.parse(entry.at) < from ? [] : observedInputsOf(observer, entry, ordinal),
    );
    return { readable: covered, inputs };
  }
}
