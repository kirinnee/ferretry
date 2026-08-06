import { readFile, writeFile } from 'node:fs/promises';
import {
  type DaemonConfig,
  DaemonConfigDocumentSchema,
  type DaemonConfigStore,
  defaultDaemonConfigDocument,
  parseDaemonConfig,
  recordedPortDocument,
} from '../../lib/index.ts';

/**
 * The configuration document an operator named on the command line.
 *
 * A SECOND ADAPTER rather than a parameter on the state-home one, because the two address different
 * things. The state home's filesystem port refuses every path outside the home, which is exactly
 * right for the daemon's own state and exactly wrong for `--config /etc/somewhere/daemon.json`: an
 * operator naming their own file is not the daemon reaching outside its confinement. Keeping them
 * apart means the confined port keeps its guarantee unweakened.
 *
 * It still writes the document PRIVATE, because a daemon configuration can name a secrets file and
 * the address a machine is administered on. And it still never persists a derived value, for the
 * reason the state-home adapter does not: a derived value on disk stops tracking what it came from.
 */
export class ExplicitDaemonConfig implements DaemonConfigStore {
  constructor(readonly path: string) {}

  async peek(): Promise<{ readonly document: Record<string, unknown> | undefined; readonly config: DaemonConfig }> {
    const text = await this.read();
    if (text === undefined) return { document: undefined, config: parseDaemonConfig({}) };
    const document = JSON.parse(text) as Record<string, unknown>;
    return { document, config: parseDaemonConfig(document) };
  }

  async load(): Promise<DaemonConfig> {
    const text = await this.read();
    if (text === undefined) {
      const document = defaultDaemonConfigDocument();
      await this.write(document);
      return parseDaemonConfig(document);
    }
    return parseDaemonConfig(JSON.parse(text));
  }

  /**
   * Writes down the address this daemon took, into the key that decides it.
   *
   * The same `recordedPortDocument` the state-home adapter records through, so a document that moves
   * between `--config` and the state home cannot have its port land in a different key on the way —
   * and, for the same reason, the same raw-in raw-out rule. The schema parse stays as the REFUSAL it
   * has always been (this daemon does not write over a document it could not act on) while what
   * reaches the disk is the operator's own JSON plus the one value this boot decided; writing the
   * schema's output instead planted defaults that later reads cannot tell from an operator's lines.
   */
  async record(port: number): Promise<void> {
    const text = await this.read();
    const raw = (text === undefined ? {} : JSON.parse(text)) as Record<string, unknown>;
    DaemonConfigDocumentSchema.parse(raw);
    await this.write(recordedPortDocument(raw, port));
  }

  /** A document that is not there is not an error: the operator names where it SHOULD live. */
  private async read(): Promise<string | undefined> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(document: unknown): Promise<void> {
    await writeFile(this.path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }
}
