import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import type { FerretRow } from '../../../app/lib/ferrets.ts';
import { ProjectDetailPage } from '../../../app/views/project-detail.tsx';
import { type Call, clickEvent, ferret, PROJECT, refusal, SWITCH_OFF, scripted, typeInto } from './support/client.ts';

const LIST = 'GET /v1/projects';
const FERRETS = 'GET /v1/ferrets';
const START = 'POST /v1/ferrets';
const SWITCH = 'GET /v1/board/projects/:projectId/switch';
const PUT_SWITCH = 'PUT /v1/board/projects/:projectId/switch';

const detail = (client: ProjectsClient, projectId: string = PROJECT.id, daemon = 'workstation') => (
  <RouterProvider>
    <ProjectDetailPage client={client} daemon={daemon} projectId={projectId} />
  </RouterProvider>
);

const client = (ferrets: readonly FerretRow[] | Error = [], extra: Record<string, unknown> = {}, calls?: Call[]) =>
  scripted({ [LIST]: [PROJECT], [FERRETS]: ferrets, [SWITCH]: SWITCH_OFF, ...extra }, calls);

const settled = async (mounted: Mounted, ready: (container: HTMLElement) => boolean, what: string): Promise<void> => {
  await settleUntil(() => ready(mounted.container), what, interact);
};

const shown = async (mounted: Mounted): Promise<void> =>
  await settled(mounted, c => c.querySelector(`[data-project-detail="${PROJECT.id}"]`) !== null, 'the project page');

const press = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(clickEvent()));
};

const buttonSaying = (mounted: Mounted, text: string): HTMLButtonElement =>
  must(
    [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      (button.textContent ?? '').includes(text),
    ),
    `the "${text}" button`,
  );

