/**
 * A preview login keeps the spend cap v4 enforced, and still leaks nothing.
 *
 * The shell is BUILT from an allowlist; the `budget` is REBUILT through v5's own budget schema into a fresh object
 * (numbers and known keys only) and handed on for `config/usage.yaml`, the only place 5.0 enforces a cap: the shell
 * itself holds none (fix4; `preview-logins-usage.test.ts` runs the real Usage start gate over it). A budget that does not
 * parse holds the login by name (never written budgetless). Preview logins are in the accepted record, with the snapshot
 * taken from the BUILT SHELL, never from a plain conversion of the v4 document, so a held deletion of an unrelated file
 * cannot drop the cap (the review of fix2, finding 1): the cap is usage.yaml's snapshot now.
 *
 * The kernel checks boot the prepared home through the REAL `createConfigFiles` over the real logins config definition,
 * as the review did. Every marker is synthetic; no real credential is read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { LOGINS_CONFIG } from '@ferretry/plugin-logins/contract';
import { USAGE_CONFIG } from '@ferretry/plugin-usage/contract';
import { createConfigFiles } from '../../../../packages/core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../packages/core/kernel/host/state/host-fs.ts';
import { heldSection, prepare } from '../../preview/driver.ts';
import { LoginKeyHold } from '../../src/steps/login-keys.ts';
import { LOGIN_BUDGET_HELD_SENTENCE } from '../../src/steps/preview-hold.ts';
import { buildShell, rebuildBudget } from '../../src/steps/preview-logins.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const COMMENT_MARKER = 'sk-ant-FAKE-BUDGET-COMMENT-0000000000';
const KEY_MARKER = 'sk-ant-FAKE-BUDGET-LITERAL-KEY-0000000000';
const PATH_MARKER = '/tmp/budget-fixture-google-credentials.json';
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

const home = () => join(f.root, 'home');
const target = () => join(home(), '.ferretry-v5');
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};
const run = (owner = false) =>
  prepare({
    v4Home: f.from,
    target: target(),
    home: home(),
    owner,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
  });

/** Every file's text under every `<HOME>/.ferretry-v5*` path, recursive. */
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

/** The logins definition is a folder of files; narrowing it here keeps the kernel's own typing. */
const LOGINS_FOLDER = LOGINS_CONFIG.shape === 'collection' ? LOGINS_CONFIG : undefined;

