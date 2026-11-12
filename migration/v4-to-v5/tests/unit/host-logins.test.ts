/**
 * Codex logins v4 kept in the terminal's own folder (`store: host`) are written `store: ferretry` under the same name
 * with an EMPTY private folder; a Claude `store: host` login and a `store: ferretry` login are not touched. Everything
 * here is a temp folder with FAKE bytes; the user home is a temp folder holding planted `.claude/` and `.codex/` canaries
 * (mode 0). An ALIAS-AWARE TRIPWIRE stands in for `node:fs` and `node:fs/promises` while a conversion runs: for every call
 * it resolves the path argument by chasing symlinks with the REAL `readlink` through each component, and a call that
 * RESOLVES (stat, open, readdir, readFile, realpath, exists, …) fails when the resolved path is under the planted folders,
 * whether the path names them directly or goes through a link at any level. Only `lstat`, `readlink` and `rm` of a link ENTRY
 * itself are allowed (the entry is not followed). The call is recorded and fails whether or not the converter swallows
 * the error.
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
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LockProbe } from '../../src/preflight.ts';
import type { Step } from '../../src/steps/index.ts';
import { fixture } from './ferret-fixture.ts';

/** The REAL link readers, taken before the mock so the tripwire's own look is never itself guarded. */
const real = { lstat: realFs.lstatSync, readlink: realFs.readlinkSync };

/** What the tripwire guards and what it caught. Armed only around a conversion, so the test's own setup is not seen. */
const wire = { armed: false, planted: [] as string[], hits: [] as string[] };

/** Calls that act on a link ENTRY itself and never follow it (as `lstat(2)`, `readlink(2)`, `unlink(2)` do). */
const ENTRY_CALLS = new Set(['lstat', 'readlink', 'rm', 'unlink', 'rmdir', 'symlink']);
/** Calls whose SECOND argument is a path too (the first is, for all but `symlink`, whose first is link text). */
const TWO_PATHS = new Set(['rename', 'copyFile', 'cp', 'link']);

const under = (path: string, base: string): boolean => path === base || path.startsWith(base + sep);

/**
 * `path` with every link on the way followed by lexical resolution (real `readlink`, never a `stat`), the last part
 * only when `followLast`. A part that cannot be looked at ends the walk where it is (the rest stays lexical).
 */
function chased(path: string, followLast: boolean): string {
  let current = resolve(path);
  for (let hops = 0; hops < 64; hops++) {
    const parts = current.split(sep).filter(part => part !== '');
    let walked: string = sep;
    let moved = false;
    for (const [index, part] of parts.entries()) {
      const next = join(walked, part);
      if (index === parts.length - 1 && !followLast) return next;
      let target: string | undefined;
      try {
        if (real.lstat(next).isSymbolicLink()) target = String(real.readlink(next));
      } catch {
        return current;
      }
      if (target !== undefined) {
        current = resolve(walked, target, ...parts.slice(index + 1));
        moved = true;
        break;
      }
      walked = next;
    }
    if (!moved) return current;
  }
  return current;
}

function guarded(name: string, call: (...args: unknown[]) => unknown) {
  const base = name.replace(/Sync$/u, '');
  return (...args: unknown[]) => {
    if (wire.armed) {
      const indexes = base === 'symlink' ? [1] : TWO_PATHS.has(base) ? [0, 1] : [0];
      for (const index of indexes) {
        const arg = args[index];
        const text =
          arg instanceof URL ? fileURLToPath(arg) : typeof arg === 'string' || Buffer.isBuffer(arg) ? String(arg) : '';
        if (text === '') continue;
        const resolved = chased(text, !ENTRY_CALLS.has(base));
        if (wire.planted.some(planted => under(resolved, planted))) {
          wire.hits.push(name);
          throw new Error(`TRIPWIRE: ${name} reached the planted terminal folder`);
        }
      }
    }
    return call(...args);
  };
}

function tripwire(source: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source))
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
  for (const path of [
    '.claude',
    '.codex',
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.codex/service-canary.conf',
  ])
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

