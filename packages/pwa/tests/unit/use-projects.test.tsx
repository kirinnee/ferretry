import { describe, expect, it } from 'bun:test';

import { useKnownProjects, useProjects, useProjectsSlice } from '../../src/hooks/use-projects.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../src/lib/fleet-grouping.ts';
import { type DaemonProjectsPort, DaemonProjectsStore } from '../../src/lib/projects-store.ts';
import { mount } from '../support/dom.ts';

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

const ferretry: FleetProject = { name: 'ferretry', path: '/home/k/ferretry' };
const homeManager: FleetProject = { name: 'home-manager', path: '/home/k/.config/home-manager' };

const port = (reads: string[]): DaemonProjectsPort => ({
  projects: async daemon => {
    reads.push(daemon.daemonId);
    return daemon.daemonId === laptop.daemonId ? [ferretry] : [homeManager];
  },
});

function Names({ store, daemon }: { readonly store: DaemonProjectsStore; readonly daemon: typeof laptop }) {
  const projects = useProjects(store, daemon);
  return <output>{projects.length === 0 ? 'none' : projects.map(project => project.name).join(',')}</output>;
}

function Status({ store, daemon }: { readonly store: DaemonProjectsStore; readonly daemon: typeof laptop }) {
  const slice = useProjectsSlice(store, daemon);
  return <output>{`${slice.status}:${slice.error ?? '—'}`}</output>;
}

function Known({ store, daemon }: { readonly store: DaemonProjectsStore; readonly daemon: typeof laptop }) {
  const projects = useKnownProjects(store, daemon.daemonId);
  return <output>{projects.length === 0 ? 'none' : projects.map(project => project.name).join(',')}</output>;
}

describe('useProjects', () => {
  it('hydrates on mount and renders only this daemon’s folders', async () => {
    const reads: string[] = [];
    const store = new DaemonProjectsStore(port(reads));
    const { container, unmount } = await mount(<Names store={store} daemon={laptop} />);

    expect(container.textContent).toBe('ferretry');
    expect(reads).toEqual([laptop.daemonId]);
    await unmount();
  });

  it('re-reads for the other daemon and never shows the first one’s folders', async () => {
    const reads: string[] = [];
    const store = new DaemonProjectsStore(port(reads));
    const { container, render, unmount } = await mount(<Names store={store} daemon={laptop} />);
    expect(container.textContent).toBe('ferretry');

    await render(<Names store={store} daemon={workstation} />);
    expect(container.textContent).toBe('home-manager');
    expect(reads).toEqual([laptop.daemonId, workstation.daemonId]);
    await unmount();
  });
});

describe('useProjectsSlice', () => {
  it('surfaces a failed read as a status rather than throwing out of the mount', async () => {
    const store = new DaemonProjectsStore({
      projects: async () => {
        throw new Error('the catalog is unavailable');
      },
    });
    const { container, unmount } = await mount(<Status store={store} daemon={laptop} />);
    expect(container.textContent).toBe('error:the catalog is unavailable');
    await unmount();
  });
});

describe('useKnownProjects', () => {
  it('reads what is already known without asking the daemon for anything', async () => {
    const reads: string[] = [];
    const store = new DaemonProjectsStore(port(reads));
    const known = await mount(<Known store={store} daemon={laptop} />);
    expect(known.container.textContent).toBe('none');
    expect(reads).toEqual([]);

    const active = await mount(<Names store={store} daemon={laptop} />);
    expect(known.container.textContent).toBe('ferretry');
    await active.unmount();
    await known.unmount();
  });
});
