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
  /**
   * Today's machine.browserPorts fact for Codex sign-in: shared is setting !== 'random' (per-user or explicit).
   * Optional until the provider is ported; a consumer without this fact must treat host ports as shared.
   */
  browserPorts?(): Promise<{ readonly shared: boolean }>;
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
  /**
   * Close the browsers a ferret launched that still run under its own pane, read afresh at this moment (today's
   * `closeLeftoverBrowsers`), and answer how many were closed. Nothing is closed — `0` — while a tool command runs
   * under the pane (it may be using that browser), or when Terminals is off (the pane cannot be read). Only top-level
   * browsers in THAT pane's process tree are sent SIGTERM: never the ferret itself, never a helper's browser, never
   * anything outside its tree. Throws when the pane's tree could not be read, or a signal was refused.
   */
  closeLeftoverBrowsers(ferret: FerretId): Promise<number>;
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
