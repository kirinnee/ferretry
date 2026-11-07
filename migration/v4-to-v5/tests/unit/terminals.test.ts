import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { terminalsStep } from '../../src/steps/terminals.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
let server: Server | undefined;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  if (server !== undefined)
    await new Promise<void>((resolve, reject) => server?.close(error => (error ? reject(error) : resolve())));
  server = undefined;
  await f.clean();
});

test('D15 links the same socket inode without connecting and carries the pane handle in FerretRecord', async () => {
  let connections = 0;
  server = createServer(() => {
    connections++;
  });
  const socket = join(f.from, 'tmux.sock');
  await new Promise<void>(resolve => server?.listen(socket, resolve));
  await f.session();
  await f.pane();
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  const report = await terminalsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await stat(socket)).ino).toBe((await stat(join(f.to, 'state/terminals/tmux.sock'))).ino);
  expect(JSON.parse(await readFile(join(f.to, 'state/ferrets/f1/ferret.json'), 'utf8')).handle).toBe('%12');
  expect(connections).toBe(0);
  expect(await stat(join(f.to, 'state/terminals/terminals.json')).catch(() => undefined)).toBeUndefined();
});

test('a missing socket and pane carry zero', async () => {
  const report = await terminalsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.every(item => item.count === 0)).toBe(true);
});

test('dry run never links the socket', async () => {
  server = createServer();
  await new Promise<void>(resolve => server?.listen(join(f.from, 'tmux.sock'), resolve));
  expect((await terminalsStep.run(f.ctx(true))).status).toBe('converted');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('mismatched or malformed panes fail without reporting their values', async () => {
  await f.session();
  await f.put('state/sessions/f1/terminal-pane.json', { paneId: 'FAKE-SECRET-PANE' });
  const report = await terminalsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
  await f.pane('f1');
  await f.session('f1', { tmuxSession: 'wrong' });
  expect((await terminalsStep.run(f.ctx())).status).toBe('failed');
});

test('a regular file cannot be used as the tmux socket', async () => {
  await f.put('tmux.sock', 'FAKE-SECRET-SOCKET');
  const report = await terminalsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
});
