/**
 * The browser's half of the daemon's terminal-capacity routes: `GET /v1/terminals` says who holds the
 * open terminals, and `POST /v1/terminals/close-finished` closes those held by ferrets that completed,
 * stopped or were removed. Like every Settings client this takes a client, so a cleanup asked of
 * machine A is never sent to machine B.
 */

import {
  CloseFinishedTerminalsResponseSchema,
  type CloseFinishedTerminalsResponse,
  type TerminalHoldersView,
  TerminalHoldersViewSchema,
} from '../../../contract/index.ts';
import type { z } from 'zod';

/** What the tab asks of a client: one parsed request (today's `IFyApiClient.request`). */
export interface TerminalSlotsClient {
  request<T>(path: string, schema: z.ZodType<T>, init?: { readonly method?: string }): Promise<T>;
}

/** Who holds the open terminals, and the machine's limit. */
export async function readTerminalHolders(client: TerminalSlotsClient): Promise<TerminalHoldersView> {
  return await client.request('/v1/terminals', TerminalHoldersViewSchema);
}

/** Closes the terminals of finished ferrets; answers how many closed and who still holds the rest. */
export async function closeFinishedTerminals(client: TerminalSlotsClient): Promise<CloseFinishedTerminalsResponse> {
  return await client.request('/v1/terminals/close-finished', CloseFinishedTerminalsResponseSchema, {
    method: 'POST',
  });
}
