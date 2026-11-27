import { describe, expect, it } from 'bun:test';
import {
  interact,
  type Mounted,
  mount,
  must,
  RouterProvider,
  settleUntil,
  ShellContext,
  WithAppHooks,
} from '@ferretry/app/testing';
import { PROJECTS_INSIGHTS_HOOK } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import type { FerretRow } from '../../../app/lib/ferrets.ts';
import { ProjectDetailPage } from '../../../app/views/project-detail.tsx';
import { ANSWERED, type Call, clickEvent, ferret, PROJECT, refusal, SWITCH_OFF, scripted } from './support/client.ts';
import { answerFor, FILES, summaryOf } from './support/finder-fixtures.ts';

const LIST = 'GET /v1/projects';
const FERRETS = 'GET /v1/ferrets';
const SWITCH = 'GET /v1/board/projects/:projectId/switch';
const PUT_SWITCH = 'PUT /v1/board/projects/:projectId/switch';

const detail = (client: ProjectsClient, projectId: string = PROJECT.id, daemon = 'workstation') => (
  <RouterProvider>
    <ProjectDetailPage client={client} daemon={daemon} projectId={projectId} />
  </RouterProvider>
);

const client = (ferrets: readonly FerretRow[] | Error = [], extra: Record<string, unknown> = {}, calls?: Call[]) =>
  scripted(
    {
      [LIST]: [PROJECT],
      [FERRETS]: ferrets,
      [SWITCH]: SWITCH_OFF,
      // The project's file finder (&F6061 U7) reads the folder, not the ferret list: it answers whatever the ferrets do.
      [FILES]: (call: Call) => answerFor(summaryOf(), call.query?.q, Number(call.query?.limit ?? 50)),
      ...extra,
    },
    calls,
  );

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
  it('draws another plugin’s insights section, with this project’s id, only when one is provided', async () => {
    const seen: unknown[] = [];
    const panel = (props: unknown) => {
      seen.push(props);
      return <p data-insights="">insight body</p>;
    };
    let mounted = await mount(
      <WithAppHooks provided={{ [PROJECTS_INSIGHTS_HOOK]: { title: 'PRs & CI', panel } }}>
        {detail(client())}
      </WithAppHooks>,
    );
    await shown(mounted);
    expect(mounted.container.querySelector('[aria-label="PRs & CI"] [data-insights]')?.textContent).toBe(
      'insight body',
    );
    expect(seen[0]).toEqual({ project: PROJECT.id, daemon: 'workstation' });
    await mounted.unmount();
    // No provider: no section, and nothing else changes.
    mounted = await mount(detail(client()));
    await shown(mounted);
    expect(mounted.container.querySelector('[aria-label="PRs & CI"]')).toBeNull();
    await mounted.unmount();
  });

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
    expect(sections).toEqual([
      'Provenance',
      'Repositories',
      'GitHub accounts',
      'Board',
      'Active ferrets',
      'Branches & worktrees',
      'Files',
    ]);
    expect(must(mounted.container.querySelector('h1'), 'the title').textContent).toBe('ferretry');
    expect(mounted.container.querySelector('[data-project-provenance="/work/ferretry"]')).not.toBeNull();
    expect(must(mounted.container.querySelector('[data-project-agents="ready"]'), 'the ferrets').textContent).toContain(
      'hayden',
    );
    await settled(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the finder rows');
    expect(
      must(mounted.container.querySelector('[data-project-files-ferret="f-1"] a'), 'the ferret link').getAttribute(
        'href',
      ),
    ).toBe('/d/workstation/ferrets/f-1');
    await mounted.unmount();
  });

  it('draws the project’s file finder over the project folder, with or without a ferret there', async () => {
    const calls: Call[] = [];
    const mounted = await mount(detail(client([], {}, calls)));
    await settled(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the finder rows');

    expect(mounted.container.querySelector('[data-project-agents="empty"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-project-files-ferret]')).toBeNull();
    const read = must(
      calls.find(call => call.route === FILES),
      'the files read',
    );
    expect(read.params).toEqual({ id: PROJECT.id });
    await mounted.unmount();
  });

  it('does not count a stopped ferret as one still working here, and still links its files', async () => {
    const mounted = await mount(detail(client([ferret('done', '/work/ferretry', { state: 'stopped' })])));
    await settled(mounted, c => c.querySelector('[data-project-agents="empty"]') !== null, 'the empty ferret list');

    // The newest ferret's browser is still where a file is opened, stopped or not.
    await settled(mounted, c => c.querySelector('[data-project-files-ferret="done"]') !== null, 'the ferret link');
    await mounted.unmount();
  });

  it('keeps an unread ferret list loading rather than claiming the project is idle; the finder does not wait for it', async () => {
    const pending = new Promise<readonly FerretRow[]>(() => undefined);
    const mounted = await mount(detail(client([], { [FERRETS]: () => pending })));
    await shown(mounted);

    expect(mounted.container.querySelector('[data-loading="background"]')).not.toBeNull();
    await settled(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the finder rows');
    // An unread list is not an absent ferret, and not a present one either: no link is offered.
    expect(mounted.container.querySelector('[data-project-files-ferret]')).toBeNull();
    expect(mounted.container.querySelector('[data-project-agents="empty"]')).toBeNull();
    await mounted.unmount();
  });

  it('names a failed ferret read instead of spinning on it forever, and the finder still works', async () => {
    const mounted = await mount(detail(client(new Error('daemon is offline'))));
    await settled(mounted, c => c.querySelector('[data-project-agents="failed"]') !== null, 'the failed read');

    expect(mounted.container.querySelector('[data-project-agents="failed"]')?.textContent).toContain(
      'daemon is offline',
    );
    await settled(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the finder rows');
    expect(mounted.container.querySelector('[data-project-files-ferret]')).toBeNull();
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

  it('starts a ferret from one fixed-width button that opens New ferret with this folder, and has no start form of its own', async () => {
    const calls: Call[] = [];
    const mounted = await mount(detail(client([], {}, calls)));
    await shown(mounted);

    const starts = [...mounted.container.querySelectorAll('button')].filter(button =>
      (button.textContent ?? '').includes('Start a ferret'),
    );
    expect(starts.map(button => button.textContent?.trim())).toEqual(['Start a ferret here']);
    expect(mounted.container.querySelector('#project-launch-runtime-name')).toBeNull();
    expect(mounted.container.textContent).not.toContain('Top-level interactive');
    expect(mounted.container.textContent).toContain('Starts in this project’s folder');

    await press(buttonSaying(mounted, 'Start a ferret here'));
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      `/d/workstation/new?folder=${encodeURIComponent('/work/ferretry')}`,
    );
    // The page never starts a ferret itself: the one start form (and its request id) is New ferret's.
    expect(calls.filter(call => call.route === 'POST /v1/ferrets')).toEqual([]);
    await mounted.unmount();
  });
});

describe('ProjectDetailPage lane editor entry', () => {
  it('opens the lane editor on this project’s own board from the header', async () => {
    const mounted = await mount(detail(client()));
    await shown(mounted);

    const lanes = must(mounted.container.querySelector(`[data-project-lanes-link="${PROJECT.id}"]`), 'the Lanes entry');
    expect(lanes.textContent).toBe('Edit lanes');
    expect(mounted.container.textContent ?? '', 'no registry eyebrow').not.toContain('Workspace registry');
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

  it('draws no Board section at all once the shell says this daemon has Board turned off (the work switch)', async () => {
    const calls: Call[] = [];
    const inShell = (boardOn: boolean) => {
      const board = { id: 'board' };
      const runtime = {
        surfaces: [board],
        listedSurfaces: () => (boardOn ? [board] : []),
        subscribe: () => () => undefined,
        version: () => 0,
        appHook: () => undefined,
      };
      return (
        <ShellContext.Provider value={{ runtime } as never}>{detail(client([], {}, calls))}</ShellContext.Provider>
      );
    };
    const sectionsOf = (mounted: Mounted) =>
      [...mounted.container.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label'));

    const off = await mount(inShell(false));
    await shown(off);
    expect(sectionsOf(off)).not.toContain('Board');
    expect(off.container.querySelector('[data-project-board-switch]')).toBeNull();
    // it did not even ask Board for the switch
    expect(calls.some(call => call.route === SWITCH)).toBe(false);
    await off.unmount();

    const on = await mount(inShell(true));
    await shown(on);
    expect(sectionsOf(on)).toContain('Board');
    await on.unmount();
  });

  it('links GitHub accounts to an existing project: sends the ordered list and re-renders the links', async () => {
    const calls: Call[] = [];
    let linked: readonly string[] = [];
    const accounts = [
      { id: 'gha_1', login: 'octocat', keys: {} },
      { id: 'gha_2', login: 'hubot', keys: {} },
    ];
    const mounted = await mount(
      detail(
        client(
          [],
          {
            'GET /v1/git-accounts': accounts,
            [LIST]: () => [{ ...PROJECT, accounts: linked }],
            'PUT /v1/projects/:id/accounts': (call: Call) => {
              linked = (call.body as { accounts: string[] }).accounts;
              return { ...PROJECT, accounts: linked };
            },
          },
          calls,
        ),
      ),
    );
    await settled(mounted, c => c.querySelector('[data-project-accounts-edit]') !== null, 'the link control');
    expect(mounted.container.querySelector('[data-project-accounts="none"]')).not.toBeNull();

    await press(must(mounted.container.querySelector('[data-project-accounts-edit]'), 'the link control'));
    // Pick the second account, then the first: the order of the picks is the order sent (the first is the default).
    await press(must(mounted.container.querySelector('[data-project-accounts-choice="gha_2"] input'), 'hubot'));
    await press(must(mounted.container.querySelector('[data-project-accounts-choice="gha_1"] input'), 'octocat'));
    await press(must(mounted.container.querySelector('[data-project-accounts-save]'), 'save'));

    await settled(mounted, c => c.querySelector('[data-project-accounts="ready"]') !== null, 'the linked list');
    expect(
      calls.filter(call => call.route === 'PUT /v1/projects/:id/accounts').map(call => [call.params, call.body]),
    ).toEqual([[{ id: PROJECT.id }, { accounts: ['gha_2', 'gha_1'] }]]);
    expect([...mounted.container.querySelectorAll('[data-project-account]')].map(row => row.textContent)).toEqual([
      '@hubot',
      '@octocat',
    ]);
    await mounted.unmount();
  });

  it('keeps the editor open and says why when the daemon refuses the accounts', async () => {
    const mounted = await mount(
      detail(
        client([], {
          'GET /v1/git-accounts': [{ id: 'gha_1', login: 'octocat', keys: {} }],
          'PUT /v1/projects/:id/accounts': refusal(403, 'only the owner links accounts'),
        }),
      ),
    );
    await settled(mounted, c => c.querySelector('[data-project-accounts-edit]') !== null, 'the link control');
    await press(must(mounted.container.querySelector('[data-project-accounts-edit]'), 'the link control'));
    await press(must(mounted.container.querySelector('[data-project-accounts-choice="gha_1"] input'), 'octocat'));
    await press(must(mounted.container.querySelector('[data-project-accounts-save]'), 'save'));
    await settled(mounted, c => c.querySelector('[data-project-accounts-editor] [role="alert"]') !== null, 'refusal');

    expect(mounted.container.textContent).toContain('This daemon refused the link: only the owner links accounts');
    await mounted.unmount();
  });
});

describe('linking accounts to a project (review fixes for PR 2288)', () => {
  const ACCOUNTS = 'GET /v1/git-accounts';
  const PUT_ACCOUNTS = 'PUT /v1/projects/:id/accounts';
  const octocat = { id: 'gha_1', login: 'octocat', keys: {} };
  const hubot = { id: 'gha_2', login: 'hubot', keys: {} };
  const putsOf = (calls: Call[]) =>
    calls.filter(call => call.route === PUT_ACCOUNTS).map(call => [call.params, call.body]);

  it('lets the owner confirm the passkey and link the FIRST account on a project with no links', async () => {
    const calls: Call[] = [];
    const base = client([], { [LIST]: [PROJECT], [PUT_ACCOUNTS]: { ...PROJECT, accounts: ['gha_1'] } }, calls);
    // The account list is protected: a read the page makes on its own is refused; the person's press reads it.
    const guarded = {
      call: <Answer,>(route: string, init?: { readonly quiet?: boolean }) =>
        route === ACCOUNTS
          ? init?.quiet === false
            ? Promise.resolve([octocat] as Answer)
            : Promise.reject(refusal(403, 'passkey first', 'grant_step_up_required'))
          : base.call<Answer>(route, init as never),
    } as ProjectsClient;
    const mounted = await mount(detail(guarded));
    await settled(mounted, c => c.querySelector('[data-confirm-to-see]') !== null, 'the confirm action');
    expect(mounted.container.querySelector('[data-project-accounts="none"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-project-accounts-edit]')).toBeNull();

    await press(must(mounted.container.querySelector('[data-confirm-to-see] button'), 'the press'));
    await settled(mounted, c => c.querySelector('[data-project-accounts-edit]') !== null, 'the link control');
    expect(mounted.container.querySelector('[data-confirm-to-see]')).toBeNull();
    await press(must(mounted.container.querySelector('[data-project-accounts-edit]'), 'the link control'));
    await press(must(mounted.container.querySelector('[data-project-accounts-choice="gha_1"] input'), 'octocat'));
    await press(must(mounted.container.querySelector('[data-project-accounts-save]'), 'save'));
    await settled(mounted, () => putsOf(calls).length === 1, 'the save');
    expect(putsOf(calls)).toEqual([[{ id: PROJECT.id }, { accounts: ['gha_1'] }]]);
    await mounted.unmount();
  });

  it('drops an open editor draft when the page moves to another project on the same daemon', async () => {
    const calls: Call[] = [];
    const other = { ...ANSWERED, accounts: ['gha_1'] };
    const c = client([], { [ACCOUNTS]: [octocat, hubot], [LIST]: [PROJECT, other] }, calls);
    const mounted = await mount(detail(c));
    await settled(mounted, x => x.querySelector('[data-project-accounts-edit]') !== null, 'the link control');
    await press(must(mounted.container.querySelector('[data-project-accounts-edit]'), 'the link control'));
    await press(must(mounted.container.querySelector('[data-project-accounts-choice="gha_2"] input'), 'hubot'));

    await mounted.render(detail(c, ANSWERED.id));
    await settled(
      mounted,
      x => x.querySelector(`[data-project-detail="${ANSWERED.id}"]`) !== null,
      'the other project',
    );
    // The first project's draft did not follow the person: no editor is open, and opening one starts from THIS project.
    expect(mounted.container.querySelector('[data-project-accounts-editor]')).toBeNull();
    await settled(mounted, x => x.querySelector('[data-project-accounts-edit]') !== null, 'the link control');
    await press(must(mounted.container.querySelector('[data-project-accounts-edit]'), 'the link control'));
    const checked = (id: string) =>
      (mounted.container.querySelector(`[data-project-accounts-choice="${id}"] input`) as HTMLInputElement).checked;
    expect([checked('gha_1'), checked('gha_2')]).toEqual([true, false]);
    await press(must(mounted.container.querySelector('[data-project-accounts-save]'), 'save'));
    await settled(mounted, () => putsOf(calls).length === 1, 'the save');
    expect(putsOf(calls)).toEqual([[{ id: ANSWERED.id }, { accounts: ['gha_1'] }]]);
    await mounted.unmount();
  });

  const removedDefault = async (calls: Call[]) => {
    const linked = { ...PROJECT, accounts: ['gha_9', 'gha_1'] };
    const mounted = await mount(
      detail(client([], { [ACCOUNTS]: [octocat, hubot], [LIST]: [linked], [PUT_ACCOUNTS]: linked }, calls)),
    );
    await settled(mounted, x => x.querySelector('[data-project-accounts-edit]') !== null, 'the link control');
    await press(must(mounted.container.querySelector('[data-project-accounts-edit]'), 'the link control'));
    return mounted;
  };

  it('shows a removed default in the editor and lets the owner choose a new default, keeping the other links', async () => {
    const calls: Call[] = [];
    const mounted = await removedDefault(calls);
    const gone = must(mounted.container.querySelector('[data-project-accounts-choice="gha_9"]'), 'the removed link');
    expect(gone.textContent).toContain('account removed');
    expect(mounted.container.querySelector('[data-project-accounts-default-gone]')).not.toBeNull();

    await press(must(mounted.container.querySelector('[data-project-accounts-choice="gha_2"] input'), 'hubot'));
    await press(must(mounted.container.querySelector('[data-project-accounts-make-default="gha_2"]'), 'make default'));
    expect(mounted.container.querySelector('[data-project-accounts-default-gone]')).toBeNull();
    await press(must(mounted.container.querySelector('[data-project-accounts-save]'), 'save'));
    await settled(mounted, () => putsOf(calls).length === 1, 'the save');
    expect(putsOf(calls)).toEqual([[{ id: PROJECT.id }, { accounts: ['gha_2', 'gha_9', 'gha_1'] }]]);
    await mounted.unmount();
  });

  it('lets the owner drop the removed link, so the next account becomes the default', async () => {
    const calls: Call[] = [];
    const mounted = await removedDefault(calls);
    await press(must(mounted.container.querySelector('[data-project-accounts-choice="gha_9"] input'), 'removed link'));
    await press(must(mounted.container.querySelector('[data-project-accounts-save]'), 'save'));
    await settled(mounted, () => putsOf(calls).length === 1, 'the save');
    expect(putsOf(calls)).toEqual([[{ id: PROJECT.id }, { accounts: ['gha_1'] }]]);
    await mounted.unmount();
  });
});
