import { describe, expect, test } from 'bun:test';
import {
  FerretRecordSchema,
  FerretSummarySchema,
  limitsLoosen,
  LimitsFileSchema,
  MAX_HARNESS_FLAG_LENGTH,
  MAX_HARNESS_FLAGS,
  parseLimitSize,
  StartDecideInputSchema,
  StartOptionsSchema,
} from '../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeFerrets,
  FakeHarness,
  FakeLoginKind,
  FakeRunner,
  FakeWorkFolders,
  fenced,
  ferretId,
  harnessConformance,
  loginKindConformance,
  mayTouchConformance,
  runnerConformance,
  sampleLaunchSpec,
  workFoldersConformance,
} from '../../contract/testing/index.ts';

runnerConformance('FakeRunner', () => {
  const runner = new FakeRunner();
  return {
    runner,
    spec: { ferret: ferretId('f1'), command: ['true'], cwd: fenced('/work'), env: emptyChildEnvironment() },
    adoptable: async () => runner.adoptable(ferretId('f1')),
    starts: () => runner.starts,
  };
});

harnessConformance('FakeHarness', () => {
  const harness = new FakeHarness();
  return {
    harness,
    runner: new FakeRunner(),
    spec: sampleLaunchSpec(),
    deliveredCount: id => harness.delivered.filter(message => message.id === id).length,
  };
});

loginKindConformance('FakeLoginKind', () => new FakeLoginKind());

mayTouchConformance('FakeFerrets', () => {
  const ferrets = new FakeFerrets();
  return { ferrets, add: (id, parent) => ferrets.add({ id, ...(parent === undefined ? {} : { parent }) }) };
});

workFoldersConformance('FakeWorkFolders', () => {
  const ferret = ferretId('f1');
  return { folders: new FakeWorkFolders(new Map([[ferret, '/work/project']])), ferret, folder: '/work/project' };
});

describe('ferret records', () => {
  test('a record has format 1 first and one of the four states', () => {
    const record = {
      format: 1,
      id: 'f1',
      name: 'Fern',
      role: 'lead',
      harness: 'codex',
      runner: 'tmux',
      folder: '/work/project',
      state: 'working',
      handle: '%12',
      createdAt: '2026-11-07T12:00:00.000Z',
      stateAt: '2026-11-07T12:00:00.000Z',
    };
    expect(FerretRecordSchema.safeParse(record).success).toBe(true);
    expect(FerretRecordSchema.safeParse({ ...record, state: 'running' }).success).toBe(false);
    expect(FerretRecordSchema.safeParse({ ...record, format: 2 }).success).toBe(false);
  });
  test('a start.decide input names who asked', () => {
    expect(
      StartDecideInputSchema.safeParse({
        ferret: 'f1',
        name: 'Fern',
        role: 'lead',
        harness: 'claude-code',
        folder: '/w',
        by: 'pack',
      }).success,
    ).toBe(true);
  });
  test('the Ferrets port attaches a known ferret without starting it (D15)', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    expect((await ferrets.attach(ferretId('f1'), '%3' as never)).ok).toBe(true);
    expect((await ferrets.get(ferretId('f1')))?.state).toBe('working');
  });
  test('a harness start goes through the runner with an opaque environment', async () => {
    const runner = new FakeRunner();
    const started = await new FakeHarness('codex').start(sampleLaunchSpec('codex'), runner, emptyChildEnvironment());
    expect(started.ok).toBe(true);
    expect(runner.starts).toBe(1);
  });
});

describe('start options (today’s start fields)', () => {
  const ok = (value: unknown) => StartOptionsSchema.safeParse(value).success;
  test('every field is optional, and an unknown one is refused', () => {
    expect(ok({})).toBe(true);
    expect(ok({ agent: 'claude-alpha' })).toBe(false);
  });
  test('the timers keep today’s floors: interval and snapshots at least 1, the rest at least 0, whole numbers', () => {
    expect(ok({ intervalSeconds: 1, maxSnapshots: 1, timeoutSeconds: 0, nudgeAfterSeconds: 0, killAfterSeconds: 0, directSendMaxChars: 0 })).toBe(true);
    for (const bad of [
      { intervalSeconds: 0 },
      { maxSnapshots: 0 },
      { timeoutSeconds: -1 },
      { nudgeAfterSeconds: 1.5 },
      { killAfterSeconds: -5 },
      { directSendMaxChars: Number.NaN },
    ])
      expect(ok(bad)).toBe(false);
  });
  test('harness flags are bounded in count and length and refuse a control character', () => {
    expect(ok({ harnessFlags: Array(MAX_HARNESS_FLAGS).fill('--x') })).toBe(true);
    expect(ok({ harnessFlags: Array(MAX_HARNESS_FLAGS + 1).fill('--x') })).toBe(false);
    expect(ok({ harnessFlags: ['x'.repeat(MAX_HARNESS_FLAG_LENGTH)] })).toBe(true);
    expect(ok({ harnessFlags: ['x'.repeat(MAX_HARNESS_FLAG_LENGTH + 1)] })).toBe(false);
    expect(ok({ harnessFlags: ['--a\nb'] })).toBe(false);
    expect(ok({ harnessFlags: ['--a\u001bb'] })).toBe(false);
  });
  test('a card is a board card id, the mode and resume menu are today’s choices, a title is at most 120', () => {
    expect(ok({ card: 'F21', mode: 'interactive', resumeMenuChoice: 'summary', title: 'Fix login' })).toBe(true);
    for (const bad of [
      { card: 'F0' },
      { card: '&F21' },
      { mode: 'sideways' },
      { resumeMenuChoice: 'half' },
      { title: 'x'.repeat(121) },
      { model: '' },
      { label: '' },
    ])
      expect(ok(bad)).toBe(false);
  });
  test('a summary carries the model, card, title, pin instant and quota beside the record fields', () => {
    const parsed = FerretSummarySchema.safeParse({
      id: 'f1',
      name: 'Fern',
      role: 'lead',
      harness: 'codex',
      runner: 'tmux',
      folder: '/work/project',
      state: 'working',
      createdAt: '2026-11-07T12:00:00.000Z',
      stateAt: '2026-11-07T12:00:00.000Z',
      model: 'opus',
      card: 'F21',
      title: 'Fix login',
      pinnedAt: '2026-11-07T12:00:00.000Z',
      quota: { weeklyPercent: 40, availability: 'available' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('limits.yaml', () => {
  test('sizes parse as today', () => {
    expect(parseLimitSize('40G')).toEqual({ kind: 'bytes', bytes: 40 * 1024 ** 3 });
    expect(parseLimitSize('25%')).toEqual({ kind: 'percent', percent: 25 });
    expect(parseLimitSize('infinity')).toEqual({ kind: 'unlimited' });
    expect(parseLimitSize('lots')).toBeUndefined();
    expect(LimitsFileSchema.safeParse({ perFerret: { memoryMax: 'lots' } }).success).toBe(false);
  });
  test('raising a cap or turning limits off loosens; lowering does not', () => {
    expect(limitsLoosen({ perFerret: { memoryMax: '8G' } }, { perFerret: { memoryMax: '4G' } })).toEqual([]);
    expect(limitsLoosen({ perFerret: { memoryMax: '4G' } }, { perFerret: { memoryMax: '8G' } })).toEqual([
      'perFerret.memoryMax raised',
    ]);
    expect(limitsLoosen({}, { enabled: false })).toEqual(['limits turned off']);
    expect(limitsLoosen({ fleet: { tasksMax: 100 } }, { fleet: {} })).toEqual(['fleet.tasksMax removed']);
  });
});
