import { describe, expect, test } from 'bun:test';
import { DaemonUpdateViewSchema, planUpdate } from '../../contract/index.ts';
import { parseView, viewLines } from '../../cli/lib/verb.ts';

const LATEST = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };
const profile = { kind: 'nix-profile', element: 'ferretry' } as const;
const apt = { kind: 'system-package', manager: 'apt' } as const;
const REPORT = {
  from: '4.28.0',
  target: '4.29.0',
  outcome: 'succeeded',
  message: 'Updated.',
  finishedAt: '2026-10-18T10:00:00.000Z',
};

const raw = (overrides: Record<string, unknown> = {}) => ({
  current: '4.28.0',
  method: profile,
  plan: planUpdate(profile, { product: 'ferretry', clientName: 'fy' }),
  check: { state: 'ok', checkedAt: '2026-10-18T09:00:00.000Z', latest: LATEST },
  available: true,
  midTurn: 0,
  autoInstall: false,
  job: null,
  ...overrides,
});
const lines = (overrides: Record<string, unknown> = {}) => viewLines(parseView(raw(overrides)));

describe('the lines `fy update check` prints', () => {
  test('parseView refuses a document that is not a daemon update view', () => {
    expect(() => parseView({ current: 'nope' })).toThrow();
    expect(parseView(raw())).toEqual(DaemonUpdateViewSchema.parse(raw()));
  });
  test('a daemon that is behind says what runs, what is out, and where', () => {
    const out = lines();
    expect(out[0]).toBe('daemon    4.28.0');
    expect(out[1]).toStartWith('installed ');
    expect(out).toContain('latest    4.29.0');
    expect(out).toContain(`behind    4.28.0 → 4.29.0 (${LATEST.url})`);
  });
  test('a daemon that has never checked says so and is not called behind', () => {
    const out = lines({ check: { state: 'never' }, available: false });
    expect(out).toContain('latest    not checked yet');
    expect(out.some(line => line.startsWith('behind'))).toBe(false);
  });
  test('a failed check with no earlier answer says the latest is unknown, with the reason', () => {
    const out = lines({
      check: { state: 'failed', checkedAt: '2026-10-18T09:00:00.000Z', reason: 'offline' },
      available: false,
    });
    expect(out).toContain('latest    unknown (the last check failed: offline)');
  });
  test('a failed check keeps the last known release', () => {
    const out = lines({
      check: {
        state: 'failed',
        checkedAt: '2026-10-18T09:00:00.000Z',
        reason: 'offline',
        lastKnown: { checkedAt: '2026-10-17T09:00:00.000Z', latest: LATEST },
      },
    });
    expect(out).toContain('latest    4.29.0 (the last check failed: offline)');
    expect(out).toContain(`behind    4.28.0 → 4.29.0 (${LATEST.url})`);
  });
  test('a daemon that cannot update itself prints the explanation and each step, notes after a #', () => {
    const plan = planUpdate(apt, { product: 'ferretry', clientName: 'fy' });
    const out = lines({ method: apt, plan });
    expect(out).toContain('explanation:');
    if (plan.kind === 'self') throw new Error('a system package cannot update itself');
    expect(out).toContain(`  ${plan.explanation}`);
    expect(out).toContain('steps:');
    for (const step of plan.steps) {
      expect(out).toContain(`  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}`);
    }
  });
  test('a plan with no steps prints the explanation alone', () => {
    const plan = { ...planUpdate(apt, { product: 'ferretry', clientName: 'fy' }), steps: [] };
    const out = lines({ method: apt, plan });
    expect(out).toContain('explanation:');
    expect(out).not.toContain('steps:');
  });
  test('an update waiting for idle, running, and finished each end the output with their line', () => {
    expect(
      lines({
        job: { state: 'waiting-for-idle', target: '4.29.0', requestedAt: '2026-10-18T09:59:00.000Z', midTurn: 3 },
      }).at(-1),
    ).toBe('waiting   to update to 4.29.0 once no ferret is mid-turn (3 now)');
    expect(lines({ job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T09:59:00.000Z' } }).at(-1)).toBe(
      'running   updating to 4.29.0',
    );
    expect(lines({ job: { state: 'finished', report: REPORT } }).at(-1)).toBe('last      succeeded: Updated.');
  });
});
