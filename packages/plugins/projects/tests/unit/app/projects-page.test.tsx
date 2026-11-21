import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { ProjectInfo } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import type { FerretRow } from '../../../app/lib/ferrets.ts';
import { projectsStoreFor } from '../../../app/views/context.ts';
import { ProjectsPage } from '../../../app/views/projects-page.tsx';
import { ANSWERED, type Call, clickEvent, ferret, PROJECT, refusal, scripted } from './support/client.ts';

const LIST = 'GET /v1/projects';
const REGISTER = 'POST /v1/projects';
const FERRETS = 'GET /v1/ferrets';
const FOLDERS = 'GET /v1/projects/folders';

/** The explorer's listing of a folder (empty), as the daemon answers it: the page's "Add project" is the Create flow. */
const folderListing = (path: string) => ({
  path,
  crumbs: [{ name: '~', path: '/home/k' }],
  entries: [],
  truncated: false,
});

// The hub's registry rows are in-app links, so the page reads the router. The shell always provides one; these suites
// provide the shell's own (with no plugin screens), so a navigation assertion exercises production code.
const page = (client: ProjectsClient, daemon = 'workstation') => (
  <RouterProvider>
    <ProjectsPage client={client} daemon={daemon} />
  </RouterProvider>
);

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};

const settled = async (mounted: Mounted, ready: (container: HTMLElement) => boolean, what: string): Promise<void> => {
  await settleUntil(() => ready(mounted.container), what, interact);
};

const press = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(clickEvent()));
};

/** The folder the create flow has chosen: what the old typed path field held. */
const chosenFolder = (mounted: Mounted): string =>
  must(mounted.container.querySelector('[data-create-chosen] .mono'), 'the chosen folder').textContent ?? '';

const buttonNamed = (mounted: Mounted, text: string): Element =>
  must(
    [...mounted.container.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === text),
    `the "${text}" button`,
  );

/** Drives the Create-a-project flow to its registration: open it, pick the open folder, name step, create. */
const registerByHand = async (mounted: Mounted, _path: string): Promise<void> => {
  await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
  await settled(mounted, c => c.querySelector('[data-explorer-state="ready"]') !== null, 'the explorer');
  await press(buttonNamed(mounted, 'Next'));
  await press(buttonNamed(mounted, 'Create project'));
};

const registry = (rows: readonly ProjectInfo[], ferrets: readonly FerretRow[] = []) =>
  scripted({ [LIST]: rows, [FERRETS]: ferrets });

