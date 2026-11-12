/**
 * Codex logins v4 kept in the terminal's own folder (`store: host`) are written `store: ferretry` under the same name
 * with an EMPTY private folder; a Claude `store: host` login and a `store: ferretry` login are not touched. Everything
 * here is a temp folder with FAKE bytes; the user home is a temp folder holding planted `.claude/` and `.codex/` canaries
 * (mode 0). A TRIPWIRE stands in for `node:fs` and `node:fs/promises` while a conversion runs: every call whose
 * path is those folders, or BELOW a v4 login folder that is a link out to it, is recorded and fails. That
 * catches stat, lstat, open, readdir and readlink as well as reads, whether or not the converter swallows the error.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import * as realPromises from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LockProbe } from '../../src/preflight.ts';
import { fixture } from './ferret-fixture.ts';

/** What the tripwire guards and what it caught. Armed only around a conversion, so the test's own setup is not seen. */
const wire = { armed: false, whole: [] as string[], below: [] as string[], hits: [] as string[] };

function guarded(name: string, call: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => {
    if (wire.armed)
      for (const arg of name.startsWith('symlink') ? args.slice(1) : args) {
        const text =
          arg instanceof URL ? fileURLToPath(arg) : typeof arg === 'string' || Buffer.isBuffer(arg) ? String(arg) : '';
        if (text === '') continue;
        const path = resolve(text);
        const hit =
          wire.whole.some(base => path === base || path.startsWith(base + sep)) ||
          wire.below.some(base => path.startsWith(base + sep));
        if (hit) {
          wire.hits.push(name);
          throw new Error(`TRIPWIRE: ${name} reached the planted terminal folder`);
        }
      }
    return call(...args);
  };
}

function tripwire(real: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real))
    out[name] = typeof value === 'function' && /^[a-z]/u.test(name) ? guarded(name, value as never) : value;
  return { ...out, default: out };
}
mock.module('node:fs/promises', () => tripwire({ ...realPromises }));
mock.module('node:fs', () => tripwire({ ...realFs }));

const { convert } = await import('../../src/convert.ts');
const { loginsStep, V5_CREDENTIALS } = await import('../../src/steps/logins.ts');
const { settingsStep } = await import('../../src/steps/settings.ts');
const { usageStep } = await import('../../src/steps/usage.ts');

let f: Awaited<ReturnType<typeof fixture>>;
let userHome = '';
beforeEach(async () => {
  f = await fixture();
  userHome = await mkdtemp(join(tmpdir(), 'fy-userhome-'));
});
afterEach(async () => {
  wire.armed = false;
  // A mode-0 canary must not stop the temp folders from being removed.
  for (const path of ['.claude', '.codex', '.claude/.credentials.json', '.codex/auth.json'])
    await chmod(join(userHome, path), 0o700).catch(() => undefined);
  await rm(userHome, { recursive: true, force: true });
  await f.clean();
});

const FAKE_CANARY = 'FAKE-CANARY-NOT-A-TOKEN';
const FAKE_V4_CLAUDE = 'FAKE-V4-OWNED-CLAUDE-SIGN-IN';

