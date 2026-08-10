import { afterEach, describe, expect, it } from 'bun:test';
import type { SessionView, StartSessionRequest } from '@ferretry/protocol';
import type { ReactElement } from 'react';

import { ProjectDetailPage } from '../../../src/features/projects/project-detail.tsx';
import { SessionSearchProvider } from '../../../src/features/session-search/session-search.tsx';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../../src/lib/fleet-grouping.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../../../src/lib/fleet-store.ts';
import { type DaemonProjectsPort, DaemonProjectsStore } from '../../../src/lib/projects-store.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { type AppStore, DaemonApiPool, StoreProvider } from '../../../src/lib/store.tsx';
import { interact, mount, type Mounted, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const daemon = daemonConnection({
  daemonId: 'workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'device-token',
});

const project: FleetProject = {
  id: PROJECT_ID,
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
};

const projectSession = (id: string, overrides: Parameters<typeof sessionView>[1] = {}): SessionView =>
  sessionView(id, {
    ...overrides,
    config: { cwd: '/work/ferretry', boardAccess: 'none', ...overrides.config },
  });

interface StoreShape {
  readonly projects?: DaemonProjectsPort;
  readonly fleet?: DaemonFleetPort;
  readonly start?: (request: StartSessionRequest) => Promise<SessionView>;
}

const listing = (sessions: readonly SessionView[]): DaemonFleetPort => ({
  list: async () => sessions,
  get: async () => {
    throw new Error('a project page never reads one session');
  },
});

const storeFor = ({ projects, fleet, start }: StoreShape = {}): AppStore =>
  ({
    projects: new DaemonProjectsStore(projects ?? { projects: async () => [project] }),
    fleet: new DaemonFleetStore(fleet ?? listing([])),
    clients: new DaemonApiPool(
      async () =>
        ({
          start:
            start ??
            (async () => {
              throw new Error('this suite did not expect a session start');
            }),
        }) as never,
    ),
  }) as AppStore;

// The file browser inside the page reads over the production `browserFetch`,
// and the whole unit tier shares ONE process, so the global is restored after
// every test rather than left answering later suites.
const realFetch = globalThis.fetch;
const answerFs = (): void => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ path: '.', entries: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
};

const detailPath = `/d/workstation/projects/${PROJECT_ID}`;
const setPath = (path: string): void => window.history.replaceState({}, '', path);

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
  globalThis.fetch = realFetch;
  setPath('/');
});

const shell = (store: AppStore, connection: DaemonConnection = daemon, projectId = PROJECT_ID): ReactElement => (
  <StoreProvider store={store}>
    <RouterProvider>
      <SessionSearchProvider connection={connection} focusSignal={0} scope={null}>
        <ProjectDetailPage connection={connection} projectId={projectId} />
      </SessionSearchProvider>
    </RouterProvider>
  </StoreProvider>
);

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const show = async (element: ReactElement): Promise<Mounted> => {
  answerFs();
  setPath(detailPath);
  open = await mount(element);
  await settle();
  return open;
};

const press = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const buttonSaying = (view: Mounted, text: string): HTMLButtonElement => {
  const found = [...view.container.querySelectorAll('button')].find(node => (node.textContent ?? '').includes(text));
  return must(found, `the “${text}” button`);
};

