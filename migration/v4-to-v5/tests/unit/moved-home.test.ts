/**
 * A MOVED or COPIED v4 home converts (the prompt's own flow: `mv H B`, then `--from B --to H`). v4 wrote absolute paths
 * of its own home INTO that home; they are re-based onto `--from` by their v4-home-relative tail (identity by id), and
 * the old absolute path is never touched. Temp folders and fake bytes only.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, cp, lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convert } from '../../src/convert.ts';
import type { LockProbe } from '../../src/preflight.ts';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { harnessHomesStep } from '../../src/steps/harness-homes.ts';
import { V5_WARDEN_REPORTS, V5_WARDEN_STATE, wardenStep } from '../../src/steps/warden.ts';
import { v4Paths } from '../../src/v4/layout.ts';
import { v5Writer } from '../../src/v5/write.ts';
import { rebaseV4Path } from '../../src/v4/rebase.ts';
import { agentHomesRoot } from '../../src/v5/harness-paths.ts';
import { fixture } from './ferret-fixture.ts';

const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const RUNTIME_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_RUNTIME = '44444444-4444-4444-8444-444444444444';
const notHeld: LockProbe = { held: async () => false };

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => f.clean());

/** A v4-shaped home at `f.from` (the ORIGINAL place P) whose own records name P by absolute path. */
async function buildAt(): Promise<void> {
  const home = f.from;
  await writeFile(join(home, 'layout-version'), '2\n', { mode: 0o600 });
  await f.put('fleet/manifest.json', {
    version: 1,
    // The runtime's own account entry names the same home by absolute path as its published runtime does.
    accounts: [
      { id: ACCOUNT, kind: 'claude', home: join(home, 'fleet/homes', ACCOUNT) },
      { id: RUNTIME_ID, kind: 'codex', home: join(home, 'fleet/homes', RUNTIME_ID) },
    ],
    runtimes: [
      { id: RUNTIME_ID, name: 'codex-work', harness: 'codex' },
      { id: OTHER_RUNTIME, name: 'claude-work', harness: 'claude' },
    ],
  });
  await f.put('fleet/ids.json', {
    version: 1,
    // One runtime names its home by absolute path, the other by default (its id).
    runtimes: {
      'codex-work': { id: RUNTIME_ID, formerNames: [] },
      'claude-work': { id: OTHER_RUNTIME, formerNames: [], home: join(home, 'fleet/homes', OTHER_RUNTIME) },
    },
  });
  await f.put(`fleet/homes/${ACCOUNT}/user-state`, 'FAKE-ACCOUNT-STATE');
  await f.put(`fleet/homes/${RUNTIME_ID}/user-state`, 'FAKE-RUNTIME-STATE');
  await f.put(`fleet/homes/${OTHER_RUNTIME}/user-state`, 'FAKE-OTHER-STATE');
  await f.put('fleet/shared/codex/sessions/rollout.jsonl', 'FAKE-ROLLOUT');
  await f.session('f1', {
    harness: 'codex',
    agent: 'codex-work',
    command: [join(home, 'fleet/bin/codex-work'), '--session-id', 'resume-fake'],
    conversion: {
      v: 1,
      converter: 1,
      fromHarness: 'codex',
      fromConversation: 'thread-fake',
      fromFile: join(home, 'fleet/shared/codex/sessions/rollout.jsonl'),
      toHarness: 'codex',
      toConversation: 'resume-fake',
      at: '2026-11-01T00:00:00.000Z',
      keptTurns: 1,
      omittedTurns: 0,
    },
    transcript: {
      v: 1,
      identity: 'minted',
      home: join(home, 'fleet/homes', RUNTIME_ID),
      file: join(home, 'fleet/shared/codex/sessions/rollout.jsonl'),
      harnessSessionId: 'resume-fake',
    },
  });
}

const run = (from: string, to: string) =>
  convert({
    from,
    to,
    dryRun: false,
    lock: notHeld,
    now: () => new Date(),
    steps: [ferretsStep, harnessHomesStep],
  });

/** What a converted home must show for the moved home: every home carried, the ferret's pointers into the NEW home. */
async function expectCarried(to: string, from: string, original: string): Promise<void> {
  const result = await run(from, to);
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.steps.map(step => `${step.id}:${step.status}`)).toEqual([
    'ferrets:converted',
    'harness-homes:converted',
  ]);
  const homes = result.report.steps[1]?.kept ?? [];
  expect(homes.find(item => item.what === 'runtime homes copied')?.count).toBe(3);
  expect(homes.find(item => item.what.startsWith('homes omitted'))?.count).toBe(0);
  const root = (harness: 'claude' | 'codex') => join(result.report.to, agentHomesRoot(harness));
  expect(await readFile(join(root('claude'), ACCOUNT, 'user-state'), 'utf8')).toContain('FAKE-ACCOUNT-STATE');
  expect(await readFile(join(root('claude'), OTHER_RUNTIME, 'user-state'), 'utf8')).toContain('FAKE-OTHER-STATE');
  expect(await readFile(join(root('codex'), RUNTIME_ID, 'user-state'), 'utf8')).toContain('FAKE-RUNTIME-STATE');
  expect(await readFile(join(root('codex'), '_shared/sessions/rollout.jsonl'), 'utf8')).toContain('FAKE-ROLLOUT');
  const ferret = JSON.parse(await readFile(join(result.report.to, 'state/ferrets/f1/ferret.json'), 'utf8')) as {
    transcript?: { home: string; file?: string };
  };
  expect(ferret.transcript?.home).toBe(join(root('codex'), RUNTIME_ID));
  expect(ferret.transcript?.file).toBe(join(root('codex'), '_shared/sessions/rollout.jsonl'));
  const config = await readFile(join(result.report.to, 'state/ferrets/f1/config.json'), 'utf8');
  expect(config).toContain(join(root('codex'), '_shared/sessions/rollout.jsonl'));
  expect(config).toContain(join(result.report.to, 'fleet/bin/codex-work'));
  // Nothing of the converted home names where the v4 home was, nor where it was read from.
  for (const name of ['state/ferrets/f1/ferret.json', 'state/ferrets/f1/config.json']) {
    const text = await readFile(join(result.report.to, name), 'utf8');
    // (in the prompt's flow the new home IS the old place, so the old spelling is then the right one)
    if (original !== to) expect(text).not.toContain(original);
    expect(text).not.toContain(from);
  }
}

