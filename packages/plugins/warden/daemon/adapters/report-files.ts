import type { StatePort } from '@ferretry/kernel/contract';
import { WARDEN_REPORTS } from '../../contract/index.ts';
import type { WardenFileInfo, WardenReportFileSystem } from '../lib/index.ts';

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/u;

/** A report is named for the instant it was commissioned (`artifacts.ts`), which is the only age the state port can give. */
export function reportInstantMs(name: string): number {
  const match = STAMP.exec(name);
  if (match === null) return 0;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Reports and their sidecars as the warden's own `reports/*` state files. A path that does not exist reads as empty;
 * a listing is the files directly under the folder, aged by the instant in their names.
 */
export class StateWardenReportFiles implements WardenReportFileSystem {
  constructor(private readonly state: StatePort) {}

  async listFiles(directory: string): Promise<readonly WardenFileInfo[]> {
    const names = await this.state.list(WARDEN_REPORTS);
    return names.map(name => ({ path: `${directory}/${name}`, mtimeMs: reportInstantMs(name) }));
  }

  async readText(path: string): Promise<string | undefined> {
    const read = await this.state.read(WARDEN_REPORTS, nameOf(path));
    if (!read.ok) throw new Error(read.error.sentence);
    const value = read.value as Uint8Array | string | undefined;
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    await this.state.write(WARDEN_REPORTS, text as never, nameOf(path));
  }
}
