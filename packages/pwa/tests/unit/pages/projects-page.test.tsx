import { afterEach, describe, expect, it } from 'bun:test';
import type { ProjectInfo, SessionView } from '@ferretry/protocol';

import { ProjectsPage } from '../../../src/features/projects/projects-page.tsx';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../../src/lib/fleet-grouping.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../../../src/lib/fleet-store.ts';
import { type DaemonProjectsPort, DaemonProjectsStore } from '../../../src/lib/projects-store.ts';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { interact, mount, must, type Mounted } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const daemon = daemonConnection({
  daemonId: 'workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'device-token',
});

/** A second machine, so a write can settle onto the wrong screen if unfenced. */
const laptop = daemonConnection({
  daemonId: 'laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'laptop-token',
});

const pathField = (mounted: Mounted): HTMLInputElement => {
  const label = [...mounted.container.querySelectorAll('label')].find(node =>
    (node.textContent ?? '').startsWith('Folder'),
  );
  const id = must(label, 'the path label').getAttribute('for');
  return must(mounted.container.querySelector<HTMLInputElement>(`#${id}`), 'the path field');
};

const project: FleetProject = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
};

const answered: ProjectInfo = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'scratch',
  path: '/home/k/scratch',
  source: 'confirmed-discovery',
  createdAt: '2026-08-06T11:00:00.000Z',
};

const fleetPort = (sessions: readonly SessionView[]): DaemonFleetPort => ({
  list: async () => sessions,
  get: async () => {
    throw new Error('a project page never reads one session');
  },
});

interface StoreShape {
  readonly projectsPort: DaemonProjectsPort;
  readonly sessions?: readonly SessionView[];
}

const storeFor = ({ projectsPort, sessions = [] }: StoreShape): AppStore =>
  ({
    projects: new DaemonProjectsStore(projectsPort),
    fleet: new DaemonFleetStore(fleetPort(sessions)),
  }) as AppStore;

