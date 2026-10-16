import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { type HarnessKind, persistedReasoningEffort, RUNTIME_SETTINGS_FILE } from '../../../lib/index.ts';

/**
 * The reasoning level a runtime's own settings file holds, read once at launch.
 *
 * The IO half of `lib/session/harness/launch-effort.ts`. It is a single local file read — no harness
 * is started and nothing is asked of a provider — so learning the level a session starts on costs
 * nothing. A home that is not absolute, a file that is missing or unreadable, and a document that
 * names no level are all the same answer, `undefined`: a launch must never fail over a readout.
 */
export async function readPersistedReasoningEffort(
  harness: HarnessKind,
  home: string | undefined,
): Promise<string | undefined> {
  if (home === undefined || !isAbsolute(home)) return undefined;
  const document = await readFile(join(home, RUNTIME_SETTINGS_FILE[harness]), 'utf8').catch(() => undefined);
  return persistedReasoningEffort(harness, document);
}
