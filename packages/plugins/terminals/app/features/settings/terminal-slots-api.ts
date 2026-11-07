/**
 * The browser's half of the daemon's terminal-capacity routes: `GET /v1/terminals` says who holds the
 * open terminals, and `POST /v1/terminals/close-finished` closes those held by ferrets that completed,
 * stopped or were removed. Both ride the shell's per-daemon client, so a cleanup asked of machine A is
 * never sent to machine B.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type CloseFinishedTerminalsResponse,
  CloseFinishedTerminalsResponseSchema,
  type TerminalHoldersView,
  TerminalHoldersViewSchema,
} from '../../../contract/index.ts';
import { TERMINAL_ROUTES } from '../../lib/web-terminals.ts';

/** Who holds the open terminals, and the machine's limit. */
export async function readTerminalHolders(client: PluginClient): Promise<TerminalHoldersView> {
  return TerminalHoldersViewSchema.parse(await client.call(TERMINAL_ROUTES.holders));
}

/** Closes the terminals of finished ferrets; answers how many closed and who still holds the rest. */
export async function closeFinishedTerminals(client: PluginClient): Promise<CloseFinishedTerminalsResponse> {
  return CloseFinishedTerminalsResponseSchema.parse(await client.call(TERMINAL_ROUTES.closeFinished));
}
