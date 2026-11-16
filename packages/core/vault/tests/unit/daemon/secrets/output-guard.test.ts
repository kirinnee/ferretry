import { expect, test } from 'bun:test';
import type { TargetKind } from '@ferretry/kernel/contract';
import { HoldRegistry } from '../../../../daemon/lib/secrets/output-guard.ts';

const terminal = { kind: 'terminal' as TargetKind, key: 'app' };
const page = { kind: 'page' as TargetKind, key: 'app' };

test('I74 the guard reports its generation, which every moved target advances by one', () => {
  const guard = new HoldRegistry();
  expect(guard.generation()).toBe(0);
  expect(guard.moved(terminal)).toBe(1);
  expect(guard.moved(page)).toBe(2);
  expect(guard.generation()).toBe(2);
});
