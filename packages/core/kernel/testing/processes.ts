import type { ProcessSignalOutcome } from '../contract/ports.ts';
import type { ProcessTable } from '../host/processes.ts';

/** One process in a test's table. */
export interface TestProcess {
  readonly pid: number;
  /** Its owner. Default: the test daemon's own uid ({@link TEST_PROCESS_UID}). */
  readonly uid?: number;
  /** Its command line, arguments joined by one space. */
  readonly commandLine: string;
  /** Its environment. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface TestProcessTableSpec {
  readonly processes: readonly TestProcess[];
  /** The test daemon's pid. Default: 1000. */
  readonly self?: number;
  /** The test daemon's ancestors, parent first. Default: `[999]`. */
  readonly ancestors?: readonly number[];
  /** `false`: the table cannot be listed (`usersOf` answers `undefined`). Default: `true`. */
  readonly listable?: boolean;
}

/** A test's process table: the {@link ProcessTable} the testing host's `options.processes` takes, plus what it saw. */
export interface TestProcessTable extends ProcessTable {
  /** Every signal sent, in order (only ever `SIGTERM`). */
  readonly signals: readonly { readonly pid: number; readonly signal: 'SIGTERM' }[];
}

/** The uid the test daemon runs as. */
export const TEST_PROCESS_UID = 501;

/**
 * A process table for `testHost({ processes })`, the real table's rules over a list: another uid's process is absent,
 * and a signalled process exits (the next look finds it gone).
 */
export function testProcessTable(spec: TestProcessTableSpec): TestProcessTable {
  const live = new Map(spec.processes.map(entry => [entry.pid, entry] as const));
  const signals: { pid: number; signal: 'SIGTERM' }[] = [];
  const ours = (pid: number): TestProcess | undefined => {
    const found = live.get(pid);
    return found !== undefined && (found.uid ?? TEST_PROCESS_UID) === TEST_PROCESS_UID ? found : undefined;
  };
  return {
    signals,
    protectedPids: async () => new Set([0, 1, spec.self ?? 1000, ...(spec.ancestors ?? [999])]),
    commandLine: async pid => ours(pid)?.commandLine,
    withEnvironment: async entries => {
      if (spec.listable === false) return undefined;
      return [...live.keys()].filter(pid => {
        const environment = ours(pid)?.environment ?? {};
        return Object.entries(environment).some(([name, value]) => entries.includes(`${name}=${value}`));
      });
    },
    sigterm: async (pid): Promise<ProcessSignalOutcome> => {
      if (ours(pid) === undefined) return 'gone';
      signals.push({ pid, signal: 'SIGTERM' });
      live.delete(pid);
      return 'signalled';
    },
  };
}
