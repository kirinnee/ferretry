/**
 * Two read-only looks at the pane a ferret runs in, for the Warden (Terminals' `liveness` and `paneBrowsers`):
 * today's `InlineObserverHost.liveness` (screen + process tree) and the read half of `closeLeftoverBrowsers` (the
 * pane's tree, re-read at the moment of asking, classified).
 *
 * WHICH PANE. The one the attach proof names — the tmux runner's own record, pane id, pid and the pid's start
 * re-observed and matched — never a pane found by name (G29, G34). Only processes whose ancestry runs through THAT
 * pane pid are ever walked, so nothing outside the ferret's own tree is read, and the pane process (the ferret) is
 * never among them.
 *
 * NOTHING HERE ACTS. No key is typed, no size changed, no process signalled: closing a leftover browser is Browsers'.
 */
import type { LivenessSample, PaneBrowser, PaneBrowsers, PaneBrowserStill } from '../../../contract/index.ts';
import type { ProcessIncarnation } from '../protocol/process-incarnation.ts';
import { SessionAttachError } from './attach/service.ts';
import { type LivenessLook, livenessSampleOf, lookAtPaneProcesses, type TextDigest } from './liveness.ts';
import { classifyPaneProcesses, type PaneProcess } from './processes/pane-processes.ts';
import type {
  ProcessDetailRow,
  ProcessProvenancePort,
  ProcessTreePort,
  SessionPaneProofPort,
} from './processes/ports.ts';

export interface PaneLookPorts {
  /** The pane the attach proof names, freshly matched; throws a `SessionAttachError` when it cannot. */
  readonly panes: SessionPaneProofPort;
  readonly tree: ProcessTreePort;
  readonly provenance: ProcessProvenancePort;
  /** A pid's start now (the attach proof's own source), to tell a browser that is gone from one that moved. */
  readonly incarnation: ProcessIncarnation;
  /**
   * Whether tmux CONFIRMS the ferret has no pane (no registration, or its session is gone on the private server). A
   * pane that is gone runs nothing; any other failure to prove the pane stays a blind spot.
   */
  paneAbsent(ferret: string): Promise<boolean>;
  /**
   * The visible screen of the proved pane, read inside an act on it and masked inside one `Redaction.read`; `undefined`
   * when it could not be read or a hold refused the read.
   */
  screen(paneId: string): Promise<string | undefined>;
  readonly digest: TextDigest;
  readonly nowMs: () => number;
}

/** The pane's processes as one look saw them, or why they could not be seen. */
export type PaneProcessObservation =
  | { readonly kind: 'observed'; readonly paneId?: string; readonly processes: readonly ObservedPaneProcess[] }
  | { readonly kind: 'unobservable'; readonly reason: string };

