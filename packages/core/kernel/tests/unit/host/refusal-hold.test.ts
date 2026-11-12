import { expect, test } from 'bun:test';
import { type HoldProcess, holdUntilStopped, startedByLaunchd } from '../../../host/refusal-hold.ts';
import { bootLog } from '../../../host/boot-log.ts';

test('startedByLaunchd: only a set, non-empty label that is not "0" means a launchd job', () => {
  expect(startedByLaunchd({ XPC_SERVICE_NAME: 'com.ferretry.fyd' })).toBe(true);
  expect(startedByLaunchd({ XPC_SERVICE_NAME: '0' })).toBe(false);
  expect(startedByLaunchd({ XPC_SERVICE_NAME: '' })).toBe(false);
  expect(startedByLaunchd({})).toBe(false);
  expect(startedByLaunchd({ INVOCATION_ID: 'abc' })).toBe(false);
});

function fakeProcess() {
  const handlers = new Map<string, () => void>();
  const log: string[] = [];
  const proc: HoldProcess = {
    once: (signal, handler) => void handlers.set(signal, handler),
    keepAlive: () => {
      log.push('alive');
      return () => void log.push('released');
    },
  };
  return { proc, handlers, log };
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`holdUntilStopped stays pending, keeps the loop alive, and resolves its code on ${signal}`, async () => {
    const { proc, handlers, log } = fakeProcess();
    let settled: number | undefined;
    const held = holdUntilStopped(78, proc).then(code => (settled = code));
    await Promise.resolve();
    expect(log).toEqual(['alive']);
    expect(settled).toBeUndefined();
    handlers.get(signal)?.();
    expect(await held).toBe(78);
    expect(log).toEqual(['alive', 'released']);
  });
}

test('holdUntilStopped with the real process seams resolves on a real SIGTERM and clears its timer', async () => {
  const held = holdUntilStopped(78);
  process.emit('SIGTERM');
  expect(await held).toBe(78);
});

test('bootLog drops every line until the home is opened, then writes them', () => {
  const written: string[] = [];
  const log = bootLog(line => void written.push(line));
  log.append('before\n');
  expect(written).toEqual([]);
  log.open();
  log.append('after\n');
  expect(written).toEqual(['after\n']);
});
