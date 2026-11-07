/**
 * Browsers' port (§2.3): the agent browser's lifecycle and the pages a ferret holds, by id and name. Never a URL, a
 * title or page text: page metadata is a `reads` act and leaves only through the act runner (§4.7).
 */
import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { BrowserPageIdSchema, type BrowserStateView, type SurfaceNameSchema } from './wire.ts';

export interface BrowserPageRef {
  readonly id: z.infer<typeof BrowserPageIdSchema>;
  readonly name?: z.infer<typeof SurfaceNameSchema>;
  readonly incognito?: true;
}

export interface BrowsersApi {
  state(): Promise<BrowserStateView>;
  /** The pages one ferret holds, by id and name only. */
  pagesOf(ferret: FerretId): Promise<readonly BrowserPageRef[]>;
  /**
   * Whether this host shares its loopback ports with other local users: the machine's `browserPorts` is anything but
   * `random` (today's `FleetLoginService` reading). Logins takes it as an optional use (lead decision 19, L2); an
   * absent method means the host is treated as shared, which fails closed.
   *
   * GAP (card F1931): Browsers does not provide it yet — 5.0 serves Browsers no read of the machine's `browserPorts`
   * (Runtimes keeps it and no contract serves it), so Browsers cannot say, and leaves it absent rather than guess.
   */
  browserPorts?(): Promise<{ readonly shared: boolean }>;
}

export const BrowsersPort = definePort<BrowsersApi>('browsers');

/** A page opened or closed, or a person took the browser over or handed it back. Read the port for the truth. */
export const PageChanged = defineEvent(
  'browsers.page-changed',
  z.strictObject({
    ferret: z.string().min(1),
    page: BrowserPageIdSchema,
    change: z.enum(['opened', 'closed', 'taken-over', 'handed-back', 'handed-over', 'asked']),
  }),
);
