/**
 * MERGE BAR (docs/rebuild/merge-bar.md, "a converted home keeps its v4 spend caps"): a converted home STOPS A START at
 * the login's v4 cap, judged by the REAL Usage plugin's `start.decide`.
 *
 * 5.0 enforces a spend budget only from `config/usage.yaml` (`budgets.<login>`); a cap left in a login file is inert.
 * So these tests prepare a home (the preview AND the real converter), read it back through the real kernel config
 * service (the version IN EFFECT: a raise v4 still holds is held there), hand that to the actual Logins and Usage daemon
 * halves on `testHost`, supply a synthetic meter reading, and observe the original `start.decide` hook (the hook is only
 * wrapped to be observed, never replaced). Every number and marker is synthetic; no real credential is read.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOGINS_CONFIG } from '@ferretry/plugin-logins/contract';
import { USAGE_CONFIG } from '@ferretry/plugin-usage/contract';
import { FakeFerrets } from '../../../../packages/core/ferrets/contract/testing/index.ts';
import { createConfigFiles } from '../../../../packages/core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../packages/core/kernel/host/state/host-fs.ts';
import { fixedClock, testHost } from '../../../../packages/core/kernel/testing/index.ts';
import { FakeVault } from '../../../../packages/core/vault/contract/testing/index.ts';
import { fakeConversation } from '../../../../packages/plugins/conversation/contract/testing/index.ts';
import logins from '../../../../packages/plugins/logins/daemon/index.ts';
import usage from '../../../../packages/plugins/usage/daemon/index.ts';
import { SpendMeter } from '../../../../packages/plugins/usage/daemon/lib/budget/meter.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { heldSection, prepare } from '../../preview/driver.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
};
const COMMENT_MARKER = 'sk-ant-FAKE-USAGE-COMMENT-0000000000';
const now = () => new Date('2026-11-09T00:00:00Z');
const lock = { held: async () => false };

const home = () => join(f.root, 'home');
const previewTarget = () => join(home(), '.ferretry-v5');
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};

type Mode = 'preview' | 'preview-owner' | 'real';
const MODES: readonly Mode[] = ['preview', 'preview-owner', 'real'];

/** Converts the v4 home of the fixture the way `mode` does; returns the new home and the whole report's text. */
async function convertHome(mode: Mode): Promise<{ readonly target: string; readonly report: string }> {
  if (mode === 'real') {
    const result = await convert({
      from: f.from,
      to: f.to,
      dryRun: false,
      lock,
      now,
      steps: [settingsStep, acceptedConfigStep],
    });
    if (result.kind !== 'done') throw new Error('the real conversion was refused');
    return { target: f.to, report: JSON.stringify(result.report) };
  }
  const done = await prepare({
    v4Home: f.from,
    target: previewTarget(),
    home: home(),
    owner: mode === 'preview-owner',
    lock,
    now,
  });
  expect(done.report?.complete).toBe(true);
  return { target: previewTarget(), report: `${JSON.stringify(done.report)}\n${heldSection(done.report as never)}` };
}

/** The converted home read back through the real kernel config service: the logins and usage IN EFFECT. */
async function boot(target: string) {
  const files = createConfigFiles({
    home: target,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: quiet,
    binary: 'fy',
    defs: [
      { plugin: 'logins', def: LOGINS_CONFIG },
      { plugin: 'usage', def: USAGE_CONFIG },
    ],
    judge: () => false,
  });
  await files.reload();
  if (LOGINS_CONFIG.shape !== 'collection') throw new Error('the logins definition is not a collection');
  const collection = LOGINS_CONFIG;
  return {
    files,
    work: () => files.port('logins').collection(collection).get('work'),
    usageFile: () => files.port('usage').file(USAGE_CONFIG),
  };
}
type Booted = Awaited<ReturnType<typeof boot>>;