/** The canaries: the user's own sign-in folders, made unreadable and unlistable (the service canary is FAKE service text). */
async function canaries() {
  await mkdir(join(userHome, '.claude'), { mode: 0o700 });
  await mkdir(join(userHome, '.codex'), { mode: 0o700 });
  await writeFile(join(userHome, '.claude/.credentials.json'), FAKE_CANARY, { mode: 0o600 });
  await writeFile(join(userHome, '.codex/auth.json'), FAKE_CANARY, { mode: 0o600 });
  await writeFile(join(userHome, '.codex/service-canary.conf'), SERVICE_TEXT(9), { mode: 0o600 });
  for (const path of [
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.codex/service-canary.conf',
    '.claude',
    '.codex',
  ])
    await chmod(join(userHome, path), 0o000);
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
  await canaries();
}

/** The tripwire's planted folders: the terminals' own sign-in folders and account file, by both spellings of the home. */
async function arm() {
  const homes = [userHome, await realpath(userHome)];
  wire.planted = homes.flatMap(home => ['.claude', '.codex', '.claude.json'].map(name => join(home, name)));
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

const SERVICE_TEXT = (hours: number): string =>
  `[Service]\nEnvironment="FYD_SESSION_ARCHIVE_AFTER_HOURS=${String(hours)}"\n`;

/** The WHOLE conversion over the fixture, tripwire armed. */
async function whole(steps?: readonly Step[]) {
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await arm();
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: notHeld,
    now: () => new Date('2026-11-07T01:00:00.000Z'),
    host: { homeDirectory: userHome, env: {} },
    ...(steps === undefined ? {} : { steps }),
  });
  wire.armed = false;
  return result;
}

const stepOf = (result: Awaited<ReturnType<typeof whole>>, id: string) =>
  result.kind === 'done' ? result.report.steps.find(s => s.id === id) : undefined;

/** A negative control: a step doing ONE call the converter must never make, swallowing the failure like a careless one. */
const injected = (call: () => Promise<unknown>): Step => ({
  id: 'probe',
  title: 'probe',
  owner: [],
  reads: [],
  sealed: [],
  notCarried: [],
  async run() {
    await call().catch(() => undefined);
    return { id: 'probe', title: 'probe', status: 'converted', kept: [], notCarried: [], sealed: [] };
  },
});

// The guarded fs the converter's own modules see (the test file's own imports above are the unguarded setup).
const guardedFs = await import('node:fs/promises');

test('the WHOLE conversion never reaches the terminal folders through a login folder that is a link, Usage included', async () => {
  await plant();
  // Usage reads fleet/credentials/<login>/usage.json: v4's Codex host folder is a link out, and so is a second login's.
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await mkdir(join(f.from, 'state/sessions'), { recursive: true });
  await symlink(join(userHome, '.claude'), join(f.from, 'fleet/credentials/claude-link'));
  const result = await whole();
  expect(result.kind).toBe('done');
  expect(wire.hits).toEqual([]);
  expect(stepOf(result, 'usage')?.status).toBe('converted');
  expect(stepOf(result, 'usage')?.note).toContain('login folder(s) not carried: the login folder is a link');
  expect(stepOf(result, 'logins')?.status).toBe('converted');
});

test('the WHOLE conversion never resolves into the terminal folders when fleet/credentials is a link', async () => {
  await canaries();
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await mkdir(join(f.from, 'fleet'), { recursive: true });
  await symlink(join(userHome, '.codex'), join(f.from, 'fleet/credentials'));
  const result = await whole();
  expect(result.kind).toBe('done');
  expect(wire.hits).toEqual([]);
});

test('the WHOLE conversion never resolves into the terminal folders when fleet itself is a link, Lessons included', async () => {
  await canaries();
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await symlink(join(userHome, '.codex'), join(f.from, 'fleet'));
  const result = await whole();
  expect(result.kind).toBe('done');
  expect(wire.hits).toEqual([]);
  // Said, with no target named: the lessons document sits under the link and was not carried.
  expect(stepOf(result, 'lessons')?.note).toContain('is not carried: the folder is a link');
  expect(JSON.stringify(result)).not.toContain('.codex');
});

