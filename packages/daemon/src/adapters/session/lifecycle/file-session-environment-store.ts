import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { SessionId } from '../../../lib/index.ts';
import type { SessionEnvironmentStore } from '../../../lib/session/lifecycle/index.ts';

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
 * session's plaintext capability lives, and nothing in the API projects it. The write is atomic for
 * the same reason turn-one is — a launch that read a half-written environment would hand the agent a
 * truncated secret, which fails as an authorization error far from its cause.
 */
export class FileSessionEnvironmentStore implements SessionEnvironmentStore {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), 'environment.json');
  }

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(EnvironmentDocumentSchema.parse(environment), undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, file);
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    let raw: string;
    try {
      raw = await readFile(this.file(id), 'utf8');
    } catch (error) {
      // A session that was never given an environment is the normal case, not a fault: it launches
      // with none. Any OTHER read failure is real and must not be flattened into "no secret".
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return EnvironmentDocumentSchema.parse(JSON.parse(raw));
  }
}
