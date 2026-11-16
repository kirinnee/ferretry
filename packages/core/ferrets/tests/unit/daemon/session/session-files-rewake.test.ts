import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootsPort } from '@ferretry/kernel/contract';
import { diskPaths, diskSessionsRoots } from '@ferretry/kernel/testing';
import { SessionFiles } from '../../../../daemon/modules/session-files.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { memoryStorage } from '../../../support/daemon/storage.ts';

/**
 * A Claude ferret's REWAKE INBOX (`FY_REWAKE_DIR`), on a REAL disk: the folder made private, a message left whole and
 * private under a name derived from its send id, taken back only while the Stop hook's listener has not claimed it, and the
 * listener's heartbeat (`armed`, by modification time) read as fresh or stale.
 */

const SESSION = parseSessionId('mw7bp88g-50e00159');
const FERRET = ferretId(SESSION);
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function inbox() {
  const parent = await mkdtemp(`${tmpdir()}/fy-rewake-`);
  parents.push(parent);
  const disk = await diskSessionsRoots(parent);
  const roots: Pick<RootsPort, 'root'> = { root: (_name, scope) => disk.root(scope?.subfolder ?? '') };
  let now = Date.parse('2026-11-16T09:00:00.000Z');
  const { storage } = await memoryStorage({ clock: { now: () => new Date(now).toISOString() } });
  const files = new SessionFiles({
    roots,
    storage,
    clock: { now: () => new Date(now).toISOString() },
    sleep: async () => undefined,
    paths: diskPaths(),
    fleet: () => [],
    log: { warn: () => undefined },
  });
  const session = files.port;
  // A launch prepares the ferret's own folder before anything else is made in it.
  await session.prepare?.(FERRET);
  const folder = `${disk.folderOf(SESSION)}/rewake`;
  return { session, folder, advance: (ms: number) => (now += ms), now: () => now };
}

describe('the rewake folder (FY_REWAKE_DIR)', () => {
  test('is rewake/ in the ferret’s own session folder, made 0700', async () => {
    const { session, folder } = await inbox();

    const named = await session.rewakeFolder?.(FERRET);

    expect(String(named)).toBe(folder);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  test('a message is left whole and 0600, and a temporary name is never left beside it', async () => {
    const { session, folder } = await inbox();

    await session.rewakeDeposit?.(
      FERRET,
      'send-1',
      '[message from ferret avary (session s1) — not from the owner] To reply: fy send avary "<reply>"\nhello',
    );

    const names = await readdir(folder);
    expect(names).toHaveLength(1);
    expect(names[0]).toEndWith('.md');
    expect(names.some(name => name.includes('.tmp'))).toBe(false);
    const path = `${folder}/${names[0]}`;
    expect(await readFile(path, 'utf8')).toBe(
      '[message from ferret avary (session s1) — not from the owner] To reply: fy send avary "<reply>"\nhello',
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('the same send id twice is ONE message, and messages are named so the oldest sorts first', async () => {
    const { session, folder, advance } = await inbox();

    await session.rewakeDeposit?.(FERRET, 'a', 'first');
    await session.rewakeDeposit?.(FERRET, 'a', 'first again');
    advance(1_500);
    await session.rewakeDeposit?.(FERRET, 'b', 'second');

    const names = (await readdir(folder)).filter(name => name.endsWith('.md')).sort();
    expect(names).toHaveLength(2);
    expect(await readFile(`${folder}/${names[0]}`, 'utf8')).toBe('first');
    expect(await readFile(`${folder}/${names[1]}`, 'utf8')).toBe('second');
  });

  test('waiting is true until the listener claims the file, and withdraw only takes back an unclaimed one', async () => {
    const { session, folder } = await inbox();
    await session.rewakeDeposit?.(FERRET, 'send-1', 'one');
    await session.rewakeDeposit?.(FERRET, 'send-2', 'two');
    expect(await session.rewakeWaiting?.(FERRET, 'send-1')).toBe(true);

    // The listener claims the first: it moves into taken/.
    const [claimed] = (await readdir(folder)).filter(name => name.endsWith('.md')).sort();
    await mkdir(`${folder}/taken`, { recursive: true });
    await Bun.write(`${folder}/taken/${claimed}`, await readFile(`${folder}/${claimed}`));
    await rm(`${folder}/${claimed}`);

    expect(await session.rewakeWaiting?.(FERRET, 'send-1')).toBe(false);
    expect(await session.rewakeWithdraw?.(FERRET, 'send-1')).toBe(false);
    expect(await session.rewakeWithdraw?.(FERRET, 'send-2')).toBe(true);
    expect(await session.rewakeWaiting?.(FERRET, 'send-2')).toBe(false);
    expect((await readdir(folder)).filter(name => name.endsWith('.md'))).toEqual([]);
  });

  test('the listener counts as armed only while its heartbeat is fresh', async () => {
    const { session, folder, now } = await inbox();
    await session.rewakeFolder?.(FERRET);
    // No heartbeat at all: not armed.
    expect(await session.rewakeArmed?.(FERRET, 5_000)).toBe(false);

    await writeFile(`${folder}/armed`, 'token');
    const fresh = new Date(now() - 1_000);
    await utimes(`${folder}/armed`, fresh, fresh);
    expect(await session.rewakeArmed?.(FERRET, 5_000)).toBe(true);

    const stale = new Date(now() - 30_000);
    await utimes(`${folder}/armed`, stale, stale);
    expect(await session.rewakeArmed?.(FERRET, 5_000)).toBe(false);
  });
});

describe('the rewake folder is a scope the kernel allows', () => {
  test('a withdraw before the listener ever made taken/ still takes the message back', async () => {
    const { session, folder } = await inbox();
    await session.rewakeDeposit?.(FERRET, 'send-9', 'nine');

    expect(await session.rewakeWithdraw?.(FERRET, 'send-9')).toBe(true);
    expect((await readdir(folder)).filter(name => name.endsWith('.md'))).toEqual([]);
  });

  test('a send id that is not a plain file name (a notice’s) is kept under a safe name', async () => {
    const { session, folder } = await inbox();

    await session.rewakeDeposit?.(FERRET, 'owner-waiting:send-failed:../../etc/passwd', 'notice');

    const names = (await readdir(folder)).filter(name => name.endsWith('.md'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d{14}-[a-z0-9_-]+-[0-9a-f]{12}\.md$/u);
    expect(await session.rewakeWaiting?.(FERRET, 'owner-waiting:send-failed:../../etc/passwd')).toBe(true);
  });
});