describe('ProjectDetailPage', () => {
  it('keeps an unread registry visibly loading instead of calling the project missing', async () => {
    // Arrange
    let release: (projects: readonly FleetProject[]) => void = () => undefined;
    const pending = new Promise<readonly FleetProject[]>(resolve => {
      release = resolve;
    });

    // Act
    const view = await show(shell(storeFor({ projects: { projects: async () => await pending } })));

    // Assert
    expect(view.container.textContent).toContain('Loading this daemon’s project registry…');
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(view.container.querySelector('[data-project-detail="missing"]')).toBeNull();

    release([project]);
    await settle();
  });

  it('names the reason the project registry could not be read', async () => {
    // Act
    const view = await show(
      shell(
        storeFor({
          projects: {
            projects: async () => {
              throw new Error('daemon is offline');
            },
          },
        }),
      ),
    );

    // Assert
    expect(must(view.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'Could not read this daemon’s project registry: daemon is offline',
    );
  });

  it('keeps a bookmark to a project this daemon no longer holds', async () => {
    // Act
    const view = await show(shell(storeFor({ projects: { projects: async () => [] } })));

    // Assert
    const missing = must(view.container.querySelector('[data-project-detail="missing"]'), 'the refusal');
    expect(missing.textContent).toContain('Project unavailable');
    expect(missing.textContent).toContain('This daemon no longer holds that project');

    // Act — the reader is offered the registry, not a dead end.
    await press(buttonSaying(view, 'View registered projects'));

    // Assert
    expect(window.location.pathname).toBe('/d/workstation/projects');
  });

  it('refuses a registry row that is not a protocol project rather than rendering half of one', async () => {
    // Arrange — an id and a name, but no `source` and no `createdAt`: a shape
    // the grouping type allows and `ProjectInfoSchema` does not.
    const partial = { id: PROJECT_ID, name: 'ferretry', path: '/work/ferretry' } as FleetProject;

    // Act
    const view = await show(shell(storeFor({ projects: { projects: async () => [partial] } })));

    // Assert
    expect(view.container.querySelector('[data-project-detail="missing"]')).not.toBeNull();
    expect(view.container.querySelector(`[data-project-detail="${PROJECT_ID}"]`)).toBeNull();
  });

  it('renders the project with its provenance, its agents, its files and its boards', async () => {
    // Arrange
    const sessions = [
      projectSession('s-old', {
        config: { name: 'Older work', boardAccess: 'read' },
        state: { status: 'running', lastActivityAt: '2026-08-01T09:00:00.000Z' },
      }),
      projectSession('s-new', {
        config: { name: 'Newest work' },
        state: { status: 'running', lastActivityAt: '2026-08-06T09:00:00.000Z' },
      }),
      // Another folder entirely: it must not appear on this project.
      sessionView('s-other', { config: { cwd: '/work/other', name: 'Elsewhere', boardAccess: 'none' } }),
    ];

    // Act
    const view = await show(
      shell(
        storeFor({
          projects: { projects: async () => [{ ...project, lastActivity: '2026-08-06T09:00:00.000Z' }] },
          fleet: listing(sessions),
        }),
      ),
    );

    // Assert
    const page = must(view.container.querySelector(`[data-project-detail="${PROJECT_ID}"]`), 'the page');
    expect(must(page.querySelector('h1'), 'the title').textContent).toBe('ferretry');
    expect(page.textContent).toContain('Project activity: 2026-08-06T09:00:00.000Z');
    expect(
      must(page.querySelector('[data-project-provenance]'), 'the rail').getAttribute('data-project-provenance'),
    ).toBe('/work/ferretry');

    // The agent rail lists this project's live sessions, most recent first.
    const rows = [...page.querySelectorAll('li')].map(row => row.textContent ?? '');
    expect(rows.some(row => row.includes('Newest work'))).toBe(true);
    expect(rows.some(row => row.includes('Older work'))).toBe(true);
    expect(page.textContent).not.toContain('Elsewhere');

    // Files are rooted in the most recently active session of this project.
    expect(page.querySelector('[data-project-files="s-new"]')).not.toBeNull();

    // Only the session that actually exposes a board is listed as one.
    const boards = must(page.querySelector('[data-project-boards="ready"]'), 'the boards list');
    expect(boards.textContent).toContain('Older work');
    expect(boards.textContent).toContain('read access · s-old');
    expect(boards.textContent).not.toContain('Newest work');
  });

  it('says a project with no session has no files to browse and no board', async () => {
    // Act
    const view = await show(shell(storeFor({ fleet: listing([]) })));

    // Assert
    expect(view.container.textContent).toContain('No active agents are working in this project.');
    expect(view.container.querySelector('[data-project-files="unavailable"]')).not.toBeNull();
    expect(view.container.querySelector('[data-project-boards="empty"]')).not.toBeNull();
  });

  it('does not count a finished session as an agent still working here', async () => {
    // Arrange
    const sessions = [projectSession('s-done', { config: { name: 'Finished' }, state: { status: 'completed' } })];

    // Act
    const view = await show(shell(storeFor({ fleet: listing(sessions) })));

    // Assert — it is gone from the agent rail, but its files are still the
    // project's most recent session, which is a different question.
    expect(view.container.textContent).toContain('No active agents are working in this project.');
    expect(view.container.querySelector('[data-project-files="s-done"]')).not.toBeNull();
  });

  it('keeps an unread session list loading rather than claiming the project is idle', async () => {
    // Arrange
    let release: (sessions: readonly SessionView[]) => void = () => undefined;
    const pending = new Promise<readonly SessionView[]>(resolve => {
      release = resolve;
    });

    // Act
    const view = await show(
      shell(
        storeFor({
          fleet: {
            list: async () => await pending,
            get: async () => {
              throw new Error('unused');
            },
          },
        }),
      ),
    );

    // Assert — and every panel says "unknown", not "none". Files and Boards are
    // drawn from the same unread list, so a collapsed empty set would turn "not
    // read yet" into "this project has no session" and "nothing exposes a board".
    expect(view.container.querySelector('[data-project-agents="unread"]')).not.toBeNull();
    expect(view.container.querySelector('[data-project-agents="empty"]')).toBeNull();
    expect(must(view.container.querySelector('[data-project-files="unread"]'), 'the files note').textContent).toContain(
      'Files are unknown until this daemon’s session list is read',
    );
    expect(
      must(view.container.querySelector('[data-project-boards="unread"]'), 'the boards note').textContent,
    ).toContain('Boards are unknown until this daemon’s session list is read');
    expect(view.container.querySelector('[data-project-files="unavailable"]')).toBeNull();
    expect(view.container.querySelector('[data-project-boards="empty"]')).toBeNull();

    release([]);
    await settle();
    expect(view.container.querySelector('[data-project-agents="empty"]')).not.toBeNull();
    expect(view.container.querySelector('[data-project-files="unavailable"]')).not.toBeNull();
    expect(view.container.querySelector('[data-project-boards="empty"]')).not.toBeNull();
  });

  it('names a failed session read instead of spinning on it forever', async () => {
    // Act
    const view = await show(
      shell(
        storeFor({
          fleet: {
            list: async () => {
              throw new Error('daemon is offline');
            },
            get: async () => {
              throw new Error('unused');
            },
          },
        }),
      ),
    );

    // Assert — the store keeps `sessions` null until a read succeeds, so this
    // is the branch a first failure lands in.
    const status = must(view.container.querySelector('[data-project-agents="failed"]'), 'the agent status');
    expect(status.textContent).toContain('Could not read this daemon’s sessions: daemon is offline');
    expect(view.container.textContent).not.toContain('Loading this daemon’s sessions…');

    // Files and Boards read the same failed list, so neither may conclude that
    // the project has no session or no board. Both name the failure instead.
    expect(must(view.container.querySelector('[data-project-files="failed"]'), 'the files note').textContent).toContain(
      'Could not read this daemon’s sessions, so this project’s files are unknown: daemon is offline',
    );
    expect(
      must(view.container.querySelector('[data-project-boards="failed"]'), 'the boards note').textContent,
    ).toContain('Could not read this daemon’s sessions, so this project’s boards are unknown: daemon is offline');
    expect(view.container.querySelector('[data-project-files="unavailable"]')).toBeNull();
    expect(view.container.querySelector('[data-project-boards="empty"]')).toBeNull();
  });

  it('calls a list it already showed stale rather than deleting it on a failed refresh', async () => {
    // Arrange
    let reads = 0;
    const fleet = new DaemonFleetStore({
      list: async () => {
        reads += 1;
        if (reads > 1) throw new Error('the connection dropped');
        return [projectSession('s-1', { config: { name: 'Still here' } })];
      },
      get: async () => {
        throw new Error('unused');
      },
    });
    const store = {
      projects: new DaemonProjectsStore({ projects: async () => [project] }),
      fleet,
      clients: new DaemonApiPool(async () => ({}) as never),
    } as AppStore;

    // Act
    const view = await show(shell(store));
    await interact(async () => {
      await fleet.hydrate(daemon).catch(() => undefined);
    });
    await settle();

    // Assert — the warning is shown AND the rows the fleet store deliberately
    // preserved are still on screen. Asserting the name alone would pass on the
    // Files caption, which renders the same session name, so this asserts the
    // agent rail itself.
    expect(
      must(view.container.querySelector('[data-project-agents="stale"]'), 'the stale notice').textContent,
    ).toContain('The session list is stale: the connection dropped');
    const rail = must(view.container.querySelector('[data-project-agents="ready"]'), 'the agent rail');
    const rows = [...rail.querySelectorAll('li')];
    expect(rows).toHaveLength(1);
    expect(must(rows[0], 'the agent row').textContent).toContain('Still here');
    expect(must(rows[0], 'the agent row').querySelector('button')?.textContent).toBe('Open');
    // Files and Boards are drawn from that same stale set, so the screen agrees
    // with itself rather than showing rows in one panel and nothing in another.
    expect(view.container.querySelector('[data-project-files="s-1"]')).not.toBeNull();
  });

  it('opens a listed agent on this daemon and no other', async () => {
    // Arrange
    const sessions = [projectSession('s-1', { config: { name: 'Port the hub' } })];

    // Act
    const view = await show(shell(storeFor({ fleet: listing(sessions) })));
    await press(buttonSaying(view, 'Open'));

    // Assert
    expect(window.location.pathname).toBe('/d/workstation/session/s-1');
  });

  it('returns to the registry of the daemon whose project this is', async () => {
    // Act
    const view = await show(shell(storeFor()));
    await press(buttonSaying(view, 'Back to Projects'));

    // Assert
    expect(window.location.pathname).toBe('/d/workstation/projects');
  });

  it('starts an interactive agent in the project folder and lands on the session it created', async () => {
    // Arrange
    const started: StartSessionRequest[] = [];
    const store = storeFor({
      start: async request => {
        started.push(request);
        return sessionView('s-created', { config: { cwd: '/work/ferretry' } });
      },
    });

    // Act
    const view = await show(shell(store));
    await press(buttonSaying(view, 'Launch agent'));
    const field = must(
      view.container.querySelector<HTMLInputElement>('#project-launch-agent-name'),
      'the wrapper field',
    );
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'claude-auto-loge');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(buttonSaying(view, 'Launch interactive agent'));
    await settle();

    // Assert
    expect(started).toEqual([
      { agent: 'claude-auto-loge', cwd: '/work/ferretry', mode: 'interactive', boardAccess: 'none' },
    ]);
    expect(window.location.pathname).toBe('/d/workstation/session/s-created');
  });

  it('reads the registry and the fleet of the connection it was given, never an ambient one', async () => {
    // Arrange
    const laptop = daemonConnection({
      daemonId: 'laptop',
      baseUrl: 'https://laptop.example.test',
      deviceToken: 'laptop-token',
    });
    const asked: string[] = [];
    const store = {
      projects: new DaemonProjectsStore({
        projects: async connection => {
          asked.push(`projects:${connection.daemonId}`);
          return connection.daemonId === 'laptop' ? [project] : [];
        },
      }),
      fleet: new DaemonFleetStore({
        list: async connection => {
          asked.push(`fleet:${connection.daemonId}`);
          return [];
        },
        get: async () => {
          throw new Error('unused');
        },
      }),
      clients: new DaemonApiPool(async () => ({}) as never),
    } as AppStore;

    // Act
    const view = await show(shell(store, laptop));

    // Assert — the workstation in the URL bar of the previous test is nowhere
    // in this page's reads, and the project it found is the laptop's.
    expect(asked.toSorted()).toEqual(['fleet:laptop', 'projects:laptop']);
    expect(view.container.querySelector(`[data-project-detail="${PROJECT_ID}"]`)).not.toBeNull();
  });
});