/** Whether the REAL Usage `start.decide` lets a start on login `work` through at `spentUsd`, under the config in effect. */
async function decideAt(booted: Booted, spentUsd: number): Promise<{ allow: boolean; reason?: string }> {
  const spent = spyOn(SpendMeter.prototype, 'spent').mockReturnValue({
    usdMicros: spentUsd * 1_000_000,
    unpriced: 0,
    partial: false,
  });
  const refresh = spyOn(SpendMeter.prototype, 'refresh').mockResolvedValue(undefined);
  let h: Awaited<ReturnType<typeof testHost>> | undefined;
  try {
    let decide: ((input: unknown) => { allow: boolean; reason?: string }) | undefined;
    const observed = {
      ...usage,
      build(ctx: never) {
        const half = (usage as { build: (c: never) => { hooks?: Record<string, unknown> } }).build(ctx);
        decide = half.hooks?.['start.decide'] as typeof decide;
        return half;
      },
    };
    const usageFile = booted.usageFile();
    h = await testHost({
      plugins: [logins, observed as never],
      fakes: { ferrets: new FakeFerrets(), conversation: fakeConversation(), vault: new FakeVault() },
      config: {
        logins: { work: booted.work() },
        ...(usageFile === undefined ? {} : { [USAGE_CONFIG.file]: usageFile }),
      },
    } as never);
    await h.runJob('usage-budget');
    if (decide === undefined) throw new Error('Usage built no start.decide hook');
    return decide({
      ferret: 'synthetic-review',
      name: 'review',
      role: 'lead',
      harness: 'claude-code',
      folder: '/tmp/synthetic',
      by: 'owner',
      login: 'work',
    });
  } finally {
    await h?.stop();
    spent.mockRestore();
    refresh.mockRestore();
  }
}

const unrelatedHeldDeletion = () => {
  const limits = 'enabled: true\nperFerret:\n  memoryMax: 4G\n';
  return { 'limits.yaml': { etag: sha(limits), text: limits } };
};

/** A v4 login with `budget`, its accepted text (default: the same), and optionally an accepted `limits.yaml` now gone. */
async function arrange(options: { current: string; accepted?: string; heldDeletion?: boolean; store?: string }) {
  const body = (budget: string) =>
    `harness: claude\nstore: ${options.store ?? 'host'}\n# ${COMMENT_MARKER}\nbudget: # ${COMMENT_MARKER}\n${budget}`;
  const current = body(options.current);
  const accepted = body(options.accepted ?? options.current);
  await put('layout-version', '2\n');
  await put('config/logins/work.yaml', current);
  await f.put('state/config-accepted.json', {
    'logins/work.yaml': { etag: sha(accepted), text: accepted },
    ...(options.heldDeletion === true ? unrelatedHeldDeletion() : {}),
  });
}

const DAILY_HARD_10 = '  daily:\n    hard: 10\n';

describe('(a) a converted home stops a start at the login v4 hard cap', () => {
  for (const mode of MODES)
    for (const heldDeletion of [false, true])
      test(`${mode}, ${heldDeletion ? 'with' : 'without'} an unrelated held deletion: refused at $15, allowed at $5, and a label apply keeps the cap`, async () => {
        await arrange({ current: DAILY_HARD_10, heldDeletion });
        const { target, report } = await convertHome(mode);
        let booted = await boot(target);
        // The cap lives in usage.yaml; the converted login carries none.
        expect(booted.usageFile()).toMatchObject({ budgets: { work: { daily: { hard: 10 } } } });
        expect(booted.work()).not.toHaveProperty('budget');
        expect((await decideAt(booted, 15)).allow).toBe(false);
        expect((await decideAt(booted, 5)).allow).toBe(true);
        // The report says the cap as numbers.
        expect(report).toContain('login work daily hard limit $10');
        expect(report).not.toContain(COMMENT_MARKER);
        // A later harmless login edit keeps the cap.
        const applied = await booted.files.write('logins', LOGINS_CONFIG, 'work', { patch: { label: 'Work review' } });
        expect(applied.kind).toBe('applied');
        booted = await boot(target);
        expect(booted.usageFile()).toMatchObject({ budgets: { work: { daily: { hard: 10 } } } });
        expect((await decideAt(booted, 15)).allow).toBe(false);
      });

  test('the converted usage.yaml keeps the keys machine.yaml split into it', async () => {
    await arrange({ current: DAILY_HARD_10 });
    await put('config/machine.yaml', 'timeZone: UTC\npublicUsageFeed: false\n');
    const { target } = await convertHome('real');
    const text = await readFile(join(target, 'config/usage.yaml'), 'utf8');
    expect(text).toContain('timeZone: UTC');
    expect(text).toContain('publicFeed: false');
    expect(text).toContain('hard: 10');
  });
});

