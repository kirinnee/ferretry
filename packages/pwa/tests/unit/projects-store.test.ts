import { describe, expect, it } from 'bun:test';

import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../src/lib/fleet-grouping.ts';
import {
  type DaemonProjectsPort,
  DaemonProjectsStore,
  daemonProjectsPort,
  fetchDaemonProjects,
  NO_PROJECTS,
} from '../../src/lib/projects-store.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ferretry: FleetProject = { name: 'ferretry', path: '/home/k/ferretry' };
const worktree: FleetProject = { name: 'ferretry-wt', path: '/home/k/ferretry/wt' };

const portFor = (answers: Map<string, () => Promise<readonly FleetProject[]>>): DaemonProjectsPort => ({
  projects: async daemon => {
    const answer = answers.get(daemon.daemonId);
    if (answer === undefined) throw new Error(`no answer for ${daemon.daemonId}`);
    return await answer();
  },
});

describe('fetchDaemonProjects', () => {
  it('reads /v1/projects from the paired daemon and narrows it to name and path', async () => {
    let seen = '';
    let authorization = '';
    const projects = await fetchDaemonProjects(laptop, async (url, init) => {
      seen = String(url);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return json([
        { name: 'ferretry', path: '/home/k/ferretry', lastActivity: '2026-08-01T09:00:00.000Z' },
        { name: 'ferretry-wt', path: '/home/k/ferretry/wt' },
      ]);
    });

    expect(seen).toBe('https://laptop.example.test/v1/projects');
    expect(authorization).toBe('Bearer token-laptop');
    expect(projects).toEqual([ferretry, worktree]);
  });

  it('raises the daemon error body, and the status when there is none', async () => {
    await expect(
      fetchDaemonProjects(laptop, async () => json({ error: 'projects are admin-only', code: 'forbidden' }, 403)),
    ).rejects.toMatchObject({ status: 403, message: 'projects are admin-only', code: 'forbidden' });

    const failure = await fetchDaemonProjects(laptop, async () => new Response('nope', { status: 500 })).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(DaemonResponseError);
    expect(failure).toMatchObject({ status: 500, message: 'HTTP 500', code: undefined });
  });

  it('rejects a catalog that does not match the protocol', async () => {
    await expect(fetchDaemonProjects(laptop, async () => json([{ name: '', path: '/x' }]))).rejects.toThrow();
  });
});

describe('daemonProjectsPort', () => {
  it('is the browser port over one fetch', async () => {
    const port = daemonProjectsPort(async () => json([{ name: 'ferretry', path: '/home/k/ferretry' }]));
    expect(await port.projects(laptop)).toEqual([ferretry]);
  });
});

describe('DaemonProjectsStore', () => {
  it('answers a shared empty and an idle slice before any read', () => {
    const store = new DaemonProjectsStore(portFor(new Map()));
    expect(store.slice(laptop.daemonId)).toEqual({ projects: null, status: 'idle', error: null });
    expect(store.projects(laptop.daemonId)).toBe(NO_PROJECTS);
  });

  it('hydrates each daemon independently and never serves one list under the other', async () => {
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => [ferretry]],
          [workstation.daemonId, async () => [worktree]],
        ]),
      ),
    );

    expect(await store.hydrate(laptop)).toEqual([ferretry]);
    expect(await store.hydrate(workstation)).toEqual([worktree]);
    expect(store.projects(laptop.daemonId)).toEqual([ferretry]);
    expect(store.projects(workstation.daemonId)).toEqual([worktree]);
    expect(store.slice(laptop.daemonId).status).toBe('ready');
  });

  it('coalesces a burst into one request per daemon', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              calls += 1;
              await gate;
              return [ferretry];
            },
          ],
        ]),
      ),
    );

    const first = store.hydrate(laptop);
    const second = store.hydrate(laptop);
    expect(second).toBe(first);
    expect(store.slice(laptop.daemonId).status).toBe('loading');
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);

    // The coalescing window closes with the request, so a later caller reads again.
    await store.hydrate(laptop);
    expect(calls).toBe(2);
  });

  it('keeps a good list when a later read fails, and reports the failure', async () => {
    let attempt = 0;
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              attempt += 1;
              if (attempt === 1) return [ferretry];
              throw new DaemonResponseError(503, 'the catalog is unavailable');
            },
          ],
        ]),
      ),
    );

    await store.hydrate(laptop);
    await expect(store.hydrate(laptop)).rejects.toThrow('the catalog is unavailable');
    expect(store.slice(laptop.daemonId)).toMatchObject({
      status: 'error',
      error: 'the catalog is unavailable',
      projects: [ferretry],
    });
  });

  it('stringifies a rejection that is not an Error', async () => {
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              throw 'socket closed';
            },
          ],
        ]),
      ),
    );
    await expect(store.hydrate(laptop)).rejects.toBe('socket closed');
    expect(store.slice(laptop.daemonId).error).toBe('socket closed');
  });

  it('resets on a re-pair and publishes nothing from the pre-rotation read', async () => {
    let release!: (value: readonly FleetProject[]) => void;
    const first = new Promise<readonly FleetProject[]>(resolve => {
      release = resolve;
    });
    let call = 0;
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              call += 1;
              return call === 1 ? await first : [worktree];
            },
          ],
        ]),
      ),
    );

    const stale = store.hydrate(laptop);
    // The rotated connection is a different entry, so it is not coalesced onto
    // the read issued with the replaced token.
    await store.hydrate({ ...laptop, deviceToken: 'token-rotated' });
    expect(store.projects(laptop.daemonId)).toEqual([worktree]);

    release([ferretry]);
    await stale;
    expect(store.projects(laptop.daemonId)).toEqual([worktree]);
  });

  it('discards a failure that lands after a re-pair', async () => {
    let reject!: (reason: unknown) => void;
    const first = new Promise<readonly FleetProject[]>((_resolve, onReject) => {
      reject = onReject;
    });
    let call = 0;
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              call += 1;
              return call === 1 ? await first : [worktree];
            },
          ],
        ]),
      ),
    );

    const stale = store.hydrate(laptop);
    await store.hydrate({ ...laptop, baseUrl: 'https://laptop-2.example.test' });
    reject(new Error('the old token was revoked'));
    await expect(stale).rejects.toThrow('the old token was revoked');
    expect(store.slice(laptop.daemonId)).toMatchObject({ status: 'ready', error: null });
  });

  it('drops one daemon and leaves the other, and says whether it held anything', async () => {
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => [ferretry]],
          [workstation.daemonId, async () => [worktree]],
        ]),
      ),
    );
    await store.hydrate(laptop);
    await store.hydrate(workstation);

    expect(store.clearDaemon(laptop.daemonId)).toBe(true);
    expect(store.clearDaemon(laptop.daemonId)).toBe(false);
    expect(store.projects(laptop.daemonId)).toBe(NO_PROJECTS);
    expect(store.projects(workstation.daemonId)).toEqual([worktree]);
  });

  it('publishes to subscribers until they leave', async () => {
    const store = new DaemonProjectsStore(portFor(new Map([[laptop.daemonId, async () => [ferretry]]])));
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });
    await store.hydrate(laptop);
    expect(calls).toBeGreaterThan(0);
    expect(store.getSnapshot().daemons.get(laptop.daemonId)?.projects).toEqual([ferretry]);

    const afterFirst = calls;
    stop();
    await store.hydrate(laptop);
    expect(calls).toBe(afterFirst);
  });
});