async function yaml(path: string, text: string) {
  const target = join(f.from, 'config', path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
}

/** A Claude host login, a Codex host login (with a v4 folder that links OUT to the planted `.codex`), an owned login. */
async function plant() {
  await yaml('logins/claude-you.yaml', '# my terminal\nharness: claude\nstore: host\n');
  await yaml('logins/codex-you.yaml', '# my codex terminal\nharness: codex\nstore: host\nlabel: Mine\n');
  await yaml('logins/work.yaml', 'harness: claude\nstore: ferretry\n');
  const credentials = join(f.from, 'fleet/credentials');
  await mkdir(join(credentials, 'work'), { recursive: true, mode: 0o700 });
  await writeFile(join(credentials, 'work/.credentials.json'), FAKE_V4_CLAUDE, { mode: 0o600 });
  // v4 held only usage.json for a host login; here the Codex one is even a link out to the user's own folder.
  await symlink(join(userHome, '.codex'), join(credentials, 'codex-you'));
  await mkdir(join(credentials, 'claude-you'), { recursive: true, mode: 0o700 });
  await writeFile(join(credentials, 'claude-you/usage.json'), '{"version":1}');
  // The canaries: the user's own sign-in folders, made unreadable and unlistable.
  await mkdir(join(userHome, '.claude'), { mode: 0o700 });
  await mkdir(join(userHome, '.codex'), { mode: 0o700 });
  await writeFile(join(userHome, '.claude/.credentials.json'), FAKE_CANARY, { mode: 0o600 });
  await writeFile(join(userHome, '.codex/auth.json'), FAKE_CANARY, { mode: 0o600 });
  for (const path of ['.claude/.credentials.json', '.codex/auth.json', '.claude', '.codex'])
    await chmod(join(userHome, path), 0o000);
}

/** Arms the tripwire on the planted terminal folders (by both spellings of the home) and on everything below each v4 login link. */
async function arm() {
  const homes = [userHome, await realpath(userHome)];
  // The terminals' own sign-in folders and account file; the rest of the home (service definitions) is read by design.
  wire.whole = homes.flatMap(home => ['.claude', '.codex', '.claude.json'].map(name => join(home, name)));
  wire.below = [join(f.from, 'fleet/credentials/codex-you'), join(f.from, 'fleet/credentials/claude-link')];
  wire.hits = [];
  wire.armed = true;
}

const ctx = () => ({ ...f.ctx(), host: { homeDirectory: userHome, env: {} } });

test('a Codex store: host login is written store: ferretry under the same name; Claude host and owned logins are unchanged', async () => {
  await plant();
  await arm();
  const settings = await settingsStep.run(ctx());
  expect(settings.status).toBe('converted');
  const text = (name: string) => readFile(join(f.to, 'config/logins', `${name}.yaml`), 'utf8');

  const codex = await text('codex-you');
  expect(codex).toContain('store: ferretry');
  expect(codex).not.toContain('store: host');
  expect(codex).toContain('harness: codex');
  expect(codex).toContain('label: Mine');
  expect(codex).toContain('# my codex terminal');
  const claude = await text('claude-you');
  expect(claude).toContain('store: host');
  expect(claude).toContain('# my terminal');
  expect(await text('work')).toContain('store: ferretry');

  const logins = await loginsStep.run(ctx());
  expect(logins.status).toBe('converted');
  // Same name; an empty, private, real folder: nothing copied, linked or read.
  const folder = join(f.to, V5_CREDENTIALS, 'codex-you');
  expect((await lstat(folder)).isDirectory()).toBe(true);
  expect((await stat(folder)).mode & 0o777).toBe(0o700);
  expect(await readdir(folder)).toEqual([]);
  // The Claude host login is as it was: v4's folder (only usage.json, left for Usage) moves as an empty one, with no sign-in;
  // the owned login moves whole.
  expect((await readdir(join(f.to, V5_CREDENTIALS))).sort()).toEqual(['claude-you', 'codex-you', 'work']);
  expect(await readdir(join(f.to, V5_CREDENTIALS, 'claude-you'))).toEqual([]);
  expect(await readFile(join(f.to, V5_CREDENTIALS, 'work/.credentials.json'), 'utf8')).toBe(FAKE_V4_CLAUDE);

  expect(logins.note).toContain(
    "codex-you: moved to Ferretry's own sign-in; needs one sign-in: fy login signin codex-you",
  );
  expect(logins.note).not.toContain('claude-you');
  expect(logins.kept).toContainEqual({
    what: 'Codex store: host logins moved to Ferretry’s own sign-in (empty folder; sign in once)',
    count: 1,
  });
  expect(JSON.stringify([settings, logins])).not.toContain(FAKE_CANARY);
  // Nothing reached the planted folders: not read, listed, statted, opened or followed (the tripwire saw no call).
  expect(wire.hits).toEqual([]);
});

const notHeld: LockProbe = { held: async () => false };

test('the WHOLE conversion never reaches the terminal folders through a login folder that is a link, Usage included', async () => {
  await plant();
  // Usage reads fleet/credentials/<login>/usage.json: v4's Codex host folder is a link out, and so is a second login's.
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await mkdir(join(f.from, 'state/sessions'), { recursive: true });
  await symlink(join(userHome, '.claude'), join(f.from, 'fleet/credentials/claude-link'));
  await arm();
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: notHeld,
    now: () => new Date('2026-11-07T01:00:00.000Z'),
    host: { homeDirectory: userHome, env: {} },
  });
  expect(result.kind).toBe('done');
  expect(wire.hits).toEqual([]);
  if (result.kind !== 'done') return;
  const step = (id: string) => result.report.steps.find(s => s.id === id);
  expect(step('usage')?.status).toBe('converted');
  expect(step('usage')?.note).toContain('login folder(s) not carried: the login folder is a link');
  expect(step('logins')?.status).toBe('converted');
});

test('a link in fleet itself is refused by Logins and skipped by Usage, never resolved', async () => {
  await mkdir(join(f.root, 'elsewhere/credentials/one'), { recursive: true });
  await symlink(join(f.root, 'elsewhere'), join(f.from, 'fleet'));
  const logins = await loginsStep.run(ctx());
  expect(logins.status).toBe('failed');
  expect(logins.note).toContain('fleet: is not a folder');
  const usage = await usageStep.run(ctx());
  expect(usage.status).toBe('converted');
  expect(usage.note).toBeUndefined();
});

test('a dry run writes no folder and no config but still names the login', async () => {
  await plant();
  const dry = { ...ctx(), dryRun: true, v5: f.ctx(true).v5 };
  const report = await loginsStep.run(dry);
  expect(report.status).toBe('converted');
  expect(report.note).toContain('fy login signin codex-you');
  expect(await readdir(f.root)).toEqual(['v4']);
});

test('a Codex host login whose name v5 cannot use fails by file name, and a v4 home with no host login is unchanged', async () => {
  await yaml('logins/Codex-Mixed.yaml', 'harness: codex\nstore: host\n');
  const failed = await loginsStep.run(ctx());
  expect(failed.status).toBe('failed');
  expect(failed.note).toContain('config/logins/Codex-Mixed.yaml');

  await rm(join(f.from, 'config'), { recursive: true });
  await yaml('logins/plain.yaml', 'harness: codex\nstore: ferretry\n');
  const plain = await loginsStep.run(ctx());
  expect(plain.status).toBe('converted');
  expect(plain.note).toBeUndefined();
  expect(plain.kept.some(item => item.what.includes('Codex store: host'))).toBe(false);
});
