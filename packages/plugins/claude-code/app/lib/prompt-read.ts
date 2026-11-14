/**
 * WHAT THE FERRET IS STOPPED ON, read for the two cards. One GET of the daemon's prompt route (Ferrets' record of the
 * pane, masked there); the permission request and the harness dialog are narrowed with this plugin's own schemas, so a
 * request that does not fit draws NO card rather than a wrong one. Nothing here answers anything.
 */

import {
  FerretPromptReadSchema,
  type HarnessDialog,
  HarnessDialogSchema,
  type PermissionRequest,
  PermissionRequestSchema,
} from '../../contract/index.ts';
import type { ClaudeCodeClient } from './client.ts';

/** What the ferret is stopped on now; every field absent when it is stopped on nothing (or the read said something unusable). */
export interface StoppedOn {
  readonly needsInput: boolean;
  readonly permission?: PermissionRequest;
  readonly dialog?: HarnessDialog;
}

export const NOT_STOPPED: StoppedOn = { needsInput: false };

/** The route this read calls, once, so the panels and a test name the same one. */
const PROMPT_ROUTE = 'GET /v1/ferrets/:ferretId/prompt';

/**
 * A request or dialog as Ferrets records it names its harness `claude` (the state document's spelling); this plugin's
 * wire names it `claude-code`. Only that one word is changed before the schema judges the rest, and the `id` is left
 * as recorded: it is what the answer route accepts (it knows both spellings of one prompt).
 */
const asWire = (recorded: unknown): unknown =>
  typeof recorded === 'object' && recorded !== null && (recorded as { harness?: unknown }).harness === 'claude'
    ? { ...recorded, harness: 'claude-code' }
    : recorded;

/** Reads and narrows the prompt. A refusal or an unreadable answer is {@link NOT_STOPPED}: a card never guesses. */
export const readStoppedOn = async (client: ClaudeCodeClient, ferret: string): Promise<StoppedOn> => {
  let raw: unknown;
  try {
    raw = await client.call(PROMPT_ROUTE, { params: { ferretId: ferret }, quiet: true });
  } catch {
    return NOT_STOPPED;
  }
  const read = FerretPromptReadSchema.safeParse(raw);
  if (!read.success) return NOT_STOPPED;
  const permission = PermissionRequestSchema.safeParse(asWire(read.data.permissionRequest));
  const dialog = HarnessDialogSchema.safeParse(asWire(read.data.dialog));
  return {
    needsInput: read.data.turnState === 'needs-input',
    ...(permission.success ? { permission: permission.data } : {}),
    ...(dialog.success ? { dialog: dialog.data } : {}),
  };
};

/** How often a ferret stopped on a prompt is re-read, and how often one that is not (a wake-up from Ferrets comes first). */
export const POLL_STOPPED_MS = 2_000;
export const POLL_IDLE_MS = 10_000;