describe('ProjectsPage', () => {
  it('opens the add form at once when the address asks for it (?add=1), and keeps it closed otherwise', async () => {
    // The DOM is installed by the first mount; the address is set before the page under test draws.
    await (await mount(<p>dom</p>)).unmount();
    window.history.replaceState({}, '', '/d/workstation/projects?add=1');
    const asked = await mount(page(registry([])));
    expect(asked.container.querySelector('#add-project-form')).not.toBeNull();
    await asked.unmount();
    window.history.replaceState({}, '', '/d/workstation/projects');
    const plain = await mount(page(registry([])));
    expect(plain.container.querySelector('#add-project-form')).toBeNull();
    await plain.unmount();
  });

  it('keeps an unread registry visibly loading instead of calling it empty', async () => {
    let release: (rows: readonly ProjectInfo[]) => void = () => undefined;
    const pending = new Promise<readonly ProjectInfo[]>(resolve => {
      release = resolve;
    });
    const mounted = await mount(page(scripted({ [LIST]: () => pending, [FERRETS]: [] })));

    expect(mounted.container.textContent).toContain('Loading registered projects…');
    expect(mounted.container.querySelector('[data-loading="page"]')).not.toBeNull();

    release([]);
    await settle();
    await mounted.unmount();
  });

  it('renders a failed registry read as an alert', async () => {
    const mounted = await mount(page(scripted({ [LIST]: new Error('daemon is offline'), [FERRETS]: [] })));
    await settled(mounted, c => c.querySelector('[role="alert"]') !== null, 'the alert');

    expect(must(mounted.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'Could not read this daemon’s project registry: daemon is offline',
    );
    await mounted.unmount();
  });

  it('distinguishes an empty registry from one that has not settled', async () => {
    const mounted = await mount(page(registry([])));
    await settled(mounted, c => c.querySelector('[data-registered-state="empty"]') !== null, 'the empty registry');

    expect(mounted.container.textContent).toContain('No projects registered');
    expect(mounted.container.textContent).toContain('A folder on this machine');
    expect(mounted.container.textContent).toContain('Clone a repository');
    await mounted.unmount();
  });

  it('renders every registered project with its daemon-reported path and provenance, linked by its UUID', async () => {
    const mounted = await mount(page(registry([PROJECT])));
    await settled(mounted, c => c.querySelector('h3') !== null, 'the registered row');

    expect(must(mounted.container.querySelector('h3'), 'the row heading').textContent).toBe('ferretry');
    // A card: the path is its tooltip, not a line of text.
    expect(must(mounted.container.querySelector('[data-project-card]'), 'the card').getAttribute('title')).toBe(
      '/work/ferretry',
    );
    expect(mounted.container.textContent).not.toContain('/work/ferretry');
    expect(must(mounted.container.querySelector('h3 a'), 'the row link').getAttribute('href')).toBe(
      `/d/workstation/projects/${PROJECT.id}`,
    );
    await mounted.unmount();
  });

  it('opens a registered project in-app rather than leaving through the document', async () => {
    const mounted = await mount(page(registry([PROJECT])));
    await settled(mounted, c => c.querySelector('h3 a') !== null, 'the row link');

    await press(must(mounted.container.querySelector('h3 a'), 'the row link'));

    expect(window.location.pathname).toBe(`/d/workstation/projects/${PROJECT.id}`);
    await mounted.unmount();
  });

  it('shows an unregistered ferret folder as a discovery and enrols nothing on its own', async () => {
    const calls: Call[] = [];
    const client = scripted(
      {
        [LIST]: [PROJECT],
        [FERRETS]: [
          ferret('f-1', '/home/k/scratch'),
          // Nested under a registered root: folded away by the SAME rule every project lookup uses.
          ferret('f-2', '/work/ferretry/packages/app'),
        ],
      },
      calls,
    );
    const mounted = await mount(page(client));
    await settled(mounted, c => c.querySelector('[data-project-discovery]') !== null, 'a discovery');

    const rows = [...mounted.container.querySelectorAll('[data-project-discovery]')];
    expect(rows.map(row => row.getAttribute('data-project-discovery'))).toEqual(['/home/k/scratch']);
    expect(calls.some(call => call.route === REGISTER)).toBe(false);
    await mounted.unmount();
  });

  it('confirms a discovery over POST /v1/projects and refreshes only this daemon’s slice', async () => {
    const calls: Call[] = [];
    let reads = 0;
    const client = scripted(
      {
        [LIST]: () => {
          reads += 1;
          return reads > 1 ? [PROJECT, ANSWERED] : [PROJECT];
        },
        [FERRETS]: [ferret('f-1', '/home/k/scratch')],
        [REGISTER]: ANSWERED,
      },
      calls,
    );

    const mounted = await mount(page(client));
    await settled(mounted, c => c.querySelector('[data-project-discovery] button') !== null, 'the confirm button');
    await press(must(mounted.container.querySelector('[data-project-discovery] button'), 'the confirm button'));
    await settled(mounted, c => c.querySelector('[data-project-registered]') !== null, 'the notice');
    await settled(mounted, c => c.querySelector('[data-project-discovery]') === null, 'the discovery to fold away');

    expect(calls.filter(call => call.route === REGISTER).map(call => call.body)).toEqual([
      { kind: 'confirmed-discovery', path: '/home/k/scratch' },
    ]);
    // The write refreshed the registry, so the folder is a project now and no longer offered as a discovery.
    expect(reads).toBe(2);
    expect(must(mounted.container.querySelector('[data-project-registered]'), 'the notice').textContent).toContain(
      'Registered — scratch',
    );
    await mounted.unmount();
  });

  it('reports that a folder was already registered rather than claiming it created one', async () => {
    const client = scripted({
      [LIST]: [ANSWERED],
      [FERRETS]: [],
      [FOLDERS]: folderListing('/home/k/scratch'),
      [REGISTER]: ANSWERED,
    });
    const mounted = await mount(page(client));
    await settled(mounted, c => c.querySelector('h3') !== null, 'the registered row');

    await registerByHand(mounted, '/home/k/scratch');
    await settled(mounted, c => c.querySelector('[data-project-registered]') !== null, 'the notice');

    expect(must(mounted.container.querySelector('[data-project-registered]'), 'the notice').textContent).toContain(
      'Already registered',
    );
    await mounted.unmount();
  });

  it('keeps the draft and states the refusal verbatim when the daemon says no', async () => {
    const client = scripted({
      [LIST]: [],
      [FERRETS]: [],
      [FOLDERS]: folderListing('/work/a/b'),
      [REGISTER]: refusal(422, 'ENOENT: no such file or directory', 'project_registration_failed'),
    });
    const mounted = await mount(page(client));
    await settled(mounted, c => c.querySelector('[data-registered-state="empty"]') !== null, 'the empty registry');

    await registerByHand(mounted, '/work/a/b');
    const alerts = (): string[] =>
      [...mounted.container.querySelectorAll('[role="alert"]')].map(node => node.textContent ?? '');
    await settled(mounted, () => alerts().some(text => text.includes('ENOENT')), 'the refusal');

    // The flow stays on the name step with the choice intact, so nothing has to be picked again.
    expect(mounted.container.querySelector('[data-create-step="name"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Your entries are still here');
    await mounted.unmount();
  });

  it('dismisses a settled notice', async () => {
    const client = scripted({
      [LIST]: [],
      [FERRETS]: [],
      [FOLDERS]: folderListing('/home/k/scratch'),
      [REGISTER]: ANSWERED,
    });
    const mounted = await mount(page(client));
    await settled(mounted, c => c.querySelector('[data-registered-state="empty"]') !== null, 'the empty registry');

    await registerByHand(mounted, '/home/k/scratch');
    await settled(mounted, c => c.querySelector('[data-project-registered]') !== null, 'the notice');
    await press(must(mounted.container.querySelector('[data-project-registered] button'), 'the dismiss button'));

    expect(mounted.container.querySelector('[data-project-registered]')).toBeNull();
    await mounted.unmount();
  });

  it('abandons a write that settles after the page moved to another daemon', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const workstation = scripted({
      [LIST]: [PROJECT],
      [FERRETS]: [],
      [FOLDERS]: folderListing('/home/k/scratch'),
      [REGISTER]: async () => {
        await held;
        return ANSWERED;
      },
    });
    const laptop = registry([]);

    const mounted = await mount(page(workstation, 'workstation'));
    await settled(mounted, c => c.querySelector('h3') !== null, 'the workstation registry');
    await registerByHand(mounted, '/home/k/scratch');

    // The reader moves to the OTHER daemon while the write is still open.
    await mounted.render(page(laptop, 'laptop'));
    await settled(mounted, c => c.querySelector('[data-registered-state="empty"]') !== null, 'the laptop registry');
    release();
    await settle();

    // Workstation's answer never becomes the laptop's screen, and the laptop's slice is still the laptop's own read.
    expect(mounted.container.querySelector('[data-project-registered]')).toBeNull();
    expect(projectsStoreFor(laptop).projects()).toEqual([]);
    expect(projectsStoreFor(workstation).projects()).toEqual([PROJECT]);
    await mounted.unmount();
  });

  it('abandons a refusal that settles after a re-pair of the SAME daemon id', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const before = scripted({
      [LIST]: [],
      [FERRETS]: [],
      [FOLDERS]: folderListing('/home/k/scratch'),
      [REGISTER]: async () => {
        await held;
        return refusal(401, 'the old credential was revoked');
      },
    });

    const mounted = await mount(page(before, 'workstation'));
    await settled(mounted, c => c.querySelector('[data-registered-state="empty"]') !== null, 'the empty registry');
    await registerByHand(mounted, '/home/k/scratch');

    // Same daemon id, a new client: a re-pair, not a different machine. The status must still be dropped, because the
    // refusal belongs to a credential that no longer exists.
    await mounted.render(page(registry([]), 'workstation'));
    await settle();
    release();
    await settle();

    const alerts = [...mounted.container.querySelectorAll('[role="alert"]')].map(node => node.textContent ?? '');
    expect(alerts.some(text => text.includes('the old credential was revoked'))).toBe(false);
    // The draft is kept: "this app can no longer tell you what happened" is not a reason to delete what was chosen.
    expect(chosenFolder(mounted)).toBe('/home/k/scratch');
    await mounted.unmount();
  });

  it('states that discoveries are unknown while the ferret list is unread', async () => {
    let release: (rows: readonly FerretRow[]) => void = () => undefined;
    const pending = new Promise<readonly FerretRow[]>(resolve => {
      release = resolve;
    });
    const mounted = await mount(page(scripted({ [LIST]: [], [FERRETS]: () => pending })));
    await settle();

    expect(mounted.container.querySelector('[data-project-discoveries-state="unread"]')).not.toBeNull();
    release([]);
    await settled(
      mounted,
      c => c.querySelector('[data-project-discoveries-state="unread"]') === null,
      'the settled discoveries',
    );
    expect(mounted.container.querySelector('[data-project-discoveries]')).toBeNull();
    await mounted.unmount();
  });

  it('names the reason when the ferret list itself could not be read', async () => {
    const mounted = await mount(page(scripted({ [LIST]: [], [FERRETS]: new Error('daemon is offline') })));
    await settled(
      mounted,
      c =>
        (c.querySelector('[data-project-discoveries-state="unread"]')?.textContent ?? '').includes('daemon is offline'),
      'the named reason',
    );
    await mounted.unmount();
  });
});
