import type { StatePort } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { join } from 'node:path';
import { AskVersionsFiles } from '../../../contract/index.ts';
import { StateAgendaFiles } from '../../../daemon/adapters/agenda/state-agenda-files.ts';
import { ASKS_STATE } from '../../../daemon/lib/state.ts';

/** Asks' kernel state port over a real home folder, as the daemon opens it (`<home>/state/asks/`). */
export function asksStateAt(home: string): StatePort {
  return state.createStatePort({
    home,
    pluginId: 'asks',
    files: [...ASKS_STATE, AskVersionsFiles],
    fs: state.createNodeHostFs(),
  });
}

/** The agenda files of every ferret under `home`, through the kernel. */
export const agendaFilesAt = (home: string): StateAgendaFiles => new StateAgendaFiles(asksStateAt(home));

/** Where a ferret's agenda file lands on disk, for a test that plants or inspects bytes. */
export const agendaFilePath = (home: string, sessionId: string, name: string): string =>
  join(home, 'state', 'asks', 'ferrets', sessionId, name);

/** Where a set-aside file lands on disk. */
export const setAsidePath = (home: string, sessionId: string, name: string): string =>
  join(home, 'state', 'asks', 'set-aside', `${sessionId}~${name}`);

/** Where a ferret's version archive of one ask lands on disk. */
export const versionArchivePath = (home: string, sessionId: string, id: string): string =>
  join(home, 'state', 'asks', 'versions', `${sessionId}~${id}.sqlite`);

/** The runtime a repository warns through; the warnings are kept for a test to read. */
export function recordingRuntime(now: () => number = () => 0): {
  readonly runtime: { now(): number; warn(message: string): void };
  readonly warnings: string[];
} {
  const warnings: string[] = [];
  return { runtime: { now, warn: message => void warnings.push(message) }, warnings };
}