/** The prepared home booted through the real kernel config service, with the owner confirming nothing. */
async function boot() {
  const files = createConfigFiles({
    home: target(),
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
  if (LOGINS_FOLDER === undefined) throw new Error('the logins definition is not a collection');
  return {
    files,
    work: () => files.port('logins').collection(LOGINS_FOLDER).get('work'),
    usageFile: () => files.port('usage').file(USAGE_CONFIG),
  };
}

describe('buildShell: the budget is rebuilt, never copied', () => {
  const build = (text: string) => buildShell(parseDocument(text), 'work', true, new LoginKeyHold());

  test('daily and weekly limits come across as a fresh object of numbers', () => {
    const shell = build(
      [
        'harness: claude',
        'store: host',
        'budget: # a comment',
        `  daily: # ${COMMENT_MARKER}`,
        '    trigger: 5',
        '    hard: 10',
        '  weekly:',
        '    hard: 40.5',
        '',
      ].join('\n'),
    );
    expect(shell.kind).toBe('carried');
    if (shell.kind !== 'carried') return;
    // The shell holds no budget; the rebuilt numbers go to usage.yaml.
    expect(shell.document.toJS()).toEqual({ harness: 'claude-code', store: 'ferretry' });
    expect(shell.budget).toEqual({ daily: { trigger: 5, hard: 10 }, weekly: { hard: 40.5 } });
    expect(shell.removed).not.toContain('budget');
    expect(String(shell.document)).not.toContain(COMMENT_MARKER);
    expect(String(shell.document)).not.toContain('comment');
  });

  test('an alias or anchor in a budget survives as numbers only', () => {
    const shell = build('harness: claude\nbudget:\n  daily: &limit\n    hard: 10\n  weekly: *limit\n');
    expect(shell.kind).toBe('carried');
    if (shell.kind !== 'carried') return;
    expect(shell.budget).toEqual({ daily: { hard: 10 }, weekly: { hard: 10 } });
    expect(JSON.stringify(shell.budget)).not.toContain('limit');
    expect(String(shell.document)).not.toContain('&');
    expect(String(shell.document)).not.toContain('*limit');
  });

  for (const [why, budget] of [
    ['an unknown key', 'budget:\n  daily:\n    hard: 10\n  monthly:\n    hard: 90\n'],
    ['an unknown key inside a period', 'budget:\n  daily:\n    hard: 10\n    note: x\n'],
    ['a string for a number', 'budget:\n  daily:\n    hard: ten\n'],
    ['a credential-shaped string for a number', `budget:\n  daily:\n    hard: ${COMMENT_MARKER}\n`],
    ['a hard limit below the trigger', 'budget:\n  daily:\n    trigger: 10\n    hard: 5\n'],
    ['a zero limit', 'budget:\n  daily:\n    hard: 0\n'],
    ['an empty budget', 'budget: {}\n'],
    ['a null budget', 'budget:\n'],
    ['a scalar budget', 'budget: 10\n'],
    ['an empty period', 'budget:\n  daily: {}\n'],
  ] as const)
    test(`${why}: the login is held by name, never carried budgetless`, () => {
      expect(build(`harness: claude\nstore: host\n${budget}`)).toEqual({ kind: 'held', harness: 'budget' });
    });

  test('rebuildBudget: absent is no budget, and the result shares nothing with the input', () => {
    expect(rebuildBudget(undefined, false)).toBeUndefined();
    const input = { daily: { hard: 10 } };
    const built = rebuildBudget(input, true);
    expect(built).toEqual({ daily: { hard: 10 } });
    expect(built).not.toBe(input);
    expect(rebuildBudget('x', true)).toBe('invalid');
  });
});

describe('a prepared preview keeps the cap (the real kernel boots it)', () => {
  const unrelatedHeldDeletion = async () => {
    const limits = 'enabled: true\nperFerret:\n  memoryMax: 4G\n';
    return { 'limits.yaml': { etag: sha(limits), text: limits } };
  };
  /** A v4 login with a cap, its own accepted text, and optionally an accepted `limits.yaml` that is now gone. */
  const arrange = async (store: 'host' | 'environment', heldDeletion: boolean) => {
    const text =
      store === 'host'
        ? `# ${COMMENT_MARKER}\nharness: claude\nstore: host\nbudget:\n  daily:\n    hard: 10\n`
        : `# ${COMMENT_MARKER}\nharness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: ${KEY_MARKER}\n  GOOGLE_APPLICATION_CREDENTIALS: ${PATH_MARKER}\nbudget:\n  daily:\n    hard: 10\n`;
    await put('layout-version', '2\n');
    await put('config/logins/work.yaml', text);
    await f.put('state/config-accepted.json', {
      'logins/work.yaml': { etag: sha(text), text },
      ...(heldDeletion ? await unrelatedHeldDeletion() : {}),
    });
  };

  for (const store of ['host', 'environment'] as const)
    for (const heldDeletion of [false, true])
      for (const owner of [false, true])
        test(`store ${store}, ${heldDeletion ? 'with' : 'without'} an unrelated held deletion, ${owner ? 'owner' : 'non-owner'}: same cap, and a label apply keeps it`, async () => {
          await arrange(store, heldDeletion);
          expect((await run(owner)).report?.complete).toBe(true);
          const { files, work, usageFile } = await boot();
          // The cap is usage.yaml's; the shell has none.
          expect(work()).not.toHaveProperty('budget');
          expect(usageFile()).toMatchObject({ budgets: { work: { daily: { hard: 10 } } } });
          // Not pending: the shell is the version in effect.
          const applied = await files.write('logins', LOGINS_CONFIG, 'work', { patch: { label: 'Work review' } });
          expect(applied.kind).toBe('applied');
          expect(work()).toMatchObject({ label: 'Work review' });
          expect(usageFile()).toMatchObject({ budgets: { work: { daily: { hard: 10 } } } });
          expect(await readFile(join(target(), 'config/usage.yaml'), 'utf8')).toContain('hard: 10');
          expect(await readFile(join(target(), 'config/logins/work.yaml'), 'utf8')).not.toContain('budget');
        });

  test('a usage.yaml that drops the accepted cap is held by the kernel (the record carries it)', async () => {
    await arrange('host', true);
    expect((await run()).report?.complete).toBe(true);
    const { files, usageFile } = await boot();
    const removed = await files.write('usage', USAGE_CONFIG, undefined, { patch: { budgets: null } } as never);
    expect(removed.kind).not.toBe('applied');
    expect(usageFile()).toMatchObject({ budgets: { work: { daily: { hard: 10 } } } });
  });
});

describe('the accepted record of a login is the built shell', () => {
  for (const owner of [false, true])
    test(`no comment, key, path or token marker reaches any preview path, snapshot included (owner=${owner})`, async () => {
      await put('layout-version', '2\n');
      const prior = `# ${COMMENT_MARKER}\nharness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: ${KEY_MARKER}\n  GOOGLE_APPLICATION_CREDENTIALS: ${PATH_MARKER}\nbudget: # ${COMMENT_MARKER}\n  daily:\n    hard: 10\n`;
      await put('config/logins/work.yaml', prior);
      const limits = 'enabled: true\nperFerret:\n  memoryMax: 4G\n';
      await f.put('state/config-accepted.json', {
        'logins/work.yaml': { etag: sha(prior), text: prior },
        'limits.yaml': { etag: sha(limits), text: limits },
      });
      expect((await run(owner)).report?.complete).toBe(true);
      const seen = await everything();
      for (const marker of [COMMENT_MARKER, KEY_MARKER, PATH_MARKER]) expect(seen).not.toContain(marker);
      const dir = join(target(), 'state/kernel/accepted-config');
      const snapshot = (await readdir(dir)).filter(name => name.includes('logins'));
      expect(snapshot).toHaveLength(1);
      const body = JSON.parse(await readFile(join(dir, snapshot[0] ?? ''), 'utf8')) as { readonly text: string };
      // The snapshot has the references, no budget, and is exactly the shell on disk.
      expect(body.text).toBe(await readFile(join(target(), 'config/logins/work.yaml'), 'utf8'));
      expect(body.text).not.toContain('budget');
      expect(body.text).toContain('${secret:LOGIN_WORK_ANTHROPIC_API_KEY}');
      expect(body.text).not.toContain('store: host');
      // The cap's snapshot is usage.yaml's: the accepted record carries the numbers next to the credential-shaped comment.
      const usageName = (await readdir(dir)).filter(name => name.includes('usage'));
      expect(usageName).toHaveLength(1);
      const usageBody = JSON.parse(await readFile(join(dir, usageName[0] ?? ''), 'utf8')) as { readonly text: string };
      expect(usageBody.text).toBe(await readFile(join(target(), 'config/usage.yaml'), 'utf8'));
      expect(usageBody.text).toContain('hard: 10');
    });

  test('a login whose budget cannot be rebuilt is held by name, with its runtime, and has no snapshot', async () => {
    await put('layout-version', '2\n');
    await put('config/profiles/main.yaml', 'contents: []\n');
    const prior = `harness: claude\nstore: host\nbudget:\n  daily:\n    hard: ten\n`;
    await put('config/logins/work.yaml', prior);
    await put('config/runtimes/main.yaml', 'credential: work\nprofile: main\n');
    const limits = 'enabled: true\nperFerret:\n  memoryMax: 4G\n';
    await f.put('state/config-accepted.json', {
      'logins/work.yaml': { etag: sha(prior), text: prior },
      'limits.yaml': { etag: sha(limits), text: limits },
    });
    const done = await run();
    expect(done.report?.complete).toBe(true);
    const held = heldSection(done.report as never);
    expect(held).toContain('login work (its budget cannot be carried)');
    expect(held).toContain(LOGIN_BUDGET_HELD_SENTENCE);
    expect(held).toContain('runtime main');
    const { work } = await boot();
    expect(work()).toBeUndefined();
    const dir = join(target(), 'state/kernel/accepted-config');
    expect((await readdir(dir).catch(() => [] as string[])).filter(name => name.includes('logins'))).toEqual([]);
    expect(await everything()).not.toContain('hard: ten');
  });
});
