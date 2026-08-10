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

const project = (name: string, path: string, extras: Record<string, unknown> = {}) => ({
  id: name === 'ferretry' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002',
  name,
  path,
  source: 'existing-folder' as const,
  createdAt: '2026-08-01T09:00:00.000Z',
  ...extras,
});

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
  it('reads /v1/projects from the paired daemon and keeps every field of the record', async () => {
    let seen = '';
    let authorization = '';
    const rows = [
      project('ferretry', '/home/k/ferretry', {
        lastActivity: '2026-08-01T09:00:00.000Z',
        git: { commonDirectory: '/home/k/ferretry/.git' },
        source: 'clone',
      }),
      project('ferretry-wt', '/home/k/ferretry/wt'),
    ];
    const projects = await fetchDaemonProjects(laptop, async (url, init) => {
      seen = String(url);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return json(rows);
    });

    expect(seen).toBe('https://laptop.example.test/v1/projects');
    expect(authorization).toBe('Bearer token-laptop');
    // Nothing is narrowed away. The earlier version mapped each row down to
    // `{ name, path }`, which made `source` unsearchable in the folder picker
    // and left every provenance surface with nothing to render.
    expect(projects).toEqual(rows);
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
    const row = project('ferretry', '/home/k/ferretry');
    const port = daemonProjectsPort(async () => json([row]));
    expect(await port.projects(laptop)).toEqual([row]);
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

  it('refreshes past the coalescing slot, because a read in flight predates the write', async () => {
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
              if (calls === 1) await gate;
              return calls === 1 ? [ferretry] : [ferretry, worktree];
            },
          ],
        ]),
      ),
    );

    const first = store.hydrate(laptop);
    // `hydrate` would hand back the read already in flight; that answer was
    // computed before the folder existed, which is the whole reason `refresh`
    // exists.
    const refreshed = store.refresh(laptop);
    expect(refreshed).not.toBe(first);
    expect(await refreshed).toEqual([ferretry, worktree]);
    expect(calls).toBe(2);

    release();
    await first;
    // The list stays on screen through the re-read rather than blanking.
    expect(store.projects(laptop.daemonId)).toEqual([ferretry, worktree]);
  });

  it('discards the abandoned read when it settles AFTER the refresh it was replaced by', async () => {
    // The race the fence exists for: the pre-write read still holds the current
    // credential, so a credential check alone lets it publish its stale list on
    // top of the post-write one whenever it answers second.
    let releaseStale!: () => void;
    const stale = new Promise<void>(resolve => {
      releaseStale = resolve;
    });
    let calls = 0;
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              calls += 1;
              if (calls === 1) {
                await stale;
                return [ferretry];
              }
              return [ferretry, worktree];
            },
          ],
        ]),
      ),
    );

    const abandoned = store.hydrate(laptop);
    await store.refresh(laptop);
    expect(store.projects(laptop.daemonId)).toEqual([ferretry, worktree]);

    releaseStale();
    expect(await abandoned).toEqual([ferretry]);
    expect(store.projects(laptop.daemonId)).toEqual([ferretry, worktree]);
    expect(store.slice(laptop.daemonId).status).toBe('ready');
  });

  it('discards an abandoned read’s FAILURE, so a stale error cannot mark a good refresh errored', async () => {
    let rejectStale!: (reason: unknown) => void;
    const stale = new Promise<readonly FleetProject[]>((_resolve, onReject) => {
      rejectStale = onReject;
    });
    let calls = 0;
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              calls += 1;
              return calls === 1 ? await stale : [ferretry, worktree];
            },
          ],
        ]),
      ),
    );

    const abandoned = store.hydrate(laptop);
    await store.refresh(laptop);

    rejectStale(new DaemonResponseError(503, 'the catalog is unavailable'));
    await expect(abandoned).rejects.toThrow('the catalog is unavailable');
    expect(store.slice(laptop.daemonId)).toMatchObject({
      status: 'ready',
      error: null,
      projects: [ferretry, worktree],
    });
  });

  it('refreshes exactly one daemon and leaves every other daemon unread', async () => {
    const reads: string[] = [];
    const store = new DaemonProjectsStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              reads.push('laptop');
              return [ferretry];
            },
          ],
          [
            workstation.daemonId,
            async () => {
              reads.push('workstation');
              return [worktree];
            },
          ],
        ]),
      ),
    );

    await store.hydrate(laptop);
    await store.hydrate(workstation);
    await store.refresh(laptop);

    expect(reads).toEqual(['laptop', 'workstation', 'laptop']);
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
