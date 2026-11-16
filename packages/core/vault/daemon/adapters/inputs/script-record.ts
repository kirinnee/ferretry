import { ScriptRecordFile, type ScriptRecord } from '../../../contract/index.ts';
import type { ScriptRecordSnapshot, ScriptRecordStore } from '../../lib/inputs/machine-scripts.ts';
import type { StatePort } from '@ferretry/kernel/contract';

/**
 * THE PAGE-SCRIPT RECORD ON THE VAULT'S OWN STATE: `state/vault/script-record.json`, owner-only and written atomically
 * by the state port. It holds host names and times, nothing a page showed. A file that is there but cannot be read
 * (the state port reads a narrower file as absent) is `'damaged'`, never "no script ever ran".
 */
export class ScriptRecordOnState implements ScriptRecordStore {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write' | 'version'>) {}

  async load(): Promise<ScriptRecordSnapshot | 'damaged' | undefined> {
    const read = await this.state.read(ScriptRecordFile);
    if (!read.ok) return 'damaged';
    if (read.value === undefined)
      return (await this.state.version(ScriptRecordFile)) === undefined ? undefined : 'damaged';
    return {
      hosts: new Map(Object.entries(read.value.hosts)),
      ...(read.value.everywhere === undefined ? {} : { everywhere: read.value.everywhere }),
    };
  }

  async save(record: ScriptRecordSnapshot): Promise<void> {
    const body: ScriptRecord = {
      format: 1,
      ...(record.everywhere === undefined ? {} : { everywhere: record.everywhere }),
      hosts: Object.fromEntries(record.hosts),
    };
    await this.state.write(ScriptRecordFile, body);
  }
}
