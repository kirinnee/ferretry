/**
 * Codex logins v4 kept in the terminal's own folder (`store: host`) are written `store: ferretry` under the same name
 * with an EMPTY private folder; a Claude `store: host` login and a `store: ferretry` login are not touched. Everything
 * here is a temp folder with FAKE bytes; the user home is a temp folder holding planted `.claude/` and `.codex/` canaries
 * (mode 0). An ALIAS-AWARE TRIPWIRE stands in for `node:fs` and `node:fs/promises` while a conversion runs: for every call
 * it asks the filesystem itself (every prefix `lstat`ed directly, the kernel's `realpath` of the whole path), sharing no code with the converter, and a call that
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
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LockProbe } from '../../src/preflight.ts';
import type { Step } from '../../src/steps/index.ts';
import { fixture } from './ferret-fixture.ts';
import { plantTripwire, provisionerLinks, TRIPWIRE_CANARY } from './v4-links-fixture.ts';

/** The REAL link readers, taken before the mock so the tripwire's own look is never itself guarded. */
const real = { lstat: realFs.lstatSync, readlink: realFs.readlinkSync, realpath: realFs.realpathSync };

/** What the tripwire guards and what it caught. Armed only around a conversion, so the test's own setup is not seen. */
const wire = { armed: false, planted: [] as string[], hits: [] as string[], aliases: [] as string[] };

/** Calls that act on a link ENTRY itself and never follow it (as `lstat(2)`, `readlink(2)`, `unlink(2)` do). */
const ENTRY_CALLS = new Set(['lstat', 'readlink', 'rm', 'unlink', 'rmdir', 'symlink']);
/** Calls whose SECOND argument is a path too (the first is, for all but `symlink`, whose first is link text). */
const TWO_PATHS = new Set(['rename', 'copyFile', 'cp', 'link']);

const under = (path: string, base: string): boolean => path === base || path.startsWith(base + sep);

/**
 * Whether a call on `path` would reach `planted`, decided WITHOUT any code the converter uses and without lexical
 * path arithmetic: the filesystem itself answers. (1) Every prefix of the path (from the root down) is `lstat`ed
 * directly, and a prefix that is a link whose `realpath` is under a planted folder flags the call. (2) A resolving call
 * is also flagged when the kernel's own `realpath` of the whole path (the deepest part that exists, then the rest) is
 * under one, `..` after a link included. An `lstat`/`readlink`/`rm` of the last part (the entry) is not followed.
 */
function reaches(path: string, followLast: boolean): boolean {
  const absolute = path.startsWith(sep) ? path : join(process.cwd(), path);
  const names = absolute.split(sep).filter(name => name !== '' && name !== '.');
  const planted = (candidate: string): boolean => wire.planted.some(base => under(candidate, base));
  const settle = (candidate: string): string => {
    // The kernel resolves; where it cannot (absent, no right to), the deepest part it can is used.
    for (let cut = candidate.split(sep).length; cut > 0; cut--) {
      const head = candidate.split(sep).slice(0, cut).join(sep) || sep;
      try {
        return join(real.realpath(head), ...candidate.split(sep).slice(cut));
      } catch {
        // try the parent
      }
    }
    return candidate;
  };
  if (planted(absolute)) return true;
  for (let index = 1; index <= names.length; index++) {
    const prefix = sep + names.slice(0, index).join(sep);
    if (names.slice(0, index).includes('..')) break;
    if (index === names.length && !followLast) break;
    try {
      if (real.lstat(prefix).isSymbolicLink()) {
        if (planted(settle(prefix))) return true;
        // The kernel could not resolve it (a mode-0 folder in the way): the link's own text, read from its real parent, decides.
        const text = String(real.readlink(prefix));
        if (planted(text.startsWith(sep) ? text : join(settle(dirname(prefix)), text))) return true;
      }
    } catch {
      // cannot be looked at: the whole-path check below still decides
    }
  }
  return planted(followLast ? settle(absolute) : join(settle(dirname(absolute)), names[names.length - 1] ?? ''));
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
        // INDEPENDENT of reaches() too: a path KNOWN to be an alias into the planted folders (set by the test that built the
        // link), compared by its plain spelling, so a path-resolution mistake shared with production cannot hide it.
        const knownAlias = !ENTRY_CALLS.has(base) && wire.aliases.includes(text);
        if (knownAlias || reaches(text, !ENTRY_CALLS.has(base))) {
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
  wire.aliases = [];
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
async function whole(steps?: readonly Step[], marker = true) {
  if (marker) await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
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
    try {
      await call();
    } catch {
      // swallowed, like a careless step
    }
    return { id: 'probe', title: 'probe', status: 'converted', kept: [], notCarried: [], sealed: [] };
  },
});

