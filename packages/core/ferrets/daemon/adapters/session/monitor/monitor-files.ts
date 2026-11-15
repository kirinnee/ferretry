import type { RootHandle } from '@ferretry/kernel/contract';
import type { FileSystemPort } from '../../../lib/ports.ts';
import { assertSessionsRoot, OwnFolder } from '../sessions-root.ts';

/** What the monitor asks of one ferret's own `sessions` handle. */
export type MonitorSessionRoot = Pick<
  RootHandle,
  'name' | 'internal' | 'resolve' | 'ensurePrivateDirectory' | 'publish'
>;

/** The one document that is not a ferret's: where the loop publishes its own record. */
export interface MonitorRecordSink {
  /** The name the loop is told to write its record to; a write to it goes to `write`. */
  readonly name: string;
  write(text: string): Promise<void>;
}

/**
 * The monitor's two artifacts, written through the kernel's handles instead of a path on disk.
 *
 * A ferret's heartbeat (`<ferret>/checks/waiting.json`) goes to that ferret's OWN `sessions` handle, scoped to its one
 * minted folder: the kernel proves at every call that no link lies below the home, so a heartbeat can never be steered
 * out of the session. The loop's record (`record.name`) goes to Ferrets' own state. Any other name is refused, because a
 * monitor that could write where it likes would be a writer nobody reviewed.
 *
 * `ensureDirectory` has nothing to do: a publish makes every missing folder `0700` itself, parent first.
 */
export class MonitorFiles implements Pick<FileSystemPort, 'ensureDirectory' | 'writeTextAtomic'> {
  constructor(
    private readonly sessionRoot: (ferret: string) => MonitorSessionRoot,
    private readonly record: MonitorRecordSink,
  ) {}

  async ensureDirectory(): Promise<void> {}

  async writeTextAtomic(path: string, text: string): Promise<void> {
    if (path === this.record.name) {
      await this.record.write(text);
      return;
    }
    const slash = path.indexOf('/');
    const ferret = slash > 0 ? path.slice(0, slash) : '';
    const inside = path.slice(slash + 1);
    if (ferret === '' || ferret === '.' || ferret === '..' || inside === '')
      throw new Error('the monitor writes only its own record and a ferret’s own checks');
    const root = this.sessionRoot(ferret);
    assertSessionsRoot(root, 'the monitor');
    await new OwnFolder(root).ensure();
    const named = root.resolve(inside);
    if (!named.ok) throw new Error(`the monitor’s file is outside the ferret’s folder (${named.error})`);
    await root.publish(named.value, new TextEncoder().encode(text), { mode: 0o600 });
  }
}