describe('(b) an unaccepted v4 raise stays held until the owner accepts', () => {
  for (const mode of MODES)
    for (const heldDeletion of [false, true])
      test(`${mode}, ${heldDeletion ? 'with' : 'without'} an unrelated held deletion: judged at the ACCEPTED $10, then at the new $20 once accepted`, async () => {
        await arrange({ current: '  daily:\n    hard: 20\n', accepted: DAILY_HARD_10, heldDeletion });
        const { target, report } = await convertHome(mode);
        const booted = await boot(target);
        // The file says 20; the version in effect is the accepted 10, with the raise held for the owner.
        expect((await decideAt(booted, 15)).allow).toBe(false);
        const edit = booted.files.held().find(held => held.plugin === 'usage');
        expect(edit?.sentences.join(' ')).toContain('goes up from 10 to 20');
        // The migration report says it in numbers.
        expect(report).toContain('login work daily hard limit held: accepted $10, pending $20');
        // The owner accepts: now the new cap applies, and $15 is under it.
        expect(await booted.files.confirm(edit?.id ?? '')).toBe(true);
        await booted.files.reload();
        expect((await decideAt(booted, 15)).allow).toBe(true);
        expect((await decideAt(booted, 25)).allow).toBe(false);
      });

  for (const mode of MODES)
    test(`${mode}: a lowered cap applies at once`, async () => {
      await arrange({ current: DAILY_HARD_10, accepted: '  daily:\n    hard: 20\n' });
      const { target, report } = await convertHome(mode);
      const booted = await boot(target);
      expect(booted.files.held().filter(held => held.plugin === 'usage')).toEqual([]);
      expect((await decideAt(booted, 15)).allow).toBe(false);
      expect(report).not.toContain('held: accepted');
    });
});

describe('(c) every period and level v4 had carries', () => {
  const CASES: readonly (readonly [string, string])[] = [
    ['daily trigger', '  daily:\n    trigger: 10\n'],
    ['daily hard', '  daily:\n    hard: 10\n'],
    ['weekly trigger', '  weekly:\n    trigger: 10\n'],
    ['weekly hard', '  weekly:\n    hard: 10\n'],
    [
      'daily and weekly, trigger and hard',
      '  daily:\n    trigger: 8\n    hard: 12\n  weekly:\n    trigger: 40\n    hard: 60\n',
    ],
  ];
  for (const mode of MODES)
    for (const [what, budget] of CASES)
      test(`${mode}: ${what}: past it nothing new starts, under it a start is allowed`, async () => {
        await arrange({ current: budget });
        const { target, report } = await convertHome(mode);
        const booted = await boot(target);
        const expected = (await import('yaml')).parse(`budget:\n${budget}`) as { budget: object };
        expect(booted.usageFile()).toMatchObject({ budgets: { work: expected.budget } });
        // Past the trigger nothing new starts (docs/budgets.md); past the hard limit nothing new starts either.
        expect((await decideAt(booted, 15)).allow).toBe(false);
        expect((await decideAt(booted, 1)).allow).toBe(true);
        expect(report).toMatch(/login work (daily|weekly) (trigger|hard) limit \$\d+/u);
      });
});

/**
 * Whether the REAL Usage `start.decide` lets a start on `work` through at 2026-11-09T20:00Z when $15 were spent at
 * 04:00Z, under the usage config IN EFFECT. UTC's day and week include that spend; America/Los_Angeles' (begin 08:00Z)
 * exclude it, so the zone alone decides the answer.
 */
