/**
 * "Keep in sync" (Settings › Agents › Conversations) THROUGH THE KERNEL'S CONFIG FILE SERVICE: whether Continue also
 * lists the conversations in the computer's own Claude Code and Codex. It is `keepInSync` in `conversation.yaml`
 * (docs/migration/clean-slate-prompt.md §4b: today's `machine.yaml` `conversations` moved there), ON when the file
 * says nothing, and it is read and edited as TEXT so the owner's comments and key order stay. The routes are the
 * kernel's (`GET`/`PUT /v1/config/file`); the etag travels in the body, and the daemon refuses a file that moved.
 */

import { readConfigText, setConfigKey } from '@ferretry/std/yaml';
import { readConfigFile, writeConfigFile } from './config-files.ts';
import type { RuntimesClient } from './client.ts';

export const CONVERSATION_FILE = 'conversation.yaml';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the file keeps for "Keep in sync" (on unless it says `false`), or `null` when it does not parse. */
const readKeepInSync = (text: string): boolean | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  return !(isRecord(read.read.value) && read.read.value.keepInSync === false);
};

/** The file with "Keep in sync" set, or `null` when it cannot be edited. Pure: text in, text out. */
const withKeepInSync = (text: string, on: boolean): string | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const raw = isRecord(read.read.value) ? read.read.value : {};
  // ON is the default, so it is written only where the file already says something about it.
  if (on && !('keepInSync' in raw)) return text;
  try {
    return setConfigKey(text, 'keepInSync', on);
  } catch {
    return null;
  }
};

export interface KeepInSyncDocument {
  readonly on: boolean;
  readonly text: string;
  readonly etag: string;
}

/** The saved switch and the text and etag it was read at; `null` when the file does not parse. */
export async function readKeepInSyncDocument(client: RuntimesClient): Promise<KeepInSyncDocument | null> {
  const file = await readConfigFile(client, CONVERSATION_FILE);
  const on = readKeepInSync(file.text);
  return on === null ? null : { on, text: file.text, etag: file.etag };
}

export type KeepInSyncSave = 'applied' | 'broken' | 'held';

/** Sets the switch against the etag the file was read at. */
export async function saveKeepInSync(client: RuntimesClient, next: boolean): Promise<KeepInSyncSave> {
  const file = await readConfigFile(client, CONVERSATION_FILE);
  const edited = withKeepInSync(file.text, next);
  if (edited === null) return 'broken';
  if (edited === file.text) return 'applied';
  const written = await writeConfigFile(client, CONVERSATION_FILE, edited, file.etag);
  return written.outcome === 'pending' ? 'held' : 'applied';
}
