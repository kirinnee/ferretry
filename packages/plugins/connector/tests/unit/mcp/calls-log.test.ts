import { describe, it } from 'bun:test';
import should from 'should';
import { CONNECTOR_CALLS, CONNECTOR_CALLS_ROTATED } from '../../../contract/index.ts';
import { KernelConnectorCallsLog } from '../../../daemon/lib/mcp/calls-log.ts';
import type { ConnectorCallRecord } from '../../../daemon/lib/mcp/ports.ts';

const record = (n: number, pad = ''): ConnectorCallRecord => ({
  at: '2026-11-24T12:00:00.000Z',
  tool: 'send_to_ferret',
  grantId: 'cg_aaaaaaaaaa',
  tokenId: '0123456789ab',
  args: { ferret: 'lizzette', message: `m${n}${pad}` },
  outcome: 'ok',
});

/** The kernel's state port as far as the log uses it: two jsonl files, appended and swapped whole. */
function fakeState() {
  const files = new Map<unknown, unknown[]>([
    [CONNECTOR_CALLS, []],
    [CONNECTOR_CALLS_ROTATED, []],
  ]);
  const fail = { append: false };
  const port = {
    append: async (file: unknown, line: unknown) => {
      if (fail.append) throw new Error('disk full');
      files.get(file)?.push(structuredClone(line));
    },
    records: async (file: unknown) => ({ records: structuredClone(files.get(file) ?? []), unreadable: 0 }),
    version: async (file: unknown) => {
      const lines = files.get(file) ?? [];
      return lines.length === 0
        ? undefined
        : { size: lines.map(line => JSON.stringify(line).length + 1).reduce((a, b) => a + b, 0), etag: 'e' };
    },
    write: async (file: unknown, value: unknown) => {
      files.set(file, structuredClone(value as unknown[]));
    },
  };
  return { port, files, fail };
}
const messages = (lines: unknown[] | undefined) =>
  (lines ?? []).map(line => (line as ConnectorCallRecord).args.message);

describe('KernelConnectorCallsLog', () => {
  it('appends one line per call, in order, stamped format 1, with the token only as its id', async () => {
    const state = fakeState();
    const log = new KernelConnectorCallsLog(state.port as never);
    await Promise.all([1, 2, 3, 4, 5].map(async n => await log.append(record(n))));
    should(messages(state.files.get(CONNECTOR_CALLS))).eql(['m1', 'm2', 'm3', 'm4', 'm5']);
    const first = state.files.get(CONNECTOR_CALLS)?.[0] as Record<string, unknown>;
    should(first.format).equal(1);
    should(first.tokenId).equal('0123456789ab');
  });

  it('rotates to calls.1.jsonl when the next line would pass the bound, replacing the one before it', async () => {
    const state = fakeState();
    const log = new KernelConnectorCallsLog(state.port as never, 600);
    for (let n = 0; n < 12; n += 1) await log.append(record(n, 'x'.repeat(100)));
    const live = messages(state.files.get(CONNECTOR_CALLS));
    const rotated = messages(state.files.get(CONNECTOR_CALLS_ROTATED));
    should(rotated.length).be.above(0);
    should(live[live.length - 1]).startWith('m11');
    should((await state.port.version(CONNECTOR_CALLS))?.size ?? 0).be.belowOrEqual(600);
    // Two files bound the whole log: the lines before the last rotation are gone, none of the kept ones is edited.
    should(live.length + rotated.length).be.below(12);
    for (const message of [...rotated, ...live]) should(String(message)).startWith('m');
  });

  it('refuses a line that is not the schema, so a stray field cannot carry a secret into the file', async () => {
    const state = fakeState();
    const log = new KernelConnectorCallsLog(state.port as never);
    const loose = { ...record(1), bearer: 'fyc_at_nope' } as unknown as ConnectorCallRecord;
    await should(log.append(loose)).be.rejected();
    should(state.files.get(CONNECTOR_CALLS)).eql([]);
  });

  it('fails the append the disk refused, and the next still goes through', async () => {
    const state = fakeState();
    const log = new KernelConnectorCallsLog(state.port as never);
    state.fail.append = true;
    await should(log.append(record(1))).be.rejected();
    state.fail.append = false;
    await log.append(record(2));
    should(messages(state.files.get(CONNECTOR_CALLS))).eql(['m2']);
  });
});