/** A process as one look saw it, with the start that, with its pid, is its identity. */
type ObservedPaneProcess = PaneProcess & { readonly start: number };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class PaneLook {
  constructor(private readonly ports: PaneLookPorts) {}

  /**
   * The processes under the ferret's own pane, as today's `PaneProcessInventory.collect` read them: each with its
   * parent, command line, age, whether provenance knows it as the harness's own, and whether it listens.
   */
  async processes(ferret: string): Promise<PaneProcessObservation> {
    let pane: { readonly pid: number; readonly paneId: string };
    try {
      pane = await this.ports.panes.resolve(ferret);
    } catch (error) {
      // ASK A SECOND QUESTION BEFORE CALLING THIS A BLIND SPOT (today's): a ferret tmux confirms has no pane runs
      // nothing; a pane that could not be proved for any other reason is not evidence of anything.
      const absent =
        error instanceof SessionAttachError &&
        (error.failure === 'missing_registration' || error.failure === 'pane_unavailable') &&
        (await this.ports.paneAbsent(ferret).catch(() => false));
      return absent ? { kind: 'observed', processes: [] } : { kind: 'unobservable', reason: message(error) };
    }
    try {
      const tree = await this.ports.tree.tree(pane.pid);
      if (tree.kind === 'unavailable') return { kind: 'unobservable', reason: tree.reason };
      const known = await this.ports.provenance.identify(tree.rows, pane.pid);
      // Only what provenance left unexplained: the harness and its own helpers are never servers to keep.
      const unexplained = tree.rows.filter(row => !known.has(row.pid)).map(row => row.pid);
      const listening = (await this.ports.tree.listening(unexplained).catch(() => undefined)) ?? new Set<number>();
      const nowMs = this.ports.nowMs();
      return {
        kind: 'observed',
        paneId: pane.paneId,
        processes: tree.rows.map(row => paneProcessOf(row, known.get(row.pid), listening, nowMs)),
      };
    } catch (error) {
      return { kind: 'unobservable', reason: `the pane could not be inspected: ${message(error)}` };
    }
  }

  /** One liveness look: the masked screen and the process tree, each total. Never throws. */
  async liveness(ferret: string): Promise<LivenessSample> {
    // `processes` is total: every failure of its ports is already an `unobservable` observation.
    const observed = await this.processes(ferret);
    // The SCREEN, not the scrollback: the work counters and background-terminal footer live on it, and any change to
    // the scrollback moves the screen too — at a fraction of the bytes per tick. Only a proved pane is read.
    const screen =
      observed.kind === 'observed' && observed.paneId !== undefined
        ? await this.ports.screen(observed.paneId).catch(() => undefined)
        : undefined;
    const look: LivenessLook = {
      screen,
      ...lookAtPaneProcesses(observed.kind === 'observed' ? observed.processes : undefined),
    };
    return livenessSampleOf(look, this.ports.digest);
  }

  /** The top-level browsers the agent launched under the pane, read now; none counts while a tool command runs. */
  async browsers(ferret: string): Promise<PaneBrowsers> {
    const observed = await this.processes(ferret);
    if (observed.kind === 'unobservable') return observed;
    const view = classifyPaneProcesses(observed.processes);
    const startOf = new Map(observed.processes.map(seen => [seen.pid, seen.start]));
    return {
      kind: 'observed',
      toolCommandRunning: view.toolCommands.length > 0,
      browsers: view.leftoverBrowsers.flatMap(browser => {
        const start = startOf.get(browser.pid);
        return start === undefined ? [] : [{ pid: browser.pid, start }];
      }),
    };
  }

  /**
   * Whether one browser `browsers` listed is STILL that browser, by a FRESH walk (nothing cached): the same pid with
   * the same start, still a top-level browser under the attach-proved pane, and no tool command running. Read only.
   */
  async still(ferret: string, browser: PaneBrowser): Promise<PaneBrowserStill> {
    if (!Number.isSafeInteger(browser.pid) || browser.pid <= 1) return { still: false, why: 'not-proved' };
    const observed = await this.processes(ferret);
    if (observed.kind === 'observed') {
      const view = classifyPaneProcesses(observed.processes);
      if (view.toolCommands.length > 0) return { still: false, why: 'tool-running' };
      const listed = new Set(view.leftoverBrowsers.map(seen => seen.pid));
      const same = observed.processes.some(
        seen => seen.pid === browser.pid && seen.start === browser.start && listed.has(seen.pid),
      );
      if (same) return { still: true };
    }
    // Not that browser under that pane now: say `gone` only when no process holds the pid at all.
    const now = await this.ports.incarnation.startOf(browser.pid).catch(() => -1);
    return { still: false, why: now === undefined ? 'gone' : 'not-proved' };
  }
}

/** One tree row as the classifier reads it (a parent not in the list is the pane itself). */
function paneProcessOf(
  row: ProcessDetailRow,
  known: { readonly kind: string } | undefined,
  listening: ReadonlySet<number>,
  nowMs: number,
): ObservedPaneProcess {
  return {
    pid: row.pid,
    start: row.start,
    ppid: row.ppid,
    argv: row.argv,
    startedSecondsAgo: Math.max(0, Math.floor((nowMs - row.startedAtMs) / 1000)),
    ...(known === undefined ? {} : { known }),
    listening: listening.has(row.pid),
  };
}
