import { type HarnessFacts, harnessKeyOfRecorded } from '../../../contract/index.ts';
import { FAKE_HARNESS_FACTS } from '../../../contract/testing/index.ts';

/**
 * The facts a unit fixture's `claude-code` and `codex` keys answer with: shaped like the real harnesses' (their history pool,
 * and Codex alone reports background terminals in its pane footer) and naming no real harness's file. A key with no row has no
 * facts, as a harness no plugin provides has none.
 */
const FACTS: Readonly<Record<string, HarnessFacts>> = {
  'claude-code': { ...FAKE_HARNESS_FACTS, historyPool: 'claude' },
  codex: {
    ...FAKE_HARNESS_FACTS,
    transcriptFormat: 'codex',
    historyPool: 'codex',
    paneReportsBackgroundTerminals: true,
  },
};

/** The facts of a harness key (`registryLeaseSessions`' third argument). */
export const factsOfKey = (key: string): HarnessFacts | undefined => FACTS[key];

/** The facts of the harness a session records, a family word or a key (`MovePreflight`'s second argument). */
export const factsOfRecorded = (harness: string): HarnessFacts | undefined => factsOfKey(harnessKeyOfRecorded(harness));
