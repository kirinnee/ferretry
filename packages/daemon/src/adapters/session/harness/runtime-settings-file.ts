import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  type HarnessKind,
  persistedFast,
  persistedReasoningEffort,
  RUNTIME_SETTINGS_FILE,
} from '../../../lib/index.ts';

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
  return persistedReasoningEffort(harness, await readSettingsDocument(harness, home));
}

/**
 * Whether the runtime's own settings file has saved fast mode on or off. `/fast` writes it, so a login
 * switched in a terminal once starts every later session the same way — which is what a new session's
 * composer has to show before the harness has said anything.
 */
export async function readPersistedFast(harness: HarnessKind, home: string | undefined): Promise<boolean | undefined> {
  return persistedFast(harness, await readSettingsDocument(harness, home));
}

async function readSettingsDocument(harness: HarnessKind, home: string | undefined): Promise<string | undefined> {
  if (home === undefined || !isAbsolute(home)) return undefined;
  return await readFile(join(home, RUNTIME_SETTINGS_FILE[harness]), 'utf8').catch(() => undefined);
}
