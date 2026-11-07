/**
 * Parity rows F-0115 … F-0125 (docs/design/rebuild-parity.tsv): the agent browser's files. 5.0 keeps them under
 * Browsers' own state folder, `FY_HOME/state/browsers/` (§9.2), where today kept them under `FY_HOME/browser/`; Chrome's
 * own profile is `data/agent` there instead of `profile`. Every file today kept beside the profile keeps its name.
 *
 * F-0430 (`FY_HOME/pair-open-`) is the `fy pair --open` redirect file, the pairing CLI's — not a Browsers file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { processHost } from '../../../daemon/adapters/host.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { BrowserProfileBusyError } from '../../../daemon/worker/control/profile.ts';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

/** A store over a fresh state folder; `alive` says which pids are running. */
async function store(alive: (pid: number) => boolean = () => false) {
  const root = await mkdtemp(join(os.tmpdir(), 'ferretry-browser-parity-'));
  roots.push(root);
  const state = join(root, 'state', 'browsers');
  const subject = new BrowserProfileStore(state, {
    daemonPid: 1001,
    hostname: 'test-host',
    isProcessAlive: alive,
    now: () => new Date(0),
  });
  return { state, subject };
}

const exists = async (path: string): Promise<boolean> =>
  await lstat(path).then(
    () => true,
    () => false,
  );

describe('the agent browser files', () => {
  test('F-0115 the browser folder is Browsers’ own state folder under FY_HOME', () => {
    expect(processHost().stateDirectory.endsWith(join('state', 'browsers'))).toBe(true);
  });

  test('F-0115 F-0116 F-0117 F-0119 F-0122 F-0123 a lease makes the private profile, its lease, its metadata and its password-saving-off preferences', async () => {
    // Arrange
    const { state, subject } = await store();

    // Act
    const lease = await subject.acquire({ sessionId: 'agent-browser', chromeVersion: 'Google Chrome 150.0' });

    // Assert — the folder and the profile are the owner's alone.
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    expect(subject.profile).toBe(join(state, 'data', 'agent'));
    expect((await stat(subject.profile)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(state, 'profile.lock'), 'utf8'))).toMatchObject({
      sessionId: 'agent-browser',
      daemonPid: 1001,
    });
    expect(JSON.parse(await readFile(join(state, 'profile.metadata.json'), 'utf8'))).toMatchObject({
      createdChromeVersion: 'Google Chrome 150.0',
    });
    const preferences = JSON.parse(await readFile(join(subject.profile, 'Default', 'Preferences'), 'utf8'));
    expect(preferences.credentials_enable_service).toBe(false);
    expect(await lease.release()).toBe(true);
    expect(await exists(join(state, 'profile.lock'))).toBe(false);
  });

  test('F-0118 a dead owner’s lease is reclaimed under the reclaim guard, which is gone afterwards', async () => {
    // Arrange — a lease left by a daemon (pid 77) that is no longer running.
    const { state, subject } = await store();
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, 'profile.lock'),
      JSON.stringify({ sessionId: 'old', daemonPid: 77, acquiredAt: new Date(0).toISOString() }),
    );

    // Act
    const lease = await subject.acquire({ sessionId: 'agent-browser' });

    // Assert
    expect(lease.recoveredDeadOwner).toBe(true);
    expect(await exists(join(state, 'profile.lock.reclaim'))).toBe(false);
    await lease.release();
  });

  test('F-0120 priming writes profile.primed.json, and only that makes the profile primed', async () => {
    // Arrange
    const { state, subject } = await store();
    const lease = await subject.acquire({ sessionId: 'agent-browser' });
    expect(await subject.isPrimed()).toBe(false);

    // Act
    await lease.markPrimed('Google Chrome 150.0');

    // Assert
    expect(await exists(join(state, 'profile.primed.json'))).toBe(true);
    expect(await subject.isPrimed()).toBe(true);
    await lease.release();
  });

  test('F-0121 F-0124 a stale SingletonLock is cleared with Chrome’s other lock files; a live one refuses the lease', async () => {
    // Arrange — Chrome pid 4242 on this host left its locks in the profile.
    let chromeAlive = true;
    const { subject } = await store(pid => pid === 4242 && chromeAlive);
    await mkdir(subject.profile, { recursive: true });
    await symlink('test-host-4242', join(subject.profile, 'SingletonLock'));
    await writeFile(join(subject.profile, 'SingletonSocket'), '');

    // Act + Assert — while that Chrome runs, the profile is its.
    await expect(subject.acquire({ sessionId: 'agent-browser' })).rejects.toBeInstanceOf(BrowserProfileBusyError);

    // Act — Chrome is gone.
    chromeAlive = false;
    const lease = await subject.acquire({ sessionId: 'agent-browser' });
    const removed = await lease.cleanupStaleChromeLocks();

    // Assert
    expect(removed).toEqual(['SingletonLock', 'SingletonSocket']);
    expect(await readdir(subject.profile)).not.toContain('SingletonLock');
    await lease.release();
  });

  test('F-0125 the private X display keeps its cookies in x11/ beside the profile', async () => {
    const { state, subject } = await store();
    expect(subject.displayDirectory).toBe(join(state, 'x11'));
  });
});
