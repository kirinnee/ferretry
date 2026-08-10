import { describe, expect, it } from 'bun:test';
import type { ProjectInfo, RegisterProjectRequest } from '@ferretry/protocol';

import type { RecentProjectOption } from '../../../src/components/daemon-picker-model.ts';
import type { ProjectRegistrationStatus } from '../../../src/features/projects/project-registration-model.ts';
import { ProjectsHub } from '../../../src/features/projects/projects-hub.tsx';
import type { FleetProject } from '../../../src/lib/fleet-grouping.ts';
import type { DaemonProjectsSlice } from '../../../src/lib/projects-store.ts';
import { interact, mount, must, type Mounted } from '../../support/dom.ts';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');

const registered: FleetProject = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'clone',
  createdAt: '2026-08-01T10:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
};

const record: ProjectInfo = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'fresh',
  path: '/work/fresh',
  source: 'new-folder',
  createdAt: '2026-08-06T11:00:00.000Z',
};

const discovery: RecentProjectOption = {
  kind: 'recent',
  key: '/home/k/scratch',
  name: 'scratch',
  path: '/home/k/scratch',
  lastActivity: '2026-08-06T10:00:00.000Z',
  searchText: '/home/k/scratch recent',
};

const slice = (patch: Partial<DaemonProjectsSlice> = {}): DaemonProjectsSlice => ({
  projects: [registered],
  status: 'ready',
  error: null,
  ...patch,
});

interface HubOptions {
  readonly onNavigate?: (to: string) => void;
  readonly projectHref?: (projectId: string) => string;
  readonly slice?: DaemonProjectsSlice;
  readonly discoveries?: readonly RecentProjectOption[] | null;
  readonly sessionsError?: string | null;
  readonly status?: ProjectRegistrationStatus | null;
  readonly onRegister?: (request: RegisterProjectRequest) => Promise<boolean>;
  readonly onDismiss?: () => void;
}

const hub = (options: HubOptions = {}) => (
  <ProjectsHub
    slice={options.slice ?? slice()}
    discoveries={options.discoveries === undefined ? [discovery] : options.discoveries}
    sessionsError={options.sessionsError ?? null}
    status={options.status ?? null}
    onRegister={options.onRegister ?? (async () => true)}
    onDismiss={options.onDismiss ?? (() => undefined)}
    {...(options.projectHref === undefined ? {} : { projectHref: options.projectHref })}
    {...(options.onNavigate === undefined ? {} : { onNavigate: options.onNavigate })}
    now={NOW}
  />
);

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

const disclosure = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('[aria-controls="add-project-form"]'), 'the disclosure');

const pathField = (mounted: Mounted): HTMLInputElement => {
  const label = [...mounted.container.querySelectorAll('label')].find(candidate =>
    (candidate.textContent ?? '').startsWith('Folder'),
  );
  const id = must(label, 'the path label').getAttribute('for');
  return must(mounted.container.querySelector<HTMLInputElement>(`#${id}`), 'the path field');
};