test('a v4 home MOVED from P to Q converts with --from Q --to P: every home carried, pointers re-based', async () => {
  await buildAt();
  const original = f.from;
  const moved = join(f.root, 'moved');
  await rename(original, moved);
  await expectCarried(original, moved, original);
});

test('a COPY at R with the original at P locked (chmod 000): the same result, and nothing was read from P', async () => {
  await buildAt();
  const original = f.from;
  const copy = join(f.root, 'copy');
  await cp(original, copy, { recursive: true, preserveTimestamps: true });
  const target = join(f.root, 'converted');
  await chmod(original, 0o000);
  try {
    await expectCarried(target, copy, original);
  } finally {
    await chmod(original, 0o700);
  }
  // The original is exactly what it was: nothing was written to it, and it was never opened.
  expect((await readdir(original)).sort()).toContain('fleet');
  expect((await lstat(join(original, 'fleet/homes', ACCOUNT, 'user-state'))).isFile()).toBe(true);
});

test('only a path with a v4-home tail is re-based; a path outside the home is kept as written', () => {
  const home = '/new/place';
  expect(rebaseV4Path(home, '/old/.ferretry/fleet/homes/abc')).toBe('/new/place/fleet/homes/abc');
  expect(rebaseV4Path(home, '/old/.ferretry/fleet/shared/codex/sessions/a/b.jsonl')).toBe(
    '/new/place/fleet/shared/codex/sessions/a/b.jsonl',
  );
  expect(rebaseV4Path(home, '/old/.ferretry/fleet/bin/codex-work')).toBe('/new/place/fleet/bin/codex-work');
  expect(rebaseV4Path(home, '/new/place/fleet/homes/abc')).toBe('/new/place/fleet/homes/abc');
  expect(rebaseV4Path(home, '/work/project')).toBe('/work/project');
  expect(rebaseV4Path(home, '/home/user/.claude')).toBe('/home/user/.claude');
  expect(rebaseV4Path(home, '/old/.ferretry/fleet/credentials/x')).toBe('/old/.ferretry/fleet/credentials/x');
  expect(rebaseV4Path(home, 'relative/fleet/homes/abc')).toBe('relative/fleet/homes/abc');
  // `..` cannot walk back out of the tail: the path is resolved first, and this one ends at /etc.
  expect(rebaseV4Path(home, '/old/fleet/homes/../../etc')).toBe('/old/fleet/homes/../../etc');
});

test('a record naming a home that is not under fleet/homes is still not carried', async () => {
  await buildAt();
  await f.put('fleet/manifest.json', {
    version: 1,
    accounts: [{ id: ACCOUNT, kind: 'claude', home: '/somewhere/else/.claude' }],
  });
  const result = await run(f.from, join(f.root, 'out'));
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.steps[1]?.kept.find(item => item.what.startsWith('homes omitted'))?.count).toBeGreaterThan(0);
});

test('a warden record whose reportPath names the OLD home is carried into the new one, not dropped', async () => {
  const original = f.from;
  await f.put('state/warden/state.json', {
    lastSweepAt: '2026-11-01T00:00:00.000Z',
    investigations: [
      {
        id: 'i1',
        scope: 'session',
        origin: 'sweep',
        startedAt: '2026-11-01T00:00:00.000Z',
        reportPath: join(original, 'state/warden/reports/FAKE.md'),
        targetId: 'lead',
      },
    ],
  });
  await f.put('state/warden/reports/FAKE.md', 'FAKE-REPORT');
  const moved = join(f.root, 'moved');
  await rename(original, moved);
  const state = wardenStep.run({
    ...f.ctx(),
    v4: v4Paths(moved),
    v5: v5Writer(join(f.root, 'out'), { dryRun: false }),
  });
  const report = await state;
  expect(report.status).toBe('converted');
  expect(report.note ?? '').not.toContain('outside the reports folder');
  const written = JSON.parse(await readFile(join(f.root, 'out', V5_WARDEN_STATE), 'utf8')) as {
    investigations: { reportPath?: string }[];
  };
  expect(written.investigations[0]?.reportPath).toBe(join(f.root, 'out', V5_WARDEN_REPORTS, 'FAKE.md'));
});
