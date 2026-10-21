/**
 * The analytics fold, on its own thread.
 *
 * Reads one finished session's transcript — up to 32 MiB — parses every record, folds them into a token
 * total and an activity account, and posts back only that. On the daemon's event loop this was the
 * largest block left once parsing yielded; here it blocks nothing anyone is waiting on. The read and the
 * fold are the very ones the event loop would run (`readAnalyticsTranscriptEvidence`,
 * `foldAnalyticsTranscript`), so moving it changes where, never what.
 */
import { readAnalyticsTranscriptEvidence } from '../src/adapters/analytics/transcript-evidence.ts';
import type {
  TranscriptFoldProbe,
  TranscriptFoldRequest,
  TranscriptFoldResponse,
} from '../src/adapters/analytics/transcript-fold-protocol.ts';
import { NodeTranscriptSource } from '../src/adapters/transcript/file-source.ts';
import { foldAnalyticsTranscript } from '../src/lib/analytics/usage-fold.ts';
import { ClaudeTranscriptParser } from '../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../src/lib/transcript/codex.ts';

const sources = {
  claude: new NodeTranscriptSource(new ClaudeTranscriptParser()),
  codex: new NodeTranscriptSource(new CodexTranscriptParser()),
} as const;

const post = (response: TranscriptFoldResponse): void => postMessage(response);

declare const self: { onmessage: ((event: MessageEvent<TranscriptFoldRequest | TranscriptFoldProbe>) => void) | null };

self.onmessage = async event => {
  const request = event.data;
  if ('probe' in request) return post({ probe: true });
  try {
    const evidence = await readAnalyticsTranscriptEvidence(
      sources[request.harness],
      request.file,
      request.sessionId,
      request.harness,
    );
    post({ id: request.id, fold: foldAnalyticsTranscript(evidence, request.aliasGroups) });
  } catch (error) {
    post({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
