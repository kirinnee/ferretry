import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ConnectorState, type ConnectorStore, connectorStateSchema } from '../../lib/connector/oauth/model.ts';
import { writeJsonAtomic } from '../session/monitor/atomic-json.ts';

export class ConnectorStoreError extends Error {
  constructor() {
    super(
      'Connector state is unreadable or damaged; all connector access is refused. Restore connector.json before enabling the connector.',
    );
  }
}

/** A single authority owns this repository. Writes publish atomically with private directory/file modes. */
export class FileConnectorStore implements ConnectorStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  private readonly file: string;
  constructor(stateHome: string) {
    this.directory = join(stateHome, 'connector');
    this.file = join(this.directory, 'connector.json');
  }

  async load(): Promise<ConnectorState> {
    await this.tail;
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { version: 1, clients: [], grants: [] };
      throw new ConnectorStoreError();
    }
    try {
      return connectorStateSchema.parse(JSON.parse(text));
    } catch {
      throw new ConnectorStoreError();
    }
  }

  save(state: ConnectorState): Promise<void> {
    // Parse before enqueueing, so neither unknown keys nor credentials can slip into persistence.
    const document = connectorStateSchema.parse(state);
    const write = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await writeJsonAtomic(this.file, document);
      await chmod(this.file, 0o600);
    });
    this.tail = write.catch(() => undefined);
    return write;
  }
}