async function decideByWindow(booted: Booted): Promise<{ allow: boolean; reason?: string }> {
  const at = Date.parse('2026-11-09T04:00:00Z');
  const spent = spyOn(SpendMeter.prototype, 'spent').mockImplementation(((
    _agents: unknown,
    start: number,
    end: number,
  ) => ({
    usdMicros: at >= start && at < end ? 15_000_000 : 0,
    unpriced: 0,
    partial: false,
  })) as never);
  const refresh = spyOn(SpendMeter.prototype, 'refresh').mockResolvedValue(undefined);
  let h: Awaited<ReturnType<typeof testHost>> | undefined;
  try {
    let decide: ((input: unknown) => { allow: boolean; reason?: string }) | undefined;
    const observed = {
      ...usage,
      build(ctx: never) {
        const half = (usage as { build: (c: never) => { hooks?: Record<string, unknown> } }).build(ctx);
        decide = half.hooks?.['start.decide'] as typeof decide;
        return half;
      },
    };
    const usageFile = booted.usageFile();
    h = await testHost({
      plugins: [logins, observed as never],
      fakes: { ferrets: new FakeFerrets(), conversation: fakeConversation(), vault: new FakeVault() },
      clock: fixedClock('2026-11-09T20:00:00Z'),
      config: {
        logins: { work: booted.work() },
        ...(usageFile === undefined ? {} : { [USAGE_CONFIG.file]: usageFile }),
      },
    } as never);
    await h.runJob('usage-budget');
    if (decide === undefined) throw new Error('Usage built no start.decide hook');
    return decide({ login: 'work' });
  } finally {
    await h?.stop();
    spent.mockRestore();
    refresh.mockRestore();
  }
}

describe('(d) an unaccepted v4 time-zone change is held: starts are judged in the ACCEPTED zone until the owner accepts', () => {
  /** v4's accepted machine.yaml says `accepted`; the file now says `current`; the owner has not accepted the change. */
  async function arrangeZone(period: 'daily' | 'weekly', accepted: string | undefined, current: string | undefined) {
    await arrange({ current: `  ${period}:\n    hard: 10\n` });
    if (current !== undefined) await put('config/machine.yaml', `timeZone: ${current}\n`);
    const prior = JSON.parse(await readFile(join(f.from, 'state/config-accepted.json'), 'utf8')) as object;
    const acceptedText = accepted === undefined ? 'publicUsageFeed: false\n' : `timeZone: ${accepted}\n`;
    await f.put('state/config-accepted.json', {
      ...prior,
      'machine.yaml': { etag: sha(acceptedText), text: acceptedText },
    });
  }

  for (const mode of MODES)
    for (const period of ['daily', 'weekly'] as const)
      test(`${mode}, ${period}: judged in the accepted UTC until the owner accepts, then in the new zone`, async () => {
        await arrangeZone(period, 'UTC', 'America/Los_Angeles');
        const { target, report } = await convertHome(mode);
        const booted = await boot(target);
        // The version in effect is the ACCEPTED zone; the new one is a held edit naming both zones.
        expect(booted.usageFile()?.timeZone).toBe('UTC');
        const edit = booted.files.held().find(held => held.plugin === 'usage');
        expect(edit?.sentences.join(' ')).toContain('budgets now reset in America/Los_Angeles instead of UTC');
        expect(report).toContain('machine.yaml (an unconfirmed edit)');
        // The same $15 the accepted UTC window holds is refused by the real hook.
        const refused = await decideByWindow(booted);
        expect(refused.allow).toBe(false);
        expect(refused.reason).toContain('(UTC)');
        // The owner accepts: the new zone applies, whose window does not include that spend.
        expect(await booted.files.confirm(edit?.id ?? '')).toBe(true);
        await booted.files.reload();
        expect(booted.usageFile()?.timeZone).toBe('America/Los_Angeles');
        expect((await decideByWindow(booted)).allow).toBe(true);
      });

  test('a zone newly set where v4 had none is held too, and the host zone stays in effect', async () => {
    await arrangeZone('daily', undefined, 'Pacific/Kiritimati');
    const set = await boot((await convertHome('real')).target);
    expect(set.usageFile()?.timeZone).toBeUndefined();
    expect(
      set.files
        .held()
        .find(held => held.plugin === 'usage')
        ?.sentences.join(' '),
    ).toContain("budgets now reset in Pacific/Kiritimati instead of the host's time zone");
  });
});

