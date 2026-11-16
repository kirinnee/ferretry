import { describe, expect, it } from 'bun:test';
import { interact, mount, settleUntil } from '@ferretry/app/testing';
import type { ProjectInfo } from '../../../contract/index.ts';
import { useKnownProjects, useProjects, useProjectsSlice } from '../../../app/hooks/use-projects.ts';
import { ProjectsStore } from '../../../app/lib/projects-store.ts';
import { ANSWERED, PROJECT } from './support/client.ts';

/**
 * One store per daemon client: the shell hands a half one client per daemon and credential, so "the other daemon" is
 * another store. Each `reads` entry is one registry read the store made.
 */
const storeOf = (rows: readonly ProjectInfo[], reads: string[], name: string): ProjectsStore =>
  new ProjectsStore({
    projects: async () => {
      reads.push(name);
      return rows;
    },
  });

function Names({ store }: { readonly store: ProjectsStore }) {
  const projects = useProjects(store);
  return <output>{projects.length === 0 ? 'none' : projects.map(project => project.name).join(',')}</output>;
}

function Status({ store }: { readonly store: ProjectsStore }) {
  const slice = useProjectsSlice(store);
  return <output>{`${slice.status}:${slice.error ?? '—'}`}</output>;
}

function Known({ store }: { readonly store: ProjectsStore }) {
  const projects = useKnownProjects(store);
  return <output>{projects.length === 0 ? 'none' : projects.map(project => project.name).join(',')}</output>;
}

describe('useProjects', () => {
  it('hydrates on mount and renders only this daemon’s folders', async () => {
    const reads: string[] = [];
    const store = storeOf([PROJECT], reads, 'laptop');
    const { container, unmount } = await mount(<Names store={store} />);
    await settleUntil(() => container.textContent === 'ferretry', 'the laptop rows', interact);

    expect(reads).toEqual(['laptop']);
    await unmount();
  });

  it('re-reads for the other daemon and never shows the first one’s folders', async () => {
    const reads: string[] = [];
    const laptop = storeOf([PROJECT], reads, 'laptop');
    const workstation = storeOf([ANSWERED], reads, 'workstation');
    const { container, render, unmount } = await mount(<Names store={laptop} />);
    await settleUntil(() => container.textContent === 'ferretry', 'the laptop rows', interact);

    await render(<Names store={workstation} />);
    await settleUntil(() => container.textContent === 'scratch', 'the workstation rows', interact);
    expect(reads).toEqual(['laptop', 'workstation']);
    await unmount();
  });
});

describe('useProjectsSlice', () => {
  it('surfaces a failed read as a status rather than throwing out of the mount', async () => {
    const store = new ProjectsStore({
      projects: async () => {
        throw new Error('the catalog is unavailable');
      },
    });
    const { container, unmount } = await mount(<Status store={store} />);
    await settleUntil(
      () => container.textContent === 'error:the catalog is unavailable',
      'the failed-read status',
      interact,
    );
    await unmount();
  });
});

describe('useKnownProjects', () => {
  it('reads what is already known without asking the daemon for anything', async () => {
    const reads: string[] = [];
    const store = storeOf([PROJECT], reads, 'laptop');
    const known = await mount(<Known store={store} />);
    expect(known.container.textContent).toBe('none');
    expect(reads).toEqual([]);

    const active = await mount(<Names store={store} />);
    await settleUntil(() => known.container.textContent === 'ferretry', 'the known rows', interact);
    await active.unmount();
    await known.unmount();
  });
});