// The guarded fs the converter's own modules see (the test file's own imports above are the unguarded setup).
const guardedFs = await import('node:fs/promises');

/** A negative control runs its step DIRECTLY, armed (convert() would refuse these fixtures before any step ran). */
async function direct(step: Step) {
  await arm();
  await step.run(ctx());
  wire.armed = false;
}

test('the WHOLE conversion REFUSES a login folder that is a link (any link inside a fenced tree), touching nothing', async () => {
  await plant();
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await mkdir(join(f.from, 'state/sessions'), { recursive: true });
  await symlink(join(userHome, '.claude'), join(f.from, 'fleet/credentials/claude-link'));
  const result = await whole();
  expect(result.kind).toBe('refused');
  const text = result.kind === 'refused' ? result.problems.join('\n') : '';
  expect(text).toContain(`${f.from}/fleet/credentials/codex-you is a link, so the conversion did not start`);
  expect(text).toContain(`${f.from}/fleet/credentials/claude-link is a link`);
  expect(text).toContain('replace it with the real file or folder, then run again');
  expect(text).not.toContain('.codex');
  expect(text).not.toContain('.claude');
  expect(wire.hits).toEqual([]);
});

test('the WHOLE conversion REFUSES a link met deep inside state, config or fleet (outside homes, shared and bin), whatever it points at', async () => {
  for (const deep of [
    'state/board/tasks/one.json',
    'config/components/x/y.yaml',
    'fleet/credentials/login/inner/file',
    'fleet/assets/components/hooks/h.sh',
    'fleet/ids.json',
  ]) {
    await rm(f.to, { recursive: true, force: true });
    await mkdir(join(f.from, deep, '..'), { recursive: true });
    await writeFile(join(f.root, 'harmless.txt'), 'x');
    await symlink(join(f.root, 'harmless.txt'), join(f.from, deep));
    const result = await whole();
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' ? result.problems.join('\n') : '').toContain(`${join(f.from, deep)} is a link`);
    await rm(join(f.from, deep));
  }
});

test('the WHOLE conversion never resolves into the terminal folders when fleet/credentials is a link', async () => {
  await canaries();
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await mkdir(join(f.from, 'fleet'), { recursive: true });
  await symlink(join(userHome, '.codex'), join(f.from, 'fleet/credentials'));
  const result = await whole();
  expect(result.kind).toBe('refused');
  expect(wire.hits).toEqual([]);
});

// THE FENCE, ENFORCED: a fenced v4 folder that is a link (or not a folder) REFUSES the conversion before any step runs.
const FENCED = [
  'config',
  'state',
  'fleet',
  'fleet/credentials',
  'fleet/assets',
  'fleet/homes',
  'fleet/shared',
  'fleet/bin',
];

