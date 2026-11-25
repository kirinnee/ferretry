import type { StatePort } from '@ferretry/kernel/contract';
import { CONNECTOR_STATE, ConnectorStateFileSchema, type ConnectorState } from '../../contract/index.ts';
import type { ConnectorStore } from './oauth/model.ts';

/** The one refusal a damaged file earns. It says what to do and quotes nothing from the file. */
class ConnectorStoreError extends Error {
  constructor() {
    super(
      'Connector state is unreadable or damaged; all connector access is refused. Restore state/connector/connector.json before enabling the connector.',
    );
  }
}

/**
 * The authority's store, over the kernel's own state port: atomic, `0600` (the declared `mode`), format-checked on every
 * read. DAMAGED IS NOT EMPTY: a file that does not check fails closed with {@link ConnectorStoreError}, never reads as
 * "nobody is signed in" and is then written over. Only an ABSENT file is the empty state.
 */
export class KernelConnectorStore implements ConnectorStore {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write'>) {}

  async load(): Promise<ConnectorState> {
    const read = await this.state.read(CONNECTOR_STATE);
    if (!read.ok) throw new ConnectorStoreError();
    return read.value ?? { format: 1, clients: [], grants: [] };
  }

  async save(state: ConnectorState): Promise<void> {
    // Parsed first, so neither an unknown key nor a credential can slip into the file.
    await this.state.write(CONNECTOR_STATE, ConnectorStateFileSchema.parse(state));
  }
}
