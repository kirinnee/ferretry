/** Appendix D, The Accounts screen: what the owner's screen can and cannot show, driven through the mounted surface. */
import { afterEach, describe, expect, it } from 'bun:test';
import { AccountsSurface } from '../../../app/features/accounts/accounts-surface.tsx';
import { DEFAULT_ONLY_ORDERS, defaultKeysOf } from '../../../app/lib/accounts-screen.ts';
import { AccountSummarySchema, observedWords } from '../../../contract/routes/index.ts';
import { ineligibleBecause } from '../../../daemon/lib/sign-in-rules/index.ts';
import manifest from '../../../manifest.ts';
import { list, SI_GITHUB } from '../../support/app/accounts-fixtures.ts';
import { type Mounted, mount } from '../../support/app/dom.ts';
import { click, settle, typeInto } from '../../support/app/dom-form.ts';
import { type Call, fakeClient } from '../../support/app/fake-client.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const PASSWORD = 'synthetic-screen-password-1';

const screen = async () => {
  const github = list().accounts.find(each => each.id === 'GITHUB');
  const fake = fakeClient((call: Call) => {
    if (call.route === 'GET /v1/accounts') return list();
    if (call.route === 'GET /v1/accounts/look-alike') return { v: 1, groups: [] };
    if (call.route === 'PUT /v1/accounts/:id') return github;
    throw new Error(`the fake daemon has no answer for ${call.route}`);
  });
  const view = await mount(<AccountsSurface client={fake.client} />);
  mounted.push(view);
  await settle();
  await settle();
  const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  await click(q('[data-accounts-row="GITHUB"] button'));
  return { q, view, calls: fake.calls };
};

const openSignIn = async (given: Awaited<ReturnType<typeof screen>>, tab: string) => {
  await click(given.q('[data-accounts-tab="sites"]'));
  await click(given.q(`[data-accounts-signin="${SI_GITHUB}"] button`));
  await click(given.q(`[data-accounts-tab="${tab}"]`));
};

describe('Appendix D: the Accounts screen', () => {
  it('S135 should draw the password box write-only and empty every time, and say the handle is not an environment variable', async () => {
    const s = await screen();
    const box = () => s.q('[data-accounts-password]') as HTMLInputElement;
    expect(box().value).toBe('');
    expect(box().type).toBe('password');
    expect(s.q('[data-accounts-password-state]')?.textContent).toContain('write-only');
    expect(s.q('[data-accounts-cli-name]')?.textContent).toContain('not an environment variable');
    await typeInto(box(), PASSWORD);
    await click(s.q('[data-accounts-save]'));
    await settle();
    // The password went out in the write and nowhere else: the box is empty again and no screen text holds it.
    expect(JSON.stringify(s.calls.find(call => call.route === 'PUT /v1/accounts/:id')?.body)).toContain(PASSWORD);
    expect((s.q('[data-accounts-password]') as HTMLInputElement).value).toBe('');
    expect(s.view.container.textContent).not.toContain(PASSWORD);
    expect(s.view.container.innerHTML).not.toContain(PASSWORD);
  });

  it('S137 should never draw 2FA usage as a check mark, nor let it make a sign-in eligible for a rule', async () => {
    const s = await screen();
    await click(s.q('[data-accounts-tab="keys"]'));
    const states = [...s.view.container.querySelectorAll('[data-accounts-key-words]')];
    expect(states.length).toBeGreaterThan(0);
    for (const each of states) {
      expect(each.textContent).not.toMatch(/[✓✔☑]/u);
      expect(each.querySelector('svg')).toBeNull();
    }
    // The seed has one path: the key form takes no seed field.
    expect(s.q('[data-accounts-key-form]')?.querySelector('input[type="password"], textarea') ?? null).toBeNull();
    // A checked key says nothing about who may have a rule: a sign-in the owner never tapped in has no history.
    const github = list().signIns.find(each => each.id === SI_GITHUB);
    expect(
      ineligibleBecause({ place: github!.place, method: github!.method, via: undefined, observed: undefined }),
    ).toBe('no-history');
  });

  it('S138 should draw a recipe as plain text, label a ferret’s recipe unreviewed, and show facts, never values', async () => {
    const s = await screen();
    await openSignIn(s, 'recipe');
    const body = s.q('[data-accounts-recipe-body]');
    expect(body?.textContent).toBe('# Sign in\n<script>alert(1)</script>\nClick **Sign in**.');
    expect(body?.querySelector('script, strong, h1, a, img')).toBeNull();
    expect(s.q('[data-accounts-recipe-unreviewed]')).not.toBeNull();
    await click(s.q('[data-accounts-tab="seen"]'));
    const fact = list().signIns.find(each => each.id === SI_GITHUB)?.observed?.[0];
    const shown = s.view.container.querySelector('ul[aria-label="What Ferretry saw"] li')?.textContent;
    expect(shown).toBe(observedWords(fact!));
    expect(shown).not.toMatch(/synthetic|JBSWY3DP/u);
  });

  it('S139 should let a default only order the list, on a host the sign-in names, and show an unreadable file as unreadable', async () => {
    const s = await screen();
    await openSignIn(s, 'defaults');
    expect(s.q('[data-accounts-defaults-note]')?.textContent).toBe(DEFAULT_ONLY_ORDERS);
    expect(DEFAULT_ONLY_ORDERS).toMatch(/which account a sign-in card lists first/u);
    // This build cannot read the file: it says so, and never draws "no defaults" or an offer to set one.
    expect(s.q('[data-accounts-defaults-unreadable]')?.textContent).toContain('not the same as having no defaults');
    expect(s.q('[data-accounts-default-key]')).toBeNull();
    // A default can be set only on a host the sign-in itself names.
    const github = list().signIns.find(each => each.id === SI_GITHUB)!;
    expect(defaultKeysOf(github.place)).toEqual(['github.com']);
  });

  it('S140 should make every write a person route, and hold no password, seed or code on any response or screen', async () => {
    const accountRoutes = manifest.actions.routes.filter(entry => entry.key.includes(' /v1/accounts'));
    const writes = accountRoutes.filter(entry => !entry.key.startsWith('GET '));
    expect(writes.length).toBeGreaterThan(15);
    for (const entry of writes) {
      expect(entry.caller).toBe('person');
      expect(entry.minimum).toBe('operator');
    }
    // What the daemon answers about an account has no field a password, seed or code could ride in.
    const github = list().accounts.find(each => each.id === 'GITHUB')!;
    for (const key of Object.keys(github)) expect(key).not.toMatch(/password|seed|secret|code|seal/iu);
    expect(AccountSummarySchema.safeParse({ ...github, password: PASSWORD }).success).toBe(false);
    const s = await screen();
    expect(s.view.container.innerHTML).not.toMatch(/synthetic|JBSWY3DP/u);
  });
});
