import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { ProjectsPage } from '../../../app/views/projects-page.tsx';
import { ANSWERED, type Call, clickEvent, refusal, scripted, typeInto } from './support/client.ts';

const LIST = 'GET /v1/projects';
const FERRETS = 'GET /v1/ferrets';
const FOLDERS = 'GET /v1/projects/folders';
const REGISTER = 'POST /v1/projects';
const ACCOUNTS = 'GET /v1/git-accounts';
const SET_ACCOUNTS = 'PUT /v1/projects/:id/accounts';
const KEYS = 'POST /v1/git-accounts/:id/keys';
const DEVICE = 'POST /v1/git-accounts/github/device';
const POLL = 'GET /v1/git-accounts/github/device/:flowId';

const listing = (path: string) => ({
  path,
  crumbs: [{ name: '~', path: '/home/k' }],
  entries: [],
  truncated: false,
});
const account = (id: string, login: string, keys: Record<string, unknown> = {}) => ({ id, login, keys });
const KEYED = { ssh: { githubKeyId: '1', title: 'Ferretry' } };

const page = (client: ReturnType<typeof scripted>) => (
  <RouterProvider>
    <ProjectsPage client={client} daemon="workstation" />
  </RouterProvider>
);
const settled = (mounted: Mounted, ready: (c: HTMLElement) => boolean, what: string) =>
  settleUntil(() => ready(mounted.container), what, interact);
const press = (element: Element) => interact(() => element.dispatchEvent(clickEvent()));
const button = (mounted: Mounted, text: string): Element =>
  must(
    [...mounted.container.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === text),
    `the "${text}" button`,
  );
const step = (mounted: Mounted, name: string) =>
  settled(mounted, c => c.querySelector(`[data-create-step="${name}"]`) !== null, `the ${name} step`);

/** Opens the flow, picks the open folder and registers it, ending on the accounts step. */
const createAt = async (mounted: Mounted): Promise<void> => {
  await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
  await settled(mounted, c => c.querySelector('[data-explorer-state="ready"]') !== null, 'the explorer');
  await press(button(mounted, 'Use this folder'));
  await press(button(mounted, 'Next'));
  await step(mounted, 'name');
  await press(button(mounted, 'Create project'));
  await step(mounted, 'accounts');
};

const base = (calls: Call[], extra: Record<string, unknown> = {}) =>
  scripted(
    {
      [LIST]: [],
      [FERRETS]: [],
      [FOLDERS]: listing('/home/k/scratch'),
      [REGISTER]: ANSWERED,
      [ACCOUNTS]: [account('gha_1', 'octocat'), account('gha_2', 'hubot', KEYED)],
      ...extra,
    },
    calls,
  );

