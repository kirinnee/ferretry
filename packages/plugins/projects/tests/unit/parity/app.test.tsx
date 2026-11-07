/**
 * Projects' app half, parity with today's Projects surfaces (docs/design/rebuild-parity.tsv, owner `projects`, kind S).
 * Every surface is proved by drawing it: the half the shell builds is mounted, and each screen is rendered against a
 * scripted daemon client. The detailed behaviour of each view is in `tests/unit/app/*.test.tsx`.
 */
import { describe, expect, test } from 'bun:test';
import type { AppComponent, PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { type ReactNode, Suspense } from 'react';
import app from '../../../app/index.ts';
import { useKnownProjects } from '../../../app/hooks/use-projects.ts';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import { projectBoardPath, projectLanesPath, projectPath, projectsPath } from '../../../app/lib/paths.ts';
import { projectsStoreFor } from '../../../app/views/context.ts';
import { ProjectDetailPage } from '../../../app/views/project-detail.tsx';
import { ProjectsPage } from '../../../app/views/projects-page.tsx';
import manifest from '../../../manifest.ts';
import { clickEvent, ferret, PROJECT, SWITCH_OFF, scripted } from '../app/support/client.ts';

const ROUTES = {
  'GET /v1/projects': [PROJECT],
  'GET /v1/ferrets': [ferret('f-1', '/work/ferretry', { name: 'hayden' }), ferret('f-2', '/home/k/scratch')],
  'GET /v1/board/projects/:projectId/switch': SWITCH_OFF,
};

const asPluginClient = (client: ProjectsClient): PluginClient =>
  ({ ...client, subscribe: () => () => undefined }) as PluginClient;

const routed = (children: ReactNode) => (
  <RouterProvider>
    <Suspense fallback={<p data-suspended="">loading</p>}>{children}</Suspense>
  </RouterProvider>
);

const settled = async (mounted: Mounted, ready: (container: HTMLElement) => boolean, what: string): Promise<void> => {
  await settleUntil(() => ready(mounted.container), what, interact);
};

/** Mounts one screen the shell would build, exactly as the half returns it (lazy, suspending on first use). */
const screen = async (id: 'projects' | 'project'): Promise<Mounted> => {
  const half = app.build?.({ manifest, client: asPluginClient(scripted(ROUTES)) });
  const Screen = must(half?.screens[id], `the ${id} screen`) as AppComponent<ScreenProps> as (
    props: ScreenProps,
  ) => ReactNode;
  return await mount(routed(<Screen params={{ id: PROJECT.id }} />));
};

describe('app parity', () => {
  test('S-0402 S-0351 S-0187 S-0188 the projects screen is the registry page', async () => {
    expect(manifest.ui?.screens?.map(entry => entry.id)).toEqual(['projects', 'project']);
    // The built screen loads its view module and draws; the testing router names no daemon, so it asks for one.
    const built = await screen('projects');
    await settled(built, c => c.querySelector('[data-suspended]') === null, 'the screen module');
    expect(built.container.textContent).toContain('Open a paired daemon to see its projects.');
    await built.unmount();

    // Bound to a daemon, the registry page draws the registered row, the add form's disclosure and the discoveries.
    const page = await mount(routed(<ProjectsPage client={scripted(ROUTES)} daemon="workstation" />));
    await settled(page, c => c.querySelector('[data-project-discovery]') !== null, 'the registry page');
    expect(must(page.container.querySelector('#projects-heading'), 'the heading').textContent).toBe('Projects');
    expect(must(page.container.querySelector('h3 a'), 'the registered row').getAttribute('href')).toBe(
      projectPath('workstation', PROJECT.id),
    );
    expect(page.container.querySelector('[aria-controls="add-project-form"]')).not.toBeNull();
    expect(
      [...page.container.querySelectorAll('[data-project-discovery]')].map(row =>
        row.getAttribute('data-project-discovery'),
      ),
    ).toEqual(['/home/k/scratch']);
    await page.unmount();
  });

  test('S-0400 S-0349 S-0183 S-0184 S-0185 the project screen is the detail page', async () => {
    expect(manifest.ui?.screens?.find(entry => entry.id === 'project')?.path).toBe('/projects/:id');
    const built = await screen('project');
    await settled(built, c => c.querySelector('[data-suspended]') === null, 'the screen module');
    expect(built.container.textContent).toContain('Open a paired daemon to see its projects.');
    await built.unmount();

    const page = await mount(
      routed(<ProjectDetailPage client={scripted(ROUTES)} daemon="workstation" projectId={PROJECT.id} />),
    );
    await settled(page, c => c.querySelector(`[data-project-detail="${PROJECT.id}"]`) !== null, 'the detail page');
    expect(must(page.container.querySelector('h1'), 'the title').textContent).toBe('ferretry');
    await page.unmount();
  });

  test('S-0401 S-0350 S-0186 the lanes of a project are edited on its own board, one link away', async () => {
    expect(projectBoardPath('workstation', PROJECT.id)).toBe(`/d/workstation/board/${PROJECT.id}`);
    expect(projectLanesPath('workstation', PROJECT.id)).toBe(`/d/workstation/board/${PROJECT.id}?lanes=1`);
    const page = await mount(
      routed(<ProjectDetailPage client={scripted(ROUTES)} daemon="workstation" projectId={PROJECT.id} />),
    );
    await settled(page, c => c.querySelector('[data-project-lanes-link]') !== null, 'the Lanes entry');

    await interact(() =>
      must(page.container.querySelector('[data-project-lanes-link]'), 'the Lanes entry').dispatchEvent(clickEvent()),
    );
    expect(`${window.location.pathname}${window.location.search}`).toBe(projectLanesPath('workstation', PROJECT.id));
    await page.unmount();
  });

  test('S-0222 S-0318 the project page draws provenance, board, ferrets and files; the registry page its form and discoveries', async () => {
    const detail = await mount(
      routed(<ProjectDetailPage client={scripted(ROUTES)} daemon="workstation" projectId={PROJECT.id} />),
    );
    await settled(detail, c => c.querySelector('[data-project-agents="ready"]') !== null, 'the ferret list');
    expect(
      [...detail.container.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label')),
    ).toEqual(['Provenance', 'Board', 'Active ferrets', 'Files of this project’s ferrets']);
    await detail.unmount();

    const hub = await mount(routed(<ProjectsPage client={scripted(ROUTES)} daemon="workstation" />));
    await settled(hub, c => c.querySelector('[data-project-discoveries]') !== null, 'the discoveries');
    await interact(() =>
      must(hub.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure').dispatchEvent(
        clickEvent(),
      ),
    );
    expect(hub.container.querySelector('form[aria-label="Register a project"]')).not.toBeNull();
    await hub.unmount();
  });

  test('S-0127 other plugins’ pickers read the project list through the projects port, and the app half keeps a known-list reader', async () => {
    expect(manifest.provides.projects.name).toBe('projects');
    const client = scripted(ROUTES);
    function Known() {
      const projects = useKnownProjects(projectsStoreFor(client));
      return <output>{projects.map(project => project.name).join(',') || 'none'}</output>;
    }
    const known = await mount(<Known />);
    expect(known.container.textContent).toBe('none');
    await interact(async () => {
      await projectsStoreFor(client).hydrate();
    });
    await settled(known, c => c.textContent === 'ferretry', 'the known list');
    await known.unmount();
  });

  test('S-0375 S-0376 S-0377 the addresses of the screens are per daemon and mint only a registered project UUID', () => {
    expect(projectsPath('workstation')).toBe('/d/workstation/projects');
    expect(projectPath('workstation', PROJECT.id)).toBe(`/d/workstation/projects/${PROJECT.id}`);
    expect(() => projectPath('workstation', '/work/ferretry')).toThrow();
    expect(() => projectPath('workstation', '')).toThrow();
  });
});