test('a service definition that is a link into a Nix-store-like folder is read; one into the planted .codex is refused', async () => {
  const unit = join(userHome, '.config/systemd/user/fyd.service');
  await mkdir(dirname(unit), { recursive: true });
  // home-manager style: ~/.config/systemd/user/fyd.service -> a store folder outside the home.
  const store = join(f.root, 'nix-like-store/abc123-fyd.service');
  await mkdir(dirname(store), { recursive: true });
  await writeFile(store, SERVICE_TEXT(24));
  await symlink(store, unit);
  await canaries();
  const linked = await whole();
  expect(wire.hits).toEqual([]);
  expect(await readFile(join(f.to, 'config/archive.yaml'), 'utf8')).toContain('afterHours: 24');
  expect(stepOf(linked, 'archive-setting')?.note ?? '').not.toContain('terminal sign-in folder');
});

test('a service definition that is a link into the planted .codex is refused with zero hits, and nothing is carried', async () => {
  const unit = join(userHome, '.config/systemd/user/fyd.service');
  await mkdir(dirname(unit), { recursive: true });
  await canaries();
  // The canary is made readable here, so a converter that DID follow the link would write afterHours: 9.
  await chmod(join(userHome, '.codex'), 0o700);
  await chmod(join(userHome, '.codex/service-canary.conf'), 0o600);
  await symlink(join(userHome, '.codex/service-canary.conf'), unit);
  const result = await whole();
  expect(wire.hits).toEqual([]);
  expect(stepOf(result, 'archive-setting')?.note).toContain(
    'the service file points into a terminal sign-in folder, so it was not read',
  );
  expect(
    await stat(join(f.to, 'config/archive.yaml')).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(JSON.stringify(result)).not.toContain('.codex');
});

test('a service folder or drop-in reached through a link, at any level, into the planted .codex is refused too', async () => {
  await canaries();
  await chmod(join(userHome, '.codex'), 0o700);
  await mkdir(join(userHome, '.codex/systemd/user'), { recursive: true });
  await writeFile(join(userHome, '.codex/systemd/user/fyd.service'), SERVICE_TEXT(9));
  // ~/.config is itself a link into ~/.codex (an ancestor), and the chain has a second hop.
  await symlink(join(userHome, '.codex'), join(userHome, 'hop'));
  await symlink(join(userHome, 'hop'), join(userHome, '.config'));
  const result = await whole();
  expect(wire.hits).toEqual([]);
  expect(stepOf(result, 'archive-setting')?.note).toContain('so it was not read');
  expect(
    await stat(join(f.to, 'config/archive.yaml')).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

// NEGATIVE CONTROLS: each of these is something the converter must NEVER do, injected as a step; the tripwire must fire.

test('NEGATIVE (a): a stat of the login ALIAS entry (it resolves into the planted .codex) is caught', async () => {
  await plant();
  await whole([injected(() => guardedFs.stat(join(f.from, 'fleet/credentials/codex-you')))]);
  expect(wire.hits).toEqual(['stat']);
});

test('NEGATIVE (b): an lstat of the planted .codex itself is caught', async () => {
  await plant();
  await whole([injected(() => guardedFs.lstat(join(userHome, '.codex')))]);
  expect(wire.hits).toEqual(['lstat']);
});

test('NEGATIVE (b2): lstat / readlink of the link ENTRY itself stay allowed', async () => {
  await plant();
  await whole([
    injected(async () => {
      await guardedFs.lstat(join(f.from, 'fleet/credentials/codex-you'));
      await guardedFs.readlink(join(f.from, 'fleet/credentials/codex-you'));
    }),
  ]);
  expect(wire.hits).toEqual([]);
});

test('NEGATIVE (c): the old Lessons lookup (an lstat under fleet/assets) on a fleet that is a link is caught', async () => {
  await canaries();
  await symlink(join(userHome, '.codex'), join(f.from, 'fleet'));
  await whole([injected(() => guardedFs.lstat(join(f.from, 'fleet', 'assets', 'instructions', 'lessons.md')))]);
  expect(wire.hits).toEqual(['lstat']);
});

test('NEGATIVE (d): an unfenced read of a service definition that is a link into .codex is caught', async () => {
  const unit = join(userHome, '.config/systemd/user/fyd.service');
  await mkdir(dirname(unit), { recursive: true });
  await canaries();
  await symlink(join(userHome, '.codex/service-canary.conf'), unit);
  await whole([injected(() => guardedFs.readFile(unit, 'utf8'))]);
  expect(wire.hits).toEqual(['readFile']);
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