describe('Create a project', () => {
  it('goes folder → name → accounts → keys → done, linking in the order picked and keying only what has no key', async () => {
    const calls: Call[] = [];
    const client = base(calls, {
      [SET_ACCOUNTS]: { ...ANSWERED, accounts: ['gha_2', 'gha_1'] },
      [KEYS]: { fingerprint: 'SHA256:abc', registered: true },
    });
    const mounted = await mount(page(client));
    await createAt(mounted);
    expect(calls.find(call => call.route === REGISTER)?.body).toEqual({
      kind: 'existing-folder',
      path: '/home/k/scratch',
    });

    await settled(mounted, c => c.querySelector('[data-create-account="gha_1"]') !== null, 'the accounts');
    // hubot first, then octocat: the first picked is the project's default.
    await press(must(mounted.container.querySelector('[data-create-account="gha_2"] input'), 'hubot'));
    await press(must(mounted.container.querySelector('[data-create-account="gha_1"] input'), 'octocat'));
    await press(button(mounted, 'Link these accounts'));
    await step(mounted, 'keys');
    const put = calls.find(call => call.route === SET_ACCOUNTS);
    expect(put?.params).toEqual({ id: ANSWERED.id });
    expect(put?.body).toEqual({ accounts: ['gha_2', 'gha_1'] });

    // Only the account with no key is offered one.
    expect(mounted.container.querySelector('[data-create-key-account="gha_2"]')).toBeNull();
    expect(must(mounted.container.querySelector('[data-create-keys-ready]'), 'the note').textContent).toContain(
      '@hubot already has a key',
    );
    await press(button(mounted, 'Set up push and signing for this account'));
    await settled(mounted, c => (c.textContent ?? '').includes('SHA256:abc'), 'the key');
    expect(calls.find(call => call.route === KEYS)).toMatchObject({
      params: { id: 'gha_1' },
      body: { purpose: 'both' },
    });
    await press(button(mounted, 'Continue'));

    await step(mounted, 'done');
    expect(must(mounted.container.querySelector('[data-create-done]'), 'done').textContent).toContain(
      'scratch is ready.',
    );
    expect(mounted.container.querySelectorAll('[data-project-account]').length).toBe(2);
    expect(must(mounted.container.querySelector('[data-create-done] a'), 'the link').getAttribute('href')).toBe(
      `/d/workstation/projects/${ANSWERED.id}`,
    );
    await mounted.unmount();
  });

  it('lets accounts be skipped: the project already exists', async () => {
    const calls: Call[] = [];
    const mounted = await mount(page(base(calls)));
    await createAt(mounted);
    await press(button(mounted, 'Skip for now'));
    await step(mounted, 'done');
    expect(calls.some(call => call.route === SET_ACCOUNTS)).toBe(false);
    expect(mounted.container.querySelector('[data-project-accounts="none"]')).not.toBeNull();
    await mounted.unmount();
  });

  it("states the daemon's refusal of the link and of a key as worded, and keeps the step", async () => {
    const client = base([], {
      [SET_ACCOUNTS]: refusal(403, 'this needs a passkey first'),
      [KEYS]: refusal(404, 'no route POST /v1/git-accounts/:id/keys'),
    });
    const mounted = await mount(page(client));
    await createAt(mounted);
    await settled(mounted, c => c.querySelector('[data-create-account="gha_1"]') !== null, 'the accounts');
    await press(must(mounted.container.querySelector('[data-create-account="gha_1"] input'), 'octocat'));
    await press(button(mounted, 'Link this account'));
    await settled(mounted, c => (c.textContent ?? '').includes('this needs a passkey first'), 'the refusal');
    expect(mounted.container.querySelector('[data-create-step="accounts"]')).not.toBeNull();
    await mounted.unmount();

    const keyed = base([], {
      [SET_ACCOUNTS]: ANSWERED,
      [KEYS]: refusal(404, 'no route POST /v1/git-accounts/:id/keys'),
    });
    const second = await mount(page(keyed));
    await createAt(second);
    await settled(second, c => c.querySelector('[data-create-account="gha_1"]') !== null, 'the accounts');
    await press(must(second.container.querySelector('[data-create-account="gha_1"] input'), 'octocat'));
    await press(button(second, 'Link this account'));
    await step(second, 'keys');
    await press(button(second, 'Set up push and signing for this account'));
    await settled(
      second,
      c => (c.textContent ?? '').includes('no route POST /v1/git-accounts/:id/keys'),
      'the key refusal',
    );
    await second.unmount();
  });

  it('connects a new account by device flow: the code, then the account appears and is picked', async () => {
    let polls = 0;
    let connected = false;
    const client = base([], {
      [ACCOUNTS]: () => [account('gha_1', 'octocat'), ...(connected ? [account('gha_3', 'newcomer')] : [])],
      [DEVICE]: {
        flowId: 'flow_aaaaaaaaaaaaaaaa',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        interval: 1,
      },
      [POLL]: () => {
        polls += 1;
        if (polls < 2) return { status: 'pending', interval: 1 };
        connected = true;
        return { status: 'done', accountId: 'gha_3', login: 'newcomer' };
      },
    });
    const mounted = await mount(page(client));
    await createAt(mounted);
    // What is asked of GitHub is said before the code is shown.
    await press(button(mounted, 'Connect a GitHub account'));
    expect(must(mounted.container.querySelector('[data-connect-consent]'), 'the consent').textContent).toContain(
      'read:org',
    );
    await press(button(mounted, 'Continue to GitHub'));
    await settled(mounted, c => c.querySelector('[data-connect-code]') !== null, 'the code');
    expect(must(mounted.container.querySelector('[data-connect-code]'), 'the code').textContent).toBe('ABCD-1234');
    await interact(() => new Promise<void>(resolve => setTimeout(resolve, 2300)));
    await settled(mounted, c => c.querySelector('[data-connect-account="connected"]') !== null, 'connected');
    await settled(mounted, c => c.querySelector('[data-create-account="gha_3"]') !== null, 'the new account listed');
    expect(
      must(mounted.container.querySelector<HTMLInputElement>('[data-create-account="gha_3"] input'), 'newcomer')
        .checked,
    ).toBe(true);
    await mounted.unmount();
  });

  it('says when a code ran out and offers another', async () => {
    const client = base([], {
      [DEVICE]: {
        flowId: 'flow_aaaaaaaaaaaaaaaa',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        interval: 1,
      },
      [POLL]: { status: 'expired' },
    });
    const mounted = await mount(page(client));
    await createAt(mounted);
    await press(button(mounted, 'Connect a GitHub account'));
    await press(button(mounted, 'Continue to GitHub'));
    await interact(() => new Promise<void>(resolve => setTimeout(resolve, 1300)));
    await settled(mounted, c => c.querySelector('[data-connect-account="expired"]') !== null, 'expired');
    expect(button(mounted, 'Try again')).toBeDefined();
    await mounted.unmount();
  });

  it('clones into the picked folder, in a new folder named after the repository', async () => {
    const calls: Call[] = [];
    const mounted = await mount(page(base(calls, { [REGISTER]: ANSWERED })));
    await press(must(mounted.container.querySelector('[aria-controls="add-project-form"]'), 'the disclosure'));
    await press(must(mounted.container.querySelector('[data-create-source="clone"] input'), 'the clone source'));
    const url = must(
      mounted.container.querySelector<HTMLInputElement>('[data-create-step="folder"] input.mono'),
      'the address',
    );
    await interact(() => typeInto(url, 'https://github.com/you/project.git'));
    await settled(mounted, c => c.querySelector('[data-explorer-state="ready"]') !== null, 'the explorer');
    await press(button(mounted, 'Clone into this folder'));
    expect(must(mounted.container.querySelector('[data-create-chosen] .mono'), 'where').textContent).toBe(
      '/home/k/scratch/project',
    );
    await press(button(mounted, 'Next'));
    await press(button(mounted, 'Create project'));
    await step(mounted, 'accounts');
    expect(calls.find(call => call.route === REGISTER)?.body).toEqual({
      kind: 'clone',
      url: 'https://github.com/you/project.git',
      path: '/home/k/scratch/project',
    });
    await mounted.unmount();
  });
});
