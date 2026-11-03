import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  EMPTY_LOCAL_MCP_INSTALL_STATE,
  type LocalMcpInstallState,
  LocalMcpInstallStateError,
  LocalMcpInstallStateSchema,
  type LocalMcpInstallStore,
} from '../../lib/local-mcp-installs/store.ts';

const LOCAL_MCP_INSTALLS_DOCUMENT = 'local-mcp-installs.json';

/**
 * `<FY_HOME>/state/local-mcp-installs.json`, `0600` from the first byte (the port writes a `0600`
 * temporary file and renames it). DAMAGED IS NOT EMPTY: a file that will not parse raises, because answering
 * "no copies" would forget every recorded hash and let a changed entry be overwritten. Only a state home that
 * never copied anything answers the empty state. No part of the file reaches a message.
 */
export class FileLocalMcpInstallStore implements LocalMcpInstallStore {
  private readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, LOCAL_MCP_INSTALLS_DOCUMENT);
  }

  async read(): Promise<LocalMcpInstallState> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return EMPTY_LOCAL_MCP_INSTALL_STATE;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new LocalMcpInstallStateError(`${LOCAL_MCP_INSTALLS_DOCUMENT} is not JSON, so no copy was changed`);
    }
    const parsed = LocalMcpInstallStateSchema.safeParse(decoded);
    if (!parsed.success)
      throw new LocalMcpInstallStateError(
        `${LOCAL_MCP_INSTALLS_DOCUMENT} is not a record of copies this daemon writes, so no copy was changed`,
      );
    return parsed.data;
  }

  async write(state: LocalMcpInstallState): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(state, undefined, 2)}\n`);
  }
}
