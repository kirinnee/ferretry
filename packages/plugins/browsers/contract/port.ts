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

/**
 * Why a browser under a ferret's pane was left alone, a closed set (never free text, never argv): `not-proved` (the
 * fresh re-proof said it is not that browser under that pane, threw, or Terminals was off), `gone` (no such process
 * any more), `tool-running` (a tool command runs under the pane and may be using it), `invalid-pid` (1 or below, or
 * not a whole number, reported as -1), `signal-refused` (proved, but the SIGTERM did not land).
 */
export const LeftAloneWhySchema = z.enum(['not-proved', 'gone', 'tool-running', 'invalid-pid', 'signal-refused']);
export type LeftAloneWhy = z.infer<typeof LeftAloneWhySchema>;

/** What one close of a ferret's leftover browsers did: how many closed, and each pid it left alone and why. */
export interface LeftoverBrowsersClosed {
  readonly closed: number;
  readonly leftAlone: readonly { readonly pid: number; readonly why: LeftAloneWhy }[];
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
   * `closeLeftoverBrowsers`). ONLY A PID IT CAN PROVE IS SIGNALLED: each is re-proved by Terminals immediately before
   * its SIGTERM (same pid and start, still a top-level browser in THAT pane's tree, no tool command running) — never
   * the ferret itself, never a helper's browser, never anything outside its tree. Every other one is left alone and
   * reported in `leftAlone`, and the rest are still tried. Terminals off: `{ closed: 0, leftAlone: [] }`. Throws only
   * when the pane's tree could not be read at all.
   */
  closeLeftoverBrowsers(ferret: FerretId): Promise<LeftoverBrowsersClosed>;
}

export const BrowsersPort = definePort<BrowsersApi>('browsers');

/**
 * A page opened or closed, a person took the browser over or handed it back, or an agent is driving a page (the
 * "Ferret is typing here" marker). Read the port for the truth.
 */
export const PageChanged = defineEvent(
  'browsers.page-changed',
  z.strictObject({
    ferret: z.string().min(1),
    page: BrowserPageIdSchema,
    change: z.enum(['opened', 'closed', 'taken-over', 'handed-back', 'handed-over', 'asked', 'driving']),
  }),
);
