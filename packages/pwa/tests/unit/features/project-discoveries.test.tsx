import { describe, expect, it } from 'bun:test';

import type { RecentProjectOption } from '../../../src/components/daemon-picker-model.ts';
import { ProjectDiscoveries } from '../../../src/features/projects/project-discoveries.tsx';
import {
  DISCOVERY_PROMISE,
  type ProjectRegistrationStatus,
} from '../../../src/features/projects/project-registration-model.ts';
import { interact, mount, must } from '../../support/dom.ts';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');

const option = (path: string, lastActivity: string): RecentProjectOption => ({
  kind: 'recent',
  key: path,
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  lastActivity,
  searchText: `${path} recent`,
});

const scratch = option('/home/k/scratch', '2026-08-06T10:00:00.000Z');
const notes = option('/home/k/notes', '2026-08-05T12:00:00.000Z');

const view = (
  discoveries: readonly RecentProjectOption[] | null,
  options: {
    readonly sessionsError?: string | null;
    readonly status?: ProjectRegistrationStatus | null;
    readonly onConfirm?: (path: string) => void;
  } = {},
) => (
  <ProjectDiscoveries
    discoveries={discoveries}
    sessionsError={options.sessionsError ?? null}
    status={options.status ?? null}
    onConfirm={options.onConfirm ?? (() => undefined)}
    now={NOW}
  />
);

const press = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

describe('ProjectDiscoveries', () => {
  it('renders one row per discovery with its path, age and a deliberate confirm', async () => {
    const mounted = await mount(view([scratch, notes]));

    const rows = [...mounted.container.querySelectorAll('[data-project-discovery]')];
    expect(rows.map(row => row.getAttribute('data-project-discovery'))).toEqual(['/home/k/scratch', '/home/k/notes']);
    expect(mounted.container.textContent).toContain('last used 2h ago');
    expect(mounted.container.textContent).toContain(DISCOVERY_PROMISE);
    expect([...mounted.container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual([
      'Confirm /home/k/scratch as a project',
      'Confirm /home/k/notes as a project',
    ]);
    await mounted.unmount();
  });

  it('counts the discoveries beside the heading', async () => {
    const mounted = await mount(view([scratch, notes]));

    expect(must(mounted.container.querySelector('h2'), 'the heading').textContent).toContain('2');
    await mounted.unmount();
  });

  it('offers no bulk action, because a confirm-all is a scan with a delay in front of it', async () => {
    const mounted = await mount(view([scratch, notes]));

    const labels = [...mounted.container.querySelectorAll('button')].map(button => button.textContent ?? '');
    expect(labels.every(label => label.includes('Confirm project'))).toBe(true);
    expect(mounted.container.textContent).not.toContain('Confirm all');
    await mounted.unmount();
  });

  it('confirms exactly the path of the row that was pressed', async () => {
    const confirmed: string[] = [];
    const mounted = await mount(view([scratch, notes], { onConfirm: path => confirmed.push(path) }));

    await press(must(mounted.container.querySelector('[data-project-discovery="/home/k/notes"] button'), 'the button'));

    expect(confirmed).toEqual(['/home/k/notes']);
    await mounted.unmount();
  });

  it('distinguishes an unread session list from a daemon with nothing left to confirm', async () => {
    const unread = await mount(view(null));
    expect(
      must(unread.container.querySelector('[data-project-discoveries-state="unread"]'), 'the unread state').textContent,
    ).toContain('has not been read yet');
    await unread.unmount();

    const none = await mount(view([]));
    expect(
      must(none.container.querySelector('[data-project-discoveries-state="none"]'), 'the empty state').textContent,
    ).toContain('already covered by a registered project');
    expect(none.container.querySelector('h2')?.textContent).not.toContain('0');
    await none.unmount();
  });

  it('names the reason when the session list could not be read', async () => {
    const mounted = await mount(view(null, { sessionsError: 'daemon is offline' }));

    expect(
      must(mounted.container.querySelector('[data-project-discoveries-state="unread"]'), 'the state').textContent,
    ).toContain('could not be read (daemon is offline)');
    await mounted.unmount();
  });

  it('shows the wait on the row being confirmed and on no other', async () => {
    const mounted = await mount(
      view([scratch, notes], {
        status: { phase: 'submitting', request: { kind: 'confirmed-discovery', path: '/home/k/notes' } },
      }),
    );

    const row = (path: string) =>
      must(mounted.container.querySelector(`[data-project-discovery="${path}"] button`), 'a button');
    expect(row('/home/k/notes').textContent).toContain('Confirming…');
    expect(row('/home/k/scratch').textContent).toContain('Confirm project');
    // Every row is disabled while any write is open: two concurrent
    // registrations would race the refresh that follows them.
    expect((row('/home/k/scratch') as HTMLButtonElement).disabled).toBe(true);
    await mounted.unmount();
  });

  it('states a refused confirmation, and stays silent about a refusal from the form', async () => {
    const refused = await mount(
      view([scratch], {
        status: {
          phase: 'refused',
          request: { kind: 'confirmed-discovery', path: '/home/k/scratch' },
          message: 'project path is not an existing directory',
        },
      }),
    );
    expect(must(refused.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'project path is not an existing directory',
    );
    await refused.unmount();

    const elsewhere = await mount(
      view([scratch], {
        status: {
          phase: 'refused',
          request: { kind: 'new-folder', path: '/work/a/b', initializeGit: false },
          message: 'ENOENT',
        },
      }),
    );
    expect(elsewhere.container.querySelector('[role="alert"]')).toBeNull();
    await elsewhere.unmount();
  });
});
