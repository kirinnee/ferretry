import { expect, test } from 'bun:test';
import type { TargetKind } from '@ferretry/kernel/contract';
import type { HoldsChangedPayload } from '../../../../contract/index.ts';
import { quarantineOverOutputGuard } from '../../../../daemon/adapters/inputs/output-guard.ts';
import { HoldRegistry } from '../../../../daemon/lib/secrets/output-guard.ts';

const terminal = { kind: 'terminal' as TargetKind, key: 'app' };
const page = { kind: 'page' as TargetKind, key: 'app' };

test('I74 timed replay-lock expiry invalidates every output stamp exactly once', () => {
  let now = 0;
  const guard = new HoldRegistry();
  const events: HoldsChangedPayload[] = [];
  const quarantine = quarantineOverOutputGuard({ now: () => now }, guard, event => events.push(event));
  quarantine.lock(10);
  const before = guard.stamp([terminal, page]);
  events.length = 0;
  now = 11;
  expect(quarantine.until('f1', ['app'])).toBeUndefined();
  expect(guard.stillShowable(before)).toBe(false);
  expect(events.map(event => event.target)).toEqual([
    { kind: 'terminal' as TargetKind, key: '*' },
    { kind: 'page' as TargetKind, key: '*' },
  ]);
  const after = guard.stamp([terminal, page]);
  quarantine.purge();
  expect(guard.stillShowable(after)).toBe(true);
  expect(events).toHaveLength(2);
});

test('I74 every hold mutation moves the output guard, including replay, expiry, release and session loss', () => {
  let now = 0;
  const guard = new HoldRegistry();
  const events: HoldsChangedPayload[] = [];
  const quarantine = quarantineOverOutputGuard({ now: () => now }, guard, event => events.push(event));
  const moved = (act: () => unknown) => {
    const stamp = guard.stamp([terminal]);
    act();
    expect(guard.stillShowable(stamp)).toBe(false);
    expect(guard.stillShowable(guard.stamp([terminal]))).toBe(true);
  };
  const before = guard.stamp([terminal]);
  const held = quarantine.begin('f1', ['app'], 'request');
  expect(guard.stillShowable(before)).toBe(false);
  moved(() => quarantine.settle(held));
  moved(() => quarantine.release(held));
  moved(() => quarantine.restore('f1', ['app'], 10, 'restored'));
  moved(() => {
    now = 11;
    quarantine.purge();
  });
  quarantine.begin('f1', ['app'], 'another');
  moved(() => quarantine.drop('f1'));
  quarantine.restore('f1', ['app'], now + 100, 'settled');
  moved(() => quarantine.end('f1', 'app'));
  expect(events.every(event => event.target.kind === 'terminal' && event.target.key === 'app')).toBe(true);
});

test('I74 page and terminal aliases stay separate, and global/session replay locks invalidate scoped reads', () => {
  const guard = new HoldRegistry();
  const quarantine = quarantineOverOutputGuard({ now: () => 0 }, guard, () => undefined);
  const terminalBefore = guard.stamp([terminal]);
  const pageBefore = guard.stamp([page]);
  quarantine.begin('f1', ['~page:app'], 'page-request');
  expect(guard.stillShowable(terminalBefore)).toBe(true);
  expect(guard.stillShowable(pageBefore)).toBe(false);
  for (const act of [() => quarantine.lock(), () => quarantine.unlock(), () => quarantine.lockSession('f1')]) {
    const stamped = guard.stamp([terminal, page]);
    act();
    expect(guard.stillShowable(stamped)).toBe(false);
  }
});
