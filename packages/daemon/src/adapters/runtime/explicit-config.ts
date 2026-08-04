import { readFile, writeFile } from 'node:fs/promises';
import {
  type DaemonConfig,
  DaemonConfigDocumentSchema,
  type DaemonConfigStore,
  defaultDaemonConfigDocument,
  parseDaemonConfig,
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

  async record(port: number): Promise<void> {
    const text = await this.read();
    const document = DaemonConfigDocumentSchema.parse(text === undefined ? {} : JSON.parse(text));
    await this.write({ ...document, port });
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
