/**
 * The transcript parse thread: it reads and parses the transcripts the daemon's event loop would
 * otherwise parse itself (`src/adapters/transcript/parse-worker/program.ts` is its program and says
 * why it exists; `protocol.ts` is what crosses to it, and in what size).
 */
import {
  defaultTranscriptParseReaders,
  serveTranscriptParse,
  type TranscriptParseScope,
} from '../src/adapters/transcript/parse-worker/program.ts';

declare const self: TranscriptParseScope;

serveTranscriptParse(self, defaultTranscriptParseReaders());
