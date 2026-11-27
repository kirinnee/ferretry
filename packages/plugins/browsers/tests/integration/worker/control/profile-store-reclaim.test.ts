import { afterEach, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tryProfileReclaimLock } from '../../../../daemon/worker/control/adapters/profile-reclaim-lock.ts';
import { BrowserProfileStore } from '../../../../daemon/worker/control/adapters/profile-store.ts';

const roots: string[] = [];
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it('excludes another process and releases the mutex when its holder crashes without unlinking it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretry-profile-mutex-'));
  roots.push(root);
  const file = path.join(root, 'reclaim.mutex');
  const module = new URL('../../../../daemon/worker/control/adapters/profile-reclaim-lock.ts', import.meta.url)
    .pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { open } from 'node:fs/promises';
    import { tryProfileReclaimLock } from ${JSON.stringify(module)};
    const handle = await open(${JSON.stringify(file)}, 'a', 0o600);
    if (!tryProfileReclaimLock(handle.fd, process.platform)) throw new Error('child could not lock');
    console.log('locked');
      setInterval(() => { if (handle.fd < 0) throw new Error('child descriptor closed'); }, 1000);
  `,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const reader = child.stdout.getReader();
    const message = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(message.value).trim()).toBe('locked');
    handle = await fs.open(file, 'a', 0o600);
    const inode = (await handle.stat()).ino;
    expect(tryProfileReclaimLock(handle.fd, process.platform)).toBe(false);
    child.kill('SIGKILL');
    await child.exited;
    expect(tryProfileReclaimLock(handle.fd, process.platform)).toBe(true);
    expect((await fs.stat(file)).ino).toBe(inode);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await handle?.close();
  }
});

it('publishes a reclaim guard only after its entire owner record has been written', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretry-profile-publish-'));
  roots.push(root);
  const subject = new BrowserProfileStore(root, { daemonPid: 1001, isProcessAlive: pid => pid === 1001 });
  await (await subject.acquire('work', { sessionId: 'seed' })).release();
  const paths = subject.paths('work');
  await fs.writeFile(
    paths.leaseFile,
    JSON.stringify({ sessionId: 'dead', daemonPid: 9999, acquiredAt: new Date(0).toISOString() }),
  );
  const open = fs.open;
  let exposed = false;
  let writes = 0;
  const watched = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).startsWith(paths.reclaimFile) && args[1] === 'wx') {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
        writes += 1;
        exposed = await fs.readFile(paths.reclaimFile).then(
          () => true,
          () => false,
        );
        return await write(...values);
      };
    }
    return handle;
  });
  try {
    await (await subject.acquire('work', { sessionId: 'recovered' })).release();
    expect(writes).toBe(1);
    expect(exposed).toBe(false);
  } finally {
    watched.mockRestore();
  }
});

for (const abandoned of ['malformed', 'dead']) {
  it(`serializes cleanup of an abandoned ${abandoned} guard across store instances`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretry-profile-abandoned-'));
    roots.push(root);
    const firstRemoval = gate();
    const resume = gate();
    const contenderProgress = gate();
    let removals = 0;
    const make = () =>
      new BrowserProfileStore(root, {
        daemonPid: 1001,
        isProcessAlive: pid => pid === 1001,
        sleep: async () => {
          contenderProgress.resolve();
          await resume.promise;
          await Bun.sleep(1);
        },
      });
    const first = make();
    const second = make();
    await (await first.acquire('work', { sessionId: 'seed' })).release();
    const paths = first.paths('work');
    const dead = JSON.stringify({ sessionId: 'dead', daemonPid: 9999, acquiredAt: new Date(0).toISOString() });
    await fs.writeFile(paths.leaseFile, dead);
    await fs.writeFile(paths.reclaimFile, abandoned === 'dead' ? dead : 'garbage');
    const rm = fs.rm;
    const watched = spyOn(fs, 'rm').mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === paths.reclaimFile) {
        removals += 1;
        if (removals === 1) firstRemoval.resolve();
        else contenderProgress.resolve();
        await resume.promise;
      }
      return await rm(...args);
    });
    const attempts = [first.acquire('work', { sessionId: 'first' })];
    try {
      await firstRemoval.promise;
      attempts.push(second.acquire('work', { sessionId: 'second' }));
      await contenderProgress.promise;
      // A delayed stale observer must not be allowed to unlink a guard another reclaimer can replace.
      expect(removals).toBe(1);
    } finally {
      resume.resolve();
      await Promise.allSettled(attempts);
      watched.mockRestore();
    }
    const results = await Promise.allSettled(attempts);
    const winners = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner === undefined) throw new Error('no caller acquired the recovered profile');
    expect(JSON.parse(await fs.readFile(paths.leaseFile, 'utf8')).sessionId).toBe(winner.sessionId);
    await winner.release();
  });
}

it('concurrent reclaimers never remove or share a freshly acquired live lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferretry-profile-reclaim-'));
  roots.push(root);
  const subject = new BrowserProfileStore(path.join(root, 'state'), {
    daemonPid: 1001,
    isProcessAlive: pid => pid === 1001,
  });
  await (await subject.acquire('work', { sessionId: 'seed' })).release();
  const paths = subject.paths('work');
  await fs.writeFile(
    paths.leaseFile,
    JSON.stringify({ sessionId: 'dead', daemonPid: 9999, acquiredAt: '1970-01-01T00:00:00.000Z' }),
  );

  // Slow the real guard writes: a contender must never mistake an unfinished live guard for an abandoned one.
  const open = fs.open;
  let guardWrites = 0;
  const delayedOpen = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes('.reclaim')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        guardWrites += 1;
        await Bun.sleep(10);
        return await write(...writeArgs);
      };
    }
    return handle;
  });
  const rm = fs.rm;
  let leaseRemovals = 0;
  const delayedRemove = spyOn(fs, 'rm').mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === paths.leaseFile && leaseRemovals++ === 0) await Bun.sleep(50);
    return await rm(...args);
  });
  try {
    const attempts = Array.from({ length: 24 }, (_, index) =>
      subject.acquire('work', { sessionId: `reclaimer-${index}` }),
    );
    await Bun.sleep(5);
    attempts.push(subject.acquire('work', { sessionId: 'fresh' }));
    const results = await Promise.allSettled(attempts);
    expect(guardWrites).toBeGreaterThan(0);
    const winners = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner === undefined) throw new Error('no caller acquired the recovered profile');
    expect(JSON.parse(await fs.readFile(paths.leaseFile, 'utf8')).sessionId).toBe(winner.sessionId);
    expect(await winner.release()).toBe(true);
  } finally {
    delayedOpen.mockRestore();
    delayedRemove.mockRestore();
  }
});
