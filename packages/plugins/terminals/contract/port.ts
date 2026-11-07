/**
 * Terminals' port (§2.3): the terminals a ferret holds, by id and title, for the screens and plugins that list them,
 * and two read-only looks at the pane a ferret itself runs in (the Warden's liveness sample, and the browsers left
 * under it). Pane text leaves only through an act (`kernel.act`): the viewer stream, a tool's read, or the liveness
 * sample's screen, each masked inside one `Redaction.read`.
 */
import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type TerminalHoldersView, TerminalIdSchema, type TerminalView } from './wire.ts';

/**
 * One look at the pane a ferret runs in, as the Warden's liveness monitor folds it (today's
 * `InlineObserverHost.liveness`, less the transcript: a ferret's transcript is Conversation's, so its digest is the
 * reader's to take). Read only: nothing is typed, resized or signalled. Each field is total: one that could not be
 * read this time is absent, and is no evidence either way.
 */
export interface LivenessSample {
  /** A digest of the visible screen (masked), so a reader learns that it changed and nothing more. */
  readonly paneHash?: string;
  /**
   * The visible screen, masked inside one `Redaction.read` (every value the Vault knows replaced), carried so the
   * reader can take the harness's work counters from it. A reader keeps only what it derives, never the text.
   */
  readonly pane?: string;
  /** A tool command runs under the pane, or the harness's footer reports a background terminal. */
  readonly subprocessAlive?: boolean;
  /** Which tool command is the youngest running one (`pid:<n>`): a different one starts a new episode. */
  readonly subprocessKey?: string;
  /** A top-level browser the agent launched (not a helper's) still runs under the pane. */
  readonly leftoverBrowser?: boolean;
}

/**
 * One browser under a ferret's pane, by its process identity: the pid AND the start the attach proof already tells
 * one incarnation of a pid from a later one by (`ProcessIncarnation`'s start value: Linux `/proc/<pid>/stat` start
 * ticks, macOS epoch seconds). A pid alone is not proof: it can be reused once the browser exits.
 */
export interface PaneBrowser {
  readonly pid: number;
  readonly start: number;
}

/**
 * The browsers left under a ferret's pane, read at the moment of asking (today's `classifyPaneProcesses` over a fresh
 * walk of the pane's process tree). `observed` lists only top-level browsers the agent launched — never the harness,
 * a helper's browser, or anything outside that pane's tree; `unobservable` says why the tree could not be read.
 */
export type PaneBrowsers =
  | {
      readonly kind: 'observed';
      /** A tool command runs under the pane now: it may be using a browser, so none is a leftover. */
      readonly toolCommandRunning: boolean;
      readonly browsers: readonly PaneBrowser[];
    }
  | { readonly kind: 'unobservable'; readonly reason: string };

/**
 * Whether one browser is STILL what `paneBrowsers` found, re-proved by a fresh walk (nothing cached): the same pid
 * with the same start, still a top-level browser in that ferret's proved pane tree, and no tool command running.
 * Otherwise why not: `gone` (no such process now), `tool-running` (a tool command runs under the pane), or
 * `not-proved` (anything else — another process now holds the pid, it is no longer under that pane, or the pane
 * could not be proved).
 */
export type PaneBrowserStill =
  | { readonly still: true }
  | { readonly still: false; readonly why: 'gone' | 'tool-running' | 'not-proved' };

export interface TerminalsApi {
  /** The terminals one ferret holds. */
  of(ferret: FerretId): Promise<readonly TerminalView[]>;
  /** Who holds terminals across the machine, against its limit. */
  holders(): Promise<TerminalHoldersView>;
  /** One liveness look at the pane the ferret runs in. Total: it never throws, and never touches the pane. */
  liveness(ferret: FerretId): Promise<LivenessSample>;
  /** The top-level browsers under the pane the ferret runs in, read afresh. Read only: closing them is Browsers'. */
  paneBrowsers(ferret: FerretId): Promise<PaneBrowsers>;
  /**
   * Re-prove one browser `paneBrowsers` listed, immediately before it is signalled (see {@link PaneBrowserStill}).
   * Read only. Browsers signals a pid only on `{ still: true }`.
   */
  paneBrowserStill(ferret: FerretId, browser: PaneBrowser): Promise<PaneBrowserStill>;
}

export const TerminalsPort = definePort<TerminalsApi>('terminals');

/** A terminal opened or closed, or a person took one over or handed it back. Read the port for the truth. */
export const TerminalChanged = defineEvent(
  'terminals.changed',
  z.strictObject({
    ferret: z.string().min(1),
    terminal: TerminalIdSchema,
    change: z.enum(['opened', 'closed', 'taken-over', 'handed-back', 'handed-over', 'asked']),
  }),
);
