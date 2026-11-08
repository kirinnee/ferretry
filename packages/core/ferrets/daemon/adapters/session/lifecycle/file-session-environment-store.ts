import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { SessionId } from '../../../lib/session-id.ts';
import type { SessionEnvironmentStore } from '../../../lib/session/lifecycle/index.ts';
import { assertOwnSession, assertSessionsRoot, OwnFolder } from '../sessions-root.ts';

/** What this store asks of the kernel's root: a durable publish, and a read that can tell "absent" from a failure. */
export type EnvironmentRoot = Pick<
  RootHandle,
  'name' | 'internal' | 'ensurePrivateDirectory' | 'resolve' | 'publish' | 'readBytes'
>;

/**
 * The environment is a flat string map, parsed rather than asserted: this file holds the only copy
 * of a session's credential, and a document that has been corrupted must fail loudly instead of
 * launching an agent with half an environment.
 */
const EnvironmentDocumentSchema = z.record(z.string().min(1), z.string());

/**
 * The per-session environment on disk, inside the session's own private folder on the `sessions` root.
 *
 * `0o600` on the file and `0o700` on the folder are the whole access control: this is where a
 * session's plaintext capability lives, and nothing in the API projects it. The temporary file is
 * synced before rename and the directory afterwards: lifecycle creation publishes the capability's
 * hash only after this method returns, so mere call ordering without power-loss durability would
 * still be able to leave a hash whose plaintext vanished after a crash.
 *
 * THE KERNEL OWNS THE DURABILITY, in two steps. The ferret's folder's own entry in `sessions/` is made durable when
 * the folder is made: `OwnFolder.ensure` (before every read and write here) has the handle make it, and the kernel
 * syncs `sessions/` right after that `mkdir`, before anything is written below it. Then `RootHandle.publish`
 * writes the temp file (exclusive create, `0o600`, synced), moves it onto the name and syncs the ferret's folder.
 * The publish itself cannot reach `sessions/` (it is above this handle's root), and nothing else persists that
 * entry: `repository.reserve` persists a different folder (`state/ferrets/<id>/`).
 *
 * USE, NEVER READ. The store has no getter that hands the document out: `read` is the launch's own and the
 * rotation's, and no route, port member or log line carries its contents.
 *
 * ONE HANDLE, ONE FERRET. The root is scoped to the ferret's own folder (`roots.root('sessions', { subfolder })`) and
 * the constructor refuses any root that is not the internal `sessions` one, so this file cannot land on `work` or on
 * any other owner's tree.
 */
export class FileSessionEnvironmentStore implements SessionEnvironmentStore {
  private readonly folder: OwnFolder;

  constructor(
    private readonly root: EnvironmentRoot,
    private readonly ferret: SessionId,
  ) {
    assertSessionsRoot(root, 'the session environment store');
    this.folder = new OwnFolder(root);
  }

  file(id: SessionId): FencedPath {
    assertOwnSession(this.ferret, id, 'the session environment store');
    const resolved = this.root.resolve('environment.json');
    if (!resolved.ok) throw new Error(`the session environment is outside its root (${resolved.error})`);
    return resolved.value;
  }

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    await this.folder.ensure();
    const document = `${JSON.stringify(EnvironmentDocumentSchema.parse(environment), undefined, 2)}\n`;
    // The kernel's durable publish: a new `0600` temp file (exclusive create, synced), moved onto the name,
    // then the folder synced. A name it did not create is never removed, and the temp is never left behind.
    await this.root.publish(this.file(id), new TextEncoder().encode(document), { mode: 0o600 });
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    // A read makes the ferret's own folder (0700, empty) on purpose: the kernel refuses a read below a missing
    // scoped folder.
    await this.folder.ensure();
    let raw: string;
    try {
      raw = new TextDecoder().decode(await this.root.readBytes(this.file(id)));
    } catch (error) {
      // A session that was never given an environment is the normal case, not a fault: it launches
      // with none. Any OTHER read failure is real and must not be flattened into "no secret".
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    // A damaged document is refused WITHOUT quoting it: a parser's message may carry a snippet of the text, and
    // this file holds a credential.
    try {
      return EnvironmentDocumentSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(`the session environment of ${id} is not a valid environment document`);
    }
  }
}