describe('ProjectsHub', () => {
  it('leads with the registry and keeps the form behind one dominant action', async () => {
    const mounted = await mount(hub());

    expect(mounted.container.querySelector('form')).toBeNull();
    expect(disclosure(mounted).getAttribute('aria-expanded')).toBe('false');
    expect(disclosure(mounted).getAttribute('data-variant')).toBe('primary');
    expect(must(mounted.container.querySelector('[data-registered-project]'), 'the row').textContent).toContain(
      'ferretry',
    );
    await mounted.unmount();
  });

  it('renders each registered folder with its full provenance, not just a name and a path', async () => {
    const mounted = await mount(hub());

    expect(mounted.container.textContent).toContain('cloned');
    expect(mounted.container.textContent).toContain('/work/ferretry/.git');
    expect(mounted.container.textContent).toContain('2026-08-01');
    await mounted.unmount();
  });

  it('opens and closes the form from the same control', async () => {
    const mounted = await mount(hub());

    await press(disclosure(mounted));
    expect(disclosure(mounted).getAttribute('aria-expanded')).toBe('true');
    expect(mounted.container.querySelector('form')).not.toBeNull();

    await press(disclosure(mounted));
    expect(mounted.container.querySelector('form')).toBeNull();
    await mounted.unmount();
  });

  it('closes the form on cancel and keeps what was typed when it is reopened', async () => {
    const mounted = await mount(hub());

    await press(disclosure(mounted));
    await type(pathField(mounted), '/work/half-typed');
    await press(must(mounted.container.querySelector('form button[type="button"]'), 'the cancel button'));
    expect(mounted.container.querySelector('form')).toBeNull();

    await press(disclosure(mounted));
    expect(pathField(mounted).value).toBe('/work/half-typed');
    await mounted.unmount();
  });

  it('registers the parsed request and clears the draft only once the daemon accepted it', async () => {
    const sent: RegisterProjectRequest[] = [];
    const mounted = await mount(
      hub({
        onRegister: async request => {
          sent.push(request);
          return true;
        },
      }),
    );

    await press(disclosure(mounted));
    await type(pathField(mounted), '/work/new');
    await press(must(mounted.container.querySelector('button[type="submit"]'), 'the submit button'));

    expect(sent).toEqual([{ kind: 'existing-folder', path: '/work/new' }]);
    expect(mounted.container.querySelector('form')).toBeNull();
    await press(disclosure(mounted));
    expect(pathField(mounted).value).toBe('');
    await mounted.unmount();
  });

  it('keeps the draft and the open form when the daemon refuses the write', async () => {
    const mounted = await mount(hub({ onRegister: async () => false }));

    await press(disclosure(mounted));
    await type(pathField(mounted), '/work/refused');
    await press(must(mounted.container.querySelector('button[type="submit"]'), 'the submit button'));

    expect(mounted.container.querySelector('form')).not.toBeNull();
    expect(pathField(mounted).value).toBe('/work/refused');
    await mounted.unmount();
  });

  it('confirms a discovery without opening the form at all', async () => {
    const sent: RegisterProjectRequest[] = [];
    const mounted = await mount(
      hub({
        onRegister: async request => {
          sent.push(request);
          return true;
        },
      }),
    );

    await press(must(mounted.container.querySelector('[data-project-discovery] button'), 'the confirm button'));

    expect(sent).toEqual([{ kind: 'confirmed-discovery', path: '/home/k/scratch' }]);
    expect(mounted.container.querySelector('form')).toBeNull();
    await mounted.unmount();
  });

  it('reports a registration, and says nothing was created when the record already existed', async () => {
    const created = await mount(
      hub({
        status: {
          phase: 'registered',
          request: { kind: 'new-folder', path: '/work/fresh', initializeGit: false },
          project: record,
          alreadyRegistered: false,
        },
      }),
    );
    const notice = must(created.container.querySelector('[role="status"]'), 'the notice');
    expect(notice.textContent).toContain('Registered — fresh');
    expect(notice.textContent).not.toContain('nothing was created');
    expect(created.container.querySelector(`[data-project-registered="${record.id}"]`)).not.toBeNull();
    await created.unmount();

    const existing = await mount(
      hub({
        status: {
          phase: 'registered',
          request: { kind: 'existing-folder', path: '/work/fresh' },
          project: record,
          alreadyRegistered: true,
        },
      }),
    );
    expect(must(existing.container.querySelector('[role="status"]'), 'the notice').textContent).toContain(
      'Already registered',
    );
    expect(existing.container.textContent).toContain('nothing was created');
    await existing.unmount();
  });

  it('dismisses a settled notice, so it cannot outlive what it describes', async () => {
    const dismissed: number[] = [];
    const mounted = await mount(
      hub({
        status: {
          phase: 'registered',
          request: { kind: 'existing-folder', path: '/work/fresh' },
          project: record,
          alreadyRegistered: false,
        },
        onDismiss: () => dismissed.push(1),
      }),
    );

    await press(must(mounted.container.querySelector('[role="status"] button'), 'the dismiss button'));

    expect(dismissed).toEqual([1]);
    await mounted.unmount();
  });

  it('keeps an unread registry visibly loading rather than calling it empty', async () => {
    const mounted = await mount(hub({ slice: { projects: null, status: 'loading', error: null } }));

    expect(must(mounted.container.querySelector('[aria-busy="true"]'), 'the loading panel').textContent).toContain(
      'Loading registered projects…',
    );
    expect(mounted.container.querySelector('[data-registered-state]')).toBeNull();
    await mounted.unmount();
  });

  it('treats an idle slice as unread too, because no read has settled', async () => {
    const mounted = await mount(hub({ slice: { projects: null, status: 'idle', error: null } }));

    expect(mounted.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('distinguishes a positively empty registry from one that was never read', async () => {
    const empty = await mount(hub({ slice: slice({ projects: [] }) }));
    expect(
      must(empty.container.querySelector('[data-registered-state="empty"]'), 'the empty state').textContent,
    ).toContain('No projects registered');
    await empty.unmount();

    const unread = await mount(hub({ slice: { projects: null, status: 'error', error: 'daemon is offline' } }));
    expect(
      must(unread.container.querySelector('[data-registered-state="unread"]'), 'the unread state').textContent,
    ).toContain('has not read this registry');
    await unread.unmount();
  });

  it('states a failed read beside the folders it already had, and still allows a write', async () => {
    const mounted = await mount(hub({ slice: slice({ status: 'error', error: 'daemon is offline' }) }));

    expect(must(mounted.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'Could not read this daemon’s project registry: daemon is offline',
    );
    // A failed refresh never blanks a good list.
    expect(mounted.container.querySelector('[data-registered-project="/work/ferretry"]')).not.toBeNull();
    await press(disclosure(mounted));
    expect(mounted.container.querySelector('form')).not.toBeNull();
    await mounted.unmount();
  });

  it('counts registered folders, and drops the count when there are none', async () => {
    const some = await mount(hub());
    expect(must(some.container.querySelector('#registered-projects-heading'), 'the heading').textContent).toContain(
      '1',
    );
    await some.unmount();

    const none = await mount(hub({ slice: slice({ projects: [] }) }));
    expect(must(none.container.querySelector('#registered-projects-heading'), 'the heading').textContent).not.toContain(
      '0',
    );
    await none.unmount();
  });

  it('keys a row by its record id when it has one, and by its path when it does not', async () => {
    const mounted = await mount(
      hub({ slice: slice({ projects: [registered, { name: 'bare', path: '/work/bare' }] }) }),
    );

    expect(
      [...mounted.container.querySelectorAll('[data-registered-project]')].map(row =>
        row.getAttribute('data-registered-project'),
      ),
    ).toEqual(['/work/ferretry', '/work/bare']);
    await mounted.unmount();
  });

  it('links only the rows that have a record id, and only when a route was supplied', async () => {
    // Arrange — one registered record and one bare row the grouping type
    // allows. A path is not an identity, so the bare row has nothing to link to.
    const mounted = await mount(
      hub({
        slice: slice({ projects: [registered, { name: 'bare', path: '/work/bare' }] }),
        projectHref: id => `/d/workstation/projects/${id}`,
      }),
    );

    // Assert
    const links = [...mounted.container.querySelectorAll('[data-registered-project] a')];
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/d/workstation/projects/11111111-1111-4111-8111-111111111111',
    ]);
    expect(links[0]?.textContent).toBe('ferretry');
    const rows = [...mounted.container.querySelectorAll('[data-registered-project]')];
    expect(must(rows[1], 'the bare row').querySelector('a')).toBeNull();
    expect(must(rows[1], 'the bare row').textContent).toContain('bare');
    await mounted.unmount();
  });

  it('navigates in-app on a primary click instead of reloading the document', async () => {
    // Arrange
    const navigated: string[] = [];
    const mounted = await mount(
      hub({
        projectHref: id => `/d/workstation/projects/${id}`,
        onNavigate: to => navigated.push(to),
      }),
    );
    const link = must(mounted.container.querySelector('[data-registered-project] a'), 'the project link');

    // Act
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await interact(() => link.dispatchEvent(event));

    // Assert — the router is asked to navigate AND the browser is stopped from
    // leaving. Without the second half the document reloads, every store
    // remounts, and the hub's own draft is discarded.
    expect(navigated).toEqual(['/d/workstation/projects/11111111-1111-4111-8111-111111111111']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets a modifier click through to the browser so open-in-new-tab still works', async () => {
    // Arrange
    const navigated: string[] = [];
    const mounted = await mount(
      hub({
        projectHref: id => `/d/workstation/projects/${id}`,
        onNavigate: to => navigated.push(to),
      }),
    );
    const link = must(mounted.container.querySelector('[data-registered-project] a'), 'the project link');

    // Act — a cmd/ctrl click, and a middle click.
    const meta = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    const middle = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    await interact(() => link.dispatchEvent(meta));
    await interact(() => link.dispatchEvent(middle));

    // Assert — the anchor stays a real href precisely so these keep working, so
    // neither is intercepted and neither is turned into an in-app navigation.
    expect(navigated).toEqual([]);
    expect(meta.defaultPrevented).toBe(false);
    expect(middle.defaultPrevented).toBe(false);
    expect(link.getAttribute('href')).toBe('/d/workstation/projects/11111111-1111-4111-8111-111111111111');
  });

  it('keeps a registered row unlinked when the caller mounted no detail route', async () => {
    // Arrange — the hub is also rendered by suites and harness frames that have
    // no router, so the link is opt-in rather than assumed.
    const mounted = await mount(hub());

    // Assert
    expect(mounted.container.querySelector('[data-registered-project] a')).toBeNull();
    expect(must(mounted.container.querySelector('[data-registered-project] h3'), 'the heading').textContent).toBe(
      'ferretry',
    );
    await mounted.unmount();
  });

  it('passes the discovery projection straight through, including its unread reading', async () => {
    const mounted = await mount(hub({ discoveries: null, sessionsError: 'daemon is offline' }));

    expect(mounted.container.querySelector('[data-project-discoveries-state="unread"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('names the page once, so the route heading is not competing with a section', async () => {
    const mounted = await mount(hub());

    expect([...mounted.container.querySelectorAll('h1')].map(node => node.textContent)).toEqual(['Projects']);
    expect(must(mounted.container.querySelector('section'), 'the page').getAttribute('aria-labelledby')).toBe(
      'projects-heading',
    );
    await mounted.unmount();
  });
});
