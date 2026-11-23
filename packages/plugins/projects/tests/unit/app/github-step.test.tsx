/**
 * The setup flow's "Connect GitHub" page (O9-10): Git accounts' own connect card (given, never copied), the connected
 * accounts as logins only, a passkey step-up that never walls the page, the optional link to the one project just made,
 * and Next that only moves on when nothing is ticked.
 */
import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { ProjectsConnectAccount } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import { GithubStep } from '../../../app/views/github-step.tsx';
import { type Call, clickEvent, refusal, scripted } from './support/client.ts';
import { stepRecorder } from './support/step-recorder.ts';

const ACCOUNTS = 'GET /v1/git-accounts';
const SET_ACCOUNTS = 'PUT /v1/projects/:id/accounts';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

/** A row as the daemon lists it, with a token-shaped field no page may ever draw. */
const account = (id: string, login: string) => ({ id, login, keys: {}, token: 'ghp_never_drawn_0123456789' });
const press = (element: Element) => interact(() => element.dispatchEvent(clickEvent()));
const settled = (mounted: Mounted, ready: (c: HTMLElement) => boolean, what: string) =>
  settleUntil(() => ready(mounted.container), what, interact);

/** What Git accounts provides: one button that reports an approved account by id, as the real card does. */
const card = (id: string, onTap?: () => void): ProjectsConnectAccount => ({
  panel: ({ onConnected }: { connected: number; onConnected: (id: string) => void }) => (
    <button
      type="button"
      data-fake-connect=""
      onClick={() => {
        onTap?.();
        onConnected(id);
      }}
    >
      Connect a GitHub account
    </button>
  ),
});

const open = async (
  routes: Record<string, unknown>,
  options: { provided?: ProjectsConnectAccount | undefined; project?: boolean; client?: ProjectsClient } = {},
) => {
  const recorder = stepRecorder('client');
  if (options.project === true) recorder.host.remember({ linkProjectId: PROJECT_ID, linkProjectName: 'atlas' });
  const calls: Call[] = [];
  const client = options.client ?? scripted(routes, calls);
  const mounted = await mount(
    <GithubStep
      step={recorder.host}
      client={client}
      connectAccount={'provided' in options ? options.provided : card('gha_2')}
    />,
  );
  await settleUntil(() => recorder.calls.includes('ready'), 'the page is drawn', interact);
  return { recorder, mounted, calls };
};

describe('the Connect GitHub step', () => {
  it('on a machine with no account says so, offers the connect card, and Next only moves on', async () => {
    const { recorder, mounted } = await open({ [ACCOUNTS]: [] });
    expect(mounted.container.querySelector('[data-github-empty]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-fake-connect]')).not.toBeNull();
    expect(recorder.committed).toBeNull();
    expect(recorder.calls).not.toContain('skip:not-needed');
    await mounted.unmount();
  });

  it('lists the connected accounts by login and never draws anything token-shaped', async () => {
    const { mounted } = await open({ [ACCOUNTS]: [account('gha_1', 'octocat')] });
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('@octocat');
    expect(text).not.toContain('ghp_');
    expect(mounted.container.querySelector('[data-github-empty]')).toBeNull();
    await mounted.unmount();
  });

  it('is never walled by the passkey step-up: the connect card is there, the list is one press away', async () => {
    const inner = scripted({ [ACCOUNTS]: [account('gha_1', 'octocat')] });
    // A read the page makes on its own is refused; only the person's press (`quiet: false`) is answered.
    const asking: ProjectsClient = {
      call: <Answer,>(route: string, init?: { readonly quiet?: boolean }) =>
        route === ACCOUNTS && init?.quiet !== false
          ? Promise.reject(refusal(403, 'passkey first', 'grant_step_up_required'))
          : inner.call<Answer>(route, init as never),
    } as ProjectsClient;
    const { recorder, mounted } = await open({}, { client: asking });
    expect(recorder.decision).toBe('shown');
    expect(mounted.container.querySelector('[data-fake-connect]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-github-error]')).toBeNull();
    const confirm = must(
      [...mounted.container.querySelectorAll('button')].find(node => (node.textContent ?? '').includes('Confirm')),
      'the passkey press',
    );
    await press(confirm);
    await settled(mounted, c => (c.textContent ?? '').includes('@octocat'), 'the accounts');
    expect(mounted.container.querySelector('[data-github-step-up]')).toBeNull();
    await mounted.unmount();
  });

  it("says a failed read in the daemon's words and still offers the connect card", async () => {
    const { recorder, mounted } = await open({ [ACCOUNTS]: refusal(500, 'the vault is locked') });
    expect(recorder.decision).toBe('shown');
    expect(mounted.container.querySelector('[data-github-error]')?.textContent).toContain('the vault is locked');
    expect(mounted.container.querySelector('[data-fake-connect]')).not.toBeNull();
    await mounted.unmount();
  });

  it('says connecting is not available when no plugin provides the card, and Skip for now is still the way out', async () => {
    const { mounted } = await open({ [ACCOUNTS]: [] }, { provided: undefined });
    expect(mounted.container.querySelector('[data-connect-account="unavailable"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('with no project made, a connected account is listed with no link to offer', async () => {
    const { recorder, mounted } = await open({ [ACCOUNTS]: [account('gha_1', 'octocat')] });
    expect(mounted.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(recorder.committed).toBeNull();
    await mounted.unmount();
  });

  it('with one project made, a freshly connected account is ticked for it and Next links it', async () => {
    let connected = false;
    const { recorder, mounted, calls } = await open(
      {
        [ACCOUNTS]: () =>
          connected ? [account('gha_1', 'octocat'), account('gha_2', 'newcomer')] : [account('gha_1', 'octocat')],
        [SET_ACCOUNTS]: {
          id: PROJECT_ID,
          name: 'atlas',
          path: '/home/k/atlas',
          source: 'existing-folder',
          createdAt: '2026-08-01T10:00:00.000Z',
          accounts: ['gha_2'],
        },
      },
      {
        project: true,
        provided: card('gha_2', () => {
          connected = true;
        }),
      },
    );
    expect(mounted.container.textContent).toContain('Use @octocat for atlas');
    expect(recorder.committed).toBeNull();
    await press(must(mounted.container.querySelector('[data-fake-connect]'), 'the connect card'));
    await settled(mounted, c => (c.textContent ?? '').includes('Use @newcomer for atlas'), 'the new account');
    const ticked = [...mounted.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
      box => box.checked,
    );
    expect(ticked).toEqual([false, true]);
    await must(recorder.committed, 'a save').call(null);
    const sent = calls.find(call => call.route === SET_ACCOUNTS);
    expect(sent?.params).toEqual({ id: PROJECT_ID });
    expect(sent?.body).toEqual({ accounts: ['gha_2'] });
    await mounted.unmount();
  });

  it('a refused link keeps the page and says why', async () => {
    const { recorder, mounted } = await open(
      { [ACCOUNTS]: [account('gha_1', 'octocat')], [SET_ACCOUNTS]: refusal(404, 'that project is gone') },
      { project: true },
    );
    await press(must(mounted.container.querySelector('input[type="checkbox"]'), 'the tick'));
    await expect(must(recorder.committed, 'a save').call(null)).rejects.toThrow('that project is gone');
    await mounted.unmount();
  });
});
