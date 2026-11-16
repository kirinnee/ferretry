import { describe, expect, test } from 'bun:test';
import { InMemoryLaunchGate } from '../../../../../daemon/adapters/session/resume/in-memory-launch-gate.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

const A = parseSessionId('session-a');
const B = parseSessionId('session-b');

function gate(pollMs = 100) {
  const slept: number[] = [];
  return { slept, gate: new InMemoryLaunchGate(async ms => void slept.push(ms), pollMs) };
}

describe('the in-process launch gate', () => {
  test('a registered launch is in flight until released, and only that session', () => {
    const { gate: g } = gate();
    expect(g.launching(A)).toBe(false);
    const launch = g.register(A);
    expect(g.launching(A)).toBe(true);
    expect(g.launching(B)).toBe(false);
    launch.release();
    expect(g.launching(A)).toBe(false);
  });

  test('a late release from a superseded attempt does not un-register the launch that replaced it', () => {
    const { gate: g } = gate();
    const first = g.register(A);
    const second = g.register(A);
    first.release();
    expect(g.launching(A)).toBe(true);
    second.release();
    expect(g.launching(A)).toBe(false);
  });

  test('awaitSettled answers true at once when nothing is launching', async () => {
    const { gate: g, slept } = gate();
    expect(await g.awaitSettled(A, 1_000)).toBe(true);
    expect(slept).toEqual([]);
  });

  test('awaitSettled polls until the launch is released, then answers true', async () => {
    const slept: number[] = [];
    let launch: { release(): void } | undefined;
    const g = new InMemoryLaunchGate(async ms => {
      slept.push(ms);
      if (slept.length === 2) launch?.release();
    }, 100);
    launch = g.register(A);
    expect(await g.awaitSettled(A, 1_000)).toBe(true);
    expect(slept).toEqual([100, 100]);
  });

  test('awaitSettled gives up at the budget, sleeping no longer than what is left, and answers false', async () => {
    const { gate: g, slept } = gate(100);
    g.register(A);
    expect(await g.awaitSettled(A, 250)).toBe(false);
    expect(slept).toEqual([100, 100, 50]);
  });

  test('a launch released during the last sleep still counts as settled', async () => {
    let launch: { release(): void } | undefined;
    const g = new InMemoryLaunchGate(async () => launch?.release(), 100);
    launch = g.register(A);
    expect(await g.awaitSettled(A, 100)).toBe(true);
  });
});
