import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileConnectorCallsLog } from '../../../../src/adapters/connector/mcp/calls-log.ts';
import type { ConnectorCallRecord } from '../../../../src/lib/connector/mcp/ports.ts';

const record = (n: number, pad = ''): ConnectorCallRecord => ({
  at: '2026-11-24T12:00:00.000Z',
  tool: 'send_to_ferret',
  grantId: 'cg_aaaaaaaaaa',
  tokenId: '0123456789ab',
  args: { ferret: 'lizzette', message: `m${n}${pad}` },
  outcome: 'ok',
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});
const fresh = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'fy-calls-'));
  dirs.push(dir);
  return join(dir, 'connector');
};

describe('FileConnectorCallsLog', () => {
  it('appends one JSON line per call, 0600 in a 0700 directory', async () => {
    const dir = await fresh();
    const log = new FileConnectorCallsLog(dir);
    await log.append(record(1));
    await log.append(record(2));
    const lines = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trimEnd().split('\n');
    should(lines.map(line => JSON.parse(line).args.message)).eql(['m1', 'm2']);
    should((await stat(join(dir, 'calls.jsonl'))).mode & 0o777).equal(0o600);
    should((await stat(dir)).mode & 0o777).equal(0o700);
  });

  it('rotates to calls.1.jsonl when the next line would pass the bound, never editing a line', async () => {
    const dir = await fresh();
    const log = new FileConnectorCallsLog(dir, 600);
    for (let n = 0; n < 6; n += 1) await log.append(record(n, 'x'.repeat(100)));
    const live = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trimEnd().split('\n');
    const rotated = (await readFile(join(dir, 'calls.1.jsonl'), 'utf8')).trimEnd().split('\n');
    should(live.length + rotated.length).be.aboveOrEqual(3);
    should((await stat(join(dir, 'calls.jsonl'))).size).be.belowOrEqual(600);
    should(JSON.parse(live[live.length - 1] as string).args.message.startsWith('m5')).be.true();
  });

  it('writes serialised appends in order', async () => {
    const dir = await fresh();
    const log = new FileConnectorCallsLog(dir);
    await Promise.all([1, 2, 3, 4, 5].map(async n => await log.append(record(n))));
    const lines = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trimEnd().split('\n');
    should(lines.map(line => JSON.parse(line).args.message)).eql(['m1', 'm2', 'm3', 'm4', 'm5']);
  });
});
