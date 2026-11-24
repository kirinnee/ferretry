/**
 * What Logins draws on Runtimes' Add runtime page (the two slots its contract/slots.ts names): the add-login panel and
 * the sign-in panel. The page hands each plain callbacks; a panel answers with a login's id or a bare "signed in", and
 * no code, address or token ever reaches the page.
 */
import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import { describe, expect, it } from 'bun:test';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import { addRuntimeLoginPanel, addRuntimeSignInPanel } from '../../../app/features/add-runtime-slots.tsx';
import { LoginSignInPanel } from '../../../app/features/login-sign-in-panel.tsx';
import app from '../../../app/index.ts';
import { ADD_RUNTIME_LOGIN_SLOT, ADD_RUNTIME_SIGN_IN_SLOT } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { loginList, login as loginFixture } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { claudeFlow } from './support/harness-login.ts';

const LIST = 'GET /v1/logins';
const GRANTS = 'GET /v1/grants';
const START = 'POST /v1/logins/sign-in';
const ANSWER = 'POST /v1/logins/sign-in/:flowId';
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

const WORK = loginFixture({ id: 'claude-work', label: 'work', usedBy: [] });
const wait = async (ms: number): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

describe('the add-login slot panel', () => {
  it('draws the add-login panel and hands the page the new login’s id through its callback', () => {
    const told: string[] = [];
    const element = addRuntimeLoginPanel(scripted({}), { onAdded: (id: string) => told.push(id) });
    expect(element.type).toBe(AddLoginPanel);
    (element.props as { onAdded: (id: string) => void }).onAdded('claude-new');
    expect(told).toEqual(['claude-new']);
  });

  it('draws the same panel, with nobody told, when the page handed no callback or something else', () => {
    expect(addRuntimeLoginPanel(scripted({}), {}).props).not.toHaveProperty('onAdded');
    expect(addRuntimeLoginPanel(scripted({}), { onAdded: 'not a function' }).props).not.toHaveProperty('onAdded');
  });
});

describe('the sign-in slot panel', () => {
  it('signs the named login in, in place, and tells the page with nothing but "signed in"', async () => {
    const calls: Call[] = [];
    const told: unknown[][] = [];
    const client = scripted(
      {
        [GRANTS]: OPEN,
        [LIST]: loginList(WORK),
        [START]: { ...claudeFlow('awaiting-code'), loginId: 'claude-work' },
        [ANSWER]: { outcome: 'accepted', flow: { ...claudeFlow('complete'), loginId: 'claude-work' } },
      },
      calls,
    );
    const view = await mount(
      addRuntimeSignInPanel(client, {
        subject: 'claude-work',
        harness: 'claude-code',
        onSignedIn: (...args: unknown[]) => told.push(args),
      }),
    );
    await wait(30);
    const start = must(view.container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'start');
    await interact(() => start.click());
    await wait(30);
    const field = must(view.container.querySelector<HTMLInputElement>('input[type="password"]'), 'the code field');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'the-code-on-the-page');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const finish = [...view.container.querySelectorAll('button')].find(item =>
      item.textContent?.startsWith('Finish sign-in'),
    );
    await interact(() => must(finish, 'finish').click());
    await wait(30);
    // The code went to the daemon's flow, not to the page: the page is told once, and with nothing.
    expect(calls.find(call => call.route === ANSWER)?.body).toEqual({ code: 'the-code-on-the-page' });
    expect(told).toEqual([[]]);
    expect(view.container.textContent).not.toContain('the-code-on-the-page');
    await view.unmount();
  });

  it('draws the sign-in panel for the subject and harness, and works without a callback', () => {
    const element = addRuntimeSignInPanel(scripted({}), { subject: 'claude-work', harness: 'codex' });
    expect(element.type).toBe(LoginSignInPanel);
    expect(element.props).toMatchObject({ harness: 'codex', subject: 'claude-work' });
    expect(element.props).not.toHaveProperty('onSignedIn');
    expect(addRuntimeSignInPanel(scripted({}), { harness: 'codex', onSignedIn: 3 }).props).not.toHaveProperty(
      'subject',
    );
    expect(addRuntimeSignInPanel(scripted({}), { harness: 'codex', onSignedIn: 3 }).props).not.toHaveProperty(
      'onSignedIn',
    );
  });

  it('says so when the logins cannot be read, when the subject is not a login of that tool, and when none is named', async () => {
    const down = await mount(
      addRuntimeSignInPanel(scripted({ [LIST]: new Error('The machine is unreachable.') }), {
        subject: 'claude-work',
        harness: 'claude-code',
      }),
    );
    await wait(30);
    expect(down.container.querySelector('[role="alert"]')?.textContent).toContain('unreachable');
    await down.unmount();

    const other = await mount(
      addRuntimeSignInPanel(scripted({ [LIST]: loginList(WORK) }), { subject: 'claude-work', harness: 'codex' }),
    );
    await wait(30);
    expect(other.container.querySelector('[data-login-sign-in-panel="none"]')?.textContent).toBe(
      'There is no Codex login claude-work on box.',
    );
    await other.unmount();

    const unnamed = await mount(addRuntimeSignInPanel(scripted({ [LIST]: loginList(WORK) }), { harness: 'codex' }));
    await wait(30);
    expect(unnamed.container.querySelector('[data-login-sign-in-panel="none"]')?.textContent).toBe(
      'Name a Codex login to sign in.',
    );
    await unnamed.unmount();
  });

  it('says which tool to name instead of starting anything when the harness is not one it signs in', () => {
    for (const harness of [undefined, 'other', 3, THIRD_HARNESS_KEY]) {
      const element = addRuntimeSignInPanel(scripted({}), { subject: 'claude-work', harness });
      expect(element.type).toBe('p');
      expect(element.props).toMatchObject({
        'data-login-sign-in-panel': 'none',
        children: 'Name which tool this login signs in to.',
      });
    }
  });
});

describe('Logins’ contribution to the Add runtime page', () => {
  it('declares one panel in each of the two slots Runtimes offers, and the app half draws both', () => {
    const declared = (manifest.ui?.panels ?? []).filter(entry => entry.slot.startsWith('runtimes.'));
    expect(declared.map(entry => [entry.slot, entry.id])).toEqual([
      [ADD_RUNTIME_LOGIN_SLOT, 'add-runtime-login'],
      [ADD_RUNTIME_SIGN_IN_SLOT, 'add-runtime-sign-in'],
    ]);
    const built = app.build?.({ manifest, client: scripted({}) } as never) as unknown as {
      panels: Record<string, (props: Record<string, unknown>) => { type: unknown }>;
    };
    expect(built.panels['add-runtime-login']?.({ onAdded: () => undefined }).type).toBe(AddLoginPanel);
    expect(built.panels['add-runtime-sign-in']?.({ subject: 'x', harness: 'codex' }).type).toBe(LoginSignInPanel);
  });
});
