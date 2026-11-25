import type { StatePort } from '@ferretry/kernel/contract';
import {
  CONNECTOR_CALLS,
  CONNECTOR_CALLS_ROTATED,
  type ConnectorCallLine,
  ConnectorCallLineSchema,
} from '../../../contract/index.ts';
import type { ConnectorCallRecord, ConnectorCallsLog } from './ports.ts';

/** docs/mcp-connector.md "Storage": rotate to `calls.1.jsonl` at 1 MiB. */
const CALLS_LOG_MAX_BYTES = 1024 * 1024;

/**
 * `state/connector/calls.jsonl`: one line per WRITE tool call, `0600`, through the kernel's state port (one atomic append
 * per line, a planted link refused, a damaged file refused). The record arrives already redacted (the toolbox does that);
 * this writes what it is given and never sees a token.
 *
 * ROTATION is the plugin's own: when the next line would pass the bound, the whole live log becomes `calls.1.jsonl`
 * (replacing the one before) and the live log starts empty, so two files of about a mebibyte bound the whole thing. Writes
 * are queued one at a time, so a rotation never interleaves with another call's line.
 */
export class KernelConnectorCallsLog implements ConnectorCallsLog {
  #writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: Pick<StatePort, 'append' | 'records' | 'version' | 'write'>,
    private readonly maxBytes: number = CALLS_LOG_MAX_BYTES,
  ) {}

  async append(record: ConnectorCallRecord): Promise<void> {
    const line = ConnectorCallLineSchema.parse({ format: 1, ...record, args: { ...record.args } });
    const write = this.#writes.then(async () => await this.#append(line));
    this.#writes = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  async #append(line: ConnectorCallLine): Promise<void> {
    const size = (await this.state.version(CONNECTOR_CALLS))?.size ?? 0;
    if (size > 0 && size + JSON.stringify(line).length + 1 > this.maxBytes) {
      const live = await this.state.records(CONNECTOR_CALLS);
      await this.state.write(CONNECTOR_CALLS_ROTATED, [...live.records] as unknown as ConnectorCallLine);
      await this.state.write(CONNECTOR_CALLS, [] as unknown as ConnectorCallLine);
    }
    await this.state.append(CONNECTOR_CALLS, line);
  }
}
