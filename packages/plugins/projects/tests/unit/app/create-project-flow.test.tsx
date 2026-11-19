import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil, WithAppHooks } from '@ferretry/app/testing';
import { PROJECTS_CONNECT_ACCOUNT_HOOK } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import { ProjectsPage } from '../../../app/views/projects-page.tsx';
import { ANSWERED, type Call, clickEvent, refusal, scripted, typeInto } from './support/client.ts';

const LIST = 'GET /v1/projects';
const FERRETS = 'GET /v1/ferrets';
const FOLDERS = 'GET /v1/projects/folders';
const REGISTER = 'POST /v1/projects';
const ACCOUNTS = 'GET /v1/git-accounts';
const SET_ACCOUNTS = 'PUT /v1/projects/:id/accounts';
const KEYS = 'POST /v1/git-accounts/:id/keys';
/** B3's own sentence for a 422 from GitHub (`git-accounts/daemon/features/ssh-keys/service.ts`): shown as the daemon worded it. */
const KEY_REFUSED = 'GitHub refused the key (it may already be used by another account)';

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
      [KEYS]: { fingerprint: 'SHA256:abc', registered: ['auth', 'signing'] },
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
      [KEYS]: refusal(409, KEY_REFUSED, 'key_refused'),
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
      [KEYS]: refusal(409, KEY_REFUSED, 'key_refused'),
    });
    const second = await mount(page(keyed));
    await createAt(second);
    await settled(second, c => c.querySelector('[data-create-account="gha_1"]') !== null, 'the accounts');
    await press(must(second.container.querySelector('[data-create-account="gha_1"] input'), 'octocat'));
    await press(button(second, 'Link this account'));
    await step(second, 'keys');
    await press(button(second, 'Set up push and signing for this account'));
    await settled(second, c => (c.textContent ?? '').includes(KEY_REFUSED), 'the key refusal');
    await second.unmount();
  });

  it("mounts Git accounts' own connect card: the account it reports is listed and picked, with no copy of the flow here", async () => {
    let connected = false;
    const shown: number[] = [];
    // What Git accounts provides: a component given how many are connected and told which account was approved.
    const panel = ({ connected: count, onConnected }: { connected: number; onConnected: (id: string) => void }) => {
      shown.push(count);
      return (
        <button
          type="button"
          data-fake-connect=""
          onClick={() => {
            connected = true;
            onConnected('gha_3');
          }}
        >
          Connect
        </button>
      );
    };
    const client = base([], {
      [ACCOUNTS]: () => [account('gha_1', 'octocat'), ...(connected ? [account('gha_3', 'newcomer')] : [])],
    });
    const mounted = await mount(
      <WithAppHooks provided={{ [PROJECTS_CONNECT_ACCOUNT_HOOK]: { panel } }}>{page(client)}</WithAppHooks>,
    );
    await createAt(mounted);
    await settled(mounted, c => c.querySelector('[data-create-account="gha_1"]') !== null, 'the accounts');
    expect(shown.at(-1)).toBe(1);
    await press(must(mounted.container.querySelector('[data-fake-connect]'), 'the connect card'));
    await settled(mounted, c => c.querySelector('[data-create-account="gha_3"]') !== null, 'the new account listed');
    expect(
      must(mounted.container.querySelector<HTMLInputElement>('[data-create-account="gha_3"] input'), 'newcomer')
        .checked,
    ).toBe(true);
    await mounted.unmount();
  });

  it('says connecting is not available when no plugin provides the card, and the rest of the step still works', async () => {
    const mounted = await mount(page(base([])));
    await createAt(mounted);
    await settled(mounted, c => c.querySelector('[data-connect-account="unavailable"]') !== null, 'the note');
    expect(mounted.container.querySelector('[data-create-account="gha_1"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('says a failed read of the accounts in the daemon\u2019s words, and says when none are connected yet', async () => {
    const failed = await mount(page(base([], { [ACCOUNTS]: refusal(500, 'the vault is locked') })));
    await createAt(failed);
    await settled(failed, c => c.querySelector('[data-create-accounts-error]') !== null, 'the error');
    expect(must(failed.container.querySelector('[data-create-accounts-error]'), 'the error').textContent).toContain(
      'the vault is locked',
    );
    await failed.unmount();
    const empty = await mount(page(base([], { [ACCOUNTS]: [] })));
    await createAt(empty);
    await settled(empty, c => c.querySelector('[data-create-accounts-empty]') !== null, 'the empty note');
    await empty.unmount();
  });

  it('offers one passkey press when the account list was refused for want of the step-up, then lists them', async () => {
    const inner = base([]);
    // A read the page makes on its own is refused; only the person's press (`quiet: false`) is answered.
    const asking: ProjectsClient = {
      call: <Answer,>(route: string, init?: { readonly quiet?: boolean }) =>
        route === ACCOUNTS && init?.quiet !== false
          ? Promise.reject(refusal(403, 'passkey first', 'grant_step_up_required'))
          : inner.call<Answer>(route, init as never),
    } as ProjectsClient;
    const mounted = await mount(page(asking));
    await createAt(mounted);
    await settled(mounted, c => c.querySelector('[data-create-accounts-step-up]') !== null, 'the press');
    expect(mounted.container.querySelector('[data-create-accounts-error]')).toBeNull();
    await press(button(mounted, 'Confirm it’s you to see this'));
    await settled(mounted, c => c.querySelector('[data-create-account="gha_1"]') !== null, 'the accounts');
    expect(mounted.container.querySelector('[data-create-accounts-step-up]')).toBeNull();
    await mounted.unmount();
  });

  it('never calls an unread account list "already keyed": a just-connected account is "not checked yet" until the passkey press reads it', async () => {
    const calls: Call[] = [];
    const inner = base(calls, {
      [SET_ACCOUNTS]: { ...ANSWERED, accounts: ['gha_3'] },
      [ACCOUNTS]: [account('gha_3', 'newcomer')],
      [KEYS]: { fingerprint: 'SHA256:new', registered: ['auth', 'signing'] },
    });
    // The list is its own passkey confirmation: only the person's press (`quiet: false`) is answered.
    const asking: ProjectsClient = {
      call: <Answer,>(route: string, init?: { readonly quiet?: boolean }) =>
        route === ACCOUNTS && init?.quiet !== false
          ? Promise.reject(refusal(403, 'passkey first', 'grant_step_up_required'))
          : inner.call<Answer>(route, init as never),
    } as ProjectsClient;
    const panel = ({ onConnected }: { connected: number; onConnected: (id: string) => void }) => (
      <button type="button" data-fake-connect="" onClick={() => onConnected('gha_3')}>
        Connect
      </button>
    );
    const mounted = await mount(
      <WithAppHooks provided={{ [PROJECTS_CONNECT_ACCOUNT_HOOK]: { panel } }}>{page(asking)}</WithAppHooks>,
    );
    await createAt(mounted);
    await settled(mounted, c => c.querySelector('[data-create-accounts-step-up]') !== null, 'the press');
    await press(must(mounted.container.querySelector('[data-fake-connect]'), 'the connect card'));
    await press(button(mounted, 'Link this account'));
    await step(mounted, 'keys');

    // Unknown is not "has a key": no claim, no key offer, only the way to check.
    expect(mounted.container.querySelector('[data-create-keys="none"]')).toBeNull();
    expect(mounted.container.querySelector('[data-create-keys-ready]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('already has a key');
    expect(must(mounted.container.querySelector('[data-create-keys="unchecked"]'), 'the note').textContent).toContain(
      'Not checked yet',
    );
    await press(button(mounted, 'Confirm it’s you to see this'));
    await settled(mounted, c => c.querySelector('[data-create-key-account="gha_3"]') !== null, 'the key offer');
    expect(mounted.container.querySelector('[data-create-keys="unchecked"]')).toBeNull();
    await press(button(mounted, 'Set up push and signing for this account'));
    await settled(mounted, c => (c.textContent ?? '').includes('SHA256:new'), 'the key');
    await mounted.unmount();
  });

  it('says every linked account already has a key only once the list was read and shows it', async () => {
    const mounted = await mount(page(base([], { [SET_ACCOUNTS]: { ...ANSWERED, accounts: ['gha_2'] } })));
    await createAt(mounted);
    await settled(mounted, c => c.querySelector('[data-create-account="gha_2"]') !== null, 'the accounts');
    await press(must(mounted.container.querySelector('[data-create-account="gha_2"] input'), 'hubot'));
    await press(button(mounted, 'Link this account'));
    await step(mounted, 'keys');
    expect(must(mounted.container.querySelector('[data-create-keys="none"]'), 'the note').textContent).toContain(
      'already has a key',
    );
    expect(mounted.container.querySelector('[data-create-keys="unchecked"]')).toBeNull();
    await mounted.unmount();
  });

  it('keeps the confirm action on the done step when the account list is still unread, then names the links', async () => {
    const inner = base([], {
      [SET_ACCOUNTS]: { ...ANSWERED, accounts: ['gha_3'] },
      [ACCOUNTS]: [account('gha_3', 'newcomer')],
    });
    const asking: ProjectsClient = {
      call: <Answer,>(route: string, init?: { readonly quiet?: boolean }) =>
        route === ACCOUNTS && init?.quiet !== false
          ? Promise.reject(refusal(403, 'passkey first', 'grant_step_up_required'))
          : inner.call<Answer>(route, init as never),
    } as ProjectsClient;
    const panel = ({ onConnected }: { connected: number; onConnected: (id: string) => void }) => (
      <button type="button" data-fake-connect="" onClick={() => onConnected('gha_3')}>
        Connect
      </button>
    );
    const mounted = await mount(
      <WithAppHooks provided={{ [PROJECTS_CONNECT_ACCOUNT_HOOK]: { panel } }}>{page(asking)}</WithAppHooks>,
    );
    await createAt(mounted);
    await settled(mounted, c => c.querySelector('[data-create-accounts-step-up]') !== null, 'the press');
    await press(must(mounted.container.querySelector('[data-fake-connect]'), 'the connect card'));
    await press(button(mounted, 'Link this account'));
    await step(mounted, 'keys');
    await press(button(mounted, 'Next'));
    await step(mounted, 'done');
    await press(button(mounted, 'Confirm it’s you to see this'));
    await settled(mounted, c => c.querySelector('[data-project-accounts="ready"]') !== null, 'the links');
    expect(mounted.container.querySelector('[data-project-account="gha_3"]')?.textContent).toBe('@newcomer');
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
