/**
 * The calls log, read back through v5's REAL state port (not the file text): a record the converter keeps must be one the
 * port returns, and a record the port cannot hold (v5's 1 MiB record limit, counted on the ENCODED line with the `format`
 * key the restamp adds) is named in the report, never counted as kept and never lost without a word.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CONNECTOR_CALLS } from '@ferretry/plugin-connector/contract';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectorStep } from '../../src/steps/connector.ts';
import { fixture } from './ferret-fixture.ts';

const repo = join(import.meta.dir, '../../../..');
const { createNodeHostFs, createStatePort, MAX_JSONL_RECORD_BYTES } = await import(
  repo + '/packages/core/kernel/host/state/index.ts'
);

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const ctx = () => ({ ...f.ctx(), now: () => new Date('2026-11-25T12:00:00.000Z') });
const lineOf = (tool: string, args: string): string =>
  JSON.stringify({
    at: '2026-11-24T00:00:00.000Z',
    tool,
    grantId: 'cg_liveliveli',
    args: { text: args },
    outcome: 'ok',
  });
/** A v4 line of exactly `bytes` encoded bytes, padded with a 3-byte character so a character count would be wrong. */
const lineOfBytes = (tool: string, bytes: number): string => {
  const empty = Buffer.byteLength(lineOf(tool, ''));
  const filler = Math.floor((bytes - empty) / 3);
  const line = lineOf(tool, '€'.repeat(filler)) + '';
  const rest = bytes - Buffer.byteLength(line);
  return lineOf(tool, '€'.repeat(filler) + 'x'.repeat(rest));
};
const raw = async (path: string, lines: string[]) => {
  await mkdir(join(f.from, 'state/connector'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, path), `${lines.join('\n')}\n`, { mode: 0o600 });
};
const readBack = async () => {
  const port = createStatePort({ home: f.to, pluginId: 'connector', fs: createNodeHostFs(), files: [CONNECTOR_CALLS] });
  return await port.records(CONNECTOR_CALLS);
};

test('every call record the converter says it kept is returned by v5 state port', async () => {
  await raw('state/connector/calls.jsonl', [lineOf('stop_ferret', 'a'), lineOf('spawn_ferret', 'b')]);
  const report = await connectorStep.run(ctx());
  expect(report.status, report.note).toBe('converted');
  const back = await readBack();
  expect(back.unreadable).toBe(0);
  expect(back.records.map((record: unknown) => (record as { tool: string }).tool)).toEqual([
    'stop_ferret',
    'spawn_ferret',
  ]);
  expect(report.kept).toContainEqual({
    what: 'connector write-tool call records (calls.1.jsonl + calls.jsonl, in order)',
    count: 2,
  });
});

test('a record that fits v5 only without the restamp is named, not counted as kept, and the rest still read', async () => {
  const exact = lineOfBytes('send_to_ferret', MAX_JSONL_RECORD_BYTES);
  expect(Buffer.byteLength(exact)).toBe(MAX_JSONL_RECORD_BYTES);
  const fits = lineOfBytes('spawn_ferret', MAX_JSONL_RECORD_BYTES - 64);
  await raw('state/connector/calls.jsonl', [lineOf('stop_ferret', 'a'), exact, fits]);
  const report = await connectorStep.run(ctx());
  expect(report.status, report.note).toBe('converted');
  const back = await readBack();
  // What the report calls kept is exactly what the port returns.
  expect(back.unreadable).toBe(0);
  expect(back.records.map((record: unknown) => (record as { tool: string }).tool)).toEqual([
    'stop_ferret',
    'spawn_ferret',
  ]);
  expect(report.kept).toContainEqual({
    what: 'connector write-tool call records (calls.1.jsonl + calls.jsonl, in order)',
    count: back.records.length,
  });
  // The one it could not hold is said: which file and line, why, and where it stays.
  const named = report.notCarried.find(item => item.what.includes('too large'));
  expect(named?.why).toContain('state/connector/calls.jsonl record 2');
  expect(named?.why).toContain('1 MiB');
  expect(JSON.stringify(report)).not.toContain('€€€');
});
