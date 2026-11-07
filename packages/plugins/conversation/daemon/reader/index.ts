import type { RootHandle } from '@ferretry/kernel/contract';
import { EntriesTranscriptSource, type HarnessTranscripts } from './adapters/entries-source.ts';
import { historyFiles } from './adapters/history-files.ts';
import { TranscriptReadService, type TranscriptReadRedactor } from './lib/reads.ts';
import {
  TranscriptImageReader,
  type TranscriptImageLocator,
} from './lib/session/image-reader.ts';
import type { SessionTranscriptMessageTokenCodec } from './lib/session/message-token.ts';
import { ClaudeTranscriptParser } from './lib/transcript/claude.ts';
import { CodexTranscriptParser } from './lib/transcript/codex.ts';
import { PacedTranscriptParser } from './lib/transcript/sliced.ts';
import { type FerretExists, readerRoutes } from './routes.ts';

export * from './lib/reads.ts';
export { EntriesTranscriptSource, type HarnessTranscripts } from './adapters/entries-source.ts';
export type { FerretExists } from './routes.ts';

export interface ReaderNeeds {
  /** A ferret's harness and that harness plugin's `TranscriptReader`: the only way a transcript is read (G162). */
  readonly transcripts: HarnessTranscripts;
  readonly exists: FerretExists;
  /** The daemon-private MAC for message tokens: two operations, no key bytes. */
  readonly codec: SessionTranscriptMessageTokenCodec;
  /** Read-scoped masking (G164): every answer is cut from masked text. */
  readonly redactor: TranscriptReadRedactor;
  /** The `harness-history` root, read-only, and where a ferret's transcript file sits in it (images only). */
  readonly history: RootHandle;
  readonly locate: TranscriptImageLocator;
  /** Gives the loop back between parse slices; nothing waits when absent. */
  readonly yieldToLoop?: () => Promise<void>;
  readonly now: () => number;
}

/**
 * The transcript reader: logs, log pages, log search, addressable messages and transcript images, with the routes that
 * serve them. Part a's `daemon/index.ts` calls this once and registers `routes` under their manifest keys.
 */
export function registerReader(needs: ReaderNeeds) {
  const source = new EntriesTranscriptSource(needs.transcripts);
  const reads = new TranscriptReadService(source, source, needs.codec, needs.redactor, source, source);
  const pacing = { now: needs.now, yieldToLoop: needs.yieldToLoop ?? (async () => undefined) };
  const images = new TranscriptImageReader(needs.locate, historyFiles(needs.history), {
    claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), pacing),
    codex: new PacedTranscriptParser(new CodexTranscriptParser(), pacing),
  });
  const handlers = readerRoutes({ reads, images, exists: needs.exists });
  return {
    reads,
    images,
    routes: {
      'GET /v1/ferrets/:ferretId/logs': handlers.logs,
      'GET /v1/ferrets/:ferretId/log-page': handlers.logPage,
      'GET /v1/ferrets/:ferretId/log-search': handlers.logSearch,
      'GET /v1/ferrets/:ferretId/messages': handlers.messages,
      'GET /v1/ferrets/:ferretId/transcript-images/:handle': handlers.transcriptImage,
    },
  } as const;
}
