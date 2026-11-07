/**
 * "Keep in sync" (Settings › Machine › Conversations): whether Continue also lists the conversations in
 * the computer's own Claude Code and Codex. It is `conversations.listComputer` in `machine.yaml`, ON
 * when the file says nothing, and is read and edited as TEXT so the owner's comments and key order stay.
 * Pure: text in, text out.
 */

import { editConfigText, readConfigText } from '@ferretry/fleet/config-text';
import { configSchemaModeline } from '@ferretry/protocol';

export const MACHINE_FILE = 'machine.yaml';

export const KEEP_IN_SYNC_EXPLANATION =
  'Show conversations from this computer’s own Claude Code and Codex in Continue. Read-only; nothing is imported until you continue one.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the file keeps for "Keep in sync" (on unless it says `false`), or `null` when it does not parse. */
export const readKeepInSync = (text: string): boolean | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const conversations = isRecord(read.read.value) ? read.read.value.conversations : undefined;
  return !(isRecord(conversations) && conversations.listComputer === false);
};

/** `machine.yaml` with "Keep in sync" set, or `null` when the file cannot be edited. */
export const withKeepInSync = (text: string, on: boolean): string | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const raw = isRecord(read.read.value) ? read.read.value : {};
  const conversations = isRecord(raw.conversations) ? raw.conversations : {};
  // ON is the default, so it is written only where the file already says something about it.
  if (on && !('listComputer' in conversations)) return text;
  const target = { ...raw, conversations: { ...conversations, listComputer: on } };
  return editConfigText(text, target, raw, configSchemaModeline({ kind: 'machine' }));
};
