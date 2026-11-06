import {
  type JoinedPages,
  joinPage,
  startJoin,
  type TranscriptParsePage,
} from '../../../src/adapters/transcript/parse-worker/protocol.ts';

/** The events, raw records and rows of an answer, put back together from its pages, in order. */
export function joinPages(pages: readonly TranscriptParsePage[]): JoinedPages {
  const joined = startJoin();
  for (const page of pages) joinPage(joined, page);
  return joined;
}