async function refusedWith(result: Awaited<ReturnType<typeof whole>>, folder: string) {
  expect(result.kind).toBe('refused');
  const text = result.kind === 'refused' ? result.problems.join('\n') : '';
  expect(text).toContain(`${f.from}/${folder} is a link or not a folder`);
  expect(text).toContain('replace it with the real folder, then run again');
  // The target is never named, and nothing was written: no v5 home was even made.
  expect(text).not.toContain('.codex');
  expect(wire.hits).toEqual([]);
  expect(
    await stat(f.to).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
}

for (const folder of FENCED) {
  test(`the WHOLE conversion REFUSES, touching nothing in the planted folders, when ${folder} is a link`, async () => {
    await canaries();
    await mkdir(join(f.from, folder, '..'), { recursive: true });
    await rm(join(f.from, folder), { recursive: true, force: true });
    await symlink(join(userHome, '.codex'), join(f.from, folder));
    await refusedWith(await whole(), folder);
  });
}

test('the WHOLE conversion REFUSES when a fenced folder is a plain file', async () => {
  await rm(join(f.from, 'state'), { recursive: true, force: true });
  await writeFile(join(f.from, 'state'), 'not a folder');
  await refusedWith(await whole(), 'state');
});

// The reviewer's five probes (RED on 773ac42a27): state link, config link, layout-version link, daemon.lock link, dot-dot service link.
test('PROBE layout-version that is a link into the planted .codex is refused before it is read', async () => {
  await canaries();
  await symlink(join(userHome, '.codex/auth.json'), join(f.from, 'layout-version'));
  const result = await whole(undefined, false);
  expect(wire.hits).toEqual([]);
  expect(result.kind).toBe('refused');
  expect(result.kind === 'refused' ? result.problems.join('\n') : '').toContain('layout-version is a link');
});

test('PROBE daemon.lock that is a link into the planted .codex is refused before it is statted', async () => {
  await canaries();
  await symlink(join(userHome, '.codex/auth.json'), join(f.from, 'daemon.lock'));
  const result = await whole();
  expect(wire.hits).toEqual([]);
  expect(result.kind).toBe('refused');
  expect(result.kind === 'refused' ? result.problems.join('\n') : '').toContain('daemon.lock is a link');
});

test('PROBE a service link through ".." after a link into the planted .codex is refused, nothing carried', async () => {
  const unit = join(userHome, '.config/systemd/user/fyd.service');
  await mkdir(dirname(unit), { recursive: true });
  await canaries();
  await chmod(join(userHome, '.codex'), 0o700);
  await mkdir(join(userHome, '.codex/inner'));
  await chmod(join(userHome, '.codex/service-canary.conf'), 0o600);
  // pivot -> .codex/inner ; unit -> <home>/pivot/../service-canary.conf : the filesystem enters .codex/inner first, so
  // ".." lands in .codex. Collapsing ".." lexically would read <home>/service-canary.conf (absent) and miss it.
  await symlink(join(userHome, '.codex/inner'), join(userHome, 'pivot'));
  await symlink(`${userHome}/pivot/../service-canary.conf`, unit);
  wire.aliases = [unit];
  const result = await whole();
  expect(wire.hits).toEqual([]);
  expect(stepOf(result, 'archive-setting')?.note).toContain('the service file points into a terminal sign-in folder');
  expect(
    await stat(join(f.to, 'config/archive.yaml')).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
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
  await direct(injected(() => guardedFs.stat(join(f.from, 'fleet/credentials/codex-you'))));
  expect(wire.hits).toEqual(['stat']);
});

test('NEGATIVE (b): an lstat of the planted .codex itself is caught', async () => {
  await plant();
  await direct(injected(() => guardedFs.lstat(join(userHome, '.codex'))));
  expect(wire.hits).toEqual(['lstat']);
});

test('NEGATIVE (b2): lstat / readlink of the link ENTRY itself stay allowed', async () => {
  await plant();
  await direct(
    injected(async () => {
      await guardedFs.lstat(join(f.from, 'fleet/credentials/codex-you'));
      await guardedFs.readlink(join(f.from, 'fleet/credentials/codex-you'));
    }),
  );
  expect(wire.hits).toEqual([]);
});

test('NEGATIVE (c): the old Lessons lookup (an lstat under fleet/assets) on a fleet that is a link is caught', async () => {
  await canaries();
  await symlink(join(userHome, '.codex'), join(f.from, 'fleet'));
  // convert() now refuses a fleet that is a link before any step runs, so the old lookup is made directly, armed.
  await direct(injected(() => guardedFs.lstat(join(f.from, 'fleet', 'assets', 'instructions', 'lessons.md'))));
  expect(wire.hits).toEqual(['lstat']);
});

test('NEGATIVE (d): an unfenced read of a service definition that is a link into .codex is caught', async () => {
  const unit = join(userHome, '.config/systemd/user/fyd.service');
  await mkdir(dirname(unit), { recursive: true });
  await canaries();
  await symlink(join(userHome, '.codex/service-canary.conf'), unit);
  await direct(injected(() => guardedFs.readFile(unit, 'utf8')));
  expect(wire.hits).toEqual(['readFile']);
});

test('NEGATIVE (e): the oracle itself resolves ".." after a link (component by component), and the independent alias guard agrees', async () => {
  const unit = join(userHome, '.config/systemd/user/fyd.service');
  await mkdir(dirname(unit), { recursive: true });
  await canaries();
  await chmod(join(userHome, '.codex'), 0o700);
  await chmod(join(userHome, '.codex/service-canary.conf'), 0o600);
  await mkdir(join(userHome, '.codex/inner'), { recursive: true });
  await symlink(join(userHome, '.codex/inner'), join(userHome, 'pivot'));
  await symlink(`${userHome}/pivot/../service-canary.conf`, unit);
  // Only reaches() sees it: no known alias listed.
  await direct(injected(() => guardedFs.readFile(unit, 'utf8')));
  expect(wire.hits).toEqual(['readFile']);
  // And the alias guard alone sees it too, on a path the oracle's resolver is not asked about.
  await rm(f.to, { recursive: true, force: true });
  wire.aliases = [join(f.root, 'any-alias')];
  await direct(injected(() => guardedFs.readFile(join(f.root, 'any-alias'), 'utf8')));
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

// ---------------------------------------------------------------------------------------------------------------
// RULES A and C: links v4 writes itself (provisioner links in fleet/homes, shared-history links in fleet/shared, a
// wrapper link in fleet/bin) are LEFT ALONE: lstat only, never followed, never carried, one note per link PATH. The
// oracle is independent of the converter: the tripwire folders are chmod 000 for the run, so any access through a link
// fails with EACCES; the guarded fs (round 3's per-prefix lstat oracle) records it even when swallowed; and the
// tripwire's own files and listings are compared before and after.
// ---------------------------------------------------------------------------------------------------------------

/** Every file path under `folder`, never following a link. */
async function filesUnder(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

test('a REAL v4 shape: provisioner, shared-history and wrapper links are left alone, noted by path, and the tripwire is untouched', async () => {
  const tripwire = await plantTripwire(userHome);
  try {
    const links = await provisionerLinks(f.from, userHome);
    // A ferret whose transcript pointer goes THROUGH the account's link: only its text is rewritten, nothing is opened.
    const account = join(f.from, 'fleet/homes/acct1');
    await f.session('f1', {
      transcript: {
        v: 1,
        home: account,
        harnessSessionId: 'abc',
        identity: 'adopted',
        file: join(account, '.codex/sessions/rollout.jsonl'),
      },
    });
    await tripwire.lock();
    const result = await whole();
    expect(result.kind).toBe('done');
    // Zero hits from the guarded fs (swallowed or not) ...
    expect(wire.hits).toEqual([]);
    // ... one note per link, naming the PATH only (never the target, which is inside the user's home) ...
    const notes = result.kind === 'done' ? (result.report.notes ?? []) : [];
    expect(notes.map(note => note.split(' is a link')[0])).toEqual([...links]);
    expect(notes.every(note => note.includes('left alone, not carried'))).toBe(true);
    expect(notes.join('\n')).not.toContain(userHome);
    expect(JSON.stringify(result)).not.toContain(userHome);
    // ... the harness-homes step walked the account and counted every link in it and in the shared pool, carried none ...
    const homes = stepOf(result, 'harness-homes');
    expect(homes?.status).toBe('converted');
    expect(homes?.kept).toContainEqual({ what: 'links omitted (no v5 policy)', count: 7 });
    expect(homes?.kept).toContainEqual({ what: 'runtime homes copied', count: 1 });
    expect((await filesUnder(f.to)).some(path => path.endsWith('projects/own.jsonl'))).toBe(true);
    for (const path of await filesUnder(f.to)) expect((await readFile(path)).includes(TRIPWIRE_CANARY)).toBe(false);
    // ... and the v4 links are as they were.
    for (const link of links) expect((await lstat(link)).isSymbolicLink()).toBe(true);
  } finally {
    wire.armed = false;
    await tripwire.restore();
  }
  // The oracle, independent of any converter code: no byte of the tripwire was read, listed or changed.
  expect(await tripwire.snapshot()).toBe(tripwire.before);
  await tripwire.restore();
});

test('the same shape is converted in a DRY run too, with the notes and no hit', async () => {
  const tripwire = await plantTripwire(userHome);
  try {
    await provisionerLinks(f.from, userHome);
    await tripwire.lock();
    await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
    await arm();
    const result = await convert({
      from: f.from,
      to: f.to,
      dryRun: true,
      lock: notHeld,
      now: () => new Date('2026-11-07T01:00:00.000Z'),
      host: { homeDirectory: userHome, env: {} },
    });
    wire.armed = false;
    expect(result.kind).toBe('done');
    expect(wire.hits).toEqual([]);
    expect(result.kind === 'done' ? result.report.notes?.length : 0).toBe(8);
  } finally {
    wire.armed = false;
    await tripwire.restore();
  }
});

test('the real-shape fixture is still REFUSED when a B-tree link sits beside the left-alone ones', async () => {
  const tripwire = await plantTripwire(userHome);
  try {
    await provisionerLinks(f.from, userHome);
    await mkdir(join(f.from, 'fleet/assets'), { recursive: true });
    await symlink(join(userHome, '.codex/auth.json'), join(f.from, 'fleet/assets/hook.sh'));
    await tripwire.lock();
    const result = await whole();
    expect(result.kind).toBe('refused');
    const text = result.kind === 'refused' ? result.problems.join('\n') : '';
    expect(text).toContain(`${f.from}/fleet/assets/hook.sh is a link, so the conversion did not start`);
    // Only the B link is a problem; the left-alone ones are not named as problems.
    expect(text).not.toContain('fleet/homes');
    expect(text).not.toContain(userHome);
    expect(wire.hits).toEqual([]);
  } finally {
    wire.armed = false;
    await tripwire.restore();
  }
});

test('ORACLE (RED control): a reader that FOLLOWS a provisioner link trips the guarded fs AND the chmod 000 itself', async () => {
  const tripwire = await plantTripwire(userHome);
  try {
    await provisionerLinks(f.from, userHome);
    await tripwire.lock();
    const alias = join(f.from, 'fleet/homes/acct1/.codex');
    // The probe swallows the error, like a careless reader; the oracle still saw the attempt ...
    await direct(injected(() => guardedFs.readdir(alias)));
    expect(wire.hits).toEqual(['readdir']);
    // ... and, with no guard at all, the kernel itself refuses: the folder behind the link is mode 000.
    await expect(readdir(alias)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(stat(join(f.from, 'fleet/shared/claude/projects'))).rejects.toMatchObject({ code: 'EACCES' });
    // lstat of the link ENTRY is what the converter may do, and it works.
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  } finally {
    wire.armed = false;
    await tripwire.restore();
  }
});

test('ORACLE (RED control): a stat or readFile through a shared-history link or the wrapper link is caught', async () => {
  const tripwire = await plantTripwire(userHome);
  try {
    await provisionerLinks(f.from, userHome);
    await tripwire.lock();
    // `direct` re-arms (and so clears the hits) each time: one look per call.
    const looks = [
      ['stat', 'fleet/shared/codex/history.jsonl'],
      ['readFile', 'fleet/bin/codex-wrapper/auth.json'],
      ['readFile', 'fleet/homes/acct1/.claude.json'],
    ] as const;
    for (const [name, path] of looks) {
      await direct(injected(() => guardedFs[name](join(f.from, path))));
      expect(wire.hits).toEqual([name]);
    }
  } finally {
    wire.armed = false;
    await tripwire.restore();
  }
});

test('a link inside fleet/homes, shared or bin does not hide a fenced folder that is itself a link', async () => {
  const tripwire = await plantTripwire(userHome);
  try {
    await provisionerLinks(f.from, userHome);
    await rm(join(f.from, 'fleet/bin'), { recursive: true, force: true });
    await symlink(join(userHome, '.codex'), join(f.from, 'fleet/bin'));
    await tripwire.lock();
    await refusedWith(await whole(), 'fleet/bin');
  } finally {
    wire.armed = false;
    await tripwire.restore();
  }
});

// Rule A at the source home's own entry, and the real v4 link shapes (reviewer probes, now regression tests).
test('RULE A: a source home that is itself a link refuses with the plain sentence, before any stat, read or realpath of it', async () => {
  await canaries();
  const alias = join(f.root, 'source-alias');
  await symlink(join(userHome, '.codex'), alias);
  await arm();
  const result = await convert({
    from: alias,
    to: f.to,
    dryRun: false,
    lock: notHeld,
    now: () => new Date(),
    steps: [],
    host: { homeDirectory: userHome, env: {} },
  });
  wire.armed = false;
  expect(wire.hits).toEqual([]);
  expect(result.kind).toBe('refused');
  const text = result.kind === 'refused' ? result.problems.join('\n') : '';
  expect(text).toContain(`${alias} is a link: replace it with the real folder, then run again`);
  expect(text).not.toContain(userHome);
  expect(await lstat(f.to).catch(() => undefined)).toBeUndefined();
});

test('RULE A: a source home spelled THROUGH an ancestor link (macOS /var, /tmp) still converts', async () => {
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  const ancestor = join(f.root, 'ancestor-alias');
  await symlink(f.root, ancestor);
  const from = join(ancestor, 'v4');
  const result = await convert({ from, to: f.to, dryRun: false, lock: notHeld, now: () => new Date(), steps: [] });
  expect(result.kind).toBe('done');
  if (result.kind === 'done') expect(result.report.complete).toBe(true);
});

test('actual v4 auth.json placement and relative and absolute C-tree loops stay untouched', async () => {
  const tripwire = await plantTripwire(userHome);
  try {
    const links = [...(await provisionerLinks(f.from, userHome))];
    const auth = join(f.from, 'fleet/homes/acct1/auth.json');
    await symlink(join(userHome, '.codex/auth.json'), auth);
    links.push(auth);
    const relativeLoop = join(f.from, 'fleet/homes/acct1/relative-loop');
    const absoluteLoop = join(f.from, 'fleet/bin/absolute-loop');
    await symlink('relative-loop', relativeLoop);
    await symlink(absoluteLoop, absoluteLoop);
    links.push(relativeLoop, absoluteLoop);
    const result = await whole();
    expect(wire.hits).toEqual([]);
    expect(result.kind).toBe('done');
    if (result.kind === 'done') {
      expect(result.report.complete).toBe(true);
      expect(result.report.notes?.map(note => note.split(' is a link')[0])).toEqual(links.sort());
      expect(JSON.stringify(result)).not.toContain(userHome);
    }
  } finally {
    wire.armed = false;
    await tripwire.restore();
  }
});

test('deep required-reader directory with a relative link to a fake terminal folder refuses before writes', async () => {
  await canaries();
  const folder = join(f.from, 'config/deep');
  await mkdir(folder, { recursive: true });
  const { relative } = await import('node:path');
  const link = join(folder, 'reader');
  await symlink(relative(folder, join(userHome, '.codex')), link);
  const result = await whole();
  expect(result.kind).toBe('refused');
  expect(wire.hits).toEqual([]);
  expect(result.kind === 'refused' ? result.problems.join('\n') : '').toContain(link + ' is a link');
  expect(await lstat(f.to).catch(() => undefined)).toBeUndefined();
});