describe('a budget that cannot be rebuilt is never written capless', () => {
  test('preview: the login is held by name with its runtime, and usage.yaml names no cap', async () => {
    await arrange({ current: '  daily:\n    hard: ten\n' });
    await put('config/profiles/main.yaml', 'contents: []\n');
    await put('config/runtimes/main.yaml', 'credential: work\nprofile: main\n');
    const { target, report } = await convertHome('preview');
    expect(report).toContain('login work (its budget cannot be carried)');
    expect(report).toContain('runtime main');
    const booted = await boot(target);
    expect(booted.work()).toBeUndefined();
    expect(booted.usageFile()?.budgets).toBeUndefined();
    expect(report).not.toContain('hard: ten');
  });
});

/** Every file name and text under every `<HOME>/.ferretry-v5*` path, recursive. */
async function everything(): Promise<string> {
  const parts: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const facts = await stat(path).catch(() => undefined);
    if (facts === undefined) return;
    if (facts.isDirectory()) {
      parts.push(path);
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else if (facts.isFile()) parts.push(path, await readFile(path, 'utf8').catch(() => ''));
  };
  for (const root of (await readdir(home()).catch(() => [] as string[])).filter(n => n.startsWith('.ferretry-v5')))
    await visit(join(home(), root));
  return parts.join('\n');
}

describe('the whole artifact still holds no comment, key, path or token marker (usage.yaml and its snapshot included)', () => {
  const KEY_MARKER = 'sk-ant-FAKE-USAGE-LITERAL-KEY-0000000000';
  const PATH_MARKER = '/tmp/usage-fixture-google-credentials.json';
  const ANCHOR = 'sk-ant-FAKE-USAGE-ANCHOR-0000000000';
  for (const owner of [false, true])
    for (const throws of [false, true])
      test(`owner=${owner}, prepare ${throws ? 'throwing (the report cannot be written)' : 'passing'}`, async () => {
        await put('layout-version', '2\n');
        const prior = [
          `# ${COMMENT_MARKER}`,
          'harness: claude',
          'store: environment',
          'env:',
          `  ANTHROPIC_API_KEY: ${KEY_MARKER}`,
          `  GOOGLE_APPLICATION_CREDENTIALS: ${PATH_MARKER}`,
          `budget: # ${COMMENT_MARKER}`,
          `  daily: &${ANCHOR} # ${COMMENT_MARKER}`,
          '    hard: 10',
          `  weekly: *${ANCHOR}`,
          '',
        ].join('\n');
        await put('config/logins/work.yaml', prior.replaceAll('hard: 10', 'hard: 20'));
        await f.put('state/config-accepted.json', {
          'logins/work.yaml': { etag: sha(prior), text: prior },
          ...unrelatedHeldDeletion(),
        });
        if (throws) await mkdir(`${previewTarget()}.conversion-report.json`, { recursive: true });
        const run = prepare({ v4Home: f.from, target: previewTarget(), home: home(), owner, lock, now });
        if (throws) await expect(run).rejects.toThrow();
        else expect((await run).report?.complete).toBe(true);
        const seen = await everything();
        for (const marker of [COMMENT_MARKER, KEY_MARKER, PATH_MARKER, ANCHOR]) expect(seen).not.toContain(marker);
        if (throws) return;
        const dir = join(previewTarget(), 'state/kernel/accepted-config');
        const names = (await readdir(dir)).filter(name => name.includes('usage'));
        expect(names).toHaveLength(1);
        const record = JSON.parse(await readFile(join(dir, names[0] ?? ''), 'utf8')) as { readonly text: string };
        // The record is v4's ACCEPTED cap (10); the file carries the raised one (20), held by the kernel.
        expect(record.text).toContain('hard: 10');
        const usageText = await readFile(join(previewTarget(), 'config/usage.yaml'), 'utf8');
        expect(usageText).toContain('hard: 20');
        expect(usageText).not.toMatch(/[&*]/u);
      });
});
