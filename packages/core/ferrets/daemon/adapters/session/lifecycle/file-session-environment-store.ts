import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { SessionId } from '../../../lib/session-id.ts';
import type { SessionEnvironmentStore } from '../../../lib/session/lifecycle/index.ts';

/** What this store asks of the kernel's root: a durable publish, and a read that can tell "absent" from a failure. */
export type EnvironmentRoot = Pick<RootHandle, 'resolve' | 'publish' | 'readBytes'>;

/**
 * The environment is a flat string map, parsed rather than asserted: this file holds the only copy
 * of a session's credential, and a document that has been corrupted must fail loudly instead of
 * launching an agent with half an environment.
 */
const EnvironmentDocumentSchema = z.record(z.string().min(1), z.string());

/**
 * The per-session environment on disk, inside the session's own private directory.
 *
 * `0o600` on the file and `0o700` on the directory are the whole access control: this is where a
 * session's plaintext capability lives, and nothing in the API projects it. The temporary file is
 * synced before rename and the directory afterwards: lifecycle creation publishes the capability's
 * hash only after this method returns, so mere call ordering without power-loss durability would
 * still be able to leave a hash whose plaintext vanished after a crash.
 *
 * THE KERNEL OWNS THE DURABILITY. `RootHandle.publish` writes the temp file (exclusive create, `0o600`, synced),
 * moves it onto the name and syncs the folder, and before writing it syncs the folder's parent and any ancestor it
 * had to create, parent first. `SessionLifecycleService.create` still persists the session directory's own entry in
 * `<sessions>` (`repository.reserve`); the extra parent sync here is a harmless repeat, not a second owner.
 */
export class FileSessionEnvironmentStore implements SessionEnvironmentStore {
  constructor(
    private readonly root: EnvironmentRoot,
    private readonly sessionDirectory: (id: SessionId) => string,
  ) {}

  file(id: SessionId): FencedPath {
    const resolved = this.root.resolve(`${this.sessionDirectory(id)}/environment.json`);
    if (!resolved.ok) throw new Error(`the session environment is outside its root (${resolved.error})`);
    return resolved.value;
  }

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    const document = `${JSON.stringify(EnvironmentDocumentSchema.parse(environment), undefined, 2)}\n`;
    // The kernel's durable publish: a new `0600` temp file (exclusive create, synced), moved onto the name,
    // then the folder synced. A name it did not create is never removed, and the temp is never left behind.
    await this.root.publish(this.file(id), new TextEncoder().encode(document), { mode: 0o600 });
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    let raw: string;
    try {
      raw = new TextDecoder().decode(await this.root.readBytes(this.file(id)));
    } catch (error) {
      // A session that was never given an environment is the normal case, not a fault: it launches
      // with none. Any OTHER read failure is real and must not be flattened into "no secret".
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return EnvironmentDocumentSchema.parse(JSON.parse(raw));
  }
}