const page = (store: AppStore) => (
  <StoreProvider store={store}>
    <ProjectsPage connection={daemon} />
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

const press = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

// The page's write path goes through the production `browserFetch`, so these
// suites replace the global. Bun runs the whole unit tier in ONE process, so a
// leaked stub would answer every later suite's requests.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ProjectsPage', () => {
  it('keeps an unread registry visibly loading instead of calling it empty', async () => {
    let release: (projects: readonly FleetProject[]) => void = () => undefined;
    const pending = new Promise<readonly FleetProject[]>(resolve => {
      release = resolve;
    });
    const mounted = await mount(page(storeFor({ projectsPort: { projects: async () => await pending } })));

    expect(mounted.container.textContent).toContain('Loading registered projects…');
    expect(mounted.container.querySelector('[aria-busy="true"]')).not.toBeNull();

    release([]);
    await settle();
    await mounted.unmount();
  });

  it('renders a failed registry read as an alert', async () => {
    const mounted = await mount(
      page(
        storeFor({
          projectsPort: {
            projects: async () => {
              throw new Error('daemon is offline');
            },
          },
        }),
      ),
    );
    await settle();

    expect(must(mounted.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'Could not read this daemon’s project registry: daemon is offline',
    );
    await mounted.unmount();
  });

  it('distinguishes an empty registry from one that has not settled', async () => {
    const mounted = await mount(page(storeFor({ projectsPort: { projects: async () => [] } })));
    await settle();

    expect(mounted.container.textContent).toContain('No projects registered');
    expect(mounted.container.textContent).toContain('Add an existing folder, create one, clone a repository');
    await mounted.unmount();
  });

  it('renders every registered workspace with its daemon-reported path and provenance', async () => {
    const mounted = await mount(page(storeFor({ projectsPort: { projects: async () => [project] } })));
    await settle();

    expect(must(mounted.container.querySelector('h3'), 'the row heading').textContent).toBe('ferretry');
    expect(mounted.container.textContent).toContain('/work/ferretry');
    expect(mounted.container.textContent).toContain('existing folder');
    await mounted.unmount();
  });

  it('shows an unregistered session folder as a discovery and enrols nothing on its own', async () => {
    const mounted = await mount(
      page(
        storeFor({
          projectsPort: { projects: async () => [project] },
          sessions: [
            sessionView('s-1', { config: { cwd: '/home/k/scratch' } }),
            // Nested under a registered root: folded away by the SAME rule the
            // new-session folder picker uses, not by a second one written here.
            sessionView('s-2', { config: { cwd: '/work/ferretry/packages/pwa' } }),
          ],
        }),
      ),
    );
    await settle();

    const rows = [...mounted.container.querySelectorAll('[data-project-discovery]')];
    expect(rows.map(row => row.getAttribute('data-project-discovery'))).toEqual(['/home/k/scratch']);
    await mounted.unmount();
  });

  it('confirms a discovery over POST /v1/projects and refreshes only this daemon’s slice', async () => {
    const reads: number[] = [];
    const projects = new DaemonProjectsStore({
      projects: async () => {
        reads.push(reads.length);
        return reads.length > 1 ? [project, answered] : [project];
      },
    });
    const store = {
      projects,
      fleet: new DaemonFleetStore(fleetPort([sessionView('s-1', { config: { cwd: '/home/k/scratch' } })])),
    } as AppStore;
    const sent: { url: string; method?: string; body?: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(answered), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const mounted = await mount(page(store));
    await settle();
    await press(must(mounted.container.querySelector('[data-project-discovery] button'), 'the confirm button'));
    await settle();

    expect(sent).toEqual([
      {
        url: 'https://workstation.example.test/v1/projects',
        method: 'POST',
        body: { kind: 'confirmed-discovery', path: '/home/k/scratch' },
      },
    ]);
    // The write refreshed the registry, so the folder is a project now and no
    // longer offered as a discovery.
    expect(reads.length).toBe(2);
    expect(mounted.container.querySelector('[data-project-discovery]')).toBeNull();
    expect(must(mounted.container.querySelector('[role="status"]'), 'the notice').textContent).toContain(
      'Registered — scratch',
    );
    await mounted.unmount();
  });

  it('reports that a folder was already registered rather than claiming it created one', async () => {
    const store = storeFor({ projectsPort: { projects: async () => [{ ...project, ...answered }] } });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(answered), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;

    const mounted = await mount(page(store));
    await settle();
    await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
    const label = [...mounted.container.querySelectorAll('label')].find(node =>
      (node.textContent ?? '').startsWith('Folder'),
    );
    await type(
      must(
        mounted.container.querySelector<HTMLInputElement>(`#${must(label, 'the label').getAttribute('for')}`),
        'field',
      ),
      '/home/k/scratch',
    );
    await press(must(mounted.container.querySelector('button[type="submit"]'), 'the submit button'));
    await settle();

    expect(must(mounted.container.querySelector('[role="status"]'), 'the notice').textContent).toContain(
      'Already registered',
    );
    await mounted.unmount();
  });

  it('keeps the draft and states the refusal verbatim when the daemon says no', async () => {
    const store = storeFor({ projectsPort: { projects: async () => [] } });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'ENOENT: no such file or directory', code: 'project_registration_failed' }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      )) as unknown as typeof globalThis.fetch;

    const mounted = await mount(page(store));
    await settle();
    await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
    const label = [...mounted.container.querySelectorAll('label')].find(node =>
      (node.textContent ?? '').startsWith('Folder'),
    );
    const field = must(
      mounted.container.querySelector<HTMLInputElement>(`#${must(label, 'the label').getAttribute('for')}`),
      'the field',
    );
    await type(field, '/work/a/b');
    await press(must(mounted.container.querySelector('button[type="submit"]'), 'the submit button'));
    await settle();

    const alerts = [...mounted.container.querySelectorAll('[role="alert"]')].map(node => node.textContent ?? '');
    expect(alerts.some(text => text.includes('ENOENT: no such file or directory'))).toBe(true);
    expect(mounted.container.querySelector('form')).not.toBeNull();
    expect(field.value).toBe('/work/a/b');
    await mounted.unmount();
  });

  it('dismisses a settled notice', async () => {
    const store = storeFor({ projectsPort: { projects: async () => [] } });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(answered), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;

    const mounted = await mount(page(store));
    await settle();
    await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
    const label = [...mounted.container.querySelectorAll('label')].find(node =>
      (node.textContent ?? '').startsWith('Folder'),
    );
    await type(
      must(
        mounted.container.querySelector<HTMLInputElement>(`#${must(label, 'the label').getAttribute('for')}`),
        'field',
      ),
      '/home/k/scratch',
    );
    await press(must(mounted.container.querySelector('button[type="submit"]'), 'the submit button'));
    await settle();
    await press(must(mounted.container.querySelector('[role="status"] button'), 'the dismiss button'));

    expect(mounted.container.querySelector('[role="status"]')).toBeNull();
    await mounted.unmount();
  });

  it('abandons a write that settles after the page moved to another daemon', async () => {
    const workstationRows = [project];
    const laptopRows: readonly FleetProject[] = [];
    const projects = new DaemonProjectsStore({
      projects: async connection => (connection.daemonId === 'workstation' ? workstationRows : laptopRows),
    });
    const store = { projects, fleet: new DaemonFleetStore(fleetPort([])) } as AppStore;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      await held;
      return new Response(JSON.stringify(answered), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const element = (connection: DaemonConnection) => (
      <StoreProvider store={store}>
        <ProjectsPage connection={connection} />
      </StoreProvider>
    );
    const mounted = await mount(element(daemon));
    await settle();
    await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
    await type(pathField(mounted), '/home/k/scratch');
    await press(must(mounted.container.querySelector('button[type="submit"]'), 'the submit button'));

    // The reader moves to the OTHER daemon while the write is still open.
    await mounted.render(element(laptop));
    await settle();
    release();
    await settle();

    // Workstation's answer never becomes the laptop's screen, and the laptop's
    // slice is still the laptop's own read rather than one taken under
    // workstation's credential.
    expect(mounted.container.querySelector('[role="status"]')).toBeNull();
    expect(projects.projects(laptop.daemonId)).toEqual([]);
    expect(projects.projects(daemon.daemonId)).toEqual(workstationRows);
    await mounted.unmount();
  });

  it('abandons a refusal that settles after a re-pair of the SAME daemon id', async () => {
    const projects = new DaemonProjectsStore({ projects: async () => [] });
    const store = { projects, fleet: new DaemonFleetStore(fleetPort([])) } as AppStore;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      await held;
      return new Response(JSON.stringify({ error: 'the old token was revoked' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const element = (connection: DaemonConnection) => (
      <StoreProvider store={store}>
        <ProjectsPage connection={connection} />
      </StoreProvider>
    );
    const mounted = await mount(element(daemon));
    await settle();
    await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
    await type(pathField(mounted), '/home/k/scratch');
    await press(must(mounted.container.querySelector('button[type="submit"]'), 'the submit button'));

    // Same daemon id, replaced device token: a re-pair, not a different machine.
    // The status must still be dropped, because the refusal belongs to a
    // credential that no longer exists.
    await mounted.render(element(daemonConnection({ ...daemon, deviceToken: 'rotated-token' })));
    await settle();
    release();
    await settle();

    const alerts = [...mounted.container.querySelectorAll('[role="alert"]')].map(node => node.textContent ?? '');
    expect(alerts.some(text => text.includes('the old token was revoked'))).toBe(false);
    // The draft is kept: "this browser can no longer tell you what happened" is
    // not a reason to delete what somebody typed.
    expect(pathField(mounted).value).toBe('/home/k/scratch');
    await mounted.unmount();
  });

  it('states that discoveries are unknown while the session list is unread', async () => {
    let releaseSessions: (sessions: readonly SessionView[]) => void = () => undefined;
    const pendingSessions = new Promise<readonly SessionView[]>(resolve => {
      releaseSessions = resolve;
    });
    const store = {
      projects: new DaemonProjectsStore({ projects: async () => [] }),
      fleet: new DaemonFleetStore({
        list: async () => await pendingSessions,
        get: async () => {
          throw new Error('unused');
        },
      }),
    } as AppStore;

    const mounted = await mount(page(store));
    await settle();

    expect(mounted.container.querySelector('[data-project-discoveries-state="unread"]')).not.toBeNull();
    releaseSessions([]);
    await settle();
    expect(mounted.container.querySelector('[data-project-discoveries-state="none"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('names the reason when the session list itself could not be read', async () => {
    const store = {
      projects: new DaemonProjectsStore({ projects: async () => [] }),
      fleet: new DaemonFleetStore({
        list: async () => {
          throw new Error('daemon is offline');
        },
        get: async () => {
          throw new Error('unused');
        },
      }),
    } as AppStore;

    const mounted = await mount(page(store));
    await settle();

    expect(
      must(mounted.container.querySelector('[data-project-discoveries-state="unread"]'), 'the state').textContent,
    ).toContain('daemon is offline');
    await mounted.unmount();
  });
});
