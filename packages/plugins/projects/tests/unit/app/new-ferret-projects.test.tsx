import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { interact, type Mounted, mount, must, settleUntil, WithAppHooks } from '@ferretry/app/testing';
import {
  type ProjectsConnectAccountProps,
  ProjectInfoSchema,
  PROJECTS_CONNECT_ACCOUNT_HOOK,
} from '../../../contract/index.ts';
import { createNewFerretProjectsPanel } from '../../../app/views/new-ferret-projects.tsx';
import { startFerretHref } from '../../../app/lib/start-href.ts';
import { projectLine } from '../../../app/lib/project-line.ts';
import { type Call, clickEvent, PROJECT, scripted } from './support/client.ts';

const SECOND = ProjectInfoSchema.parse({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'website',
  path: '/work/website',
  source: 'clone',
  createdAt: '2026-08-02T10:00:00.000Z',
  repos: [{ path: '.', remote: 'https://github.com/acme/website', provider: 'github' }],
});

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
});

const draw = async (
  projects: unknown,
  value = '',
  onPick: (folder: string) => void = () => undefined,
  recent: readonly string[] = [],
  routes: Readonly<Record<string, unknown>> = {},
  hooks: Readonly<Record<string, unknown>> = {},
  calls: Call[] = [],
) => {
  // A slot panel is handed the slot's props (`value`, `id`, `recent`, `onPick`), which PanelProps does not name.
  const Panel = createNewFerretProjectsPanel(scripted({ 'GET /v1/projects': projects, ...routes }, calls)) as (props: {
    readonly daemon: string;
    readonly value: string;
    readonly id: string;
    readonly recent: readonly string[];
    readonly onPick: (folder: string) => void;
  }) => ReactNode;
  open = await mount(
    <WithAppHooks provided={hooks}>
      <Panel daemon="d" id="fy-where" onPick={onPick} recent={recent} value={value} />
    </WithAppHooks>,
  );
  return open;
};

const q = <T extends Element>(view: Mounted, selector: string): T | null => view.container.querySelector<T>(selector);
const switchButton = (view: Mounted, text: string): HTMLButtonElement =>
  must(
    [...view.container.querySelectorAll<HTMLButtonElement>('[data-new-ferret-where-switch] [role="radio"]')].find(
      button => button.textContent === text,
    ),
    text,
  );
const rows = (view: Mounted): HTMLElement[] => [
  ...view.container.querySelectorAll<HTMLElement>('[data-where-project-row]'),
];
const rowPick = (row: HTMLElement): HTMLButtonElement =>
  must(row.querySelector<HTMLButtonElement>('button[title]'), 'row pick');
const trigger = (view: Mounted): HTMLButtonElement =>
  must(q<HTMLButtonElement>(view, '[data-where-project-trigger]'), 'trigger');