describe('ProjectDetailPage', () => {
  it('keeps an unread registry visibly loading instead of calling the project missing', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<readonly unknown[]>(resolve => {
      release = () => resolve([PROJECT]);
    });
    const mounted = await mount(detail(scripted({ [LIST]: () => pending, [FERRETS]: [], [SWITCH]: SWITCH_OFF })));

    expect(mounted.container.textContent).toContain('Loading this daemon’s project registry…');
    expect(mounted.container.querySelector('[data-project-detail="missing"]')).toBeNull();
    release();
    await shown(mounted);
    await mounted.unmount();
  });

  it('names the reason the project registry could not be read', async () => {
    const mounted = await mount(detail(scripted({ [LIST]: new Error('daemon is offline'), [FERRETS]: [] })));
    await settled(mounted, c => c.querySelector('[role="alert"]') !== null, 'the alert');

    expect(must(mounted.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'Could not read this daemon’s project registry: daemon is offline',
    );
    await mounted.unmount();
  });

  it('keeps a bookmark to a project this daemon no longer holds', async () => {
    const mounted = await mount(detail(client(), '33333333-3333-4333-8333-333333333333'));
    await settled(mounted, c => c.querySelector('[data-project-detail="missing"]') !== null, 'the missing page');

    expect(mounted.container.textContent).toContain('This daemon no longer holds that project');
    await press(buttonSaying(mounted, 'View registered projects'));
    expect(window.location.pathname).toBe('/d/workstation/projects');
    await mounted.unmount();
  });

  it('renders the project with its provenance, its board switch, its ferrets and its files', async () => {
    const mounted = await mount(detail(client([ferret('f-1', '/work/ferretry', { name: 'hayden' })])));
    await shown(mounted);
    await settled(mounted, c => c.querySelector('[data-project-board-switch="off"]') !== null, 'the board switch');

    const sections = [...mounted.container.querySelectorAll('section[aria-label]')].map(node =>
      node.getAttribute('aria-label'),
    );
    expect(sections).toEqual(['Provenance', 'Board', 'Active ferrets', 'Files of this project’s ferrets']);
    expect(must(mounted.container.querySelector('h1'), 'the title').textContent).toBe('ferretry');
    expect(mounted.container.querySelector('[data-project-provenance="/work/ferretry"]')).not.toBeNull();
    expect(must(mounted.container.querySelector('[data-project-agents="ready"]'), 'the ferrets').textContent).toContain(
      'hayden',
    );
    expect(
      must(mounted.container.querySelector('[data-project-files="f-1"] a'), 'the files link').getAttribute('href'),
    ).toBe('/d/workstation/ferrets/f-1');
    await mounted.unmount();
  });

  it('says a project with no ferret has no files to browse', async () => {
    const mounted = await mount(detail(client([])));
    await settled(mounted, c => c.querySelector('[data-project-files="unavailable"]') !== null, 'the files state');

    expect(mounted.container.querySelector('[data-project-agents="empty"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('does not count a stopped ferret as one still working here', async () => {
    const mounted = await mount(detail(client([ferret('done', '/work/ferretry', { state: 'stopped' })])));
    await settled(mounted, c => c.querySelector('[data-project-agents="empty"]') !== null, 'the empty ferret list');

    // Its files are still the newest ferret's, stopped or not.
    expect(mounted.container.querySelector('[data-project-files="done"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('keeps an unread ferret list loading rather than claiming the project is idle', async () => {
    const pending = new Promise<readonly FerretRow[]>(() => undefined);
    const mounted = await mount(detail(client([], { [FERRETS]: () => pending })));
    await shown(mounted);

    expect(mounted.container.querySelector('[data-project-agents="unread"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-project-files="unread"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-project-agents="empty"]')).toBeNull();
    await mounted.unmount();
  });

  it('names a failed ferret read instead of spinning on it forever', async () => {
    const mounted = await mount(detail(client(new Error('daemon is offline'))));
    await settled(mounted, c => c.querySelector('[data-project-agents="failed"]') !== null, 'the failed read');

    expect(mounted.container.querySelector('[data-project-agents="failed"]')?.textContent).toContain(
      'daemon is offline',
    );
    expect(mounted.container.querySelector('[data-project-files="failed"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('opens a listed ferret on this daemon and no other', async () => {
    const mounted = await mount(detail(client([ferret('f-1', '/work/ferretry')])));
    await settled(mounted, c => c.querySelector('[data-project-agents="ready"] a') !== null, 'the open link');

    await press(must(mounted.container.querySelector('[data-project-agents="ready"] a'), 'the open link'));
    expect(window.location.pathname).toBe('/d/workstation/ferrets/f-1');
    await mounted.unmount();
  });

  it('returns to the registry of the daemon whose project this is', async () => {
    const mounted = await mount(detail(client()));
    await shown(mounted);

    await press(buttonSaying(mounted, 'Back to Projects'));
    expect(window.location.pathname).toBe('/d/workstation/projects');
    await mounted.unmount();
  });

  it('starts an interactive ferret in the project folder and lands on the ferret it created', async () => {
    const calls: Call[] = [];
    const mounted = await mount(detail(client([], { [START]: { id: 'f-created' } }, calls)));
    await shown(mounted);

    await press(buttonSaying(mounted, 'Start a ferret'));
    const field = must(
      mounted.container.querySelector<HTMLInputElement>('#project-launch-runtime-name'),
      'the runtime field',
    );
    await interact(() => typeInto(field, 'claude-code'));
    await press(buttonSaying(mounted, 'Start interactive ferret'));
    await settleUntil(
      () => window.location.pathname === '/d/workstation/ferrets/f-created',
      'the new ferret',
      interact,
    );

    expect(calls.filter(call => call.route === START).map(call => call.body)).toEqual([
      { runtime: 'claude-code', folder: '/work/ferretry', mode: 'interactive' },
    ]);
    await mounted.unmount();
  });
});

describe('ProjectDetailPage lane editor entry', () => {
  it('opens the lane editor on this project’s own board from the header', async () => {
    const mounted = await mount(detail(client()));
    await shown(mounted);

    const lanes = must(mounted.container.querySelector(`[data-project-lanes-link="${PROJECT.id}"]`), 'the Lanes entry');
    expect(lanes.textContent).toBe('Lanes ✎');
    await press(lanes);

    // Board opens its lane editor only for `?lanes=1`; without it this button would land on the board itself.
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/d/workstation/board/${PROJECT.id}?lanes=1`);
    await mounted.unmount();
  });
});

describe('the project’s board switch', () => {
  it('reads the project’s switch, says who decided, and puts the owner’s change', async () => {
    const calls: Call[] = [];
    const mounted = await mount(
      detail(client([], { [PUT_SWITCH]: { ...SWITCH_OFF, on: true, setBy: 'owner' } }, calls)),
    );
    await settled(mounted, c => c.querySelector('[data-project-board-switch="off"]') !== null, 'the switch');
    expect(mounted.container.textContent).toContain('Off by default.');

    await press(must(mounted.container.querySelector('[role="switch"]'), 'the switch'));
    await settled(mounted, c => c.querySelector('[data-project-board-switch="on"]') !== null, 'the switch on');

    expect(calls.filter(call => call.route === PUT_SWITCH).map(call => [call.params, call.body])).toEqual([
      [{ projectId: PROJECT.id }, { on: true }],
    ]);
    expect(mounted.container.textContent).toContain('You set this.');
    await mounted.unmount();
  });

  it('keeps the state and says why when the change is refused', async () => {
    const mounted = await mount(detail(client([], { [PUT_SWITCH]: refusal(403, 'only the owner sets this') })));
    await settled(mounted, c => c.querySelector('[data-project-board-switch="off"]') !== null, 'the switch');

    await press(must(mounted.container.querySelector('[role="switch"]'), 'the switch'));
    await settled(mounted, c => c.querySelector('[data-project-board-switch] [role="alert"]') !== null, 'the refusal');

    expect(mounted.container.querySelector('[data-project-board-switch="off"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('The switch did not change: only the owner sets this');
    await mounted.unmount();
  });

  it('tells a daemon with Board off from a failed read', async () => {
    const off = await mount(detail(client([], { [SWITCH]: refusal(404, 'no such route') })));
    await settled(off, c => c.querySelector('[data-project-board-switch="missing"]') !== null, 'board off');
    await off.unmount();

    const failed = await mount(detail(client([], { [SWITCH]: refusal(500, 'the board store is unreadable') })));
    await settled(failed, c => c.querySelector('[data-project-board-switch="failed"]') !== null, 'a failed read');
    expect(failed.container.textContent).toContain('the board store is unreadable');
    await failed.unmount();
  });
});
