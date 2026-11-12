import { EntriesTranscriptSource, type HarnessTranscripts } from './adapters/entries-source.ts';
import { FileTranscriptReads, type TranscriptOpener } from './adapters/file-reads.ts';
import { TranscriptReadService, type TranscriptReadRedactor } from './lib/reads.ts';
import { TranscriptImageReader } from './lib/session/image-reader.ts';
import type { SessionTranscriptMessageTokenCodec } from './lib/session/message-token.ts';
import { type FerretExists, readerRoutes } from './routes.ts';

export * from './lib/reads.ts';

export interface ReaderNeeds {
  /**
   * A ferret's harness bytes: the proved transcript as raw, unmasked bytes (Ferrets' `transcriptBytes`, G162). The
   * ONLY way a transcript's records are read; every answer cut from them is masked by `redactor`.
   */
  readonly bytes: TranscriptOpener;
  /**
   * A ferret's harness and that harness plugin's `TranscriptReader` (entries): what a read falls back to for a harness
   * that offers no bytes. An honest, thinner read (no tool calls, thinking or images) rather than none.
   */
  readonly transcripts: HarnessTranscripts;
  readonly exists: FerretExists;
  /** The daemon-private MAC for message tokens: two operations, no key bytes. */
  readonly codec: SessionTranscriptMessageTokenCodec;
  /** Read-scoped masking (G164): every answer is cut from masked text. */
  readonly redactor: TranscriptReadRedactor;
  /** Gives the loop back between parse slices; nothing waits when absent. */
  readonly yieldToLoop?: () => Promise<void>;
  /** Sleeps; used only by a live follower, which no read path uses. Absent: returns at once. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** The current instant as an ISO string, stamped on observed inputs. Absent: derived from `now`. */
  readonly instant?: () => string;
  readonly now: () => number;
}

/**
 * The transcript reader: logs, log pages, log search, addressable messages and transcript images, with the routes that
 * serve them. Part a's `daemon/index.ts` calls this once and registers `routes` under their manifest keys.
 */
export function registerReader(needs: ReaderNeeds) {
  const pacing = { now: needs.now, yieldToLoop: needs.yieldToLoop ?? (async () => undefined) };
  const entries = new EntriesTranscriptSource(needs.transcripts);
  const files = new FileTranscriptReads(
    needs.bytes,
    {
      now: needs.instant ?? (() => new Date(needs.now()).toISOString()),
      pacing,
      sleep: needs.sleep ?? (async () => undefined),
    },
    entries,
  );
  const reads = new TranscriptReadService(files, files, needs.codec, needs.redactor, files, files);
  const images = new TranscriptImageReader(files, files.runtime, FileTranscriptReads.pacedParsers(pacing));
  const handlers = readerRoutes({ reads, images, exists: needs.exists });
  return {
    reads,
    images,
    /** Closes the transcript handle held for one ferret that stopped or was removed. */
    release: (ferret: string) => files.release(ferret),
    /** Closes every harness transcript handle the reader holds. */
    close: async () => await files.close(),
    routes: {
      'GET /v1/ferrets/:ferretId/logs': handlers.logs,
      'GET /v1/ferrets/:ferretId/log-page': handlers.logPage,
      'GET /v1/ferrets/:ferretId/log-search': handlers.logSearch,
      'GET /v1/ferrets/:ferretId/messages': handlers.messages,
      'GET /v1/ferrets/:ferretId/transcript-images/:handle': handlers.transcriptImage,
    },
  } as const;
}