describe('the New ferret where-it-works panel', () => {
  it('opens on Project when projects exist, and its dropdown lists them and picks the one pressed', async () => {
    const picked: string[] = [];
    const view = await draw([PROJECT, SECOND], '', folder => picked.push(folder));
    await settleUntil(() => q(view, '[data-where-project-trigger]') !== null, 'the project dropdown', interact);
    expect(switchButton(view, 'Project').getAttribute('aria-checked')).toBe('true');
    expect(switchButton(view, 'Folder').getAttribute('aria-checked')).toBe('false');
    expect(trigger(view).id).toBe('fy-where');
    expect(rows(view)).toHaveLength(0);

    await interact(() => trigger(view).dispatchEvent(clickEvent()));
    expect(rows(view).map(row => row.querySelector('button[title]')?.textContent)).toEqual([
      'ferretry/work/ferretry',
      'websiteacme/website',
    ]);
    await interact(() => rowPick(rows(view)[1] as HTMLElement).dispatchEvent(clickEvent()));
    expect(picked).toEqual(['/work/website']);
    expect(rows(view)).toHaveLength(0);
  });

  it('searches the projects by name, folder or repository', async () => {
    const view = await draw([PROJECT, SECOND]);
    await settleUntil(() => q(view, '[data-where-project-trigger]') !== null, 'the project dropdown', interact);
    await interact(() => trigger(view).dispatchEvent(clickEvent()));
    const search = must(q<HTMLInputElement>(view, '[data-where-project-search]'), 'search');
    const type = async (text: string): Promise<void> =>
      interact(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        set?.call(search, text);
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await type('acme');
    expect(rows(view)).toHaveLength(1);
    await type('zzz');
    expect(rows(view)).toHaveLength(0);
    expect(q(view, '[data-where-project-none]')?.textContent).toBe('No project matches.');
  });

  it('shows the picked project on the trigger when the folder in the field is a project', async () => {
    const view = await draw([PROJECT, SECOND], '/work/website');
    await settleUntil(() => q(view, '[data-where-project-trigger]') !== null, 'the project dropdown', interact);
    expect(trigger(view).textContent).toContain('website');
  });

  it('opens on Folder with no projects, or when the folder in the field is not a project', async () => {
    const none = await draw([]);
    await settleUntil(() => q(none, '[data-new-ferret-where-folder]') !== null, 'the folder field', interact);
    expect(switchButton(none, 'Folder').getAttribute('aria-checked')).toBe('true');
    await none.unmount();
    open = null;
    const typed = await draw([PROJECT], '/elsewhere/app');
    await settleUntil(() => q(typed, '[data-new-ferret-where-folder]') !== null, 'the folder field', interact);
    expect(q<HTMLInputElement>(typed, '#fy-where')?.value).toBe('/elsewhere/app');
  });

  it('reserves the room while the registry is unread', async () => {
    const view = await draw(new Promise(() => undefined));
    expect(q(view, '[data-new-ferret-where-reading]')).not.toBeNull();
    expect(q(view, '[data-where-project-trigger]')).toBeNull();
    expect(q(view, '[data-new-ferret-where-folder]')).toBeNull();
  });

  it('Folder: recent folders are one-tap picks and Browse opens the project-setup finder, whose choice is picked', async () => {
    const picked: string[] = [];
    const view = await draw([PROJECT], '', folder => picked.push(folder), ['/work/a', '/work/b'], {
      'GET /v1/projects/folders': {
        path: '/work',
        parent: '/',
        entries: [{ name: 'x', path: '/work/x', kind: 'folder' }],
      },
    });
    await settleUntil(() => q(view, '[data-where-project-trigger]') !== null, 'the project dropdown', interact);
    await interact(() => switchButton(view, 'Folder').dispatchEvent(clickEvent()));
    const chips = [...view.container.querySelectorAll<HTMLButtonElement>('[data-where-recent-folder]')];
    expect(chips.map(chip => chip.textContent)).toEqual(['a', 'b']);
    await interact(() => chips[1]?.dispatchEvent(clickEvent()));
    expect(picked).toEqual(['/work/b']);

    expect(q(view, '[data-where-surface]')).toBeNull();
    await interact(() => must(q<HTMLButtonElement>(view, '[data-where-browse]'), 'Browse').dispatchEvent(clickEvent()));
    expect(q(view, '[data-where-surface]')).not.toBeNull();
  });

  it('Link GitHub opens the account editor in place and picks nothing', async () => {
    const picked: string[] = [];
    const view = await draw([PROJECT], '', folder => picked.push(folder), [], {
      'GET /v1/git-accounts': [{ id: 'acct-1', login: 'octo', provider: 'github', status: 'connected' }],
    });
    await settleUntil(() => q(view, '[data-where-project-trigger]') !== null, 'the project dropdown', interact);
    await interact(() => trigger(view).dispatchEvent(clickEvent()));
    const link = must(q<HTMLButtonElement>(view, '[data-where-link-github]'), 'Link GitHub');
    expect(link.textContent).toBe('Link GitHub');
    await interact(() => link.dispatchEvent(clickEvent()));
    expect(q(view, '[data-where-link-panel]')).not.toBeNull();
    expect(picked).toEqual([]);
  });

  it('Link GitHub with no account connected offers Git accounts’ own connect card, and a connected account is linked at once', async () => {
    const calls: Call[] = [];
    const connectProvider = {
      panel: ({ connected, onConnected }: ProjectsConnectAccountProps) => (
        <button data-fake-connect="" onClick={() => onConnected('acct-9')} type="button">
          {connected === 0 ? 'Connect a GitHub account' : 'Connect another'}
        </button>
      ),
    };
    const view = await draw(
      [PROJECT],
      '',
      () => undefined,
      [],
      {
        'GET /v1/git-accounts': [],
        'PUT /v1/projects/:id/accounts': (call: Call) => ({
          ...PROJECT,
          accounts: (call.body as { accounts: string[] }).accounts,
        }),
      },
      { [PROJECTS_CONNECT_ACCOUNT_HOOK]: connectProvider },
      calls,
    );
    await settleUntil(() => q(view, '[data-where-project-trigger]') !== null, 'the project dropdown', interact);
    await interact(() => trigger(view).dispatchEvent(clickEvent()));
    await interact(() =>
      must(q<HTMLButtonElement>(view, '[data-where-link-github]'), 'Link GitHub').dispatchEvent(clickEvent()),
    );
    await settleUntil(() => q(view, '[data-fake-connect]') !== null, 'the connect card', interact);
    expect(q(view, '[data-fake-connect]')?.textContent).toBe('Connect a GitHub account');
    await interact(() =>
      must(q<HTMLButtonElement>(view, '[data-fake-connect]'), 'connect').dispatchEvent(clickEvent()),
    );
    await settleUntil(() => calls.some(call => call.route === 'PUT /v1/projects/:id/accounts'), 'the link', interact);
    expect(calls.find(call => call.route === 'PUT /v1/projects/:id/accounts')?.body).toMatchObject({
      accounts: ['acct-9'],
    });
  });

  it('says so when Git accounts is off and no account is connected', async () => {
    const view = await draw([PROJECT], '', () => undefined, [], { 'GET /v1/git-accounts': [] });
    await settleUntil(() => q(view, '[data-where-project-trigger]') !== null, 'the project dropdown', interact);
    await interact(() => trigger(view).dispatchEvent(clickEvent()));
    await interact(() =>
      must(q<HTMLButtonElement>(view, '[data-where-link-github]'), 'Link GitHub').dispatchEvent(clickEvent()),
    );
    await settleUntil(() => q(view, '[data-connect-account="unavailable"]') !== null, 'the unavailable line', interact);
  });

  it('says so when there are no projects to choose, in the Project choice', async () => {
    const view = await draw([]);
    await settleUntil(() => q(view, '[data-new-ferret-where-folder]') !== null, 'the folder field', interact);
    await interact(() => switchButton(view, 'Project').dispatchEvent(clickEvent()));
    await interact(() => trigger(view).dispatchEvent(clickEvent()));
    expect(q(view, '[data-where-project-none]')?.textContent).toContain('No projects yet');
  });
});

describe('startFerretHref', () => {
  it('opens New ferret on this daemon with the folder encoded', () => {
    expect(startFerretHref('workstation', '/work/my project&x')).toBe(
      '/d/workstation/new?folder=%2Fwork%2Fmy%20project%26x',
    );
  });
});

describe('projectLine', () => {
  it('names the repository, else the folder', () => {
    expect(projectLine(PROJECT)).toBe('/work/ferretry');
    expect(projectLine(SECOND)).toBe('acme/website');
    const two = { ...SECOND, repos: [...(SECOND.repos ?? []), { path: 'api', remote: 'https://github.com/acme/api' }] };
    expect(projectLine(two)).toBe('acme/website + 1 more');
  });

  it('names another host with its host, and shows a remote that is not a URL as written', () => {
    const on = (remote: string) => ({ ...SECOND, repos: [{ path: '.', remote }] });
    expect(projectLine(on('https://git.example.com/team/app.git'))).toBe('git.example.com/team/app');
    expect(projectLine(on('git@github.com:acme/site.git'))).toBe('git@github.com:acme/site.git');
  });
});

describe('the panel in a slot it was not built for', () => {
  it('draws nothing for props that are not the New ferret project slot’s', async () => {
    const Panel = createNewFerretProjectsPanel(scripted({ 'GET /v1/projects': [PROJECT] })) as (
      props: object,
    ) => ReactNode;
    open = await mount(<Panel />);
    await interact(async () => await new Promise(resolve => setTimeout(resolve, 20)));
    expect(open.container.querySelector('[data-new-ferret-projects]')).toBeNull();
  });
});
