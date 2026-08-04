import { describe, expect, it } from 'bun:test';

import { ProjectsPage } from '../../../src/features/projects/projects-page.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../../src/lib/fleet-grouping.ts';
import { type DaemonProjectsPort, DaemonProjectsStore } from '../../../src/lib/projects-store.ts';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { interact, mount } from '../../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'device-token',
});

const project: FleetProject = { name: 'ferretry', path: '/work/ferretry' };

const storeFor = (port: DaemonProjectsPort): AppStore => ({ projects: new DaemonProjectsStore(port) }) as AppStore;

const page = (store: AppStore) => (
  <StoreProvider store={store}>
    <ProjectsPage connection={daemon} />
  </StoreProvider>
);

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('ProjectsPage', () => {
  it('keeps an unread registry visibly loading instead of calling it empty', async () => {
    let release: (projects: readonly FleetProject[]) => void = () => undefined;
    const pending = new Promise<readonly FleetProject[]>(resolve => {
      release = resolve;
    });
    const mounted = await mount(page(storeFor({ projects: async () => await pending })));

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
          projects: async () => {
            throw new Error('daemon is offline');
          },
        }),
      ),
    );
    await settle();

    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not read this daemon’s project registry: daemon is offline',
    );
    await mounted.unmount();
  });

  it('distinguishes an empty registry from one that has not settled', async () => {
    const mounted = await mount(page(storeFor({ projects: async () => [] })));
    await settle();

    expect(mounted.container.textContent).toContain('No projects registered');
    expect(mounted.container.textContent).toContain('Add an existing folder, create one, clone a repository');
    await mounted.unmount();
  });

  it('renders every registered workspace with its daemon-reported path', async () => {
    const mounted = await mount(page(storeFor({ projects: async () => [project] })));
    await settle();

    expect(mounted.container.querySelector('h2')?.textContent).toBe('ferretry');
    expect(mounted.container.textContent).toContain('/work/ferretry');
    expect(mounted.container.textContent).toContain('Registered workspace folder');
    await mounted.unmount();
  });
});
