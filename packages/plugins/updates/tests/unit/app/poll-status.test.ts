import { expect, test } from 'bun:test';
import { DaemonUpdateViewSchema, planUpdate } from '../../../contract/index.ts';
import { pollUpdateStatus } from '../../../app/lib/poll-status.ts';

const method = { kind: 'nix-profile', element: 'ferretry' } as const;
const view = (job: unknown) =>
  DaemonUpdateViewSchema.parse({
    current: '5.0.0',
    method,
    plan: planUpdate(method, { product: 'ferretry', clientName: 'fy' }),
    check: { state: 'never' },
    available: false,
    midTurn: 0,
    autoInstall: false,
    job,
  });
const startedAt = '2026-11-07T00:00:00.000Z';
const waiting = view({ state: 'waiting-for-idle', target: '5.0.1', requestedAt: startedAt, midTurn: 1 });
const running = view({ state: 'running', target: '5.0.1', startedAt });
const finished = view({
  state: 'finished',
  report: {
    from: '5.0.0',
    target: '5.0.1',
    outcome: 'succeeded',
    message: 'Updated.',
    finishedAt: startedAt,
  },
});

test('settings advances waiting → running → finished and retries failed reads during restart', async () => {
  const answers = [waiting, running, new Error('restarting'), finished];
  const states: string[] = [];
  const failures: unknown[] = [];
  const timers: (() => void)[] = [];
  const stop = pollUpdateStatus({
    read: async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? finished;
    },
    view: next => {
      states.push(next.job?.state ?? 'none');
    },
    failed: error => {
      failures.push(error);
    },
    later: work => {
      timers.push(work);
      return () => {
        timers.splice(timers.indexOf(work), 1);
      };
    },
  });
  await Promise.resolve();
  expect(states).toEqual(['waiting-for-idle']);
  for (let i = 0; i < 3; i++) {
    timers.shift()?.();
    await Promise.resolve();
  }
  expect(states).toEqual(['waiting-for-idle', 'running', 'finished']);
  expect(failures).toHaveLength(1);
  stop();
  expect(timers).toEqual([]);
});

test('an already-open settings tab discovers an automatic update, and unmount ignores an in-flight read', async () => {
  const states: unknown[] = [];
  let deliver: ((answer: typeof running) => void) | undefined;
  const timers: (() => void)[] = [];
  let reads = 0;
  const stop = pollUpdateStatus({
    read: async () =>
      ++reads === 1
        ? view(null)
        : await new Promise(resolve => {
            deliver = resolve;
          }),
    view: next => {
      states.push(next.job);
    },
    failed: () => {},
    later: work => {
      timers.push(work);
      return () => {
        timers.splice(timers.indexOf(work), 1);
      };
    },
  });
  await Promise.resolve();
  timers.shift()?.();
  await Promise.resolve();
  stop();
  deliver?.(running);
  await Promise.resolve();
  await Promise.resolve();
  expect(states).toEqual([null]);
  expect(timers).toEqual([]);
});
